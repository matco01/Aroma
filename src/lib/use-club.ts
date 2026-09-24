"use client";

import { useCallback, useState } from "react";
import { useAccount, useSignTypedData, useWriteContract, usePublicClient, useChainId } from "wagmi";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { parseUnits, type Address } from "viem";
import { clubAuctionAbi, erc20PermitAbi } from "./abis";
import { contractsForChain, USDG_DECIMALS } from "./robinhood";
import { readableError, type TxPhase } from "./use-trade";

/**
 * Reads and writes for the Club auction.
 *
 * Bidding needs one signature, not an approve-then-bid, for the same reason
 * AromaRouterUsdg.buy does: USDG supports EIP-2612 permit (confirmed against
 * Paxos's own `usdg-contract` README), so `ClubAuction.bid` takes a permit
 * instead of requiring a prior approval — see that contract's NatSpec.
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

const PERMIT_TYPEHASH_TYPES = {
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
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<TxPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<`0x${string}` | null>(null);

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
    setHash(null);
  }, []);

  const invalidate = useCallback(() => {
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
    setTimeout(sweep, 3_500);
  }, [queryClient]);

  const bid = useCallback(
    async (bidAmountUsdg: string, devBuyUsdg: string, draft: Draft): Promise<boolean> => {
      if (!address || !publicClient) return false;
      const { usdg, clubAuction } = contractsForChain(chainId);
      try {
        setError(null);
        setPhase("signing");

        const bidAmount = parseUnits(bidAmountUsdg || "0", USDG_DECIMALS);
        const devBuy = devBuyUsdg ? parseUnits(devBuyUsdg, USDG_DECIMALS) : 0n;
        const total = bidAmount + devBuy;
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

        const [name, nonce] = await Promise.all([
          publicClient.readContract({
            address: usdg as Address,
            abi: erc20PermitAbi,
            functionName: "name",
          }) as Promise<string>,
          publicClient.readContract({
            address: usdg as Address,
            abi: erc20PermitAbi,
            functionName: "nonces",
            args: [address],
          }) as Promise<bigint>,
        ]);

        const signature = await signTypedDataAsync({
          domain: {
            name,
            version: "1",
            chainId: publicClient.chain.id,
            verifyingContract: usdg as Address,
          },
          types: PERMIT_TYPEHASH_TYPES,
          primaryType: "Permit",
          message: { owner: address, spender: clubAuction as Address, value: total, nonce, deadline },
        });

        const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
        const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
        const v = parseInt(signature.slice(130, 132), 16);

        setPhase("pending");
        const txHash = await writeContractAsync({
          address: clubAuction as Address,
          abi: clubAuctionAbi,
          functionName: "bid",
          args: [bidAmount, devBuy, 0n, draft, { deadline, v, r, s }],
        });

        setHash(txHash);
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        setPhase("success");
        invalidate();
        return true;
      } catch (e) {
        setError(readableError(e));
        setPhase("error");
        return false;
      }
    },
    [address, chainId, publicClient, writeContractAsync, signTypedDataAsync, invalidate],
  );

  return { bid, phase, error, hash, reset };
}

export function useUpdateClubDraft() {
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<TxPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
  }, []);

  const updateDraft = useCallback(
    async (draft: Draft): Promise<boolean> => {
      if (!address || !publicClient) return false;
      const { clubAuction } = contractsForChain(chainId);
      try {
        setError(null);
        setPhase("signing");
        const txHash = await writeContractAsync({
          address: clubAuction as Address,
          abi: clubAuctionAbi,
          functionName: "updateDraft",
          args: [draft],
        });
        setPhase("pending");
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        setPhase("success");
        queryClient.invalidateQueries({ queryKey: ["club"] });
        return true;
      } catch (e) {
        setError(readableError(e));
        setPhase("error");
        return false;
      }
    },
    [address, chainId, publicClient, writeContractAsync, queryClient],
  );

  return { updateDraft, phase, error, reset };
}

export function useWithdrawFromClub() {
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<TxPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  const withdraw = useCallback(async (): Promise<boolean> => {
    if (!address || !publicClient) return false;
    const { clubAuction } = contractsForChain(chainId);
    try {
      setError(null);
      setPhase("signing");
      const txHash = await writeContractAsync({
        address: clubAuction as Address,
        abi: clubAuctionAbi,
        functionName: "withdraw",
      });
      setPhase("pending");
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      setPhase("success");
      queryClient.invalidateQueries({
        predicate: (q) => q.queryKey[0] === "balance" || q.queryKey[0] === "readContract",
      });
      return true;
    } catch (e) {
      setError(readableError(e));
      setPhase("error");
      return false;
    }
  }, [address, chainId, publicClient, writeContractAsync, queryClient]);

  return { withdraw, phase, error };
}
