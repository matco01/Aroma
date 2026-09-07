import "server-only";
import { formatUnits } from "viem";
import { query } from "./subgraph";
import { CURVE } from "../arc";

/**
 * A public feed of curve trading, in the shape DEX Screener's indexer polls.
 *
 * Why this exists at all: a coin on the curve is invisible to every screener
 * and terminal in the market. Those trades happen inside CurveManager, which
 * is not an AMM anyone has an adapter for, so nothing indexes them — the same
 * blind spot pump.fun coins have before they graduate, where the curve data
 * traders rely on comes from third parties who built it themselves. After
 * graduation the problem disappears: the pool is an ordinary hookless Uniswap
 * v4 pool and gets picked up natively. So this covers exactly the window
 * nothing else can see, and stops at graduation rather than duplicating what
 * v4 already reports.
 *
 * The endpoint shape is DEX Screener's because it is a good one and widely
 * understood, not because they have agreed to poll it. Publishing it costs
 * little — the subgraph already holds every field — and it means anyone
 * building on Arc can index Aroma without asking us for anything.
 *
 * Two conventions worth stating, since both are choices:
 *
 * Asset order is token first, USDC second, so `priceNative` reads as USDC per
 * token — a dollar price, directly, because USDC is Arc's native gas token.
 * This is deliberately the opposite of the graduated v4 pool's ordering, where
 * native currency has to sort first as address zero. Same pair, two systems,
 * and the one that matters here is the one that makes the quoted price the
 * number a human would expect.
 *
 * Reserves are the *real* ones — USDC actually held, tokens actually left to
 * sell — not the virtual reserves the pricing math uses. Reporting virtual
 * reserves would make price equal reserve1/reserve0 exactly, and would
 * overstate liquidity by the 4,600 USDC that does not exist. Depth shown to a
 * trader should be depth they can actually take.
 */

/** Native USDC, addressed the way Arc and Uniswap v4 both address it. */
export const USDC_ASSET_ID = "0x0000000000000000000000000000000000000000";

/** Names this DEX in the feed. */
export const DEX_KEY = "aroma";

const ONE = 10n ** 18n;
const VIRTUAL_USDC = BigInt(CURVE.virtualUsdcReserve);
const VIRTUAL_TOKEN = BigInt(CURVE.virtualTokenReserve);
const K = VIRTUAL_USDC * VIRTUAL_TOKEN;
const CURVE_SUPPLY = BigInt(CURVE.curveSupply) * ONE;
const TOTAL_SUPPLY = BigInt(CURVE.totalSupply) * ONE;
const LP_RESERVE = BigInt(CURVE.lpReserveSupply) * ONE;

/** Newton's method; BigInt has no sqrt and these values overflow a double. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/**
 * The curve's state at a given spot price.
 *
 * Trades record the price they left behind but not the reserves, and the curve
 * is a constant product, so the reserves fall out of the price: with x*y = k
 * and price = x/y, x = sqrt(k*price) and y = sqrt(k/price).
 *
 * The inversion is lossy, because spotPrice truncated on integer division on
 * the way in and no arithmetic here can recover what it discarded. Measured
 * against the indexed reserves of every token that has traded, the worst drift
 * is 5.4e-10 USDC and 1.3e-4 of a token — far below anything that could show
 * up in a price or a depth figure.
 *
 * Small, but not always *valid*: a token bought and then entirely sold back
 * sits at exactly zero reserves, and drift of either sign there produces a
 * negative USDC balance or a token balance above the curve's whole supply.
 * Three of nine tokens did precisely that. Magnitude was never the problem;
 * a negative reserve is nonsense at any size, and an indexer is right to
 * reject it. So the result is clamped into the range the curve can actually
 * occupy, which costs a rounding error and removes an impossible number.
 */
export function curveStateAtPrice(price: bigint): {
  usdcHeld: bigint;
  tokensSold: bigint;
} {
  if (price <= 0n) return { usdcHeld: 0n, tokensSold: 0n };

  const x = isqrt((K * price) / ONE);
  const y = isqrt((K * ONE) / price);

  const usdcHeld = x > VIRTUAL_USDC ? x - VIRTUAL_USDC : 0n;
  const sold = VIRTUAL_TOKEN > y ? VIRTUAL_TOKEN - y : 0n;

  return {
    usdcHeld,
    tokensSold: sold > CURVE_SUPPLY ? CURVE_SUPPLY : sold,
  };
}

/** Every amount on the wire is a decimal string, never a float. */
const dec = (v: bigint): string => formatUnits(v, 18);

export type AdapterBlock = { blockNumber: number; blockTimestamp: number };

export async function latestBlock(): Promise<AdapterBlock> {
  const data = await query<{
    _meta: { block: { number: number; timestamp: number } };
  }>("dex:latest-block", `{ _meta { block { number timestamp } } }`, {}, 2_000);

  return {
    blockNumber: data._meta.block.number,
    blockTimestamp: data._meta.block.timestamp,
  };
}

export type AdapterAsset = {
  id: string;
  name: string;
  symbol: string;
  totalSupply: string;
  circulatingSupply: string;
  metadata?: Record<string, string>;
};

