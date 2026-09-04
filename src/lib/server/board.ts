import "server-only";
import { query, type SubgraphMeta } from "./subgraph";
import type { Coin } from "../mock";
import type { Trade } from "../mock";

/**
 * Board queries, expressed so the *index* does the filtering, sorting and
 * paging rather than the browser.
 *
 * The board used to fetch every token and sort in a useMemo. That is fine
 * at six tokens and impossible at ten thousand — you cannot paginate a
 * client-side sort, and rendering everything kills the tab long before the
 * network gives out.
 */

export type BoardFilter = "all" | "climbing" | "graduated";
export type BoardSort = "buys" | "new" | "mcap" | "volume";

/**
 * "Recent buys" means most-recently-traded, which is an indexed field. The
 * old heat formula (volume divided by age) was a mock-data approximation
 * that no database can order by.
 */
const SORT_FIELDS: Record<BoardSort, string> = {
  buys: "lastTradeAt",
  new: "createdAt",
  mcap: "marketCap",
  volume: "volume",
};

const TOKEN_FIELDS = `
  id creator name symbol description createdAt
  reserve price marketCap progressBps graduated
  volume tradeCount buyerCount lastTradeAt
`;

const TRADE_FIELDS = `
  id token { id symbol } account isBuy usdc tokens priceAfter timestamp
`;

const BOARD_QUERY = `
  query Board($first: Int!, $skip: Int!, $orderBy: Token_orderBy!, $where: Token_filter!) {
    tokens(first: $first, skip: $skip, orderBy: $orderBy, orderDirection: desc, where: $where) {
      ${TOKEN_FIELDS}
    }
    protocols(first: 1) {
      tokenCount tradeCount graduatedCount totalVolume totalFees
    }
    _meta { block { number } hasIndexingErrors }
  }
`;

const TRADES_QUERY = `
  query Trades($first: Int!, $where: Trade_filter!) {
    trades(first: $first, orderBy: timestamp, orderDirection: desc, where: $where) {
      ${TRADE_FIELDS}
    }
  }
`;

const TOKEN_QUERY = `
  query TokenDetail($id: ID!, $tradeLimit: Int!) {
    token(id: $id) { ${TOKEN_FIELDS} }
    trades(first: $tradeLimit, orderBy: timestamp, orderDirection: asc, where: { token: $id }) {
      ${TRADE_FIELDS}
    }
    _meta { block { number } hasIndexingErrors }
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
  lastTradeAt: string;
};

type RawProtocol = {
  tokenCount: number;
  tradeCount: number;
  graduatedCount: number;
  totalVolume: string;
  totalFees: string;
};

type RawTrade = {
  id: string;
  token: { id: string; symbol: string };
  account: string;
  isBuy: boolean;
  usdc: string;
  tokens: string;
  priceAfter: string;
  timestamp: string;
};

/**
 * A trade as it goes over the wire.
 *
 * Deliberately not the RPC path's ChainTrade: that carries a bigint block
 * number, which JSON cannot serialize, and which nothing on the client
 * uses. Keeping the wire shape narrow avoids smuggling a placeholder 0n
 * through the boundary just to satisfy a type.
 */
export type TapeTrade = Trade & {
  tokenAddress: string;
  ticker: string;
  timestamp: number;
};

const WAD = 1e18;
export const toNum = (v: string) => Number(v) / WAD;

/** Stable art inputs derived from the address itself. */
function artFromAddress(address: string): { hue: number; seed: number } {
  let h = 0;
  for (let i = 2; i < address.length; i++) {
    h = (h * 31 + address.charCodeAt(i)) >>> 0;
  }
  return { hue: h % 360, seed: h };
}

function toTrade(t: RawTrade, now: number): TapeTrade {
  return {
    id: t.id,
    tokenAddress: t.token.id,
    ticker: t.token.symbol,
    side: t.isBuy ? ("buy" as const) : ("sell" as const),
    account: t.account,
    usd: toNum(t.usdc),
    tokens: toNum(t.tokens),
    timestamp: Number(t.timestamp),
    agoSeconds: Math.max(1, now - Number(t.timestamp)),
  };
}

export function toCoin(t: RawToken, now: number, history: number[] = []): Coin {
  const { hue, seed } = artFromAddress(t.id);
  const price = toNum(t.price);
  const points = history.length >= 2 ? history : [price, price];
  const first = points[0] || price;
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
    change24hPct: first > 0 ? ((price - first) / first) * 100 : 0,
    holders: t.buyerCount,
    replies: 0,
    raisedUsd: toNum(t.reserve),
    graduated: t.graduated,
    hue,
    seed,
    history: points,
  };
}

export type BoardStats = {
  tokenCount: number;
  tradeCount: number;
  graduatedCount: number;
  totalVolumeUsd: number;
  totalFeesUsd: number;
};

export type BoardPage = {
  tokens: Coin[];
  stats: BoardStats;
  meta: SubgraphMeta;
  hasMore: boolean;
};

export async function fetchBoardPage(opts: {
  filter: BoardFilter;
  sort: BoardSort;
  limit: number;
  skip: number;
}): Promise<BoardPage> {
  const where =
    opts.filter === "climbing"
      ? { graduated: false }
      : opts.filter === "graduated"
        ? { graduated: true }
        : {};

  // Ask for one extra row to learn whether another page exists, rather than
  // paying for a second count query.
  const first = opts.limit + 1;
  const key = `board:${opts.filter}:${opts.sort}:${opts.limit}:${opts.skip}`;

  const data = await query<{
    tokens: RawToken[];
    protocols: RawProtocol[];
    _meta: { block: { number: number }; hasIndexingErrors: boolean };
  }>(key, BOARD_QUERY, {
    first,
    skip: opts.skip,
    orderBy: SORT_FIELDS[opts.sort],
    where,
  });

  const now = Math.floor(Date.now() / 1000);
  const hasMore = data.tokens.length > opts.limit;
  const rows = hasMore ? data.tokens.slice(0, opts.limit) : data.tokens;
  const p = data.protocols.length > 0 ? data.protocols[0] : null;

  return {
    tokens: rows.map((t) => toCoin(t, now)),
    stats: {
      tokenCount: p ? p.tokenCount : 0,
      tradeCount: p ? p.tradeCount : 0,
      graduatedCount: p ? p.graduatedCount : 0,
      totalVolumeUsd: p ? toNum(p.totalVolume) : 0,
      totalFeesUsd: p ? toNum(p.totalFees) : 0,
    },
    meta: {
      indexedBlock: data._meta.block.number,
      hasIndexingErrors: data._meta.hasIndexingErrors,
    },
    hasMore,
  };
}

export async function fetchTapeTrades(limit: number): Promise<TapeTrade[]> {
  const data = await query<{ trades: RawTrade[] }>(`trades:all:${limit}`, TRADES_QUERY, {
    first: limit,
    where: {},
  });
  const now = Math.floor(Date.now() / 1000);
  return data.trades.map((t) => toTrade(t, now));
}

export async function fetchTokenDetail(address: string): Promise<{
  coin: Coin | null;
  trades: TapeTrade[];
  meta: SubgraphMeta;
}> {
  const id = address.toLowerCase();
  const data = await query<{
    token: RawToken | null;
    trades: RawTrade[];
    _meta: { block: { number: number }; hasIndexingErrors: boolean };
  }>(`token:${id}`, TOKEN_QUERY, { id, tradeLimit: 500 });

  const now = Math.floor(Date.now() / 1000);
  const meta = {
    indexedBlock: data._meta.block.number,
    hasIndexingErrors: data._meta.hasIndexingErrors,
  };
  if (!data.token) return { coin: null, trades: [], meta };

  // priceAfter is the spot price the index recorded at each trade, so the
  // chart is read rather than reconstructed from raw amounts.
  const history = data.trades.map((t) => toNum(t.priceAfter));
  history.push(toNum(data.token.price));

  // Ascending for the chart, descending for the trades table.
  const trades = data.trades.map((t) => toTrade(t, now)).reverse();

  return { coin: toCoin(data.token, now, history), trades, meta };
}

const PORTFOLIO_QUERY = `
  query Portfolio($account: String!) {
    balances(where: { account: $account, amount_gt: "0" }, first: 200) {
      amount costBasis realisedPnl
      token { ${TOKEN_FIELDS} }
    }
    _meta { block { number } hasIndexingErrors }
  }
