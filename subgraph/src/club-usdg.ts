import { BigInt } from "@graphprotocol/graph-ts";
import { TokenCreated } from "../generated/ClubFactoryUsdg/ClubFactoryUsdg";
import { Swap } from "../generated/PoolManager/PoolManager";
import { FeeTaken, Credited } from "../generated/ClubVaultUsdg/ClubVaultUsdg";
import { Trade, Token, PoolRef } from "../generated/schema";
import {
  marketCapOf,
  progressBpsOf,
  getOrCreateToken,
  getAccount,
  getBalance,
  getProtocol,
  updateCandles,
  tradeId,
} from "./shared";
import {
  ZERO,
  ONE,
  BPS_DENOMINATOR,
  CLUB_TRADE_FEE_BPS,
  POOL_USDG_TICK_GRADUATION,
  USDG_DECIMAL_FACTOR,
  VENUE_CLUB,
  WAD,
  Q192,
} from "./constants";

/**
 * Robinhood Chain's mappings: club coins, settled in USDG.
 *
 * club.ts (launch) and pool.ts (swaps) do the same job for Arc's club coins,
 * and this file follows them field for field. It is a separate file rather
 * than a reuse of theirs for two reasons. The generated event classes are
 * per-manifest — pool.ts imports Arc-only contracts that do not exist in the
 * Robinhood build. And USDG has 6 decimals where Arc's native USDC reads as
 * 18, which moves the graduation tick and needs a 10^12 correction in the
 * price (see priceFromSqrtX96Usdg); reusing pool.ts's math would be off by
 * exactly that factor, not merely wrong.
 *
 * ClubAuction's own events (club-auction.ts) link each coin to the auction
 * round that launched it.
 */

export function handleTokenCreated(event: TokenCreated): void {
  const token = getOrCreateToken(
    event.params.token,
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
  );

  const isNew = token.name == "";

  token.creator = event.params.creator;
  token.name = event.params.name;
  token.symbol = event.params.symbol;
  token.description = event.params.description;
  token.metadataUri = event.params.metadataUri;
  token.createdAt = event.block.timestamp;
  token.createdAtBlock = event.block.number;
  token.createdTx = event.transaction.hash;
  token.venue = VENUE_CLUB;
  token.poolId = event.params.poolId;
  token.tradeFeeBps = CLUB_TRADE_FEE_BPS;
  token.save();

  const ref = new PoolRef(event.params.poolId.toHexString());
  ref.token = token.id;
  ref.save();

  getAccount(event.params.creator, event.block.timestamp);

  if (isNew) {
    const protocol = getProtocol();
    protocol.tokenCount = protocol.tokenCount + 1;
    protocol.save();
  }
}

