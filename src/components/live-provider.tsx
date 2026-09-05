"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
 * It also turns the raw stream into per-token pulses, so a card can ask
 * "did something just happen to me" without every card in the grid
 * re-deriving that from the whole trade list on every frame.
 */

export type Pulse = { side: "buy" | "sell"; seq: number };

type LiveState = {
  trades: TapeTrade[];
  indexer: IndexerHealth | null;
  connected: boolean;
  /** Keyed by lowercased token address. */
  pulses: Record<string, Pulse>;
};

const LiveContext = createContext<LiveState>({
  trades: [],
  indexer: null,
  connected: false,
  pulses: {},
});

/**
 * How many trade ids to remember before rebuilding from the current feed.
 *
 * The set only exists to answer "have I already flashed this one", and the
 * feed carries a few dozen trades, so anything well above that is enough.
 * Without a cap it grows for as long as the tab is open.
 */
const SEEN_LIMIT = 600;

export function LiveProvider({ children }: { children: ReactNode }) {
  const live = useLive();
  const [pulses, setPulses] = useState<Record<string, Pulse>>({});

  // null means "no frame seen yet" — distinct from an empty set, which
  // would mean every trade in the first frame is news.
  const seen = useRef<Set<string> | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!live.trades.length) return;

    // The first frame is history, not news. Flashing all of it would set
    // the whole board off at once the moment the page loads, which reads
    // as a bug rather than as activity.
    if (seen.current === null) {
      seen.current = new Set(live.trades.map((t) => t.id));
      return;
    }

    const fresh = live.trades.filter((t) => !seen.current!.has(t.id));
    if (!fresh.length) return;

    for (const t of fresh) seen.current.add(t.id);
    if (seen.current.size > SEEN_LIMIT) {
      seen.current = new Set(live.trades.map((t) => t.id));
    }

    setPulses((prev) => {
      const next = { ...prev };
      // Oldest first, so a token traded twice in one frame ends up
      // carrying the side of its most recent trade.
      for (const t of [...fresh].reverse()) {
        seq.current += 1;
        next[t.tokenAddress.toLowerCase()] = {
          side: t.side,
          seq: seq.current,
        };
      }
      return next;
    });
  }, [live.trades]);

  const value = useMemo(
    () => ({
      trades: live.trades,
      indexer: live.indexer,
      connected: live.connected,
      pulses,
    }),
    [live.trades, live.indexer, live.connected, pulses],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLiveFeed(): LiveState {
  return useContext(LiveContext);
}

/** The most recent trade on one token, or null if it has been quiet. */
export function useTokenPulse(address: string | undefined): Pulse | null {
  const { pulses } = useContext(LiveContext);
  if (!address) return null;
  return pulses[address.toLowerCase()] ?? null;
}
