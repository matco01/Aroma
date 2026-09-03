"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchBoardData } from "./chain-data";

/**
 * One query backs the whole app.
 *
 * Every screen derives what it needs from the same cached board fetch
 * instead of running its own scan. That isn't just tidiness — separate
 * per-screen queries on independent timers duplicated the log scan and
 * rate-limited the public RPC within minutes of use.
 *
 * Polling rather than subscriptions: Arc finalises in under a second, so a
 * few seconds of staleness is barely visible, and a websocket subscription
 * would still be reading the same unindexed logs underneath. Push belongs
 * with the indexer (plan §5), not before it.
 */

const REFETCH_MS = 15_000;

function useBoard() {
  return useQuery({
    queryKey: ["board"],
    queryFn: fetchBoardData,
    refetchInterval: REFETCH_MS,
    refetchOnWindowFocus: false,
    staleTime: 8_000,
  });
}

export function useTokens() {
  const { data, ...rest } = useBoard();
  return { ...rest, data: data?.tokens };
}

export function useToken(address: string | undefined) {
  const { data, ...rest } = useBoard();
  const token = address
    ? data?.tokens.find((t) => t.id.toLowerCase() === address.toLowerCase())
    : undefined;
  return { ...rest, data: token };
}

export function useTrades(address: string | undefined) {
  const { data, ...rest } = useBoard();
  const trades = address
    ? data?.trades.filter(
        (t) => t.tokenAddress.toLowerCase() === address.toLowerCase(),
      )
    : undefined;
  return { ...rest, data: trades };
}

/** Powers the live tape — every trade across every token. */
export function useAllTrades() {
  const { data, ...rest } = useBoard();
  return { ...rest, data: data?.trades };
}
