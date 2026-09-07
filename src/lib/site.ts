/**
 * Where this site lives, for everything that needs an absolute URL.
 *
 * Metadata, the sitemap and robots.txt all have to agree on one origin, and
 * disagreement is not loud: a sitemap listing one host while canonical tags
 * name another is the sort of thing that quietly costs search ranking without
 * ever showing up as an error.
 *
 * Written down rather than configured, because configuration is what broke
 * it. The pages that need this are statically prerendered, so the value is
 * decided at build time, while a platform's own domain variable is injected
 * at runtime — never set when it was read. Every build silently baked in
 * localhost and every share of the site rendered with no preview image.
 *
 * NEXT_PUBLIC_SITE_URL still overrides, for a preview deploy or a fork, and
 * it must be set at build time to have any effect.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://aroma.money"
).replace(/\/$/, "");

/** How the project refers to itself where a name is needed. */
export const SITE_NAME = "Aroma";

export const SITE_TAGLINE = "Launch and trade coins on Arc";

/**
 * The one-sentence description, used for the home page and as the fallback
 * anywhere a more specific one is not available.
 *
 * Written to answer the question someone would actually type or ask, rather
 * than to describe the product to someone who already knows what it is.
 */
export const SITE_DESCRIPTION =
  "Aroma is a bonding-curve launchpad on Arc, Circle's Layer 1 where USDC is the native gas token. Launch a fixed-supply coin in one transaction and trade it instantly — every price is already a dollar.";