export async function asset(id: string): Promise<AdapterAsset | null> {
  const data = await query<{
    token: {
      id: string;
      name: string;
      symbol: string;
      tokensSold: string;
      graduated: boolean;
      creator: string;
    } | null;
  }>(
    `dex:asset:${id}`,
    `query Asset($id: ID!) {
      token(id: $id) { id name symbol tokensSold graduated creator }
    }`,
    { id },
    10_000,
  );

  const t = data.token;
  if (!t) return null;

  // Held by the curve contract until sold, and by the locked pool after
  // graduation — so what is actually in circulation is what the curve has
  // sold, plus the pool's share once that pool exists.
  const sold = BigInt(t.tokensSold);
  const circulating = t.graduated ? sold + LP_RESERVE : sold;

  return {
    id: t.id,
    name: t.name,
    symbol: t.symbol,
    totalSupply: dec(TOTAL_SUPPLY),
    circulatingSupply: dec(circulating),
    metadata: { creator: t.creator, graduated: String(t.graduated) },
  };
}

export type AdapterPair = {
  id: string;
  dexKey: string;
  asset0Id: string;
  asset1Id: string;
  createdAtBlockNumber: number;
  createdAtBlockTimestamp: number;
  createdAtTxnId: string;
  feeBps: number;
};

export async function pair(id: string): Promise<AdapterPair | null> {
  const data = await query<{
    token: {
      id: string;
      createdAt: string;
      createdAtBlock: string;
      createdTx: string;
    } | null;
  }>(
    `dex:pair:${id}`,
    `query Pair($id: ID!) {
      token(id: $id) { id createdAt createdAtBlock createdTx }
    }`,
    { id },
    60_000,
  );

  const t = data.token;
  if (!t) return null;

  return {
    id: t.id,
    dexKey: DEX_KEY,
    asset0Id: t.id,
    asset1Id: USDC_ASSET_ID,
    createdAtBlockNumber: Number(t.createdAtBlock),
    createdAtBlockTimestamp: Number(t.createdAt),
    createdAtTxnId: t.createdTx,
    feeBps: CURVE.tradeFeeBps,
  };
}

export type AdapterSwap = {
  block: AdapterBlock;
  eventType: "swap";
  txnId: string;
  txnIndex: number;
  eventIndex: number;
  maker: string;
  pairId: string;
  asset0In?: string;
  asset1In?: string;
  asset0Out?: string;
  asset1Out?: string;
  priceNative: string;
  reserves: { asset0: string; asset1: string };
};

type RawTrade = {
  id: string;
  account: string;
  isBuy: boolean;
  usdc: string;
  tokens: string;
  priceAfter: string;
  timestamp: string;
  block: string;
  tx: string;
  token: { id: string };
};

const PAGE = 1_000;

/**
 * How many trades one call will return before refusing.
 *
 * graph-node stops paginating past a skip of 5000, so this is the real ceiling
 * rather than a chosen one. A caller that hits it is asking for too wide a
 * window and is told to narrow it, which is better than silently returning a
 * prefix and letting them believe they have the whole range.
 */
const MAX_EVENTS = 5 * PAGE;

export class RangeTooWide extends Error {}

export async function events(
  fromBlock: number,
  toBlock: number,
): Promise<AdapterSwap[]> {
  const out: AdapterSwap[] = [];

  for (let skip = 0; skip <= MAX_EVENTS; skip += PAGE) {
    const data = await query<{ trades: RawTrade[] }>(
      `dex:events:${fromBlock}:${toBlock}:${skip}`,
      `query Events($from: BigInt!, $to: BigInt!, $first: Int!, $skip: Int!) {
        trades(
          where: { block_gte: $from, block_lte: $to }
          orderBy: block
          orderDirection: asc
          first: $first
          skip: $skip
        ) {
          id account isBuy usdc tokens priceAfter timestamp block tx
          token { id }
        }
      }`,
      { from: String(fromBlock), to: String(toBlock), first: PAGE, skip },
      15_000,
    );

    const trades = data.trades;
    if (skip >= MAX_EVENTS && trades.length > 0) {
      throw new RangeTooWide(
        `More than ${MAX_EVENTS} events between blocks ${fromBlock} and ${toBlock}.`,
      );
    }
    for (const t of trades) out.push(toSwap(t));
    if (trades.length < PAGE) break;
  }

  // Ordered by (block, logIndex). The subgraph can only sort by block, and
  // logIndex is block-scoped in graph-node, so it totally orders the ties.
  out.sort((a, b) =>
    a.block.blockNumber !== b.block.blockNumber
      ? a.block.blockNumber - b.block.blockNumber
      : a.eventIndex - b.eventIndex,
  );

  return out;
}

function toSwap(t: RawTrade): AdapterSwap {
  const price = BigInt(t.priceAfter);
  const { usdcHeld, tokensSold } = curveStateAtPrice(price);

  const usdc = BigInt(t.usdc);
  const tokens = BigInt(t.tokens);

  // Trade ids are `txHash-logIndex`; the suffix is what orders events inside a
  // block. txnIndex stays 0 because the subgraph does not record the
  // transaction's position, and it does not need to — sorting on
  // (block, eventIndex) alone is already a total order.
  const eventIndex = Number(t.id.split("-")[1] ?? 0);

  return {
    block: {
      blockNumber: Number(t.block),
      blockTimestamp: Number(t.timestamp),
    },
    eventType: "swap",
    txnId: t.tx,
    txnIndex: 0,
    eventIndex,
    maker: t.account,
    pairId: t.token.id,
    ...(t.isBuy
      ? { asset1In: dec(usdc), asset0Out: dec(tokens) }
      : { asset0In: dec(tokens), asset1Out: dec(usdc) }),
    priceNative: dec(price),
    reserves: {
      asset0: dec(CURVE_SUPPLY - tokensSold),
      asset1: dec(usdcHeld),
    },
  };
}
