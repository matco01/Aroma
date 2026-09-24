import {
  assert,
  describe,
  test,
  clearStore,
  beforeEach,
  newMockEvent,
} from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { TokenCreated } from "../generated/ClubFactoryUsdg/ClubFactoryUsdg";
import { Swap } from "../generated/PoolManager/PoolManager";
import { FeeTaken, Credited } from "../generated/ClubVaultUsdg/ClubVaultUsdg";
import {
  handleTokenCreated,
  handleSwap,
  handleFeeTaken,
  handleCredited,
} from "../src/club-usdg";

/**
 * Unit tests for Robinhood Chain's club-usdg mappings — see pool.test.ts's own header for
 * why these three things (swap sign convention, gross-from-net
 * reconstruction, cost-basis carry) are worth pinning down: none of them
 * fail to compile or throw when wrong, they just produce a plausible-looking
 * board that's quietly incorrect.
 *
 * The one thing genuinely different from pool.test.ts: every USDG amount
 * here is sized like a real 6-decimal amount (e.g. "100000000" for 100 USDG),
 * not the 18-decimal magnitudes native USDC uses, every fee is a club coin's
 * 1.5% rather than 1%, and SQRT_AT_INIT/
 * PRICE_AT_INIT are recomputed for the USDG tick constants and the
 * 10^12 decimal correction priceFromSqrtX96Usdg applies. Reusing the native
 * test's numbers here would silently test the wrong thing.
 */

const TOKEN = Address.fromString("0x1111111111111111111111111111111111111111");
const CREATOR = Address.fromString("0x2222222222222222222222222222222222222222");
const TRADER = Address.fromString("0x3333333333333333333333333333333333333333");
const ROUTER = Address.fromString("0x4444444444444444444444444444444444444444");
const POOL_ID = Bytes.fromHexString(
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
const OTHER_POOL_ID = Bytes.fromHexString(
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
);

/** sqrtPriceX96 and the WAD price at ClubVaultUsdg's TICK_INIT (399,870). */
const SQRT_AT_INIT = "38151549679843848184410015836849485153";
const PRICE_AT_INIT = "4312556529721";
/** ...and at TICK_GRADUATION (372,142). */
const SQRT_AT_GRADUATION = "9537540976788860775081690540159831255";

const TICK_INIT = 399870;
const TICK_GRADUATION = 372142;

let nextLogIndex: i32 = 1;

function bi(v: string): BigInt {
  return BigInt.fromString(v);
}

function createTokenCreatedEvent(): TokenCreated {
  const e = changetype<TokenCreated>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(TOKEN)));
  e.parameters.push(new ethereum.EventParam("creator", ethereum.Value.fromAddress(CREATOR)));
  e.parameters.push(new ethereum.EventParam("poolId", ethereum.Value.fromFixedBytes(POOL_ID)));
  e.parameters.push(new ethereum.EventParam("name", ethereum.Value.fromString("Aroma Coin")));
  e.parameters.push(new ethereum.EventParam("symbol", ethereum.Value.fromString("AROMA")));
  e.parameters.push(new ethereum.EventParam("description", ethereum.Value.fromString("a coin")));
  e.parameters.push(new ethereum.EventParam("metadataUri", ethereum.Value.fromString("ipfs://x")));
  e.parameters.push(
    new ethereum.EventParam("devBuyUsdc", ethereum.Value.fromUnsignedBigInt(BigInt.zero())),
  );
  return e;
}

function createSwapEvent(
  poolId: Bytes,
  amount0: BigInt,
  amount1: BigInt,
  sqrtPriceX96: string,
  tick: i32,
): Swap {
  const e = changetype<Swap>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("id", ethereum.Value.fromFixedBytes(poolId)));
  e.parameters.push(new ethereum.EventParam("sender", ethereum.Value.fromAddress(ROUTER)));
  e.parameters.push(new ethereum.EventParam("amount0", ethereum.Value.fromSignedBigInt(amount0)));
  e.parameters.push(new ethereum.EventParam("amount1", ethereum.Value.fromSignedBigInt(amount1)));
  e.parameters.push(
    new ethereum.EventParam("sqrtPriceX96", ethereum.Value.fromUnsignedBigInt(bi(sqrtPriceX96))),
  );
  e.parameters.push(
    new ethereum.EventParam("liquidity", ethereum.Value.fromUnsignedBigInt(bi("1000"))),
  );
  e.parameters.push(new ethereum.EventParam("tick", ethereum.Value.fromI32(tick)));
  e.parameters.push(new ethereum.EventParam("fee", ethereum.Value.fromI32(0)));
  e.transaction.from = TRADER;
  e.logIndex = BigInt.fromI32(nextLogIndex);
  nextLogIndex++;
  return e;
}

