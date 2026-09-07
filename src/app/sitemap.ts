import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";
import { fetchBoardPage } from "@/lib/server/board";
import { hasSubgraph } from "@/lib/server/subgraph";

/**
 * The sitemap, including live coins rather than only the fixed pages.
 *
 * Coin pages are where the searchable long tail actually is — someone looking
 * for a specific ticker is the traffic worth having, and a crawler has no way
 * to discover those addresses on its own: the board renders them through a
 * client-side data fetch, so following links from the home page finds nothing.
 * Listing them here is the only path in.
 *
 * Capped rather than exhaustive. A launchpad accumulates coins without limit,
 * most of which never traded, and a sitemap full of dead pages teaches a
 * crawler the site is mostly filler. Ranking by volume keeps the ones a person
 * might plausibly search for.
 */

/**
 * Generated per request rather than cached by the framework.
 *
 * It was `revalidate = 3600`, which silently produced a sitemap with no coins
 * in it: the subgraph client fetches with `cache: "no-store"`, which a route
 * Next is trying to cache treats as an error, and the catch below turned that
 * into the fixed-pages fallback. The page looked fine and the coins were
 * simply missing — the failure mode this whole file exists to avoid.
 *
 * Cost is one indexed query per request, which the subgraph client's own
 * cache already collapses, and crawlers ask for this rarely.
 */
export const dynamic = "force-dynamic";

const COIN_LIMIT = 200;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const fixed: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: "hourly", priority: 1 },
    { url: `${SITE_URL}/docs`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${SITE_URL}/create`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE_URL}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
    { url: `${SITE_URL}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
  ];

  // /portfolio is deliberately absent: it renders one wallet's holdings and is
  // meaningless to a crawler that has no wallet connected.

  if (!hasSubgraph) return fixed;

  try {
    const page = await fetchBoardPage({
      filter: "all",
      sort: "volume",
      limit: COIN_LIMIT,
      skip: 0,
    });

    return [
      ...fixed,
      ...page.tokens.map((c) => ({
        url: `${SITE_URL}/coin/${c.contract}`,
        lastModified: now,
        changeFrequency: "daily" as const,
        priority: 0.6,
      })),
    ];
  } catch (e) {
    // A sitemap missing its coins still beats a 500, which teaches a crawler
    // to come back less often — but it is logged, because a silently
    // coin-less sitemap is indistinguishable from a working one from outside
    // and that is exactly how the last version of this stayed broken.
    console.error("[sitemap] falling back to fixed pages:", e);
    return fixed;
  }
}
