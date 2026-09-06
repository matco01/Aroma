import "server-only";

/**
 * What a client is told when a call to the indexer fails.
 *
 * The errors these routes catch come from upstream, and upstream error text
 * is written for us, not for the public. A GraphQL error names fields and
 * types and so hands out a map of the subgraph schema; a transport error can
 * carry the endpoint. Neither helps the person whose page failed to load,
 * and both help someone probing the service.
 *
 * So the real error is logged where we can read it and the caller gets one
 * fixed sentence. Callers already treat this as opaque display text — it is
 * rendered, never parsed — so nothing downstream depends on the detail.
 *
 * This deliberately gives up the ability to debug a user's failure from
 * their screenshot alone. The logs have what the screenshot used to.
 */
export function upstreamFailure(e: unknown): string {
  console.error("[upstream]", e);
  return "The indexer is not responding right now.";
}
