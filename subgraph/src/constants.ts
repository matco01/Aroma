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
export const PROTOCOL_ID = "aram";

/** Candle intervals in seconds: 5m, 1h, 1d. */
export const CANDLE_INTERVALS: i32[] = [300, 3600, 86400];
