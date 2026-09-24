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
 * (already a correctly-numeric `BigInt`) is what "current" and "past" order
 * by instead; there is no need for a second ordering field just for this.
 */

const CLUB_FIELDS = `
  id openedAt endsAt finalized void topBidder topBid topDevBuy
  name symbol description metadataUri token
`;

const CURRENT_CLUB_QUERY = `
  query CurrentClub {
    clubs(first: 1, orderBy: openedAt, orderDirection: desc) {
      ${CLUB_FIELDS}
    }
  }
`;

/**
 * `where: { finalized: true }` is sufficient on its own to exclude the
 * current club — exactly one Club is ever unfinalized at a time (the one
 * open right now), since finalize() opens the next round in the same
 * transaction it sets `finalized = true` on this one. No `skip` needed.
 */
const PAST_CLUBS_QUERY = `
  query PastClubs($first: Int!) {
    clubs(
      first: $first
      orderBy: openedAt
      orderDirection: desc
      where: { finalized: true }
    ) {
      ${CLUB_FIELDS}
    }
  }
`;

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
  imageUrl: string;
  token: string | null;
};

const toUsdg = (v: string) => Number(v) / 10 ** USDG_DECIMALS;

async function toClub(t: RawClub): Promise<Club> {
  const images = await resolveImages([t.metadataUri]);
  const image = images.get(t.metadataUri)?.image ?? "";
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
export async function fetchCurrentClub(): Promise<Club | null> {
  const data = await query<{ clubs: RawClub[] }>(
    "club:current",
    CURRENT_CLUB_QUERY,
    {},
    5_000,
  );
  if (data.clubs.length === 0) return null;
  return toClub(data.clubs[0]);
}

/** Finalized rounds before the current one — void or launched alike. */
export async function fetchPastClubs(limit = 10): Promise<Club[]> {
  const data = await query<{ clubs: RawClub[] }>(
    `club:past:${limit}`,
    PAST_CLUBS_QUERY,
    { first: limit },
    30_000,
  );
  return Promise.all(data.clubs.map(toClub));
}
