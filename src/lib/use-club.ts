"use client";

import { useCallback, useState } from "react";
import {
  useAccount,
  useSignTypedData,
  useSwitchChain,
  useWriteContract,
  usePublicClient,
} from "wagmi";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { parseUnits, type Address, type PublicClient } from "viem";
import { clubAuctionAbi, erc20PermitAbi } from "./abis";
import { contractsForChain, USDG_DECIMALS } from "./robinhood";
import { liveChain } from "./wagmi";
import { confirm, readableError, type TxPhase } from "./pool-trade";

/**
 * Reads and writes for the Club auction.
 *
 * Bidding needs one signature, not an approve-then-bid, for the same reason
 * AromaRouterUsdg.buy does: USDG supports EIP-2612 permit (confirmed against
 * Paxos's own `usdg-contract` README), so `ClubAuction.bid` takes a permit
 * instead of requiring a prior approval — see that contract's NatSpec.
 *
 * Every read and write is pinned to Robinhood Chain and the wallet is
 * switched there before signing, the same way use-trade.ts pins the pool
 * system to Arc. Both chains are registered with the wallet (see wagmi.ts),
 * so "whatever chain the wallet happens to be on" is never a safe default —
 * reading the connected chain's contracts would silently target the wrong
 * network rather than fail.
 *
 * @dev The permit domain below assumes `version: "1"`, OpenZeppelin's
 * ERC20Permit default and what AromaToken itself uses — this has not been
 * independently confirmed against USDG's actual deployed contract. If real
 * bids start failing with a signature-mismatch revert, this is the first
 * thing to check.
 */

export type Draft = {
  name: string;
  symbol: string;
  description: string;
  metadataUri: string;
};

export type ClubData = {
  id: string;
  openedAt: number;
  endsAt: number;
  finalized: boolean;
  void: boolean;
  topBidder: string | null;
  topBidUsdg: number;
  topDevBuyUsdg: number;
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  token: string | null;
};

type ClubResponse = { current: ClubData | null; past: ClubData[] };

const CLUB_CONTRACTS = contractsForChain(liveChain.id);

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

/**
 * Polled every 7s. Trades on the board poll slower and lean on a push
 * stream instead — a Club changes far less often (a handful of bids across
 * 24 hours, not per block), so plain polling is simple enough here without
 * extending the SSE `/api/live` stream for it.
 */
const REFETCH_MS = 7_000;

export function useClub() {
  return useQuery({
    queryKey: ["club"],
    queryFn: () => getJson<ClubResponse>("/api/club"),
    refetchInterval: REFETCH_MS,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });
}

/** Puts the wallet on Robinhood Chain before anything is signed. */
function useLiveChain() {
  const { chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  return useCallback(async () => {
    if (chainId !== liveChain.id) {
      await switchChainAsync({ chainId: liveChain.id });
    }
  }, [chainId, switchChainAsync]);
}

/** Refreshes the Club and every balance a Club transaction touches. */
function useInvalidate() {
  const queryClient = useQueryClient();
  return useCallback(() => {
    const sweep = () => {
      queryClient.invalidateQueries({ queryKey: ["club"] });
      queryClient.invalidateQueries({
        predicate: (q) => {
          const head = q.queryKey[0];
          return typeof head === "string" && (head === "balance" || head === "readContract");
        },
      });
    };
    sweep();
    // The indexer can trail the receipt by a second or two.
    setTimeout(sweep, 3_500);
  }, [queryClient]);
}

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function useBidOnClub() {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: liveChain.id });
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  const ensureChain = useLiveChain();
  const invalidate = useInvalidate();

  const [phase, setPhase] = useState<TxPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<`0x${string}` | null>(null);

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
    setHash(null);
  }, []);

  const bid = useCallback(
    async (bidAmountUsdg: string, devBuyUsdg: string, draft: Draft): Promise<boolean> => {
      if (!address || !publicClient) return false;
      const usdg = CLUB_CONTRACTS.usdg as Address;
      const clubAuction = CLUB_CONTRACTS.clubAuction as Address;
      try {
        setError(null);
        setPhase("signing");
        await ensureChain();

        const bidAmount = parseUnits(bidAmountUsdg || "0", USDG_DECIMALS);
        const devBuy = devBuyUsdg ? parseUnits(devBuyUsdg, USDG_DECIMALS) : 0n;
        const total = bidAmount + devBuy;
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

        const [name, nonce] = await Promise.all([
          publicClient.readContract({ address: usdg, abi: erc20PermitAbi, functionName: "name" }),
          publicClient.readContract({
            address: usdg,
            abi: erc20PermitAbi,
            functionName: "nonces",
            args: [address],
          }),
        ]);

        const signature = await signTypedDataAsync({
          domain: { name, version: "1", chainId: liveChain.id, verifyingContract: usdg },
          types: PERMIT_TYPES,
          primaryType: "Permit",
          message: { owner: address, spender: clubAuction, value: total, nonce, deadline },
        });
        const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
        const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
        const v = parseInt(signature.slice(130, 132), 16);

        const txHash = await writeContractAsync({
          address: clubAuction,
          abi: clubAuctionAbi,
          functionName: "bid",
          args: [bidAmount, devBuy, 0n, draft, { deadline, v, r, s }],
          chainId: liveChain.id,
        });
        setHash(txHash);
        setPhase("pending");
        await confirm(publicClient as unknown as PublicClient, txHash);
        setPhase("success");
        invalidate();
        return true;
      } catch (e) {
        setError(readableError(e));
        setPhase("error");
        return false;
      }
    },
    [address, publicClient, ensureChain, writeContractAsync, signTypedDataAsync, invalidate],
  );

  return { bid, phase, error, hash, reset };
}

export function useUpdateClubDraft() {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: liveChain.id });
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useLiveChain();
  const invalidate = useInvalidate();

  const [phase, setPhase] = useState<TxPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
  }, []);

  const updateDraft = useCallback(
    async (draft: Draft): Promise<boolean> => {
      if (!address || !publicClient) return false;
      try {
        setError(null);
        setPhase("signing");
        await ensureChain();
        const txHash = await writeContractAsync({
          address: CLUB_CONTRACTS.clubAuction as Address,
          abi: clubAuctionAbi,
          functionName: "updateDraft",
          args: [draft],
          chainId: liveChain.id,
        });
        setPhase("pending");
        await confirm(publicClient as unknown as PublicClient, txHash);
        setPhase("success");
        invalidate();
        return true;
      } catch (e) {
        setError(readableError(e));
        setPhase("error");
        return false;
      }
    },
    [address, publicClient, ensureChain, writeContractAsync, invalidate],
  );

  return { updateDraft, phase, error, reset };
}

export function useWithdrawFromClub() {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: liveChain.id });
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useLiveChain();
  const invalidate = useInvalidate();

  const [phase, setPhase] = useState<TxPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  const withdraw = useCallback(async (): Promise<boolean> => {
    if (!address || !publicClient) return false;
    try {
      setError(null);
      setPhase("signing");
      await ensureChain();
      const txHash = await writeContractAsync({
        address: CLUB_CONTRACTS.clubAuction as Address,
        abi: clubAuctionAbi,
        functionName: "withdraw",
        chainId: liveChain.id,
      });
      setPhase("pending");
      await confirm(publicClient as unknown as PublicClient, txHash);
      setPhase("success");
      invalidate();
      return true;
    } catch (e) {
      setError(readableError(e));
      setPhase("error");
      return false;
    }
  }, [address, publicClient, ensureChain, writeContractAsync, invalidate]);

  return { withdraw, phase, error };
}