function createFeeTakenEvent(usdc: BigInt): FeeTaken {
  const e = changetype<FeeTaken>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(TOKEN)));
  e.parameters.push(new ethereum.EventParam("trader", ethereum.Value.fromAddress(TRADER)));
  e.parameters.push(new ethereum.EventParam("usdc", ethereum.Value.fromUnsignedBigInt(usdc)));
  return e;
}

function createCreditedEvent(account: Address, level: i32, usdc: BigInt): Credited {
  const e = changetype<Credited>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(TOKEN)));
  e.parameters.push(new ethereum.EventParam("account", ethereum.Value.fromAddress(account)));
  e.parameters.push(new ethereum.EventParam("level", ethereum.Value.fromI32(level)));
  e.parameters.push(new ethereum.EventParam("usdc", ethereum.Value.fromUnsignedBigInt(usdc)));
  return e;
}

const TOKEN_ID = TOKEN.toHexString();

/** The token side of a 100-USDG buy. 18-decimal, same as the launched token everywhere. */
const TOKENS_OUT = bi("22472630624944238063672500");

function launch(): void {
  handleTokenCreated(createTokenCreatedEvent());
}

/** A 100 USDG buy: the hook took 1.5 USDG, so 98.5 reached the pool. */
function buy100(): string {
  const e = createSwapEvent(POOL_ID, bi("-98500000"), TOKENS_OUT, SQRT_AT_INIT, TICK_INIT - 400);
  handleSwap(e);
  return tradeIdOf(e);
}

/** A 50 USDG sell of half the position. The event reports the gross. */
function sellHalf(): string {
  const e = createSwapEvent(
    POOL_ID,
    bi("50000000"),
    TOKENS_OUT.div(BigInt.fromI32(2)).neg(),
    SQRT_AT_INIT,
    TICK_INIT - 200,
  );
  handleSwap(e);
  return tradeIdOf(e);
}

describe("club-usdg launches", () => {
  beforeEach(() => {
    clearStore();
    nextLogIndex = 1;
  });

  test("a launch records a club coin, its fee and its pool", () => {
    launch();

    assert.entityCount("Token", 1);
    assert.fieldEquals("Token", TOKEN_ID, "venue", "club");
    assert.fieldEquals("Token", TOKEN_ID, "tradeFeeBps", "150");
    assert.fieldEquals("Token", TOKEN_ID, "symbol", "AROMA");
    assert.fieldEquals("Token", TOKEN_ID, "poolId", POOL_ID.toHexString());
    assert.entityCount("PoolRef", 1);
    assert.fieldEquals("PoolRef", POOL_ID.toHexString(), "token", TOKEN_ID);
    assert.fieldEquals("Protocol", "Aroma", "tokenCount", "1");
  });

  test("a swap in someone else's v4 pool is ignored", () => {
    launch();
    handleSwap(
      createSwapEvent(OTHER_POOL_ID, bi("-98500000"), TOKENS_OUT, SQRT_AT_INIT, TICK_INIT),
    );
    assert.entityCount("Trade", 0);
    assert.fieldEquals("Token", TOKEN_ID, "tradeCount", "0");
  });
});

describe("buys", () => {
  beforeEach(() => {
    clearStore();
    nextLogIndex = 1;
    launch();
  });

  test("a negative currency0 delta is a buy", () => {
    const id = buy100();
    assert.entityCount("Trade", 1);
    assert.fieldEquals("Trade", id, "isBuy", "true");
  });

  test("the buyer's gross is recovered from the net that reached the pool", () => {
    const id = buy100();
    assert.fieldEquals("Trade", id, "usdc", "100000000");
    assert.fieldEquals("Trade", id, "fee", "1500000");
    assert.fieldEquals("Trade", id, "tokens", TOKENS_OUT.toString());
  });

  test("reserve tracks what reached the pool, not what the buyer paid", () => {
    buy100();
    assert.fieldEquals("Token", TOKEN_ID, "reserve", "98500000");
    assert.fieldEquals("Token", TOKEN_ID, "tokensSold", TOKENS_OUT.toString());
    assert.fieldEquals("Token", TOKEN_ID, "volume", "100000000");
  });

  test("price comes from the pool's sqrt price, corrected for USDG's 6 decimals", () => {
    handleSwap(createSwapEvent(POOL_ID, bi("-98500000"), TOKENS_OUT, SQRT_AT_INIT, TICK_INIT));
    // Without the 10^12 correction this would read ~4312.56, not
    // $4,312.556529721 — off by exactly that factor, not merely wrong.
    assert.fieldEquals("Token", TOKEN_ID, "price", PRICE_AT_INIT);
    assert.fieldEquals("Token", TOKEN_ID, "marketCap", "4312556529721000000000");
  });

  test("the position is credited to the trader, not the router", () => {
    buy100();
    const balanceId = TOKEN_ID + "-" + TRADER.toHexString();
    assert.fieldEquals("Balance", balanceId, "amount", TOKENS_OUT.toString());
    assert.fieldEquals("Balance", balanceId, "costBasis", "100000000");
    assert.entityCount("Balance", 1);
    assert.fieldEquals("Token", TOKEN_ID, "buyerCount", "1");
  });

  test("candles are written for every interval", () => {
    buy100();
    assert.entityCount("Candle", 3);
  });
});

