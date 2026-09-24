import { SITE_URL, SITE_NAME } from "@/lib/site";
import { CLUB } from "@/lib/arc";
import { NETWORK } from "@/lib/network";
import { AUCTION } from "@/lib/robinhood";

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

> ${SITE_NAME} runs invite-only coins on Robinhood Chain, settled in USDG (a dollar-backed stablecoin) rather than the chain's own ETH gas token. Every coin is a club: only members can buy, members get in by invitation, and every trade's fee is paid to the people who invited the trader. A new club launches each time someone wins the 24-hour Club auction.

## What it does

Anyone can bid USDG for the current Club. The top bidder can rewrite the coin's name, ticker, description and image at any time while they hold the lead. A bid inside the closing minutes extends the countdown, so the round can't be won by a bid nobody has time to answer.

When the countdown reaches zero, the leading bid's coin launches on its own: a fixed supply of 1,000,000,000 tokens with no mint function, deposited as locked single-sided Uniswap v4 liquidity in the same transaction. The position is owned by a contract with no function that removes liquidity, so nobody can withdraw it, including us. The winning bid goes to the protocol treasury, not the coin; the winner can also set aside a separate, optional first buy of up to ${AUCTION.maxFirstBuyUsdg.toLocaleString("en-US")} USDG, which runs inside the launch transaction so it cannot be front-run.

The winner is the club's creator and holds its first ${CLUB.creatorSeats} invite seats. An invite is a signed link, free to make; a seat is used only when the person invited actually buys (at least $${CLUB.minJoinUsd}), and each new member gets ${CLUB.memberSeats} seats of their own. Selling is never gated — anyone holding the coin can always sell.

Trades pay ${CLUB.tradeFeeBps / 100}%, always in USDG, charged by a hook on the pool so it applies whichever app or router sends the trade: ${CLUB.protocolFeeBps / 100}% to the protocol, ${CLUB.rootFeeBps / 100}% to the creator, and ${CLUB.treeFeeBps / 100}% up the trader's invite chain — two thirds to whoever invited them, two thirds of the remainder to the next person up, for up to ${CLUB.maxDepth} levels. Earnings collect in the vault and are withdrawn in one transaction. There is no launch tax.

Outbid? Nothing is taken: the USDG sits in the contract as a withdrawable refund from the moment someone bids higher.

## Status

Live on ${NETWORK.name}.${NETWORK.testnet ? " Coins here trade in test funds and are worth nothing." : ""} The contracts are public and have not been independently audited.

## Pages

- [Board](${SITE_URL}/): every launched coin, live prices and trades
- [The Club](${SITE_URL}/club): the current auction — bid, edit the draft, or watch the countdown
- [Docs](${SITE_URL}/docs): how the auction, fees and the pool mechanics work, and how to trade or index a coin
- [Terms](${SITE_URL}/terms) and [Privacy](${SITE_URL}/privacy)

## For machines

Every coin is a standard Uniswap v4 pool: USDG as currency0, the coin as currency1, and Aroma's PoolVaultUsdg as the hook. Index it from PoolFactoryUsdg's TokenCreated event, which carries the PoolId, and PoolManager's Swap events filtered by that id; ClubAuction's ClubLaunched event ties a coin to the round that launched it. AromaRouterUsdg's buy and sell are the simplest way to trade one. Documented at ${SITE_URL}/docs.

## Caveats worth repeating

Coins launched here are not investments and most go to zero. Anyone can win the auction and launch anything, including a coin that imitates a real project. Nothing on this site is vetted.
`;

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, s-maxage=86400",
    },
  });
}
