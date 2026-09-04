"use client";

import { useEffect, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import type { Coin, Trade } from "./mock";

/**
 * The client's read path: our own API, never the indexer directly.
 *
 * Going through a route handler means one upstream query serves every
 * viewer, the subgraph URL stays server-side, and filtering/sorting/paging
 * happen in the index rather than in a useMemo over every token that
 * exists.
 */

export type IndexerHealth = {
  indexedBlock: number;
  headBlock: number | null;
  blocksBehind: number | null;
  secondsBehind: number | null;
  status: "live" | "lagging" | "stale" | "unknown";
  hasIndexingErrors: boolean;
};

export type BoardStats = {
  tokenCount: number;
  tradeCount: number;
  graduatedCount: number;
  totalVolumeUsd: number;
  totalFeesUsd: number;
};

export type TapeTrade = Trade & {
  tokenAddress: string;
  ticker: string;
  timestamp: number;
};

type BoardResponse = {
  tokens: Coin[];
  trades: TapeTrade[];
  stats: BoardStats;
  indexer: IndexerHealth;
  hasMore: boolean;
};

export type BoardFilter = "all" | "climbing" | "graduated";
export type BoardSort = "buys" | "new" | "mcap" | "volume";

/**
 * A slow safety net, not the primary refresh path.
 *
 * useLive invalidates these queries the moment a trade lands, so this only
 * covers the case where the stream is down. Polling fast *as well* would
 * throw away the point of pushing.
 */
const REFETCH_MS = 60_000;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export function useBoard(opts: {
  filter: BoardFilter;
  sort: BoardSort;
  limit: number;
  skip: number;
}) {
  const qs = new URLSearchParams({
    filter: opts.filter,
    sort: opts.sort,
    limit: String(opts.limit),
    skip: String(opts.skip),
  });

  return useQuery({
    queryKey: ["board", opts.filter, opts.sort, opts.limit, opts.skip],
    queryFn: () => getJson<BoardResponse>(`/api/board?${qs}`),
    refetchInterval: REFETCH_MS,
    refetchOnWindowFocus: false,
    // Keep the previous page on screen while the next loads, so paging and
    // re-sorting don't blank the grid.
    placeholderData: keepPreviousData,
  });
}

type TokenResponse = {
  coin: Coin;
  trades: TapeTrade[];
  indexer: IndexerHealth;
};

export function useToken(address: string | undefined) {
  return useQuery({
    queryKey: ["token", address?.toLowerCase()],
    queryFn: () => getJson<TokenResponse>(`/api/token/${address}`),
    enabled: Boolean(address),
    refetchInterval: REFETCH_MS,
    refetchOnWindowFocus: false,
    retry: (count, error) =>
      // A missing token is an answer, not a failure worth retrying.
      !/not found/i.test(error.message) && count < 2,
  });
}

/** Powers the live tape — piggybacks on the board query's cache. */
export function useTape() {
  return useQuery({
    queryKey: ["board", "all", "buys", 24, 0],
    queryFn: () => getJson<BoardResponse>("/api/board?filter=all&sort=buys&limit=24&skip=0"),
    refetchInterval: 5_000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Debounced token search against the index.
 *
 * Debounced because a query per keystroke is both wasteful and worse to
 * use — results that thrash while you finish a word are harder to read
 * than results that settle. 200ms is below the threshold where typing
 * feels laggy but above the rate at which people type.
 */
export function useSearch(term: string) {
  const [debounced, setDebounced] = useState(term);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(term), 200);
    return () => clearTimeout(id);
  }, [term]);

  return useQuery({
    queryKey: ["search", debounced.trim().toLowerCase()],
    queryFn: () =>
      getJson<{ tokens: Coin[] }>(`/api/search?q=${encodeURIComponent(debounced.trim())}`),
    // Hold the last results while the next query runs, so the list doesn't
    // blank between keystrokes.
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
}
