import { SITE_URL, SITE_NAME } from "@/lib/site";
import { NETWORK, POOL } from "@/lib/arc";

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

const n = (v: number) => v.toLocaleString("en-US");
const d = (v: number) =>
  `$${v.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`;

export function GET() {
  const body = `# ${SITE_NAME}

> ${SITE_NAME} is a launchpad on Arc, Circle's Layer 1 blockchain, where USDC is the native gas token. Anyone can launch a fixed-supply coin in one transaction, and it trades in its own Uniswap v4 pool from the first block. Because gas and pricing are the same dollar-denominated stablecoin, every price and market cap is already in dollars.

## What it does

Launching mints ${n(POOL.totalSupply)} tokens with no mint function and no admin key over the coin, and deposits the whole supply as single-sided liquidity in a Uniswap v4 pool. Nobody has to provide USDC to start trading: buyers' USDC becomes the pool's liquidity as the price rises. The position is owned by a contract with no function that removes liquidity, so it cannot be withdrawn by anyone, including us.

The first ${n(POOL.saleSupply)} tokens span a 16x rise from a ${d(POOL.openingMarketCapUsd)} market cap to ${d(POOL.graduationMarketCapUsd)}, which is where a coin graduates. Graduation moves nothing: trading carries on in the same pool into a further ${n(POOL.reserveSupply)} tokens, up to about a ${d(POOL.topMarketCapUsd)} market cap.

Trades pay ${POOL.tradeFeeBps / 100}%, always in USDC, charged by a hook on the pool so it applies whichever app or router sends the trade. ${POOL.creatorFeeShareBps / 100}% of that goes to the coin's creator, the rest to the protocol.

There is no launch tax. A creator's own first buy, up to ${d(POOL.maxDevBuyUsd)}, runs inside the launch transaction so it cannot be front-run.

## Status

Live on ${NETWORK.name} mainnet (chain ${NETWORK.id}). The contracts are public and have not been independently audited.

## Pages

- [Board](${SITE_URL}/): every coin, live prices and trades
- [Docs](${SITE_URL}/docs): launching, pricing, fees, graduation, and how to trade or index a coin
- [Create](${SITE_URL}/create): launch a coin
- [Terms](${SITE_URL}/terms) and [Privacy](${SITE_URL}/privacy)

## For machines

Every coin is a standard Uniswap v4 pool: native USDC as currency0, the coin as currency1, and Aroma's PoolVault as the hook. Index it from PoolFactory's TokenCreated event, which carries the PoolId, and PoolManager's Swap events filtered by that id. AromaRouter's buy and sell are the simplest way to trade one. Both are documented at ${SITE_URL}/docs.

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
