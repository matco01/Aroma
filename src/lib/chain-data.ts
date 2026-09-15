import "server-only";
import { createPublicClient, getAbiItem, type Address, type Hex } from "viem";
import { aromaRouterAbi, poolFactoryAbi, poolManagerAbi } from "./abis";
import { POOL, POOL_CONTRACTS } from "./arc";
import { activeChain } from "./chain";
import { arcTransport } from "./transport";
import { resolveImages } from "./server/ipfs";
import type { Coin } from "./mock";
import type { SeriesPoint, TapeTrade } from "./server/board";

/**
 * The board, read straight from the chain, for when there is no indexer.
 *
 * The real read path is the subgraph (src/lib/server/board.ts). This exists
 * for two situations: a fresh clone exercising the app against a local fork,
 * and — the one that matters on launch day — an indexer that cannot serve Arc
 * mainnet yet. Goldsky's own pages disagree about whether it can, so rather
 * than finding out with the site down, the site degrades to this: slower,
 * heavier on the RPC, and correct.
 *
 * It follows the pool subgraph's mapping rule for rule, so a page reads the
 * same whichever path served it:
 *
 *   - trades come from PoolManager's Swap events for our pools. v4 is a
 *     singleton, so the query is filtered by PoolId rather than address;
 *   - a buy's Swap amounts are net of the hook's fee (it charges first), a
 *     sell's are gross (it charges after), and both are converted back to
 *     what the trader actually paid or received;
 *   - price is the pool's own post-swap sqrt price, not a reserve ratio;
 *   - graduation latches the first time a swap ends at or past the
 *     graduation tick, and never un-happens.
 *
 * One difference is an improvement: the subgraph has to credit trades to the
 * transaction sender, because Swap's `sender` is the router. Here the router's
 * own Bought/Sold events name the trader, so they are used where they exist.
 *
 * Everything is cached for a few seconds and fetched once however many
 * requests arrive together. The previous fallback rescanned the chain on
 * every request, which on a busy day is a way to be rate-limited off the RPC
 * the site's trades depend on.
 */

const client = createPublicClient({ chain: activeChain, transport: arcTransport() });

const TOKEN_CREATED = getAbiItem({ abi: poolFactoryAbi, name: "TokenCreated" });
const SWAP = getAbiItem({ abi: poolManagerAbi, name: "Swap" });
const BOUGHT = getAbiItem({ abi: aromaRouterAbi, name: "Bought" });
const SOLD = getAbiItem({ abi: aromaRouterAbi, name: "Sold" });

const WAD = 10n ** 18n;
const Q192 = 2n ** 192n;
const toNum = (v: bigint) => Number(v) / 1e18;

/** Public RPCs cap how many blocks one eth_getLogs may span. */
const LOG_CHUNK = 45_000n;
/** And how many topics one filter may OR together. */
const IDS_PER_QUERY = 100;

async function scan<T>(
  fetchRange: (fromBlock: bigint, toBlock: bigint) => Promise<readonly T[]>,
  latest: bigint,
): Promise<T[]> {
  let from = POOL_CONTRACTS.deployBlock;
  const out: T[] = [];
  while (from <= latest) {
    const to = from + LOG_CHUNK > latest ? latest : from + LOG_CHUNK;
    out.push(...(await fetchRange(from, to)));
    from = to + 1n;
  }
  return out;
}

/** USDC per token, 18-decimal, from a pool's sqrtPriceX96. See subgraph/src/shared.ts. */
function priceFromSqrt(sqrtPriceX96: bigint): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  return (WAD * Q192) / (sqrtPriceX96 * sqrtPriceX96);
}

/** A buy's gross USDC from the net that reached the pool. See subgraph/src/pool.ts. */
function grossFromNet(net: bigint): bigint {
  const q = net / 99n;
  return q * 100n + (net - q * 99n);
}

function artFromAddress(address: string): { hue: number; seed: number } {
  let h = 0;
  for (let i = 2; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) >>> 0;
  return { hue: h % 360, seed: h };
}

const blockTimeCache = new Map<bigint, number>();