`;

type RawBalance = {
  amount: string;
  costBasis: string;
  realisedPnl: string;
  token: RawToken;
};

export type Holding = {
  coin: Coin;
  tokens: number;
  valueUsd: number;
  costUsd: number;
  pnlUsd: number;
  pnlPct: number;
  realisedPnlUsd: number;
};

/**
 * A wallet's holdings, straight from the index.
 *
 * No balanceOf multicall: the subgraph already tracks per-account amount
 * and average cost basis as trades arrive. The old client-side version
 * called balanceOf on *every token that exists* to find the few a wallet
 * held — fine at six tokens, absurd at ten thousand.
 *
 * The tradeoff is that transfers outside aram aren't seen, since only the
 * curve's own events are indexed. Someone who received tokens by direct
 * transfer will not see them here.
 */
export async function fetchPortfolio(account: string): Promise<{
  holdings: Holding[];
  meta: SubgraphMeta;
}> {
  const id = account.toLowerCase();
  const data = await query<{
    balances: RawBalance[];
    _meta: { block: { number: number }; hasIndexingErrors: boolean };
  }>(`portfolio:${id}`, PORTFOLIO_QUERY, { account: id });

  const now = Math.floor(Date.now() / 1000);
  const holdings = data.balances.map((b) => {
    const coin = toCoin(b.token, now);
    const tokens = toNum(b.amount);
    const valueUsd = tokens * coin.priceUsd;
    const costUsd = toNum(b.costBasis);
    const pnlUsd = valueUsd - costUsd;
    return {
      coin,
      tokens,
      valueUsd,
      costUsd,
      pnlUsd,
      pnlPct: costUsd > 0 ? (pnlUsd / costUsd) * 100 : 0,
      realisedPnlUsd: toNum(b.realisedPnl),
    };
  });

  holdings.sort((a, b) => b.valueUsd - a.valueUsd);

  return {
    holdings,
    meta: {
      indexedBlock: data._meta.block.number,
      hasIndexingErrors: data._meta.hasIndexingErrors,
    },
  };
}
