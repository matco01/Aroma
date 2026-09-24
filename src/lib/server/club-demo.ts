import "server-only";
import type { Club, ClubBid } from "./club";

/**
 * Sample Club data for local development, served by /api/club when
 * CLUB_DEMO=1 and the build is not production.
 *
 * Exists so the /club page can be seen and clicked through before any
 * ClubAuction is deployed or any subgraph indexes one. Nothing here is real:
 * bidding against it will still fail, because there is no contract behind it.
 *
 * The round ends at the next UTC midnight rather than "now + N hours", so
 * the countdown stays put across the page's 7-second polls instead of
 * resetting on each one. Bids are placed at fixed points in the round for
 * the same reason, and each clears the one before by the contract's 5%.
 */
export const clubDemoEnabled =
  process.env.CLUB_DEMO === "1" && process.env.NODE_ENV !== "production";

const DAY = 24 * 60 * 60;
const TOP_BIDDER = "0x776d63784aF98DA3CE9cFf020D2ea6bf67a12EcB";

export function demoClub(): { current: Club; bids: ClubBid[] } {
  const now = Math.floor(Date.now() / 1000);
  const endsAt = (Math.floor(now / DAY) + 1) * DAY;
  const openedAt = endsAt - DAY;
  // Spread across whatever part of the round has already happened, so every
  // bid is in the past no matter what time of day the demo is opened.
  const elapsed = Math.max(60, now - openedAt);
  const at = (fraction: number) => openedAt + Math.floor(elapsed * fraction);

  // Oldest first here; reversed below to match the API's newest-first order.
  const history: [string, number, number, number][] = [
    ["0xA11CE0000000000000000000000000000000A11C", 120, 0, 0.08],
    ["0xB0B0000000000000000000000000000000000B0B", 150, 0, 0.21],
    [TOP_BIDDER, 200, 50, 0.37],
    ["0xB0B0000000000000000000000000000000000B0B", 300, 0, 0.55],
    ["0xCA7000000000000000000000000000000000CA7", 320, 100, 0.74],
    [TOP_BIDDER, 350, 150, 0.9],
  ];

  const bids: ClubBid[] = history
    .map(([bidder, bidUsdg, firstBuyUsdg, f], i) => ({
      id: `demo-${i}`,
      bidder,
      bidUsdg,
      firstBuyUsdg,
      endsAt,
      timestamp: at(f),
    }))
    .reverse();

  return {
    current: {
      id: "7",
      openedAt,
      endsAt,
      finalized: false,
      void: false,
      topBidder: TOP_BIDDER,
      topBidUsdg: 350,
      topDevBuyUsdg: 150,
      name: "Hood Cat",
      symbol: "HCAT",
      description: "The cat that won the Club. Launching the moment the clock runs out.",
      imageUrl: "",
      imageUri: "",
      metadataUri: "",
      links: { website: "https://hoodcat.example", x: "@hoodcat", telegram: "" },
      token: null,
    },
    bids,
  };
}
