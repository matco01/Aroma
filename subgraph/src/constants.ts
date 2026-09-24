import { BigInt } from "@graphprotocol/graph-ts";

/**
 * These MUST match CurveManager.sol exactly.
 *
 * They are duplicated here because a subgraph cannot read Solidity
 * constants without an eth_call per event, which would defeat the point of
 * indexing. The cost of that duplication is drift, so contracts/README.md
 * records that changing a curve constant means changing it in three places:
 * derive_curve.py, CurveManager.sol, and here.
 */

export const WAD = BigInt.fromString("1000000000000000000");

// Retuned 2026-09-04. A 20% LP reserve against a $69,000 graduation forces
// a $13,800 raise — see contracts/README.md, "The raise target is not a
// free parameter".
export const VIRTUAL_USDC_RESERVE = BigInt.fromString("4600000000000000000000");
export const VIRTUAL_TOKEN_RESERVE = BigInt.fromString("1066666666666666666666666667");
export const TOTAL_SUPPLY = BigInt.fromString("1000000000000000000000000000");
export const GRADUATION_RAISE = BigInt.fromString("13800000000000000000000");

export const TRADE_FEE_BPS = BigInt.fromI32(100);
export const BPS_DENOMINATOR = BigInt.fromI32(10000);

export const ZERO = BigInt.zero();
export const ONE = BigInt.fromI32(1);
export const PROTOCOL_ID = "Aroma";

/** Candle intervals in seconds: 5m, 1h, 1d. */
export const CANDLE_INTERVALS: i32[] = [300, 3600, 86400];

/**
 * Pool-system constants. These MUST match src/pool/PoolVault.sol, for the
 * same reason the curve constants must match CurveManager.sol: a subgraph
 * cannot read a Solidity constant without an eth_call per event.
 */

/**
 * PoolVault.TICK_GRADUATION. The sale range is exhausted at or *below* it.
 *
 * Below, not above: native USDC sorts first as currency0, so the pool
 * quotes tokens-per-USDC and a token getting more expensive moves the tick
 * down. Every comparison against this constant reads backwards from the
 * intuition, which is why it is worth saying twice.
 */
export const POOL_TICK_GRADUATION = 95818;

/** PoolVault.CREATOR_FEE_SHARE_BPS — the creator's cut of the 1% fee. */
export const CREATOR_FEE_SHARE_BPS = BigInt.fromI32(7000);

/** Q192 = 2^192, for converting sqrtPriceX96 to a WAD price. */
export const Q192 = BigInt.fromI32(2).pow(192);

export const VENUE_CURVE = "curve";
export const VENUE_POOL = "pool";
/** A club coin. See CLUBS.md — a separate hook, same pool geometry. */
export const VENUE_CLUB = "club";

/** ClubVault.SWAP_FEE_BPS — 1.5%, vs. a normal coin's 1%. */
export const CLUB_TRADE_FEE_BPS = BigInt.fromI32(150);

/**
 * Robinhood Chain constants. These MUST match src/club/ClubVaultUsdg.sol.
 *
 * Club coins there write `venue = VENUE_CLUB` and CLUB_TRADE_FEE_BPS, the same
 * as Arc's club coins. What differs at the raw-number level is decimals: USDG
 * has 6, not the 18 Arc's native USDC reads as, and that changes the
 * tick-to-price conversion below.
 */

/**
 * ClubVaultUsdg.TICK_GRADUATION. Not the same value as POOL_TICK_GRADUATION
 * above — see script/math/derive_pool_usdg.py for why a 6-decimal quote
 * currency moves every tick constant.
 */
export const POOL_USDG_TICK_GRADUATION = 372142;

/**
 * 10^(18-6): the decimal gap between the launched token (18 decimals) and
 * USDG (6 decimals). priceFromSqrtX96Usdg multiplies by this where
 * priceFromSqrtX96 (native, both sides 18-decimal) has no such factor at
 * all — see that function's own comment for the derivation.
 */
export const USDG_DECIMAL_FACTOR = BigInt.fromString("1000000000000");
