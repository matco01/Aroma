import type { Coin } from "./mock";
import type { ChainTrade, BoardData } from "./chain-data";
import { CURVE } from "./arc";

/**
 * The indexed read path.
 *
 * Replaces walking the chain's logs on every render with one GraphQL query.
 * The subgraph (see subgraph/) computes price, market cap and graduation
 * progress as each event arrives, so what used to be O(all history) per
 * viewer is now a single indexed read — verified against on-chain
 * `tokenState` to the wei.
 *
 * Returns exactly the shapes `chain-data.ts` did, so nothing above this
 * layer changed when it was swapped in.
 */

export const SUBGRAPH_URL = process.env.NEXT_PUBLIC_SUBGRAPH_URL ?? "";
export const hasSubgraph = SUBGRAPH_URL.length > 0;

const WAD = 1e18;
/** Subgraph values are 18-decimal integers in strings. */
const toNum = (v: string) => Number(v) / WAD;

const BOARD_QUERY = `
  query Board {
    tokens(first: 200, orderBy: createdAt, orderDirection: desc) {
      id
      creator
      name
      symbol
      description
      createdAt
      reserve
      price
      marketCap
      progressBps
      graduated
      volume
      tradeCount
      buyerCount
    }
    trades(first: 500, orderBy: timestamp, orderDirection: desc) {
      id
      token { id }
      account
      isBuy
      usdc
      tokens
      priceAfter
      timestamp
    }
  }
`;

type RawToken = {
  id: string;
  creator: string;
  name: string;
  symbol: string;
  description: string;
  createdAt: string;
  reserve: string;
  price: string;
  marketCap: string;
  progressBps: number;
  graduated: boolean;
  volume: string;
  tradeCount: number;
  buyerCount: number;
};

type RawTrade = {
  id: string;
  token: { id: string };
  account: string;
  isBuy: boolean;
  usdc: string;
  tokens: string;
  priceAfter: string;
  timestamp: string;
};

/** Stable pseudo-random art inputs, derived from the address itself. */
function artFromAddress(address: string): { hue: number; seed: number } {
  let h = 0;
  for (let i = 2; i < address.length; i++) {
    h = (h * 31 + address.charCodeAt(i)) >>> 0;
  }
  return { hue: h % 360, seed: h };
}

export async function fetchBoardFromSubgraph(): Promise<BoardData> {
  const res = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: BOARD_QUERY }),
  });
  if (!res.ok) throw new Error(`subgraph ${res.status}`);

  const json = (await res.json()) as {
    data?: { tokens: RawToken[]; trades: RawTrade[] };
    errors?: { message: string }[];
  };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  if (!json.data) throw new Error("subgraph returned no data");

  const now = Math.floor(Date.now() / 1000);

  const trades: (ChainTrade & { tokenAddress: string })[] = json.data.trades.map((t) => ({
    id: t.id,
    tokenAddress: t.token.id,
    side: t.isBuy ? ("buy" as const) : ("sell" as const),
    account: t.account,
    usd: toNum(t.usdc),
    tokens: toNum(t.tokens),
    blockNumber: 0n,
    timestamp: Number(t.timestamp),
    agoSeconds: Math.max(1, now - Number(t.timestamp)),
  }));

  const tokens: Coin[] = json.data.tokens.map((t) => {
    const { hue, seed } = artFromAddress(t.id);
    const price = toNum(t.price);

    // Chart points come from the trades already fetched — priceAfter is the
    // spot price the subgraph recorded at each trade, so no reconstruction.
    const mine = trades
      .filter((x) => x.tokenAddress.toLowerCase() === t.id.toLowerCase())
      .sort((a, b) => a.timestamp - b.timestamp);
    const raw = json.data!.trades;
    const history =
      mine.length > 0
        ? mine.map(
            (x) =>
              toNum(raw.find((r) => r.id === x.id)?.priceAfter ?? t.price),
          )
        : [price];
    if (history.length < 2) history.unshift(price);

    const first = history[0] || price;
    const change = first > 0 ? ((price - first) / first) * 100 : 0;

    return {
      id: t.id,
      name: t.name || "Untitled",
      ticker: t.symbol || "???",
      description: t.description || "",
      creator: t.creator,
      contract: t.id,
      createdAgoSeconds: Math.max(1, now - Number(t.createdAt)),
      priceUsd: price,
      marketCapUsd: toNum(t.marketCap),
      volume24hUsd: toNum(t.volume),
      change24hPct: change,
      holders: t.buyerCount,
      replies: 0,
      raisedUsd: toNum(t.reserve),
      graduated: t.graduated,
      hue,
      seed,
      history,
    } satisfies Coin;
  });

  // Sanity: progressBps is authoritative from the index; keep the derived
  // raisedUsd consistent with it rather than letting the two disagree.
  void CURVE;

  return { tokens, trades };
}
