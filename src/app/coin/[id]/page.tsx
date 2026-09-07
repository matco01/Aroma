import type { Metadata } from "next";
import { CoinView } from "@/components/coin-view";
import { fetchTokenDetail } from "@/lib/server/board";
import { hasSubgraph } from "@/lib/server/subgraph";
import { SITE_NAME } from "@/lib/site";
import { CURVE } from "@/lib/arc";

/**
 * Token pages are dynamic now that they render real chain state — prices
 * move every block, so there is nothing meaningful to prerender. The `id`
 * segment is the token's contract address.
 */
export default async function CoinPage({ params }: PageProps<"/coin/[id]">) {
  const { id } = await params;
  return <CoinView address={id} />;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Every coin gets its own title, description and preview image.
 *
 * Until now they all inherited the home page's, so a thousand coins shared one
 * title and one picture. That wastes the only search traffic a launchpad can
 * realistically win — nobody searches for a launchpad, they search for a
 * ticker — and it makes every shared link look identical in a group chat,
 * which is where these are actually passed around.
 *
 * The description leads with what the coin is rather than what Aroma is,
 * because it is answering someone who has already typed the ticker.
 */
export async function generateMetadata({
  params,
}: PageProps<"/coin/[id]">): Promise<Metadata> {
  const { id } = await params;

  const fallback: Metadata = {
    title: "Coin",
    description: `A coin on ${SITE_NAME}, the bonding-curve launchpad on Arc.`,
  };

  if (!ADDRESS.test(id) || !hasSubgraph) return fallback;

  try {
    // Shares the subgraph cache with the page's own fetch, so rendering a coin
    // page still costs one query rather than two.
    const { coin } = await fetchTokenDetail(id);
    if (!coin) return fallback;

    const title = `${coin.name} (${coin.ticker})`;
    const pct = Math.min(100, (coin.raisedUsd / CURVE.graduationTargetUsd) * 100);
    const graduated = coin.graduated
      ? "Graduated to a locked Uniswap v4 pool."
      : `${pct.toFixed(1)}% of the way to graduation.`;

    // The creator's own words first when there are any — they describe the
    // coin better than generated text, and a stranger searching the ticker
    // wants to know what it claims to be.
    const said = coin.description.trim().slice(0, 140);
    const description = said
      ? `${said} — ${title} on ${SITE_NAME}, priced in USDC on Arc. ${graduated}`
      : `${title} on ${SITE_NAME}, the bonding-curve launchpad on Arc. Priced in USDC, tradeable instantly. ${graduated}`;

    return {
      title,
      description,
      alternates: { canonical: `/coin/${coin.contract}` },
      openGraph: {
        type: "website",
        title: `${title} · ${SITE_NAME}`,
        description,
        // The creator's image where there is one; otherwise the site card,
        // since a broken image unfurls worse than a generic one.
        images: coin.imageUrl
          ? [{ url: coin.imageUrl, alt: title }]
          : [{ url: "/og.png", width: 1200, height: 630, alt: SITE_NAME }],
      },
      twitter: {
        card: "summary_large_image",
        title: `${title} · ${SITE_NAME}`,
        description,
        images: coin.imageUrl ? [coin.imageUrl] : ["/og.png"],
      },
    };
  } catch {
    return fallback;
  }
}
