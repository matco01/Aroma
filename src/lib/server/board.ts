import "server-only";
import { query, type SubgraphMeta } from "./subgraph";
import { resolveImages } from "./ipfs";
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
  volume tradeCount buyerCount lastTradeAt metadataUri
  creatorFeesEarned creatorFeesClaimed
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
  query TokenDetail($id: ID!, $tradeLimit: Int!, $interval: Int!, $candleLimit: Int!) {
    token(id: $id) { ${TOKEN_FIELDS} }
    trades(first: $tradeLimit, orderBy: timestamp, orderDirection: desc, where: { token: $id }) {
      ${TRADE_FIELDS}
    }
    candles(
      first: $candleLimit
      orderBy: bucketStart
      orderDirection: desc
      where: { token: $id, interval: $interval }
    ) {
      bucketStart open high low close volume
    }
    _meta { block { number } hasIndexingErrors }
  }
`;

type RawCandle = {
  bucketStart: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
};

/**
 * Candle interval matched to how much history there is.
 *
 * A token minutes old has nothing to show on daily candles; one a year old
 * has 100,000 five-minute buckets. Picking from age keeps the chart at a
 * roughly constant number of points whatever the token's age, which is
 * what makes this bounded rather than growing forever.
 */
function candleInterval(ageSeconds: number): number {
  if (ageSeconds < 6 * 3600) return 300; // 5m
  if (ageSeconds < 14 * 86400) return 3600; // 1h
  return 86400; // 1d
}

/** Enough points to draw a readable line, few enough to stay cheap. */
const CANDLE_POINTS = 120;

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
  metadataUri: string;
  creatorFeesEarned: string;
  creatorFeesClaimed: string;
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

export function toCoin(
  t: RawToken,
  now: number,
  history: number[] = [],
  imageUrl = "",
): Coin {
  const { hue, seed } = artFromAddress(t.id);
  const price = toNum(t.price);
  const points = history.length >= 2 ? history : [price, price];
  const first = points[0] || price;
  return {
    id: t.id,
    name: t.name || "Untitled",
    ticker: t.symbol || "???",
    description: t.description || "",
    imageUrl,
    creatorFeesEarnedUsd: toNum(t.creatorFeesEarned),
    creatorFeesClaimedUsd: toNum(t.creatorFeesClaimed),
    creator: t.creator,
    contract: t.id,
    createdAgoSeconds: Math.max(1, now - Number(t.createdAt)),
    priceUsd: price,
    marketCapUsd: toNum(t.marketCap),
    volume24hUsd: toNum(t.volume),
    change24hPct: first > 0 ? ((price - first) / first) * 100 : 0,
    holders: t.buyerCount,
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

  // Bounded by the page size, and every lookup after the first is a cache
  // hit, so this is one fetch per token that has ever been rendered.
  const images = await resolveImages(rows.map((t) => t.metadataUri));

  return {
    tokens: rows.map((t) => toCoin(t, now, [], images.get(t.metadataUri) ?? "")),
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

const SEARCH_QUERY = `
  query Search($q: String!, $first: Int!) {
    byName: tokens(where: { name_contains_nocase: $q }, first: $first, orderBy: volume, orderDirection: desc) {
      ${TOKEN_FIELDS}
    }
    bySymbol: tokens(where: { symbol_contains_nocase: $q }, first: $first, orderBy: volume, orderDirection: desc) {
      ${TOKEN_FIELDS}
    }
  }
