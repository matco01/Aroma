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

/**
 * Caps on who may listen.
 *
 * An SSE connection is cheap for the client to open and not free for us to
 * hold — a measured 1000 concurrent streams cost this process ~246MB. The
 * endpoint is unauthenticated, so without a bound one machine can hold
 * enough streams open to exhaust the instance, which is a denial of service
 * that costs the attacker almost nothing.
 *
 * Two limits rather than one, because a global cap on its own is a worse
 * failure: an attacker fills it and every real visitor gets refused. The
 * per-client cap means filling the global one requires MAX_LISTENERS /
 * PER_CLIENT distinct addresses, and a single abusive address can only ever
 * take PER_CLIENT slots from everyone else.
 *
 * The per-client cap moves with pressure rather than being fixed, because a
 * fixed one has to be wrong in one direction or the other. Client identity
 * here is an IP address, and an IP address is not a person: mobile carriers
 * put thousands of subscribers behind one address. A cap tight enough to
 * blunt an attack would refuse real visitors sharing a carrier NAT on an
 * ordinary day, which trades a hypothetical outage for a real one.
 *
 * So while there is plenty of room, be generous and let a shared address
 * hold many streams. Once the pool is filling, tighten to the number one
 * person plausibly needs, so the remaining slots go to distinct visitors
 * rather than to whoever opened connections fastest. Nothing is refused
 * until refusing is the only way to keep the service up.
 */
const MAX_LISTENERS = 1_000;

/** Beyond this share of the pool, start rationing per address. */
const PRESSURE_AT = 0.6;

/** Room to spare: a whole office or carrier NAT is welcome. */
const PER_CLIENT_RELAXED = 25;

/** Under pressure: a person with several tabs, and no more. */
const PER_CLIENT_STRICT = 5;

function perClientLimit(): number {
  return listeners.size >= MAX_LISTENERS * PRESSURE_AT
    ? PER_CLIENT_STRICT
    : PER_CLIENT_RELAXED;
}

const listeners = new Set<Listener>();
/** Open streams per client key, so one address cannot crowd out the rest. */
const perClient = new Map<string, number>();
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

/**
 * Returns an unsubscribe function, or null when a cap is already reached.
 *
 * Null rather than a throw: being over capacity is an expected condition
 * with a correct HTTP answer (503 and a Retry-After), not an exception.
 */
export function subscribe(listener: Listener, clientKey: string): (() => void) | null {
  if (listeners.size >= MAX_LISTENERS) return null;

  const held = perClient.get(clientKey) ?? 0;
  if (held >= perClientLimit()) return null;

  listeners.add(listener);
  perClient.set(clientKey, held + 1);

  // Hand a new subscriber the current state immediately rather than making
  // it wait up to a full interval for its first paint.
  if (lastEvent) listener(lastEvent);

  if (timer === null) {
    void poll();
    timer = setInterval(() => void poll(), POLL_MS);
  }

  let released = false;
  return () => {
    // Cleanup can fire more than once (client abort and stream cancel both
    // run it). Counting a release twice would leak slots downward until the
    // map wrongly reported free capacity, so make it idempotent.
    if (released) return;
    released = true;

    listeners.delete(listener);
    const now = (perClient.get(clientKey) ?? 1) - 1;
    // Delete at zero rather than storing it — otherwise the map grows one
    // entry per address ever seen, which is the leak the cap was added for.
    if (now <= 0) perClient.delete(clientKey);
    else perClient.set(clientKey, now);

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
