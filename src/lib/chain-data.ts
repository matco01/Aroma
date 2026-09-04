import { createPublicClient, parseAbiItem, formatUnits, type Address } from "viem";
import { arcTestnet } from "@reown/appkit/networks";
import { curveManagerAbi } from "./abis";
import { arcTransport } from "./transport";
import { ARC_TESTNET_CONTRACTS, CURVE } from "./arc";
import type { Coin, Trade } from "./mock";

/**
 * Direct-from-chain fallback, used only when no subgraph is configured.
 *
 * The real read path is the indexer (see src/lib/server/board.ts). This
 * exists so a fresh clone with newly deployed contracts still shows a
 * board before anyone has stood an indexer up — it re-scans the full log
 * range on every call and rate-limits public RPCs within minutes, so it is
 * a bootstrap convenience, not a second supported mode.
 *
 * Returns the same `Coin`/`Trade` shapes the indexed path does, which is
 * what made the swap invisible to every component.
 */

export const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: arcTransport(),
});

const TOKEN_CREATED = parseAbiItem(
  "event TokenCreated(address indexed token, address indexed creator, string name, string symbol, string description, uint256 devBuyUsdc)",
);
const BOUGHT = parseAbiItem(
  "event Bought(address indexed token, address indexed recipient, address payer, uint256 usdcIn, uint256 fee, uint256 creatorFee, uint256 tokensOut)",
);
const SOLD = parseAbiItem(
  "event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 usdcOut, uint256 fee, uint256 creatorFee)",
);

const WAD = 10n ** 18n;

/**
 * Public RPCs cap how many blocks a single eth_getLogs may span, so scans
 * are chunked rather than asking for the whole history at once. Starting
 * from the factory's deploy block keeps the chunk count small; without
 * both of those the request is rejected outright — Arc is already past
 * block 60,000,000.
 *
 * Takes a range-fetcher rather than event params so viem infers the log
 * type for each event on its own.
 */
const LOG_CHUNK = 45_000n;

async function scanLogs<T>(
  fetchRange: (fromBlock: bigint, toBlock: bigint) => Promise<readonly T[]>,
): Promise<T[]> {
  const latest = await publicClient.getBlockNumber();
  let from = ARC_TESTNET_CONTRACTS.deployBlock;
  const out: T[] = [];
  while (from <= latest) {
    const to = from + LOG_CHUNK > latest ? latest : from + LOG_CHUNK;
    out.push(...(await fetchRange(from, to)));
    from = to + 1n;
  }
  return out;
}

const toNum = (v: bigint) => Number(formatUnits(v, 18));

/** Stable pseudo-random art inputs, derived from the address itself. */
function artFromAddress(address: string): { hue: number; seed: number } {
  let h = 0;
  for (let i = 2; i < address.length; i++) {
    h = (h * 31 + address.charCodeAt(i)) >>> 0;
  }
  return { hue: h % 360, seed: h };
}

/**
 * Spot price in USDC per token, from the same constant-product formula the
 * contract uses: (virtualUsdc + raised) / (virtualToken - sold).
 */
function priceFrom(reserve: bigint, sold: bigint): number {
  const effUsdc = BigInt(CURVE.virtualUsdcReserve) + reserve;
  const effToken = BigInt(CURVE.virtualTokenReserve) - sold;
  if (effToken <= 0n) return 0;
  return Number((effUsdc * WAD) / effToken) / 1e18;
}

export type ChainTrade = Trade & { blockNumber: bigint; timestamp: number };

export type BoardData = {
  tokens: Coin[];
  trades: (ChainTrade & { tokenAddress: string })[];
};

/**
 * One pass over the chain serving the whole board: token list, per-token
 * curve state, and every trade. Deliberately a single function rather than
 * separate token/trade fetches — those duplicated the same log scan on
 * independent poll timers and rate-limited the public RPC within minutes.
 * Callers share this through one React Query key.
 */
export async function fetchBoardData(): Promise<BoardData> {
  const factory = ARC_TESTNET_CONTRACTS.aromaFactory as Address;
  const curve = ARC_TESTNET_CONTRACTS.curveManager as Address;

  const created = await scanLogs((fromBlock, toBlock) =>
    publicClient.getLogs({ address: factory, event: TOKEN_CREATED, fromBlock, toBlock }),
  );
  if (created.length === 0) return { tokens: [], trades: [] };

  // One multicall for every token's curve state rather than N round trips.
  const states = await publicClient.multicall({
    contracts: created.map((log) => ({
      address: curve,
      abi: curveManagerAbi,
      functionName: "tokenState",
      args: [log.args.token as Address],
    })),
    allowFailure: false,
  });

  const trades = await fetchAllTrades();

  // Timestamps for "3m ago" labels. Deduped across creations and trades,
  // and cached process-wide — a mined block's timestamp never changes, so
  // re-fetching it every poll is pure waste against a rate limit.
  const blockNumbers = [...new Set(created.map((l) => l.blockNumber))];
  const timeByBlock = await blockTimes(blockNumbers);
  const now = Math.floor(Date.now() / 1000);

  const tokens = created.map((log, i) => {
    const address = log.args.token as Address;
    const [reserve, sold, creator, graduated] = states[i] as unknown as [
      bigint,
      bigint,
      Address,
      boolean,
    ];

    const price = priceFrom(reserve, sold);
    const forToken = trades.filter((t) => t.tokenAddress.toLowerCase() === address.toLowerCase());
    const volume = forToken.reduce((sum, t) => sum + t.usd, 0);
    const holders = new Set(forToken.filter((t) => t.side === "buy").map((t) => t.account)).size;

    // Price history reconstructed from trade order. Real charts need
    // timestamped candles from an indexer; this is enough to draw a line
    // that reflects what actually happened.
    const history = buildHistory(forToken, price);
    const first = history[0] ?? price;
    const change = first > 0 ? ((price - first) / first) * 100 : 0;

    const { hue, seed } = artFromAddress(address);
    const created_at = timeByBlock.get(log.blockNumber) ?? now;

    return {
      id: address,
      name: (log.args.name as string) || "Untitled",
      ticker: (log.args.symbol as string) || "???",
      description: (log.args.description as string) || "",
      creator: creator,
      contract: address,
      createdAgoSeconds: Math.max(1, now - created_at),
      priceUsd: price,
      marketCapUsd: price * CURVE.totalSupply,
      volume24hUsd: volume,
      change24hPct: change,
      holders,
      replies: 0, // not on-chain; needs its own store (plan §4)
      raisedUsd: toNum(reserve),
      graduated,
      hue,
      seed,
      history,
    } satisfies Coin;
  });

  return { tokens, trades };
}

