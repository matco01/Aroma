import "server-only";
import { fetchBoardPage, fetchTapeTrades, type TapeTrade } from "./board";
import { indexerLag, type IndexerHealth } from "./lag";

/**
 * One poller, many listeners.
 *
 * Every open tab used to poll /api/board on its own timer. That is N
 * requests per interval for data that is identical for everyone, and it
 * gets worse exactly when the site is busiest. Here a single loop polls
 * the index and pushes changes to whoever is connected, so upstream load
 * is flat in the number of viewers.
 *
 * The loop only runs while someone is listening — no subscribers, no
 * polling, so an idle deployment costs nothing. And it only emits when
 * something actually changed, so a quiet market produces no traffic at
 * all beyond the heartbeat that keeps proxies from closing the stream.
 */

export type LiveEvent = {
  trades: TapeTrade[];
  indexer: IndexerHealth;
  /** Cheap change-detector: newest trade id plus the protocol trade count. */
  cursor: string;
};

type Listener = (event: LiveEvent) => void;

const listeners = new Set<Listener>();
let timer: NodeJS.Timeout | null = null;
let lastCursor = "";
let lastEvent: LiveEvent | null = null;

/** Fast enough to feel live on a sub-second chain, slow enough to be cheap. */
const POLL_MS = 3_000;

async function poll(): Promise<void> {
  try {
    const [page, trades] = await Promise.all([
      fetchBoardPage({ filter: "all", sort: "buys", limit: 1, skip: 0 }),
      fetchTapeTrades(12),
    ]);
    const indexer = await indexerLag(page.meta);

    const newest = trades.length > 0 ? trades[0].id : "none";
    const cursor = `${newest}:${page.stats.tradeCount}`;

    // Nothing new — say nothing. Pushing identical payloads on a timer is
    // just polling with extra steps.
    if (cursor === lastCursor) return;
    lastCursor = cursor;

    const event: LiveEvent = { trades, indexer, cursor };
    lastEvent = event;
    for (const listener of listeners) listener(event);
  } catch {
    // A failed poll is not worth tearing the stream down for; the next
    // tick will try again, and clients still hold the last good state.
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);

  // Hand a new subscriber the current state immediately rather than making
  // it wait up to a full interval for its first paint.
  if (lastEvent) listener(lastEvent);

  if (timer === null) {
    void poll();
    timer = setInterval(() => void poll(), POLL_MS);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    // lastCursor is deliberately NOT reset here. It stays paired with
    // lastEvent: a reconnecting client already receives lastEvent as its
    // first paint, so clearing the cursor would make the very next poll
    // emit that identical state a second time. Keeping them in step means
    // a poll only ever speaks when something genuinely changed.
  };
}

export function liveStats() {
  return { listeners: listeners.size, polling: timer !== null, pollMs: POLL_MS };
}
