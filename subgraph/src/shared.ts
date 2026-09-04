import { BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { Token, Account, Balance, Candle, Protocol } from "../generated/schema";
import {
  WAD,
  VIRTUAL_USDC_RESERVE,
  VIRTUAL_TOKEN_RESERVE,
  TOTAL_SUPPLY,
  GRADUATION_RAISE,
  BPS_DENOMINATOR,
  ZERO,
  PROTOCOL_ID,
  CANDLE_INTERVALS,
} from "./constants";

/**
 * Spot price in USDC per token, 18-decimal fixed point.
 *
 * The same constant-product formula CurveManager uses:
 *   (virtualUsdc + reserve) / (virtualToken - sold)
 * Kept identical so a price shown in the UI matches what the contract will
 * actually execute — that agreement is the whole reason to duplicate the
 * constants rather than approximate them.
 */
export function spotPrice(reserve: BigInt, tokensSold: BigInt): BigInt {
  const effUsdc = VIRTUAL_USDC_RESERVE.plus(reserve);
  const effToken = VIRTUAL_TOKEN_RESERVE.minus(tokensSold);
  if (effToken.le(ZERO)) return ZERO;
  return effUsdc.times(WAD).div(effToken);
}

export function marketCapOf(price: BigInt): BigInt {
  return price.times(TOTAL_SUPPLY).div(WAD);
}

/** Graduation progress in basis points, clamped — never shows over 100%. */
export function progressBpsOf(reserve: BigInt): i32 {
  if (GRADUATION_RAISE.equals(ZERO)) return 0;
  let bps = reserve.times(BPS_DENOMINATOR).div(GRADUATION_RAISE);
  if (bps.gt(BPS_DENOMINATOR)) bps = BPS_DENOMINATOR;
  return bps.toI32();
}

/**
 * Load a Token, creating a bare one if the trade beat the announcement.
 *
 * The contract now emits TokenCreated before any dev-buy, so this should
 * not fire. It exists because the previous ordering dropped every dev-buy
 * *silently* — balances and reserves were all correct on-chain, only the
 * index was wrong, which is the hardest kind of bug to notice. Making both
 * handlers order-independent means a future reordering degrades to "metadata
 * arrives late" instead of "trades vanish".
 */
export function getOrCreateToken(
  address: Bytes,
  timestamp: BigInt,
  block: BigInt,
  tx: Bytes,
): Token {
  const id = address.toHexString();
  let token = Token.load(id);
  if (token != null) return token;

  token = new Token(id);
  token.address = address;
  token.creator = Bytes.empty();
  token.name = "";
  token.symbol = "";
  token.description = "";
  token.createdAt = timestamp;
  token.createdAtBlock = block;
  token.createdTx = tx;
  token.reserve = ZERO;
  token.tokensSold = ZERO;
  token.price = spotPrice(ZERO, ZERO);
  token.marketCap = marketCapOf(token.price);
  token.progressBps = 0;
  token.price24hAgo = token.price;
  token.graduated = false;
  token.volume = ZERO;
  token.tradeCount = 0;
  token.buyerCount = 0;
  token.lastTradeAt = timestamp;
  token.save();
  return token;
}

export function getProtocol(): Protocol {
  let p = Protocol.load(PROTOCOL_ID);
  if (p == null) {
    p = new Protocol(PROTOCOL_ID);
    p.tokenCount = 0;
    p.tradeCount = 0;
    p.graduatedCount = 0;
    p.totalVolume = ZERO;
    p.totalFees = ZERO;
    p.save();
  }
  return p;
}

export function getAccount(address: Bytes, timestamp: BigInt): Account {
  let a = Account.load(address.toHexString());
  if (a == null) {
    a = new Account(address.toHexString());
    a.address = address;
    a.firstSeen = timestamp;
    a.tradeCount = 0;
    a.volume = ZERO;
    a.save();
  }
  return a;
}

export function balanceId(token: string, account: Bytes): string {
  return token + "-" + account.toHexString();
}

export function getBalance(token: Token, account: Account): Balance {
  const id = balanceId(token.id, account.address);
  let b = Balance.load(id);
  if (b == null) {
    b = new Balance(id);
    b.token = token.id;
    b.account = account.id;
    b.amount = ZERO;
    b.costBasis = ZERO;
    b.realisedPnl = ZERO;
  }
  return b;
}

/**
 * Fold one trade into every candle interval.
 *
 * Written on each trade rather than aggregated on read: a chart over a
 * token with 20,000 trades should be a bounded query, not a fold over all
 * of them.
 */
export function updateCandles(
  token: Token,
  price: BigInt,
  volume: BigInt,
  timestamp: BigInt,
): void {
  for (let i = 0; i < CANDLE_INTERVALS.length; i++) {
    const interval = CANDLE_INTERVALS[i];
    const bucket = timestamp.div(BigInt.fromI32(interval)).times(BigInt.fromI32(interval));
    const id = token.id + "-" + interval.toString() + "-" + bucket.toString();

    let c = Candle.load(id);
    if (c == null) {
      c = new Candle(id);
      c.token = token.id;
      c.interval = interval;
      c.bucketStart = bucket;
      // A new bucket opens where the last one closed, so gaps between
      // trades don't render as a jump from zero.
      c.open = price;
      c.high = price;
      c.low = price;
      c.volume = ZERO;
      c.tradeCount = 0;
    }
    if (price.gt(c.high)) c.high = price;
    if (price.lt(c.low)) c.low = price;
    c.close = price;
    c.volume = c.volume.plus(volume);
    c.tradeCount = c.tradeCount + 1;
    c.save();
  }
}

export function tradeId(event: ethereum.Event): string {
  return event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
}