/** Block timestamps are immutable once mined — cache them forever. */
const blockTimeCache = new Map<bigint, number>();

async function blockTimes(numbers: bigint[]): Promise<Map<bigint, number>> {
  const missing = numbers.filter((n) => !blockTimeCache.has(n));
  if (missing.length > 0) {
    const fetched = await Promise.all(
      missing.map((bn) => publicClient.getBlock({ blockNumber: bn })),
    );
    for (const b of fetched) blockTimeCache.set(b.number, Number(b.timestamp));
  }
  return new Map(numbers.map((n) => [n, blockTimeCache.get(n) ?? 0]));
}

/**
 * Spot price after each trade, reconstructed by replaying curve state.
 *
 * Not each trade's average execution price: that figure is gross of the 1%
 * fee, while the live spot price is net of it, so mixing the two made a
 * series of pure buys render as a 1% *decline* — the fee showing up as a
 * price move. Replaying reserve and supply through the contract's own
 * formula keeps every point on the same basis.
 */
function buildHistory(trades: ChainTrade[], currentPrice: number): number[] {
  const ordered = [...trades].sort((a, b) => Number(a.blockNumber - b.blockNumber));
  if (ordered.length === 0) return [currentPrice, currentPrice];

  const feeRate = CURVE.tradeFeeBps / 10_000;
  let reserve = 0;
  let sold = 0;
  const vUsdc = Number(CURVE.virtualUsdcReserve) / 1e18;
  const vToken = Number(CURVE.virtualTokenReserve) / 1e18;

  const points: number[] = [vUsdc / vToken]; // price before any trade
  for (const t of ordered) {
    if (t.side === "buy") {
      reserve += t.usd * (1 - feeRate); // fee never enters the curve
      sold += t.tokens;
    } else {
      reserve -= t.usd / (1 - feeRate); // usd here is already net of fee
      sold -= t.tokens;
    }
    const effToken = vToken - sold;
    points.push(effToken > 0 ? (vUsdc + reserve) / effToken : currentPrice);
  }

  points.push(currentPrice);
  return points;
}

export async function fetchAllTrades(): Promise<(ChainTrade & { tokenAddress: string })[]> {
  const curve = ARC_TESTNET_CONTRACTS.curveManager as Address;

  const [buys, sells] = await Promise.all([
    scanLogs((fromBlock, toBlock) =>
      publicClient.getLogs({ address: curve, event: BOUGHT, fromBlock, toBlock }),
    ),
    scanLogs((fromBlock, toBlock) =>
      publicClient.getLogs({ address: curve, event: SOLD, fromBlock, toBlock }),
    ),
  ]);

  const blockNumbers = [...new Set([...buys, ...sells].map((l) => l.blockNumber))];
  const timeByBlock = await blockTimes(blockNumbers);
  const now = Math.floor(Date.now() / 1000);

  const rows = [
    ...buys.map((l) => ({
      id: `${l.transactionHash}-${l.logIndex}`,
      tokenAddress: l.args.token as string,
      side: "buy" as const,
      account: l.args.recipient as string,
      usd: toNum(l.args.usdcIn as bigint),
      tokens: toNum(l.args.tokensOut as bigint),
      blockNumber: l.blockNumber,
      timestamp: timeByBlock.get(l.blockNumber) ?? now,
    })),
    ...sells.map((l) => ({
      id: `${l.transactionHash}-${l.logIndex}`,
      tokenAddress: l.args.token as string,
      side: "sell" as const,
      account: l.args.seller as string,
      usd: toNum(l.args.usdcOut as bigint),
      tokens: toNum(l.args.tokensIn as bigint),
      blockNumber: l.blockNumber,
      timestamp: timeByBlock.get(l.blockNumber) ?? now,
    })),
  ];

  return rows
    .sort((a, b) => Number(b.blockNumber - a.blockNumber))
    .map((r) => ({ ...r, agoSeconds: Math.max(1, now - r.timestamp) }));
}

export async function fetchTokens(): Promise<Coin[]> {
  return (await fetchBoardData()).tokens;
}
