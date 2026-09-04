"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import type { Coin } from "./mock";
import type { IndexerHealth } from "./use-chain";

/**
 * A wallet's holdings, served from the index.
 *
 * Previously this called balanceOf on *every token that exists* to find
 * the handful a wallet held. The subgraph already tracks per-account
 * balances and average cost basis as trades arrive, so this is now one
 * query that scales with what you hold rather than with what exists.
 */

export type Holding = {
  coin: Coin;
  tokens: number;
  valueUsd: number;
  costUsd: number;
  pnlUsd: number;
  pnlPct: number;
  realisedPnlUsd: number;
};

type PortfolioResponse = {
  holdings: Holding[];
  indexer: IndexerHealth;
};

export function usePortfolio() {
  const { address } = useAccount();

  return useQuery({
    queryKey: ["portfolio", address?.toLowerCase()],
    enabled: Boolean(address),
    refetchInterval: 10_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<PortfolioResponse> => {
      const res = await fetch(`/api/portfolio?address=${address}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `request failed (${res.status})`);
      }
      return (await res.json()) as PortfolioResponse;
    },
  });
}
