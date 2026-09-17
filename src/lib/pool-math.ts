import { POOL } from "./arc";

/**
 * Previews of a pool trade, for display while someone is typing.
 *
 * Never the number a trade is sent with. The binding quote comes from
 * simulating the router call itself immediately before sending (see
 * pool-trade.ts), which runs the real pool, the real hook fee and the
 * router's own checks. This is what the panel shows between keystrokes, where
 * an RPC round trip per character would be both slow and wasteful.
 *
 * It is exact for the pool as Aroma creates it: two positions with known
 * ranges and known liquidity, and nothing else. Anyone may add liquidity to a
 * v4 pool, and extra liquidity only makes a trade fill better than this says,
 * so a preview here errs on the side of promising too little.
 *
 * The working variable is q = 1/sqrt(P), where P is the pool's own price in
 * tokens per USDC. q^2 is USDC per token, which is the price people read.
 * Inside a range of liquidity L the virtual USDC reserve is L*q and the
 * virtual token reserve is L/q, so:
 *
 *   buying  with dx USDC:    q' = q + dx/L,          tokens out = L(1/q - 1/q')
 *   selling dy tokens:       1/q' = 1/q + dy/L,      USDC out   = L(q - q')
 *
 * Both currencies are 18 decimals on Arc, so L can be carried in whole units
 * and there is no decimal correction anywhere.
 */

const FEE = POOL.tradeFeeBps / 10_000;

/**
 * The fee as a fraction, for a given rate. Club coins charge 1.5% where a
 * normal coin charges 1%, on an identical pool, so the rate is the only thing
 * these previews need told.
 */
const feeFraction = (feeBps?: number) => (feeBps === undefined ? FEE : feeBps / 10_000);

/** L in whole-token units. The contract constants are 18-decimal. */
const L_SALE = Number(POOL.saleLiquidity) / 1e18;
const L_RESERVE = Number(POOL.reserveLiquidity) / 1e18;

/** q at a tick: 1/sqrt(1.0001^tick). */
const qAtTick = (tick: number) => Math.pow(1.0001, -tick / 2);

/** Launch price. The sale position starts here and runs up to graduation. */
const Q_INIT = qAtTick(POOL.tickInit);
/** Graduation price: top of the sale position, bottom of the reserve. */
const Q_GRAD = qAtTick(POOL.tickGraduation);
/** Top of the reserve position. Past this the pool has no liquidity at all. */
const Q_TOP = qAtTick(POOL.tickReserveFloor);

export type Preview = {
  /** Tokens received on a buy, USDC received (net of fee) on a sell. */
  out: number;
  priceAfterUsd: number;
  /** How far the trade moves the price, as a positive percentage. */
  impactPct: number;
  /**
   * False when the pool cannot absorb the whole amount. The router refuses
   * those outright rather than filling part of them, so the panel should
   * say so before anyone signs.
   */
  fillable: boolean;
};

export function previewBuy(priceUsd: number, usdcIn: number, feeBps?: number): Preview {
  let q = Math.max(Math.sqrt(Math.max(priceUsd, 0)), Q_INIT);
  const qStart = q;
  // The hook takes its 1% before the swap, so only the rest moves the price.
  let rest = usdcIn * (1 - feeFraction(feeBps));
  let out = 0;

  for (const [L, ceiling] of [
    [L_SALE, Q_GRAD],
    [L_RESERVE, Q_TOP],
  ] as const) {
    if (rest <= 0 || q >= ceiling) continue;
    const capacity = L * (ceiling - q);
    const spend = Math.min(rest, capacity);
    const qNext = spend === capacity ? ceiling : q + spend / L;
    out += L * (1 / q - 1 / qNext);
    rest -= spend;
    q = qNext;
  }

  const priceAfterUsd = q * q;
  return {
    out,
    priceAfterUsd,
    impactPct: qStart > 0 ? (priceAfterUsd / (qStart * qStart) - 1) * 100 : 0,
    // A few millionths of a dollar left over is float noise, not a real
    // shortfall; anything more means the pool ran dry.
    fillable: rest <= usdcIn * 1e-9,
  };
}

export function previewSell(priceUsd: number, tokensIn: number, feeBps?: number): Preview {
  let q = Math.min(Math.sqrt(Math.max(priceUsd, 0)), Q_TOP);
  const qStart = q;
  let rest = tokensIn;
  let gross = 0;

  // Walking down: the reserve position first if the price is above
  // graduation, then the sale position, which ends at the launch price.
  for (const [L, floor] of [
    [L_RESERVE, Q_GRAD],
    [L_SALE, Q_INIT],
  ] as const) {
    if (rest <= 0 || q <= floor) continue;
    const capacity = L * (1 / floor - 1 / q);
    const sell = Math.min(rest, capacity);
    const qNext = sell === capacity ? floor : 1 / (1 / q + sell / L);
    gross += L * (q - qNext);
    rest -= sell;
    q = qNext;
  }

  const priceAfterUsd = q * q;
  return {
    // The hook takes its 1% from what leaves the pool.
    out: gross * (1 - feeFraction(feeBps)),
    priceAfterUsd,
    impactPct: qStart > 0 ? (1 - priceAfterUsd / (qStart * qStart)) * 100 : 0,
    fillable: rest <= tokensIn * 1e-9,
  };
}

/** Launch price in USDC per token. */
export const OPENING_PRICE_USD = Q_INIT * Q_INIT;

/**
 * Market cap after a creator's own first buy, for the launch form.
 *
 * It is the number their coin will be judged on the moment it appears, and
 * worth showing before they commit rather than after.
 */
export function marketCapAfterDevBuy(usdcIn: number): number {
  return previewBuy(OPENING_PRICE_USD, usdcIn).priceAfterUsd * POOL.totalSupply;
}

/**
 * How far a coin is toward graduation, 0–1, from its price.
 *
 * Graduation in the pool system is a price level, not an event: the sale
 * position is fully bought at the graduation price and trading carries on in
 * the same pool. Measured in q rather than market cap so that halfway means
 * half the sale's USDC has come in, which is what a progress bar should mean.
 */
export function graduationProgress(priceUsd: number): number {
  const q = Math.sqrt(Math.max(priceUsd, 0));
  return Math.min(1, Math.max(0, (q - Q_INIT) / (Q_GRAD - Q_INIT)));
}

/** USDC that has come into the sale position at a given price. */
export function raisedAtPrice(priceUsd: number): number {
  return graduationProgress(priceUsd) * L_SALE * (Q_GRAD - Q_INIT);
}
