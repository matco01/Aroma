"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TapeTrade, IndexerHealth } from "./use-chain";

/**
 * Subscribes to the live stream and keeps the tape current.
 *
 * When a trade lands it also invalidates the board and token queries, so
 * prices refresh because something happened rather than because a timer
 * fired. That is the actual win over polling: quiet markets cost nothing,
 * busy ones update immediately.
 *
 * EventSource reconnects by itself, so there is no retry logic here. The
 * one thing worth handling is the page being hidden — a backgrounded tab
 * holding a stream open helps nobody, so we close it and reopen on return.
 */

type LiveState = {
  trades: TapeTrade[];
  indexer: IndexerHealth | null;
  connected: boolean;
};

export function useLive(enabled = true): LiveState {
  const [state, setState] = useState<LiveState>({
    trades: [],
    indexer: null,
    connected: false,
  });
  const queryClient = useQueryClient();
  const lastCursor = useRef<string>("");

  useEffect(() => {
    if (!enabled) return;

    let source: EventSource | null = null;

    const open = () => {
      if (source) return;
      source = new EventSource("/api/live");

      source.addEventListener("open", () => {
        setState((s) => ({ ...s, connected: true }));
      });

      source.addEventListener("update", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as {
            trades: TapeTrade[];
            indexer: IndexerHealth;
            cursor: string;
          };

          setState({ trades: data.trades, indexer: data.indexer, connected: true });

          // Only refetch prices when the trade set actually moved.
          if (data.cursor !== lastCursor.current) {
            lastCursor.current = data.cursor;
            queryClient.invalidateQueries({ queryKey: ["board"] });
            queryClient.invalidateQueries({ queryKey: ["token"] });
            queryClient.invalidateQueries({ queryKey: ["portfolio"] });
          }
        } catch {
          // A malformed frame is not worth dropping the connection over.
        }
      });

      source.addEventListener("error", () => {
        // EventSource retries on its own; just reflect the state.
        setState((s) => ({ ...s, connected: false }));
      });
    };

    const close = () => {
      source?.close();
      source = null;
      setState((s) => ({ ...s, connected: false }));
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") open();
      else close();
    };

    if (document.visibilityState === "visible") open();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      close();
    };
  }, [enabled, queryClient]);

  return state;
}
