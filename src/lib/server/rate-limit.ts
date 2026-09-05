import "server-only";

/**
 * A fixed-window rate limiter, in memory.
 *
 * This exists for one endpoint in particular: /api/upload holds a Pinata
 * JWT that writes to our account. Unlimited and unauthenticated, anyone
 * could pin unbounded content to it — that is our storage bill, and
 * whatever they pinned is content we are hosting under our own key.
 *
 * Honest about what this is not: process-local. Behind more than one
 * instance each gets its own counters, so the effective limit multiplies
 * by the instance count, and a restart forgets everything. It raises the
 * cost of abuse from zero to something real, which is worth doing now;
 * it is not a substitute for a shared limiter (Redis, or the platform's
 * own) once this runs on more than one process.
 *
 * Keyed on the client IP, which behind a proxy means a header the client
 * can set unless the platform overwrites it. Treated as a best-effort
 * signal rather than an identity for that reason.
 */

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

/** Bound on distinct keys, so the limiter cannot itself be a memory leak. */
const MAX_KEYS = 10_000;

export type RateLimitResult = {
  ok: boolean;
  /** Seconds until the window resets — for a Retry-After header. */
  retryAfter: number;
};

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const existing = windows.get(key);

  if (!existing || existing.resetAt <= now) {
    if (windows.size >= MAX_KEYS) {
      for (const [k, w] of windows) {
        if (w.resetAt <= now) windows.delete(k);
      }
      // Still full: everything is live, so drop the oldest insertion.
      while (windows.size >= MAX_KEYS) {
        const oldest = windows.keys().next();
        if (oldest.done) break;
        windows.delete(oldest.value);
      }
    }
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }

  existing.count += 1;
  if (existing.count > limit) {
    return { ok: false, retryAfter: Math.ceil((existing.resetAt - now) / 1000) };
  }
  return { ok: true, retryAfter: 0 };
}

/**
 * Best-effort client address.
 *
 * x-forwarded-for is chosen over the socket address because in every
 * deployment shape we care about there is a proxy in front. The leftmost
 * entry is the client as the first proxy saw it; entries after it are the
 * proxies themselves.
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}