describe("sells", () => {
  beforeEach(() => {
    clearStore();
    nextLogIndex = 1;
    launch();
    buy100();
  });

  test("a positive currency0 delta is a sell, net of the fee", () => {
    const id = sellHalf();
    assert.entityCount("Trade", 2);
    assert.fieldEquals("Trade", id, "isBuy", "false");
    assert.fieldEquals("Trade", id, "usdc", "49250000");
    assert.fieldEquals("Trade", id, "fee", "750000");
  });

  test("a partial sell carries cost basis proportionally", () => {
    sellHalf();
    const balanceId = TOKEN_ID + "-" + TRADER.toHexString();
    assert.fieldEquals("Balance", balanceId, "amount", TOKENS_OUT.div(BigInt.fromI32(2)).toString());
    assert.fieldEquals("Balance", balanceId, "costBasis", "50000000");
    assert.fieldEquals("Balance", balanceId, "realisedPnl", "-750000");
  });

  test("selling reduces the reserve by the gross that left the pool", () => {
    sellHalf();
    assert.fieldEquals("Token", TOKEN_ID, "reserve", "48500000");
  });
});

describe("graduation", () => {
  beforeEach(() => {
    clearStore();
    nextLogIndex = 1;
    launch();
  });

  test("reaching the graduation tick graduates the token", () => {
    handleSwap(
      createSwapEvent(POOL_ID, bi("-13800000000"), TOKENS_OUT, SQRT_AT_GRADUATION, TICK_GRADUATION),
    );
    assert.fieldEquals("Token", TOKEN_ID, "graduated", "true");
    assert.fieldEquals("Protocol", "Aroma", "graduatedCount", "1");
  });

  test("graduation latches when the price falls back", () => {
    handleSwap(
      createSwapEvent(POOL_ID, bi("-13800000000"), TOKENS_OUT, SQRT_AT_GRADUATION, TICK_GRADUATION),
    );
    handleSwap(
      createSwapEvent(
        POOL_ID,
        bi("1000000"),
        TOKENS_OUT.neg(),
        SQRT_AT_INIT,
        TICK_GRADUATION + 500,
      ),
    );
    assert.fieldEquals("Token", TOKEN_ID, "graduated", "true");
    assert.fieldEquals("Protocol", "Aroma", "graduatedCount", "1");
  });

  test("a tick above graduation does not graduate", () => {
    buy100();
    assert.fieldEquals("Token", TOKEN_ID, "graduated", "false");
  });
});

describe("fees", () => {
  beforeEach(() => {
    clearStore();
    nextLogIndex = 1;
    launch();
  });

  test("the hook's own event is what settles the protocol's fee total", () => {
    handleFeeTaken(createFeeTakenEvent(bi("1500000")));
    assert.fieldEquals("Protocol", "Aroma", "totalFees", "1500000");
  });

  test("the creator earns the root cut, not the tree's shares", () => {
    handleCredited(createCreditedEvent(CREATOR, 0, bi("100000")));
    handleCredited(createCreditedEvent(TRADER, 1, bi("733333")));
    assert.fieldEquals("Token", TOKEN_ID, "creatorFeesEarned", "100000");
  });

  test("a fee for a token we never saw launched is ignored", () => {
    clearStore();
    handleFeeTaken(createFeeTakenEvent(bi("1500000")));
    handleCredited(createCreditedEvent(CREATOR, 0, bi("100000")));
    assert.entityCount("Token", 0);
  });
});

// --- helpers -----------------------------------------------------------

function tradeIdOf(e: ethereum.Event): string {
  return e.transaction.hash.toHexString() + "-" + e.logIndex.toString();
}