`;

/**
 * Search by name or ticker, in the index.
 *
 * Two queries rather than one because The Graph has no OR across fields —
 * a single `where` ANDs its conditions, so matching "name OR symbol" means
 * asking twice and merging. Symbol matches rank first: someone typing
 * "PEG" almost always wants the ticker, not every description mentioning
 * a peg.
 *
 * This is substring matching, not real full-text search. It has no notion
 * of relevance beyond volume and won't tolerate a typo. Good enough while
 * the corpus is small; a proper search index is its own piece of work.
 */
export async function searchTokens(q: string, limit = 8): Promise<Coin[]> {
  const term = q.trim();
  if (term.length === 0) return [];

  const data = await query<{ byName: RawToken[]; bySymbol: RawToken[] }>(
    `search:${term.toLowerCase()}:${limit}`,
    SEARCH_QUERY,
    { q: term, first: limit },
  );

  const now = Math.floor(Date.now() / 1000);
  const seen = new Set<string>();
  const merged: Coin[] = [];
  for (const t of [...data.bySymbol, ...data.byName]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    merged.push(toCoin(t, now));
    if (merged.length >= limit) break;
  }
  return merged;
}

export async function fetchTapeTrades(limit: number): Promise<TapeTrade[]> {
  const data = await query<{ trades: RawTrade[] }>(`trades:all:${limit}`, TRADES_QUERY, {
    first: limit,
    where: {},
  });
  const now = Math.floor(Date.now() / 1000);
  return data.trades.map((t) => toTrade(t, now));
}

export type Candle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

export async function fetchTokenDetail(address: string): Promise<{
  coin: Coin | null;
  trades: TapeTrade[];
  candles: Candle[];
  interval: number;
  meta: SubgraphMeta;
}> {
  const id = address.toLowerCase();
  const now = Math.floor(Date.now() / 1000);

  // The interval depends on the token's age, which needs one cheap read
  // before the main query. Cached like everything else, so a hot token
  // pays for it once per TTL.
  const ageProbe = await query<{ token: { createdAt: string } | null }>(
    `age:${id}`,
    `query Age($id: ID!) { token(id: $id) { createdAt } }`,
    { id },
  );
  const age = ageProbe.token ? now - Number(ageProbe.token.createdAt) : 0;
  const interval = candleInterval(age);

  const data = await query<{
    token: RawToken | null;
    trades: RawTrade[];
    candles: RawCandle[];
    _meta: { block: { number: number }; hasIndexingErrors: boolean };
  }>(`token:${id}:${interval}`, TOKEN_QUERY, {
    id,
    // Most RECENT trades, not the oldest. Ascending here meant a token
    // with more than this many trades showed its ancient history and
    // nothing since — invisible at three trades, badly wrong at fifty
    // thousand.
    tradeLimit: 50,
    interval,
    candleLimit: CANDLE_POINTS,
  });

  const meta = {
    indexedBlock: data._meta.block.number,
    hasIndexingErrors: data._meta.hasIndexingErrors,
  };
  if (!data.token) return { coin: null, trades: [], candles: [], interval, meta };

  // Chart from candles, not from individual trades. This is the whole
  // reason candles are indexed: the series stays ~120 points whether the
  // token has ten trades or a million, instead of growing without bound.
  const candles = [...data.candles].reverse(); // oldest first, for plotting
  const history =
    candles.length > 0
      ? [toNum(candles[0].open), ...candles.map((c) => toNum(c.close))]
      : [toNum(data.token.price)];
  // Always end on the live price so the chart's last point matches the
  // number displayed beside it.
  history.push(toNum(data.token.price));

  const trades = data.trades.map((t) => toTrade(t, now));
  const images = await resolveImages([data.token.metadataUri]);

  // Oldest first for plotting. Short keys because this is the one payload
  // that can carry a hundred-plus rows.
  const candleRows: Candle[] = [...data.candles].reverse().map((c) => ({
    t: Number(c.bucketStart),
    o: toNum(c.open),
    h: toNum(c.high),
    l: toNum(c.low),
    c: toNum(c.close),
    v: toNum(c.volume),
  }));

  return {
    coin: toCoin(data.token, now, history, images.get(data.token.metadataUri) ?? ""),
    trades,
    candles: candleRows,
    interval,
    meta,
  };
}

const PORTFOLIO_QUERY = `
  query Portfolio($account: String!) {
    created: tokens(where: { creator: $account }, first: 100, orderBy: createdAt, orderDirection: desc) {
      ${TOKEN_FIELDS}
    }
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

/** A coin this wallet launched. Fee balances are read on-chain, not here. */
export type CreatedCoin = { coin: Coin };

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
 * The tradeoff is that transfers outside Aroma aren't seen, since only the
 * curve's own events are indexed. Someone who received tokens by direct
 * transfer will not see them here.
 */
export async function fetchPortfolio(account: string): Promise<{
  holdings: Holding[];
  created: Coin[];
  meta: SubgraphMeta;
}> {
  const id = account.toLowerCase();
  const data = await query<{
    balances: RawBalance[];
    created: RawToken[];
    _meta: { block: { number: number }; hasIndexingErrors: boolean };
  }>(`portfolio:${id}`, PORTFOLIO_QUERY, { account: id });

  const now = Math.floor(Date.now() / 1000);
  const images = await resolveImages([
    ...data.balances.map((b) => b.token.metadataUri),
    ...data.created.map((t) => t.metadataUri),
  ]);
  const holdings = data.balances.map((b) => {
    const coin = toCoin(b.token, now, [], images.get(b.token.metadataUri) ?? "");
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

  const created = data.created.map((t) =>
    toCoin(t, now, [], images.get(t.metadataUri) ?? ""),
  );

  return {
    holdings,
    created,
    meta: {
      indexedBlock: data._meta.block.number,
      hasIndexingErrors: data._meta.hasIndexingErrors,
    },
  };
}
