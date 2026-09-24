"use client";

import { useCallback, useState } from "react";
import { useAccount, useWriteContract, usePublicClient } from "wagmi";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { parseUnits, type Abi, type Address, type PublicClient } from "viem";
import { clubAuctionAbi } from "./abis";
import { activeChain } from "./chain";
import { AUCTION_CONTRACT, SETTLEMENT } from "./network";
import { permitFor } from "./club-trade";
import { confirm, type TxPhase } from "./pool-trade";
import { tradeError, useActiveChain, useCtx } from "./use-trade";

/**
 * Reads and writes for the Club auction.
 *
 * Bidding needs one signature, not an approve-then-bid, for the same reason
 * ClubRouterUsdg.buy does: USDG supports EIP-2612 permit, so `ClubAuction.bid`
 * takes a permit instead of requiring a prior approval. The permit is built by
 * club-trade's permitFor, which asks USDG for its own signing domain rather
 * than assuming one, and skips the signature when an allowance already covers
 * the bid.
 *
 * Every read and write is pinned to `activeChain` and the wallet is switched
 * there before signing, as everywhere else in the app.
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
  imageUri: string;
  metadataUri: string;
  links: { website: string; x: string; telegram: string };
  token: string | null;
};

export type ClubBidData = {
  id: string;
  bidder: string;
  bidUsdg: number;
  firstBuyUsdg: number;
  endsAt: number;
  timestamp: number;
};

/** The live round and its bids, newest first. */
type ClubResponse = { current: ClubData | null; bids: ClubBidData[] };

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

export function useClubAuction() {
  return useQuery({
    queryKey: ["club"],
    queryFn: () => getJson<ClubResponse>("/api/club"),
    refetchInterval: REFETCH_MS,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });
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

const AUCTION = AUCTION_CONTRACT as Address;

export function useBidOnClub() {
  const makeCtx = useCtx();
  const ensureChain = useActiveChain();
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
      try {
        setError(null);
        await ensureChain();
        const ctx = makeCtx(setPhase);
        if (!ctx) return false;

        const bidAmount = parseUnits(bidAmountUsdg || "0", SETTLEMENT.decimals);
        const devBuy = devBuyUsdg ? parseUnits(devBuyUsdg, SETTLEMENT.decimals) : 0n;
        const permit = await permitFor(ctx, SETTLEMENT.token as Address, AUCTION, bidAmount + devBuy);

        ctx.onPhase?.("signing");
        const txHash = await ctx.write({
          address: AUCTION,
          abi: clubAuctionAbi as Abi,
          functionName: "bid",
          args: [bidAmount, devBuy, 0n, draft, permit],
        });
        setHash(txHash);
        setPhase("pending");
        await confirm(ctx.publicClient, txHash);
        setPhase("success");
        invalidate();
        return true;
      } catch (e) {
        setError(tradeError(e));
        setPhase("error");
        return false;
      }
    },
    [makeCtx, ensureChain, invalidate],
  );

  return { bid, phase, error, hash, reset };
}

export function useUpdateClubDraft() {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: activeChain.id });
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useActiveChain();
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
          address: AUCTION,
          abi: clubAuctionAbi,
          functionName: "updateDraft",
          args: [draft],
          chainId: activeChain.id,
        });
        setPhase("pending");
        await confirm(publicClient as unknown as PublicClient, txHash);
        setPhase("success");
        invalidate();
        return true;
      } catch (e) {
        setError(tradeError(e));
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
  const publicClient = usePublicClient({ chainId: activeChain.id });
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useActiveChain();
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
        address: AUCTION,
        abi: clubAuctionAbi,
        functionName: "withdraw",
        chainId: activeChain.id,
      });
      setPhase("pending");
      await confirm(publicClient as unknown as PublicClient, txHash);
      setPhase("success");
      invalidate();
      return true;
    } catch (e) {
      setError(tradeError(e));
      setPhase("error");
      return false;
    }
  }, [address, publicClient, ensureChain, writeContractAsync, invalidate]);

  return { withdraw, phase, error };
}
