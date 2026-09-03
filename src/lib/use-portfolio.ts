"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { formatUnits, type Address } from "viem";
import { aramTokenAbi } from "./abis";
import { publicClient, fetchBoardData } from "./chain-data";
import type { Coin } from "./mock";

export type Holding = {
  coin: Coin;
  tokens: number;
  valueUsd: number;
  costUsd: number;
  pnlUsd: number;
  pnlPct: number;
};

/**
 * A wallet's real holdings: balances read from each token contract, with
 * cost basis reconstructed from that wallet's own trade history.
 *
 * Balances are authoritative — they come from `balanceOf`. Cost basis is
 * inferred from Bought/Sold logs, so it's only complete for tokens acquired
 * through aram; tokens received by transfer will show a holding with no
 * recorded cost. An indexer would track transfers too (plan §4).
 */
export function usePortfolio() {
  const { address } = useAccount();

  return useQuery({
    queryKey: ["portfolio", address?.toLowerCase()],
    enabled: Boolean(address),
    refetchInterval: 10_000,
    queryFn: async (): Promise<Holding[]> => {
      if (!address) return [];

      const { tokens, trades } = await fetchBoardData();
      if (tokens.length === 0) return [];

      const balances = await publicClient.multicall({
        contracts: tokens.map((t) => ({
          address: t.contract as Address,
          abi: aramTokenAbi,
          functionName: "balanceOf",
          args: [address],
        })),
        allowFailure: false,
      });

      const mine = trades.filter(
        (t) => t.account.toLowerCase() === address.toLowerCase(),
      );

      const holdings: Holding[] = [];
      tokens.forEach((coin, i) => {
        const raw = balances[i] as unknown as bigint;
        if (raw === 0n) return;

        const amount = Number(formatUnits(raw, 18));
        const valueUsd = amount * coin.priceUsd;

        // Average cost across this wallet's buys, less the basis released
        // by any sells — the same average-cost approach the contract's own
        // fee accounting uses, applied to trade history.
        const forToken = mine.filter(
          (t) => t.tokenAddress.toLowerCase() === coin.contract.toLowerCase(),
        );
        let boughtTokens = 0;
        let boughtCost = 0;
        let soldTokens = 0;
        for (const t of forToken) {
          if (t.side === "buy") {
            boughtTokens += t.tokens;
            boughtCost += t.usd;
          } else {
            soldTokens += t.tokens;
          }
        }
        const avgCost = boughtTokens > 0 ? boughtCost / boughtTokens : 0;
        const netTokens = Math.max(0, boughtTokens - soldTokens);
        const costUsd = avgCost * Math.min(amount, netTokens || amount);

        const pnlUsd = valueUsd - costUsd;
        holdings.push({
          coin,
          tokens: amount,
          valueUsd,
          costUsd,
          pnlUsd,
          pnlPct: costUsd > 0 ? (pnlUsd / costUsd) * 100 : 0,
        });
      });

      return holdings.sort((a, b) => b.valueUsd - a.valueUsd);
    },
  });
}
