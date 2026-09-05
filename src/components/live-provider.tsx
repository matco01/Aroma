"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useLive } from "@/lib/use-live";
import type { TapeTrade, IndexerHealth } from "@/lib/use-chain";

/**
 * Holds one live subscription for the whole app.
 *
 * It used to live inside the tape, which only renders on the board — so a
 * coin page had no stream at all and fell back to the 60s safety poll.
 * Someone would buy, watch nothing happen, and refresh.
 *
 * A context rather than calling useLive wherever it's wanted: each call
 * opens its own EventSource, so two consumers would mean two connections
 * to a stream that carries identical data. One owner, many readers.
 *
 * This briefly also derived per-token pulses so a card could flash when
 * its coin was traded. The flash is gone, and the bookkeeping went with
 * it — a seen-set and a counter running on every frame to feed nothing is
 * worse than no feature at all.
 */

type LiveState = {
  trades: TapeTrade[];
  indexer: IndexerHealth | null;
  connected: boolean;
};

const LiveContext = createContext<LiveState>({
  trades: [],
  indexer: null,
  connected: false,
});

export function LiveProvider({ children }: { children: ReactNode }) {
  const live = useLive();
  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

export function useLiveFeed(): LiveState {
  return useContext(LiveContext);
}
