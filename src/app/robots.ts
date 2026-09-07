import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * robots.txt.
 *
 * Everything public is open to everyone, AI crawlers included. That is a
 * choice, and the opposite of the one most sites are drifting toward: being
 * quotable by an assistant answering "what launchpads are on Arc" is worth
 * more to us than withholding a page that is already public. There is nothing
 * here to protect — the coins, the curve and the fees are all on chain.
 *
 * The API is excluded because it is not content. A crawler walking
 * /api/dex/events across block ranges would burn its crawl budget on JSON it
 * cannot index and hit our own rate limits doing it. Machines that want that
 * data should read the docs page describing it, which is indexable.
 *
 * Cloudflare serves its own generated robots.txt for this domain today, so
 * this may not be what is actually returned — worth checking after deploy
 * rather than assuming, since a robots.txt you cannot see is a robots.txt you
 * do not control.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
