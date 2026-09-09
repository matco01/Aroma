import { BigInt } from "@graphprotocol/graph-ts";
import { TokenCreated } from "../generated/PoolFactory/PoolFactory";
import { Swap } from "../generated/PoolManager/PoolManager";
import { FeeTaken, CreatorFeesClaimed } from "../generated/PoolVault/PoolVault";
import { Trade, Token, PoolRef } from "../generated/schema";
import {
  marketCapOf,
  progressBpsOf,
  priceFromSqrtX96,
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
  POOL_TICK_GRADUATION,
  VENUE_POOL,
} from "./constants";

/**
 * The pool launch mechanism's mappings.
 *
 * These write exactly the same entities as the curve mappings — Token,
 * Trade, Balance, Candle, Protocol — so the board, the API and the DEX
 * Screener adapter all work across both venues without knowing which
 * produced a row. `Token.venue` is the only thing that distinguishes them,
 * and it exists for labelling rather than for branching.
 *
 * Three things here have no analogue on the curve side, and each is a place
 * to be careful:
 *
 *   1. v4 is a singleton. Every swap on the whole chain reaches handleSwap,
 *      identified only by PoolId, so the first thing it does is discard the
 *      ones that are not ours.
 *
 *   2. The Swap event's `sender` is the router, not the trader.
 *
 *   3. The Swap event's amounts are net of the hook's fee on a buy and
 *      gross of it on a sell, because the hook charges before the swap in
 *      one direction and after it in the other.
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

  // The reverse index handleSwap needs. Immutable: a pool's identity is its
  // key, and a key cannot be reassigned to a different token.
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

/**
 * Every swap in every Uniswap v4 pool on the chain arrives here.
 *
 * That is not a design choice, it is what a singleton pool manager means:
 * there is one contract and one event, and the only way to tell an Aroma
 * pool from any other is to look the PoolId up. The load-and-return below
 * is the hot path for the whole subgraph and is deliberately the first
 * thing that happens.
 */
export function handleSwap(event: Swap): void {
  const ref = PoolRef.load(event.params.id.toHexString());
  if (ref == null) return;
  const token = Token.load(ref.token);
  if (token == null) return;

  // Both amounts are the *swapper's* deltas: negative is paid, positive is
  // received. The event's own NatSpec says "the delta of the currency0
  // balance of the pool", which is the opposite sign — PoolManager emits
  // `delta` straight from `pool.swap`, which is the caller's. Verified
  // against a real swap rather than taken from the comment.
  const amount0 = event.params.amount0; // native USDC, currency0
  const amount1 = event.params.amount1; // the launched token, currency1
  const isBuy = amount0.lt(ZERO);

  let usdc = ZERO; // what the trader actually put in or took out
  let tokens = ZERO;
  let fee = ZERO;
  let reserveDelta = ZERO;

  if (isBuy) {
    // The hook charges in beforeSwap, so what reached the pool is already
    // net of the fee. Recover the gross the buyer parted with.
    const net = amount0.neg();
    fee = grossFromNet(net).minus(net);
    usdc = net.plus(fee);
    tokens = amount1;
    reserveDelta = net;
  } else {
    // The hook charges in afterSwap, so the event shows the gross leaving
    // the pool and the seller receives that less the fee.
    const gross = amount0;
    fee = gross.times(TRADE_FEE_BPS).div(BPS_DENOMINATOR);
    usdc = gross.minus(fee);
    tokens = amount1.neg();
    reserveDelta = gross.neg();
  }

  token.reserve = token.reserve.plus(reserveDelta);
  token.tokensSold = isBuy
    ? token.tokensSold.plus(tokens)
    : token.tokensSold.minus(tokens);
  // Price comes from the pool's own post-swap sqrt price rather than from a
  // reserve ratio. On the curve those agree by construction; here the pool
  // is the authority and reserve is only a running total.
  token.price = priceFromSqrtX96(event.params.sqrtPriceX96);
  token.marketCap = marketCapOf(token.price);
  token.progressBps = progressBpsOf(token.reserve);
  token.volume = token.volume.plus(usdc);
  token.tradeCount = token.tradeCount + 1;
  token.lastTradeAt = event.block.timestamp;

  // Graduation latches. The contract's `graduated()` view is instantaneous
  // — it reads the current tick — so a coin that falls back below the
  // graduation price stops reporting graduated on-chain. In the index it
  // means "this coin made it", which is not a thing that should un-happen,
  // and it keeps the field meaning the same as it does for curve launches
  // where graduation genuinely is irreversible.
  if (!token.graduated && event.params.tick <= POOL_TICK_GRADUATION) {
    token.graduated = true;
    token.graduatedAt = event.block.timestamp;
    const p = getProtocol();
    p.graduatedCount = p.graduatedCount + 1;
    p.save();
  }

  // `event.params.sender` is the router that called swap, not the person
  // who signed for it, so it is useless for per-account positions — every
  // trade through one router would collapse into a single balance. The
  // transaction sender is the closest thing to the trader that a v4 swap
  // exposes. It is wrong for smart-contract wallets and bundlers, which is
  // a real limitation and the reason the curve's own `recipient` parameter
  // was worth having.
  const trader = event.transaction.from;
  const account = getAccount(trader, event.block.timestamp);
  const balance = getBalance(token, account);

  if (isBuy) {
    if (balance.amount.equals(ZERO)) {
      token.buyerCount = token.buyerCount + 1;
    }
    balance.amount = balance.amount.plus(tokens);
    balance.costBasis = balance.costBasis.plus(usdc);
  } else {
    // Average-cost basis, matching the curve path: the sold fraction of the
    // position takes the same fraction of its cost with it.
    if (balance.amount.gt(ZERO)) {
      const sold = tokens.gt(balance.amount) ? balance.amount : tokens;
      const costOut = balance.costBasis.times(sold).div(balance.amount);
      balance.realisedPnl = balance.realisedPnl.plus(usdc.minus(costOut));
      balance.costBasis = balance.costBasis.minus(costOut);
      balance.amount = balance.amount.minus(sold);
    }
  }
  balance.save();

  account.tradeCount = account.tradeCount + 1;
  account.volume = account.volume.plus(usdc);
  account.save();

  const trade = new Trade(tradeId(event));
  trade.token = token.id;
  trade.account = trader;
  trade.isBuy = isBuy;
  trade.usdc = usdc;
  trade.tokens = tokens;
  trade.fee = fee;
  trade.priceAfter = token.price;
  trade.timestamp = event.block.timestamp;
  trade.block = event.block.number;
  trade.tx = event.transaction.hash;
  trade.save();

  token.save();
  updateCandles(token, token.price, usdc, event.block.timestamp);

  const protocol = getProtocol();
  protocol.tradeCount = protocol.tradeCount + 1;
  protocol.totalVolume = protocol.totalVolume.plus(usdc);
  protocol.save();
}

