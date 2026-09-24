import { BigInt } from "@graphprotocol/graph-ts";
import { TokenCreated } from "../generated/PoolFactoryUsdg/PoolFactoryUsdg";
import { Swap } from "../generated/PoolManager/PoolManager";
import { FeeTaken, CreatorFeesClaimed } from "../generated/PoolVaultUsdg/PoolVaultUsdg";
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
  TRADE_FEE_BPS,
  BPS_DENOMINATOR,
  CREATOR_FEE_SHARE_BPS,
  POOL_USDG_TICK_GRADUATION,
  USDG_DECIMAL_FACTOR,
  VENUE_POOL,
  WAD,
  Q192,
} from "./constants";

/**
 * The pool-usdg launch mechanism's mappings — Robinhood Chain, USDG instead
 * of Arc's native USDC. Structurally identical to pool.ts (same events, same
 * entities, same singleton-PoolManager caveats — see that file's own header
 * for the three things worth being careful about), because `PoolFactoryUsdg`/
 * `PoolVaultUsdg` emit the exact same event shapes `PoolFactory`/`PoolVault`
 * do. The one real difference is decimals: USDG is 6-decimal, not the
 * 18-decimal view native USDC gets for free, so the tick-to-price conversion
 * needs the correction `priceFromSqrtX96UsdG` applies and `pool.ts`'s
 * `priceFromSqrtX96` does not.
 *
 * Writes `venue = "pool"`, the same value the native pool system uses — see
 * schema.graphql's own note on `Token.venue` for why a club-launched coin
 * doesn't get a third venue value.
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
  token.venue = VENUE_POOL;
  token.poolId = event.params.poolId;
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
    const net = amount0.neg();
    fee = grossFromNet(net).minus(net);
    usdg = net.plus(fee);
    tokens = amount1;
    reserveDelta = net;
  } else {
    const gross = amount0;
    fee = gross.times(TRADE_FEE_BPS).div(BPS_DENOMINATOR);
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
  token.progressBps = progressBpsOf(token.reserve);
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

export function handleFeeTaken(event: FeeTaken): void {
  const token = Token.load(event.params.token.toHexString());
  if (token == null) return;

  const creatorShare = event.params.usdg.times(CREATOR_FEE_SHARE_BPS).div(BPS_DENOMINATOR);
  token.creatorFeesEarned = token.creatorFeesEarned.plus(creatorShare);
  token.save();

  const protocol = getProtocol();
  protocol.totalFees = protocol.totalFees.plus(event.params.usdg);
  protocol.save();
}

export function handleCreatorFeesClaimed(event: CreatorFeesClaimed): void {
  const token = Token.load(event.params.token.toHexString());
  if (token == null) return;
  token.creatorFeesClaimed = token.creatorFeesClaimed.plus(event.params.usdg);
  token.save();
}

/** Same reconstruction pool.ts's grossFromNet does — see that function's comment. */
function grossFromNet(net: BigInt): BigInt {
  const ninetyNine = BigInt.fromI32(99);
  const hundred = BigInt.fromI32(100);
  const q = net.div(ninetyNine);
  const r = net.minus(q.times(ninetyNine));
  return q.times(hundred).plus(r);
}

/**
 * Spot price in USDG per token, 18-decimal fixed point, from a v4 pool's
 * sqrtPriceX96.
 *
 * pool.ts's priceFromSqrtX96 assumes both currencies carry 18 decimals,
 * which is only true of native USDC. USDG is 6-decimal (confirmed against
 * Paxos's deployed contract), so the raw price the pool reports —
 * token-raw-units per USDG-raw-unit — needs the same 10^12 correction
 * script/math/derive_pool_usdg.py applies to the tick constants themselves:
 *
 *     price = USDG_DECIMAL_FACTOR * WAD * 2^192 / sqrtPriceX96^2
 *
 * Dropping this factor doesn't produce a merely-wrong number, it produces
 * one off by exactly 10^12 — a $69,000 market cap would show as $0.000000069.
 */
export function priceFromSqrtX96Usdg(sqrtPriceX96: BigInt): BigInt {
  if (sqrtPriceX96.equals(ZERO)) return ZERO;
  return USDG_DECIMAL_FACTOR.times(WAD).times(Q192).div(sqrtPriceX96.times(sqrtPriceX96));
}
