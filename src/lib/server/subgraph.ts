import "server-only";

/**
 * Server-side Goldsky client: one upstream query serves every viewer.
 *
 * Previously the browser queried the subgraph directly, which meant the
 * endpoint was public, the board was recomputed per viewer, and credits
 * burned in proportion to traffic rather than to actual data change. The
 * board is identical for everyone, so it should be fetched once.
 *
 * Two protections matter here and are easy to get wrong:
 *
 *   - A TTL cache, so repeat requests inside the window cost nothing.
 *   - In-flight de-duplication, so N simultaneous misses produce ONE
 *     upstream query rather than N. Without it a cache expiry under load
 *     is a thundering herd — the exact moment you least want a stampede.
 */

const SUBGRAPH_URL = process.env.SUBGRAPH_URL ?? "";
export const hasSubgraph = SUBGRAPH_URL.length > 0;

/** Prices move every block; a few seconds of staleness is invisible. */
const TTL_MS = 5_000;

type Entry = { value: unknown; expires: number };
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

/**
 * Hard ceiling on cached queries.
 *
 * Entries expired by TTL but never read again were still sitting in this
 * Map forever, and cache keys carry caller-supplied values — the board's
 * `skip`, the search term. Walking ?skip=1..1000000, or searching a
 * million random strings, therefore grew this Map without bound, each
 * entry holding a full GraphQL response. That is a remote memory
 * exhaustion with no authentication and no cost to the attacker.
 *
 * A Map iterates in insertion order, so the oldest key is simply the
 * first one. Evicting expired entries first means a burst of junk keys
 * cannot push out the small set of hot ones that are actually serving
 * traffic; only if everything is live do we fall back to dropping the
 * oldest.
 */
const MAX_ENTRIES = 500;

function evictIfFull() {
  if (cache.size < MAX_ENTRIES) return;

  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expires <= now) cache.delete(key);
  }

  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export type SubgraphMeta = {
  indexedBlock: number;
  hasIndexingErrors: boolean;
};

export class SubgraphError extends Error {}

export async function query<T>(
  key: string,
  document: string,
  variables: Record<string, unknown> = {},
  /**
   * How long this key stays fresh. Defaults to the board's interval, which
   * is right for anything a viewer is watching change. Callers with a
   * different need pass their own: a chain-head read wants a shorter one, a
   * query over a block range that is already history wants a longer one,
   * since the answer cannot change once those blocks are behind the head.
   */
  ttlMs: number = TTL_MS,
): Promise<T> {
  if (!hasSubgraph) throw new SubgraphError("SUBGRAPH_URL is not configured");

  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value as T;

  // Someone else is already fetching this exact key — wait on theirs.
  const pending = inflight.get(key);
  if (pending) return (await pending) as T;

  const promise = (async () => {
    const res = await fetch(SUBGRAPH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: document, variables }),
      // Next's fetch cache doesn't key on POST bodies, so caching is ours.
      cache: "no-store",
    });
    if (!res.ok) throw new SubgraphError(`subgraph responded ${res.status}`);

    const json = (await res.json()) as {
      data?: unknown;
      errors?: { message: string }[];
    };
    if (json.errors?.length) throw new SubgraphError(json.errors[0].message);
    if (!json.data) throw new SubgraphError("subgraph returned no data");

    evictIfFull();
    cache.set(key, { value: json.data, expires: Date.now() + ttlMs });
    return json.data;
  })();

  inflight.set(key, promise);
  try {
    return (await promise) as T;
  } finally {
    inflight.delete(key);
  }
}

/** Cache stats, for the health endpoint. */
export function cacheState() {
  const now = Date.now();
  let fresh = 0;
  for (const entry of cache.values()) if (entry.expires > now) fresh++;
  return { entries: cache.size, fresh, ttlMs: TTL_MS };
}