/**
 * The authoritative fee record.
 *
 * `Trade.fee` above is reconstructed from the swap amounts and is right to
 * within a wei; this is the number the hook actually took. Fee totals are
 * kept from this event rather than by summing trades, because those are the
 * figures a creator is owed against.
 */
export function handleFeeTaken(event: FeeTaken): void {
  const token = Token.load(event.params.token.toHexString());
  if (token == null) return;

  const creatorShare = event.params.usdc.times(CREATOR_FEE_SHARE_BPS).div(BPS_DENOMINATOR);
  token.creatorFeesEarned = token.creatorFeesEarned.plus(creatorShare);
  token.save();

  const protocol = getProtocol();
  protocol.totalFees = protocol.totalFees.plus(event.params.usdc);
  protocol.save();
}

export function handleCreatorFeesClaimed(event: CreatorFeesClaimed): void {
  const token = Token.load(event.params.token.toHexString());
  if (token == null) return;
  token.creatorFeesClaimed = token.creatorFeesClaimed.plus(event.params.usdc);
  token.save();
}

/**
 * Recover a buy's gross USDC from the net that reached the pool.
 *
 * The hook takes `floor(gross * 100 / 10000)`, so with gross = 100q + r and
 * 0 <= r < 100, the pool sees net = 99q + r. Inverting that is right except
 * where r is 99: gross = 100q + 99 and gross = 100(q + 1) both produce
 * net = 99(q + 1), so one net in a hundred has two pre-images and this
 * returns the larger. The error is one wei on an 18-decimal amount, and it
 * only ever reaches `Trade.fee` and `Trade.usdc` — never a balance, and
 * never the fee ledger, which comes from the hook's own FeeTaken event.
 */
function grossFromNet(net: BigInt): BigInt {
  const ninetyNine = BigInt.fromI32(99);
  const hundred = BigInt.fromI32(100);
  const q = net.div(ninetyNine);
  const r = net.minus(q.times(ninetyNine));
  return q.times(hundred).plus(r);
}