async function blockTimes(numbers: bigint[]): Promise<Map<bigint, number>> {
  const missing = [...new Set(numbers)].filter((n) => !blockTimeCache.has(n));
  const fetched = await Promise.all(missing.map((bn) => client.getBlock({ blockNumber: bn })));
  for (const b of fetched) blockTimeCache.set(b.number, Number(b.timestamp));
  return new Map(numbers.map((n) => [n, blockTimeCache.get(n) ?? 0]));
}

type TokenState = {
  coin: Coin;
  createdAt: number;
  trades: TapeTrade[];
  series: SeriesPoint[];
};

export type BoardData = {
  tokens: Coin[];
  trades: TapeTrade[];
};

type Snapshot = { byToken: Map<string, TokenState>; tokens: Coin[]; trades: TapeTrade[] };

async function load(): Promise<Snapshot> {
  const empty: Snapshot = { byToken: new Map(), tokens: [], trades: [] };
  if (!POOL_CONTRACTS.poolFactory) return empty;

  const factory = POOL_CONTRACTS.poolFactory as Address;
  const router = POOL_CONTRACTS.aromaRouter as Address;
  const poolManager = POOL_CONTRACTS.poolManager as Address;
  const latest = await client.getBlockNumber();

  const created = await scan(
    (fromBlock, toBlock) =>
      client.getLogs({ address: factory, event: TOKEN_CREATED, fromBlock, toBlock }),
    latest,
  );
  if (created.length === 0) return empty;

  const poolIds = created.map((l) => l.args.poolId as Hex);
  const swaps = [];
  for (let i = 0; i < poolIds.length; i += IDS_PER_QUERY) {
    const ids = poolIds.slice(i, i + IDS_PER_QUERY);
    swaps.push(
      ...(await scan(
        (fromBlock, toBlock) =>
          client.getLogs({
            address: poolManager,
            event: SWAP,
            args: { id: ids },
            fromBlock,
            toBlock,
          }),
        latest,
      )),
    );
  }

  // Who actually traded, by transaction: the router names its trader, and
  // the factory names the creator whose dev-buy rode in the launch.
  const traderByTx = new Map<string, string>();
  for (const l of created) traderByTx.set(l.transactionHash, l.args.creator as string);
  if (router) {
    const [bought, sold] = await Promise.all([
      scan((f, t) => client.getLogs({ address: router, event: BOUGHT, fromBlock: f, toBlock: t }), latest),
      scan((f, t) => client.getLogs({ address: router, event: SOLD, fromBlock: f, toBlock: t }), latest),
    ]);
    for (const l of bought) traderByTx.set(l.transactionHash, l.args.buyer as string);
    for (const l of sold) traderByTx.set(l.transactionHash, l.args.seller as string);
  }

  const times = await blockTimes([
    ...created.map((l) => l.blockNumber),
    ...swaps.map((l) => l.blockNumber),
  ]);
  const images = await resolveImages(created.map((l) => l.args.metadataUri as string));
  const now = Math.floor(Date.now() / 1000);

  const tokenByPool = new Map<string, string>();
  const byToken = new Map<string, TokenState>();
  const openingPrice = Math.pow(1.0001, -POOL.tickInit);

  for (const l of created) {
    const token = (l.args.token as string).toLowerCase();
    tokenByPool.set((l.args.poolId as string).toLowerCase(), token);
    const createdAt = times.get(l.blockNumber) ?? now;
    const meta = images.get(l.args.metadataUri as string);
    const { hue, seed } = artFromAddress(token);
    byToken.set(token, {
      createdAt,
      trades: [],
      series: [{ t: createdAt, m: openingPrice * POOL.totalSupply }],
      coin: {
        id: token,
        name: (l.args.name as string) || "Untitled",
        ticker: (l.args.symbol as string) || "???",
        description: (l.args.description as string) || "",
        imageUrl: meta?.image ?? "",
        links: meta?.links ?? { website: "", x: "", telegram: "" },
        creatorFeesEarnedUsd: 0,
        // Claims are not replayed here; the coin page reads what is owed
        // straight from PoolVault.
        creatorFeesClaimedUsd: 0,
        creator: l.args.creator as string,
        contract: token,
        createdAgoSeconds: Math.max(1, now - createdAt),
        priceUsd: openingPrice,
        marketCapUsd: openingPrice * POOL.totalSupply,
        volume24hUsd: 0,
        change24hPct: 0,
        holders: 0,
        raisedUsd: 0,
        graduated: false,
        hue,
        seed,
        history: [openingPrice],
      },
    });
  }

  const ordered = [...swaps].sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber),
  );
  const reserve = new Map<string, bigint>();
  const buyers = new Map<string, Set<string>>();
  const feesEarned = new Map<string, bigint>();
  const allTrades: TapeTrade[] = [];

  for (const l of ordered) {
    const token = tokenByPool.get((l.args.id as string).toLowerCase());
    const state = token ? byToken.get(token) : undefined;
    if (!token || !state) continue;

    const amount0 = l.args.amount0 as bigint;
    const amount1 = l.args.amount1 as bigint;
    const isBuy = amount0 < 0n;

    let usdc: bigint;
    let tokens: bigint;
    let fee: bigint;
    let reserveDelta: bigint;
    if (isBuy) {
      const net = -amount0;
      const gross = grossFromNet(net);
      fee = gross - net;
      usdc = gross;
      tokens = amount1;
      reserveDelta = net;
    } else {
      const gross = amount0;
      fee = (gross * BigInt(POOL.tradeFeeBps)) / 10_000n;
      usdc = gross - fee;
      tokens = -amount1;
      reserveDelta = -gross;
    }

    reserve.set(token, (reserve.get(token) ?? 0n) + reserveDelta);
    feesEarned.set(
      token,
      (feesEarned.get(token) ?? 0n) + (fee * BigInt(POOL.creatorFeeShareBps)) / 10_000n,
    );

    const trader = traderByTx.get(l.transactionHash) ?? (l.args.sender as string);
    if (isBuy) {
      const set = buyers.get(token) ?? new Set<string>();
      set.add(trader.toLowerCase());
      buyers.set(token, set);
    }

    const priceUsd = toNum(priceFromSqrt(l.args.sqrtPriceX96 as bigint));
    const timestamp = times.get(l.blockNumber) ?? now;
    const coin = state.coin;
    coin.priceUsd = priceUsd;
    coin.marketCapUsd = priceUsd * POOL.totalSupply;
    coin.volume24hUsd += toNum(usdc);
    coin.history.push(priceUsd);
    if (!coin.graduated && (l.args.tick as number) <= POOL.tickGraduation) coin.graduated = true;
    state.series.push({ t: timestamp, m: coin.marketCapUsd });

    const trade: TapeTrade = {
      id: `${l.transactionHash}-${l.logIndex}`,
      tokenAddress: token,
      ticker: coin.ticker,
      side: isBuy ? "buy" : "sell",
      account: trader,
      usd: toNum(usdc),
      tokens: toNum(tokens),
      timestamp,
      agoSeconds: Math.max(1, now - timestamp),
    };
    state.trades.push(trade);
    allTrades.push(trade);
  }

  for (const [token, state] of byToken) {
    const coin = state.coin;
    coin.raisedUsd = toNum(reserve.get(token) ?? 0n);
    coin.holders = buyers.get(token)?.size ?? 0;
    coin.creatorFeesEarnedUsd = toNum(feesEarned.get(token) ?? 0n);
    const first = coin.history[0] || coin.priceUsd;
    coin.change24hPct = first > 0 ? ((coin.priceUsd - first) / first) * 100 : 0;
    if (coin.history.length < 2) coin.history.push(coin.priceUsd);
    state.series.push({ t: now, m: coin.marketCapUsd });
    // Newest first, matching the indexed path.
    state.trades.reverse();
  }

  return {
    byToken,
    tokens: [...byToken.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => s.coin),
    trades: allTrades.reverse(),
  };
}

const TTL_MS = 4_000;
let cached: { at: number; data: Snapshot } | null = null;
let inflight: Promise<Snapshot> | null = null;

async function snapshot(): Promise<Snapshot> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.data;
  if (inflight) return inflight;
  inflight = load()
    .then((data) => {
      cached = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function fetchBoardData(): Promise<BoardData> {
  const { tokens, trades } = await snapshot();
  return { tokens, trades };
}

export async function fetchTokenFromChain(address: string): Promise<{
  coin: Coin;
  trades: TapeTrade[];
  series: SeriesPoint[];
} | null> {
  const state = (await snapshot()).byToken.get(address.toLowerCase());
  if (!state) return null;
  return { coin: state.coin, trades: state.trades, series: state.series };
}
