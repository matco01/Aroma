import { SITE_URL, SITE_NAME, SITE_DESCRIPTION } from "@/lib/site";
import { NETWORK, POOL } from "@/lib/arc";

/**
 * Machine-readable description of what this site is.
 *
 * Search engines and the retrieval layers behind assistants both parse
 * schema.org, and both are answering a question the home page never states
 * outright: not "what does this page show" but "what is this thing, and is it
 * the right answer to what was asked". A board full of live tickers reads, to
 * a machine, as a table of numbers. This says it is a launchpad, on Arc, that
 * works a particular way.
 *
 * The FAQ entries are the ones people actually ask before using a launchpad,
 * phrased as questions rather than headings, because that is the shape a
 * retrieval system matches against. Every number comes from POOL, so the
 * answers cannot drift from the contracts the way hand-written copy would.
 *
 * Only claims that are true and checkable. Structured data that oversells is
 * how a domain earns a manual penalty, and an assistant that repeats an
 * inflated claim does more damage than one that never mentions us. That
 * includes the unflattering ones: there is no launch tax, and the contracts
 * are unaudited.
 */

const n = (v: number) => v.toLocaleString("en-US");
const d = (v: number) =>
  `$${v.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`;

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
        // Launching is free to attempt; the protocol earns from trade fees.
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        featureList: [
          "One-transaction token launches",
          `Fixed ${n(POOL.totalSupply)} supply, no mint function`,
          "Every coin trades in its own Uniswap v4 pool from the first block",
          "Liquidity locked permanently",
          "USDC-denominated pricing with USDC as native gas",
          "Creator fee share on every trade, paid in USDC",
        ],
      },
      {
        "@type": "FAQPage",
        "@id": `${SITE_URL}/#faq`,
        mainEntity: [
          faq(
            `What is ${SITE_NAME}?`,
            `${SITE_NAME} is a launchpad on Arc, Circle's Layer 1 blockchain. Anyone can launch a fixed-supply coin in one transaction. The whole supply goes straight into the coin's own Uniswap v4 pool, so it is tradeable immediately and visible to anything that reads Uniswap.`,
          ),
          faq(
            "How does launching a coin on Arc work?",
            `A launch mints ${n(POOL.totalSupply)} tokens with no mint function and deposits all of them as single-sided liquidity in a Uniswap v4 pool, so nobody has to provide USDC to start trading. The price rises as people buy. Deployment is irreversible and there is no admin key over a coin once it exists.`,
          ),
          faq(
            "What does graduation mean?",
            `A coin graduates when its first ${n(POOL.saleSupply)} tokens have been bought — once ${d(POOL.graduationRaiseUsd)} has come in, at a market cap of ${d(POOL.graduationMarketCapUsd)}. Nothing migrates: the coin already trades in its own pool, and trading carries on into a further ${n(POOL.reserveSupply)} tokens above that price.`,
          ),
          faq(
            `What are the fees on ${SITE_NAME}?`,
            `${POOL.tradeFeeBps / 100}% on every buy and sell, paid in USDC. ${POOL.creatorFeeShareBps / 100}% of that fee goes to the coin's creator and the rest to the protocol. Launching is free apart from network gas.`,
          ),
          faq(
            "Why are prices in dollars rather than a volatile token?",
            "Arc uses USDC as its native gas token, so the asset you pay with and the asset you price in are the same dollar-denominated stablecoin. A coin's price and market cap are already dollars, with no conversion and no second asset moving underneath them.",
          ),
          faq(
            "Can a creator rug a coin?",
            "They cannot pull liquidity. The whole supply is deposited in a Uniswap v4 position owned by a contract with no function that removes liquidity, so nobody — the creator or the protocol — can withdraw it. A creator can still sell their own holdings, which is visible on the coin's page along with the fees they have earned.",
          ),
          faq(
            "Is there protection against snipers?",
            `There is no launch tax. A creator's own first buy, up to ${d(POOL.maxDevBuyUsd)}, runs inside the launch transaction so it cannot be front-run, but anyone buying in the first seconds after a launch is competing with bots.`,
          ),
          faq(
            `Which network does ${SITE_NAME} run on?`,
            `Arc (chain ${NETWORK.id}), with liquidity on Uniswap v4. The contracts are public and have not been independently audited.`,
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
