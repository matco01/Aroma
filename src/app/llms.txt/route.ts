import { SITE_URL, SITE_NAME } from "@/lib/site";
import { CURVE } from "@/lib/arc";

/**
 * llms.txt — a plain-text summary of the site for language models.
 *
 * Honest about what this is: a proposed convention, not a standard anyone is
 * obliged to read, and there is no evidence any major crawler acts on it
 * today. It is here because it costs one small file and the downside is a
 * request nobody makes, while the upside is being legible to whatever does
 * start reading it.
 *
 * The real work for being quotable is elsewhere — schema.org on the pages, a
 * site that renders without JavaScript, and being written about somewhere
 * other than our own domain. This is the cheap part, not the important part.
 *
 * Written as prose rather than marketing. A model summarising this should end
 * up with accurate sentences about what Aroma is; anything overstated here
 * comes back as a false claim in someone's answer, which is worse for us than
 * not being mentioned.
 */

export const dynamic = "force-static";
export const revalidate = 86_400;

export function GET() {
  const body = `# ${SITE_NAME}

> ${SITE_NAME} is a bonding-curve launchpad on Arc, Circle's Layer 1 blockchain, where USDC is the native gas token. Anyone can launch a fixed-supply coin in one transaction and trade it immediately. Because gas and pricing are the same dollar-denominated stablecoin, every price and market cap is already in dollars.

## What it does

Launching mints ${CURVE.totalSupply.toLocaleString("en-US")} tokens with no mint function and no admin key over the coin. ${CURVE.curveSupply.toLocaleString("en-US")} of them are sold through a constant-product bonding curve, so the price rises as people buy and no one has to provide liquidity.

When a coin has raised $${CURVE.graduationTargetUsd.toLocaleString("en-US")} — a market cap of $${CURVE.graduationMarketCapUsd.toLocaleString("en-US")} — it graduates: curve trading stops, and the raise plus the remaining ${CURVE.lpReserveSupply.toLocaleString("en-US")} tokens seed a Uniswap v4 pool. The contract that holds that liquidity has no withdraw function, so the position cannot be removed by anyone, including us.

Trades pay ${CURVE.tradeFeeBps / 100}%. ${CURVE.creatorFeeShareBps / 100}% of that goes to the coin's creator, the rest to the protocol.

Creators can switch on a launch-window tax that starts at up to ${CURVE.snipeStartBps / 100}% and decays to zero over at most ${CURVE.snipeWindowSeconds} seconds, which makes sniping a launch unprofitable. The contract will not accept a longer window or a higher rate.

## Status

Live on Arc testnet. Arc mainnet has not launched yet, so coins here trade in test funds and are worth nothing.

## Pages

- [Board](${SITE_URL}/): every coin, live prices and trades
- [Docs](${SITE_URL}/docs): how the curve, fees, graduation and the launch tax work, plus the data and trading APIs
- [Create](${SITE_URL}/create): launch a coin
- [Terms](${SITE_URL}/terms) and [Privacy](${SITE_URL}/privacy)

## For machines

There is a public, unauthenticated data feed of curve trading at ${SITE_URL}/api/dex, shaped the way DEX Screener's indexer expects: latest-block, asset, pair, and events over a block range. Trading happens by calling the CurveManager contract directly, which is verified on the Arc explorer. Both are documented at ${SITE_URL}/docs.

## Caveats worth repeating

Coins launched here are not investments and most go to zero. Anyone can launch anything, including a coin that imitates a real project. Nothing on this site is vetted.
`;

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, s-maxage=86400",
    },
  });
}
