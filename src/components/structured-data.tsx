import { SITE_URL, SITE_NAME, SITE_DESCRIPTION } from "@/lib/site";
import { CLUB } from "@/lib/arc";
import { NETWORK } from "@/lib/network";
import { AUCTION } from "@/lib/robinhood";

/**
 * Machine-readable description of what this site is.
 *
 * Search engines and the retrieval layers behind assistants both parse
 * schema.org, and both are answering a question the home page never states
 * outright: not "what does this page show" but "what is this thing, and is it
 * the right answer to what was asked". This says it is a launch auction, on
 * Robinhood Chain, that works a particular way — not a permissionless
 * launchpad, which is what it used to be and no longer is.
 *
 * The FAQ entries are the ones people actually ask before bidding, phrased
 * as questions rather than headings, because that is the shape a retrieval
 * system matches against. Numbers come from CLUB/AUCTION so the answers
 * cannot drift from the contracts the way hand-written copy would.
 *
 * Only claims that are true and checkable. Structured data that oversells is
 * how a domain earns a manual penalty, and an assistant that repeats an
 * inflated claim does more damage than one that never mentions us. That
 * includes the unflattering ones: there is no launch tax, and the contracts
 * are unaudited.
 */

export function StructuredData() {
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${SITE_URL}/#website`,
        url: SITE_URL,
        name: SITE_NAME,
        description: SITE_DESCRIPTION,
        inLanguage: "en",
        publisher: { "@id": `${SITE_URL}/#org` },
      },
      {
        "@type": "Organization",
        "@id": `${SITE_URL}/#org`,
        name: SITE_NAME,
        url: SITE_URL,
        logo: `${SITE_URL}/icon-512.png`,
        description: SITE_DESCRIPTION,
        sameAs: ["https://x.com/Aromadotmoney"],
      },
      {
        "@type": "WebApplication",
        "@id": `${SITE_URL}/#app`,
        name: SITE_NAME,
        url: SITE_URL,
        applicationCategory: "FinanceApplication",
        operatingSystem: "Web",
        description: SITE_DESCRIPTION,
        // Bidding costs whatever the auction demands; the protocol earns
        // the winning bid, not a fee for attempting to launch.
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        featureList: [
          "24-hour Club auction gating every launch",
          "Top bidder edits the coin's name, ticker, description and image live",
          "Fixed 1,000,000,000 supply, no mint function",
          "Settled in USDG on Robinhood Chain",
          "Locked single-sided Uniswap v4 liquidity from the first block",
          "Creator fee share on every trade after launch",
        ],
      },
      {
        "@type": "FAQPage",
        "@id": `${SITE_URL}/#faq`,
        mainEntity: [
          faq(
            `What is ${SITE_NAME}?`,
            `${SITE_NAME} runs invite-only coins on Robinhood Chain. Every coin is a club: only members can buy, members get in by invitation, and every trade's fee is paid to the people who invited the trader. A new club launches each time someone wins the 24-hour Club auction.`,
          ),
          faq(
            "How do invites work?",
            `The auction's winner founds the club and holds ${CLUB.creatorSeats} invite seats. An invite is a signed link — free, no transaction — and a seat is used only when the person invited buys at least $${CLUB.minJoinUsd}. Every new member gets ${CLUB.memberSeats} seats of their own. Selling is never gated: anyone holding a club coin can always sell it.`,
          ),
          faq(
            "How does the Club auction work?",
            "Anyone can bid USDG for the current Club. The top bidder can rewrite the coin's name, ticker, description and image at any time while they hold the lead, visible to everyone watching. A bid inside the last few minutes extends the countdown, so the round can't be won by a bid nobody has time to answer. When time runs out, the leading bid's coin launches on its own — no separate transaction needed.",
          ),
          faq(
            "What happens to the winning bid?",
            "It goes to the protocol treasury, not into the coin. The winner can also set aside a separate, optional first buy — up to a fixed cap — which becomes their own opening position in the coin they just launched.",
          ),
          faq(
            "What happens if I'm outbid?",
            "Your USDG is never taken — it sits in the contract as a withdrawable refund the moment someone bids higher, and you claim it back whenever you like.",
          ),
          faq(
            "What is USDG, and why not the chain's own gas token?",
            "Robinhood Chain's native gas token is ETH, not a stablecoin, so Aroma settles every bid and every trade in USDG — Paxos's dollar-backed stablecoin — instead. A coin's price and market cap are USDG amounts, not a volatile gas-token quantity.",
          ),
          faq(
            "What does a launched coin look like?",
            `A fixed supply of 1,000,000,000 tokens with no mint function and no admin key, deposited as locked single-sided Uniswap v4 liquidity in the same transaction it launches. Trades pay ${CLUB.tradeFeeBps / 100}%: ${CLUB.protocolFeeBps / 100}% to the protocol, ${CLUB.rootFeeBps / 100}% to the creator, and ${CLUB.treeFeeBps / 100}% up the trader's invite chain, for up to ${CLUB.maxDepth} levels.`,
          ),
          faq(
            "Can the auction's winner rug the coin?",
            "They cannot pull liquidity, because there is none to pull: it is deposited once, at launch, into a contract with no withdraw function. A winner can still sell their own opening position, which is visible on the coin's page along with the fees they have earned.",
          ),
          faq(
            "Is there protection against snipers?",
            `There is no launch tax. The winner's optional first buy, up to ${AUCTION.maxFirstBuyUsdg.toLocaleString("en-US")} USDG, runs inside the same transaction that launches the coin, so it cannot be front-run — but anyone else buying in the first seconds after a launch is competing with bots.`,
          ),
          faq(
            `Which network does ${SITE_NAME} run on?`,
            `Robinhood Chain, an Arbitrum Orbit Layer 2, with liquidity on Uniswap v4. It is live on ${NETWORK.name}, running a ${AUCTION.roundDurationSeconds / 3600}-hour auction cycle. The contracts are public and have not been independently audited.`,
          ),
        ],
      },
    ],
  };

  return (
    <script
      type="application/ld+json"
      // Values are our own constants, never user input, so there is no
      // injection surface here — but the escape is kept anyway, because the
      // day someone interpolates a coin name into this it will already be
      // wrong to remove.
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(graph).replace(/</g, "\\u003c"),
      }}
    />
  );
}

function faq(question: string, answer: string) {
  return {
    "@type": "Question",
    name: question,
    acceptedAnswer: { "@type": "Answer", text: answer },
  };
}
