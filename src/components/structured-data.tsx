import { SITE_URL, SITE_NAME, SITE_DESCRIPTION } from "@/lib/site";
import { ARC_TESTNET, CURVE } from "@/lib/arc";

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
 * retrieval system matches against. Every number comes from CURVE, so the
 * answers cannot drift from the contract the way hand-written copy would.
 *
 * Only claims that are true and checkable. Structured data that oversells is
 * how a domain earns a manual penalty, and an assistant that repeats an
 * inflated claim does more damage than one that never mentions us.
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
        // Launching is free to attempt; the protocol earns from trade fees.
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        featureList: [
          "Bonding-curve token launches",
          "Fixed 1,000,000,000 supply, no mint function",
          "USDC-denominated pricing with USDC as native gas",
          "Automatic graduation to a locked Uniswap v4 pool",
          "Creator fee share on every trade",
          "Optional launch-window tax against snipers",
        ],
      },
      {
        "@type": "FAQPage",
        "@id": `${SITE_URL}/#faq`,
        mainEntity: [
          faq(
            `What is ${SITE_NAME}?`,
            `${SITE_NAME} is a bonding-curve launchpad on Arc, Circle's Layer 1 blockchain. Anyone can launch a fixed-supply coin in one transaction and trade it immediately against a bonding curve, with no liquidity to provide and no pool to seed.`,
          ),
          faq(
            "How does launching a coin on Arc work?",
            `A launch mints a fixed supply of ${CURVE.totalSupply.toLocaleString("en-US")} tokens with no mint function, and ${CURVE.curveSupply.toLocaleString("en-US")} of them are sold through a bonding curve. The price rises as people buy. Deployment is irreversible and there is no admin key over a coin once it exists.`,
          ),
          faq(
            "What does graduation mean?",
            `When a coin has raised $${CURVE.graduationTargetUsd.toLocaleString("en-US")} on the curve — a market cap of $${CURVE.graduationMarketCapUsd.toLocaleString("en-US")} — curve trading stops and the raise plus the remaining ${CURVE.lpReserveSupply.toLocaleString("en-US")} tokens seed a Uniswap v4 pool. That liquidity is locked permanently; the contract holding it has no function that can withdraw it.`,
          ),
          faq(
            `What are the fees on ${SITE_NAME}?`,
            `${CURVE.tradeFeeBps / 100}% on every buy and sell. ${CURVE.creatorFeeShareBps / 100}% of that fee goes to the coin's creator and the rest to the protocol. There is a $${CURVE.graduationFeeUsd} fee taken from the raise at graduation.`,
          ),
          faq(
            "Why are prices in dollars rather than a volatile token?",
            "Arc uses USDC as its native gas token, so the asset you pay with and the asset you price in are the same dollar-denominated stablecoin. A coin's price and market cap are already dollars, with no conversion and no second asset moving underneath them.",
          ),
          faq(
            "Can a creator rug a coin?",
            "They cannot pull liquidity, because there is none to pull: the USDC sits in the curve contract while a coin is on the curve, and moves into a permanently locked pool at graduation. A creator can still sell their own holdings, which is visible on the coin's page along with the fees they have earned.",
          ),
          faq(
            "What is the launch tax?",
            `An optional tax a creator can switch on for the first seconds of a coin's life, to make sniping the launch unprofitable. It starts at up to ${CURVE.snipeStartBps / 100}% and decays to zero across at most ${CURVE.snipeWindowSeconds} seconds. The contract rejects anything longer or higher, and creators can exempt named wallets.`,
          ),
          faq(
            `Which network does ${SITE_NAME} run on?`,
            `Arc. It is live on ${ARC_TESTNET.name} today, with contracts verified on the public explorer.`,
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
