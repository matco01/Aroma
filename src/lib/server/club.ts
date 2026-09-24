import "server-only";
import { query } from "./subgraph";
import { resolveImages } from "./ipfs";
import { USDG_DECIMALS } from "../robinhood";

/**
 * Club queries — the same "index does the work" shape board.ts uses.
 *
 * One real gotcha: `Club.id` is a GraphQL `ID` (string), and The Graph
 * sorts `orderBy: id` lexicographically, not numerically — "10" would sort
 * before "2". Clubs open strictly in real-time order, so `openedAt`
 * (already a correctly-numeric `BigInt`) is what "current" orders by
 * instead; there is no need for a second ordering field just for this.
 */

const CLUB_FIELDS = `
  id openedAt endsAt finalized void topBidder topBid topDevBuy
  name symbol description metadataUri token
`;

/**
 * The live round and its bids, newest first, in one request. 100 is far
 * more bids than a 24-hour round of 5%-minimum raises realistically sees —
 * every bid has to beat the last by 5%, so 100 of them is a ~130x climb.
 */
const CURRENT_CLUB_QUERY = `
  query CurrentClub {
    clubs(first: 1, orderBy: openedAt, orderDirection: desc) {
      ${CLUB_FIELDS}
      bids(first: 100, orderBy: timestamp, orderDirection: desc) {
        id bidder bidAmount devBuyUsdc endsAt timestamp
      }
    }
  }
`;

type RawBid = {
  id: string;
  bidder: string;
  bidAmount: string;
  devBuyUsdc: string;
  endsAt: string;
  timestamp: string;
};

export type ClubBid = {
  id: string;
  bidder: string;
  bidUsdg: number;
  firstBuyUsdg: number;
  /** The deadline after this bid — later than the one before it if it extended the clock. */
  endsAt: number;
  timestamp: number;
};

type RawClub = {
  id: string;
  openedAt: string;
  endsAt: string;
  finalized: boolean;
  void: boolean;
  topBidder: string | null;
  topBid: string;
  topDevBuy: string;
  name: string;
  symbol: string;
  description: string;
  metadataUri: string;
  token: string | null;
};

export type Club = {
  id: string;
  openedAt: number;
  endsAt: number;
  finalized: boolean;
  void: boolean;
  topBidder: string | null;
  topBidUsdg: number;
  topDevBuyUsdg: number;
  name: string;
  symbol: string;
  description: string;
  /** Renderable (gateway) image URL, for display. */
  imageUrl: string;
  /**
   * The same image as an `ipfs://` URI, and the draft's metadata URI — what
   * a bid or draft edit has to send back to keep the image and links, since
   * /api/metadata only accepts `ipfs://` images and a bid overwrites the
   * on-chain metadataUri wholesale.
   */
  imageUri: string;
  metadataUri: string;
  links: { website: string; x: string; telegram: string };
  token: string | null;
};

const toUsdg = (v: string) => Number(v) / 10 ** USDG_DECIMALS;

/** Recovers `ipfs://CID/...` from a gateway URL of the form `https://host/ipfs/CID/...`. */
function ipfsUriFrom(gatewayUrl: string): string {
  const i = gatewayUrl.indexOf("/ipfs/");
  return i < 0 ? "" : `ipfs://${gatewayUrl.slice(i + "/ipfs/".length)}`;
}

async function toClub(t: RawClub): Promise<Club> {
  const images = await resolveImages([t.metadataUri]);
  const meta = images.get(t.metadataUri);
  const image = meta?.image ?? "";
  return {
    id: t.id,
    openedAt: Number(t.openedAt),
    endsAt: Number(t.endsAt),
    finalized: t.finalized,
    void: t.void,
    topBidder: t.topBidder,
    topBidUsdg: toUsdg(t.topBid),
    topDevBuyUsdg: toUsdg(t.topDevBuy),
    name: t.name,
    symbol: t.symbol,
    description: t.description,
    imageUrl: image,
    imageUri: ipfsUriFrom(image),
    metadataUri: t.metadataUri,
    links: meta?.links ?? { website: "", x: "", telegram: "" },
    token: t.token,
  };
}

/**
 * The live Club, or null if none has ever opened (a fresh deploy before its
 * constructor's first ClubOpened has been indexed).
 *
 * Short TTL: unlike the board, a live auction's top bid is the number
 * someone is about to be outbid on, and 5s of staleness is the difference
 * between seeing you're still winning and finding out a second late.
 */
export async function fetchCurrentClub(): Promise<{ club: Club; bids: ClubBid[] } | null> {
  const data = await query<{ clubs: (RawClub & { bids: RawBid[] })[] }>(
    "club:current",
    CURRENT_CLUB_QUERY,
    {},
    5_000,
  );
  if (data.clubs.length === 0) return null;
  const raw = data.clubs[0];
  return {
    club: await toClub(raw),
    bids: raw.bids.map((b) => ({
      id: b.id,
      bidder: b.bidder,
      bidUsdg: toUsdg(b.bidAmount),
      firstBuyUsdg: toUsdg(b.devBuyUsdc),
      endsAt: Number(b.endsAt),
      timestamp: Number(b.timestamp),
    })),
  };
}
