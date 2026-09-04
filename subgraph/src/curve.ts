import { BigInt } from "@graphprotocol/graph-ts";
import { Bought, Sold, Graduated } from "../generated/CurveManager/CurveManager";
import { Trade } from "../generated/schema";
import {
  spotPrice,
  marketCapOf,
  progressBpsOf,
  getOrCreateToken,
  getAccount,
  getBalance,
  getProtocol,
  updateCandles,
  tradeId,
} from "./shared";
import { ZERO } from "./constants";

/**
 * Every buy and sell in the protocol lands here — CurveManager is shared
 * across all tokens, so this is the hot path.
 *
 * Each handler does the work the frontend used to do per render: advance
 * curve state, recompute price and market cap, fold a candle, and carry
 * cost basis forward.
 */

export function handleBought(event: Bought): void {
  // Load-or-create rather than bail: a trade for a token we have not seen
  // announced is a gap in the index, not a reason to discard the trade.
  const token = getOrCreateToken(
    event.params.token,
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
  );

  // `fee` is the WHOLE trade fee; `creatorFee` is the creator's share *of
  // that fee*, not an extra charge on top. Adding them double-counts the
  // creator's 70% — which understated every reserve and inflated protocol
  // fees by 70%. The contract is the authority here:
  //     fee = msg.value * TRADE_FEE_BPS / FEE_DENOMINATOR
  //     usdcInNet = msg.value - fee
  //     creatorFee = fee * CREATOR_FEE_SHARE_BPS / FEE_DENOMINATOR
  const grossIn = event.params.usdcIn;
  const totalFee = event.params.fee;
  const netIn = grossIn.minus(totalFee);
  const tokensOut = event.params.tokensOut;

  token.reserve = token.reserve.plus(netIn);
  token.tokensSold = token.tokensSold.plus(tokensOut);
  token.price = spotPrice(token.reserve, token.tokensSold);
  token.marketCap = marketCapOf(token.price);
  token.progressBps = progressBpsOf(token.reserve);
  token.volume = token.volume.plus(grossIn);
  token.tradeCount = token.tradeCount + 1;

  const account = getAccount(event.params.recipient, event.block.timestamp);
  const balance = getBalance(token, account);
  // First time this account holds this token — counts as a new holder.
  if (balance.amount.equals(ZERO)) {
    token.buyerCount = token.buyerCount + 1;
  }
  balance.amount = balance.amount.plus(tokensOut);
  balance.costBasis = balance.costBasis.plus(grossIn);
  balance.save();

  account.tradeCount = account.tradeCount + 1;
  account.volume = account.volume.plus(grossIn);
  account.save();

  const trade = new Trade(tradeId(event));
  trade.token = token.id;
  trade.account = event.params.recipient;
  trade.isBuy = true;
  trade.usdc = grossIn;
  trade.tokens = tokensOut;
  trade.fee = totalFee;
  trade.priceAfter = token.price;
  trade.timestamp = event.block.timestamp;
  trade.block = event.block.number;
  trade.tx = event.transaction.hash;
  trade.save();

  token.save();
  updateCandles(token, token.price, grossIn, event.block.timestamp);

  const protocol = getProtocol();
  protocol.tradeCount = protocol.tradeCount + 1;
  protocol.totalVolume = protocol.totalVolume.plus(grossIn);
  protocol.totalFees = protocol.totalFees.plus(totalFee);
  protocol.save();
}

export function handleSold(event: Sold): void {
  const token = getOrCreateToken(
    event.params.token,
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
  );

  // Mirror of the buy path: `fee` is the whole fee, `creatorFee` a share of
  // it. The contract takes usdcOutGross off the reserve and hands the seller
  // usdcOutGross - fee, so what actually left the curve is netOut + fee.
  const netOut = event.params.usdcOut;
  const totalFee = event.params.fee;
  const grossOut = netOut.plus(totalFee);
  const tokensIn = event.params.tokensIn;

  token.reserve = token.reserve.minus(grossOut);
  token.tokensSold = token.tokensSold.minus(tokensIn);
  token.price = spotPrice(token.reserve, token.tokensSold);
  token.marketCap = marketCapOf(token.price);
  token.progressBps = progressBpsOf(token.reserve);
  token.volume = token.volume.plus(netOut);
  token.tradeCount = token.tradeCount + 1;

  const account = getAccount(event.params.seller, event.block.timestamp);
  const balance = getBalance(token, account);

  // Average-cost basis: the portion of basis leaving is proportional to the
  // portion of tokens leaving, so a partial sell doesn't distort what
  // remains. Realised P&L is proceeds minus the basis that left with them.
  if (balance.amount.gt(ZERO)) {
    let sold = tokensIn;
    if (sold.gt(balance.amount)) sold = balance.amount;
    const basisOut = balance.costBasis.times(sold).div(balance.amount);
    balance.costBasis = balance.costBasis.minus(basisOut);
    balance.realisedPnl = balance.realisedPnl.plus(netOut.minus(basisOut));
    balance.amount = balance.amount.minus(sold);
  }
  balance.save();

  account.tradeCount = account.tradeCount + 1;
  account.volume = account.volume.plus(netOut);
  account.save();

  const trade = new Trade(tradeId(event));
  trade.token = token.id;
  trade.account = event.params.seller;
  trade.isBuy = false;
  trade.usdc = netOut;
  trade.tokens = tokensIn;
  trade.fee = totalFee;
  trade.priceAfter = token.price;
  trade.timestamp = event.block.timestamp;
  trade.block = event.block.number;
  trade.tx = event.transaction.hash;
  trade.save();

  token.save();
  updateCandles(token, token.price, netOut, event.block.timestamp);

  const protocol = getProtocol();
  protocol.tradeCount = protocol.tradeCount + 1;
  protocol.totalVolume = protocol.totalVolume.plus(netOut);
  protocol.totalFees = protocol.totalFees.plus(totalFee);
  protocol.save();
}

export function handleGraduated(event: Graduated): void {
  const token = getOrCreateToken(
    event.params.token,
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
  );

  token.graduated = true;
  token.graduatedAt = event.block.timestamp;
  token.progressBps = 10000;
  // The reserve physically leaves the contract at graduation; leaving a
  // number here would claim backing that no longer exists, the same bug
  // the contract itself had before it zeroed realUsdcReserve.
  token.reserve = ZERO;
  token.save();

  const protocol = getProtocol();
  protocol.graduatedCount = protocol.graduatedCount + 1;
  protocol.save();
}
