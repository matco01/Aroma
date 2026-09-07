import "server-only";
import { NextResponse } from "next/server";
import { rateLimit, clientKey } from "./rate-limit";

/**
 * What the public feed will serve one caller per minute.
 *
 * The feed exists to be polled by strangers, so this has to be loose enough
 * that a real indexer never notices it. One that keeps up with a sub-second
 * chain asks for the head every second or two and a block range each time it
 * moves — a couple of requests a second between the two, sustained.
 *
 * The limits below sit well above that, and the split is about what a request
 * costs us rather than how often it is made. A head or a pair lookup is a
 * single cheap query. A range can page the index up to six times, and the
 * block numbers are in the caller's hands, so every distinct range is a fresh
 * cache key that reaches the indexer no matter how recently a neighbouring
 * range was asked for. Walking fromBlock forward one at a time is therefore an
 * unbounded stream of misses, which is what this is really for: it cannot make
 * the feed cheap to abuse, only bounded.
 *
 * Anyone who genuinely needs more should be talking to us, and a 429 with a
 * Retry-After is how they find that out.
 */
const WINDOW_MS = 60_000;

/** Ranges: capped tighter, since one can page the index six times. */
export const EVENTS_PER_WINDOW = 90;

/** Head, asset and pair: one query each, so the ceiling can be higher. */
export const LOOKUPS_PER_WINDOW = 240;

/**
 * Applies the limit, returning a 429 to send back or null to carry on.
 *
 * Shared rather than repeated per route so the four endpoints cannot drift
 * apart on the header they set or the shape of the refusal.
 */
export function dexRateLimit(
  request: Request,
  bucket: string,
  limit: number,
): NextResponse | null {
  const result = rateLimit(`dex:${bucket}:${clientKey(request)}`, limit, WINDOW_MS);
  if (result.ok) return null;

  return NextResponse.json(
    {
      error:
        "Rate limit reached on the public data feed. Slow down, or get in touch if you need a higher ceiling.",
    },
    { status: 429, headers: { "retry-after": String(result.retryAfter) } },
  );
}