export function handleSwap(event: Swap): void {
  const ref = PoolRef.load(event.params.id.toHexString());
  if (ref == null) return;
  const token = Token.load(ref.token);
  if (token == null) return;

  const amount0 = event.params.amount0; // USDG, currency0
  const amount1 = event.params.amount1; // the launched token, currency1
  const isBuy = amount0.lt(ZERO);

  let usdg = ZERO;
  let tokens = ZERO;
  let fee = ZERO;
  let reserveDelta = ZERO;

  if (isBuy) {
    // Net of the fee: the hook charged before the swap.
    const net = amount0.neg();
    const gross = grossFromNet(net, token.tradeFeeBps);
    fee = gross.minus(net);
    usdg = gross;
    tokens = amount1;
    reserveDelta = net;
  } else {
    // Gross: the hook charged after the swap, out of what the pool paid.
    const gross = amount0;
    fee = gross.times(token.tradeFeeBps).div(BPS_DENOMINATOR);
    usdg = gross.minus(fee);
    tokens = amount1.neg();
    reserveDelta = gross.neg();
  }

  token.reserve = token.reserve.plus(reserveDelta);
  token.tokensSold = isBuy
    ? token.tokensSold.plus(tokens)
    : token.tokensSold.minus(tokens);
  token.price = priceFromSqrtX96Usdg(event.params.sqrtPriceX96);
  token.marketCap = marketCapOf(token.price);
  // progressBpsOf measures against an 18-decimal raise; the reserve is USDG's 6.
  token.progressBps = progressBpsOf(token.reserve.times(USDG_DECIMAL_FACTOR));
  token.volume = token.volume.plus(usdg);
  token.tradeCount = token.tradeCount + 1;
  token.lastTradeAt = event.block.timestamp;

  if (!token.graduated && event.params.tick <= POOL_USDG_TICK_GRADUATION) {
    token.graduated = true;
    token.graduatedAt = event.block.timestamp;
    const p = getProtocol();
    p.graduatedCount = p.graduatedCount + 1;
    p.save();
  }

  const trader = event.transaction.from;
  const account = getAccount(trader, event.block.timestamp);
  const balance = getBalance(token, account);

  if (isBuy) {
    if (balance.amount.equals(ZERO)) {
      token.buyerCount = token.buyerCount + 1;
    }
    balance.amount = balance.amount.plus(tokens);
    balance.costBasis = balance.costBasis.plus(usdg);
  } else {
    if (balance.amount.gt(ZERO)) {
      const sold = tokens.gt(balance.amount) ? balance.amount : tokens;
      const costOut = balance.costBasis.times(sold).div(balance.amount);
      balance.realisedPnl = balance.realisedPnl.plus(usdg.minus(costOut));
      balance.costBasis = balance.costBasis.minus(costOut);
      balance.amount = balance.amount.minus(sold);
    }
  }
  balance.save();

  account.tradeCount = account.tradeCount + 1;
  account.volume = account.volume.plus(usdg);
  account.save();

  const trade = new Trade(tradeId(event));
  trade.token = token.id;
  trade.account = trader;
  trade.isBuy = isBuy;
  trade.usdc = usdg;
  trade.tokens = tokens;
  trade.fee = fee;
  trade.priceAfter = token.price;
  trade.timestamp = event.block.timestamp;
  trade.block = event.block.number;
  trade.tx = event.transaction.hash;
  trade.save();

  token.save();
  updateCandles(token, token.price, usdg, event.block.timestamp);

  const protocol = getProtocol();
  protocol.tradeCount = protocol.tradeCount + 1;
  protocol.totalVolume = protocol.totalVolume.plus(usdg);
  protocol.save();
}

/** The whole fee a trade paid, before it is split up the tree. */
export function handleFeeTaken(event: FeeTaken): void {
  const token = Token.load(event.params.token.toHexString());
  if (token == null) return;

  const protocol = getProtocol();
  protocol.totalFees = protocol.totalFees.plus(event.params.usdc);
  protocol.save();
}

/**
 * One share of a fee. Level 0 is the creator's root cut — the one share
 * that is the coin's creator's by virtue of creating it, so it is what the
 * coin page's "creator earned" shows. Shares further up an invite chain are
 * the inviters' and are read live from the vault, not indexed per coin.
 */
export function handleCredited(event: Credited): void {
  if (event.params.level != 0) return;
  const token = Token.load(event.params.token.toHexString());
  if (token == null) return;
  token.creatorFeesEarned = token.creatorFeesEarned.plus(event.params.usdc);
  token.save();
}

/** The gross a buyer paid, given the net that reached the pool. See pool.ts. */
function grossFromNet(net: BigInt, feeBps: BigInt): BigInt {
  let gross = net.times(BPS_DENOMINATOR).div(BPS_DENOMINATOR.minus(feeBps));
  while (gross.gt(ZERO) && netOfGross(gross, feeBps).gt(net)) {
    gross = gross.minus(ONE);
  }
  while (netOfGross(gross.plus(ONE), feeBps).le(net)) {
    gross = gross.plus(ONE);
  }
  return gross;
}

function netOfGross(gross: BigInt, feeBps: BigInt): BigInt {
  return gross.minus(gross.times(feeBps).div(BPS_DENOMINATOR));
}

/**
 * Spot price in USDG per token, 18-decimal fixed point, from a v4 pool's
 * sqrtPriceX96.
 *
 * pool.ts's priceFromSqrtX96 assumes both currencies carry 18 decimals,
 * which is only true of native USDC. USDG has 6, so the raw price the pool
 * reports needs the same 10^12 correction script/math/derive_pool_usdg.py
 * applies to the tick constants:
 *
 *     price = USDG_DECIMAL_FACTOR * WAD * 2^192 / sqrtPriceX96^2
 *
 * Without it a $69,000 market cap would show as $0.000000069.
 */
export function priceFromSqrtX96Usdg(sqrtPriceX96: BigInt): BigInt {
  if (sqrtPriceX96.equals(ZERO)) return ZERO;
  return USDG_DECIMAL_FACTOR.times(WAD).times(Q192).div(sqrtPriceX96.times(sqrtPriceX96));
}
