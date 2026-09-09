import {
  assert,
  describe,
  test,
  clearStore,
  beforeEach,
  newMockEvent,
} from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { TokenCreated } from "../generated/PoolFactory/PoolFactory";
import { Swap } from "../generated/PoolManager/PoolManager";
import { FeeTaken, CreatorFeesClaimed } from "../generated/PoolVault/PoolVault";
import {
  handleTokenCreated,
  handleSwap,
  handleFeeTaken,
  handleCreatorFeesClaimed,
} from "../src/pool";

/**
 * Unit tests for the pool mappings.
 *
 * These exist because the three things most likely to be wrong here are all
 * silent when wrong: the swap amounts' sign convention, the reconstruction of
 * a buy's gross from the net that reached the pool, and the cost-basis carry
 * on a partial sell. None of them fail to compile, none throw, and each one
 * produces a plausible-looking board that is simply incorrect.
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

/** sqrtPriceX96 and the WAD price at PoolVault's TICK_INIT (123,546). */
const SQRT_AT_INIT = "38151600112934443872199254736162";
const PRICE_AT_INIT = "4312545128081";
/** ...and at TICK_GRADUATION (95,818). */
const SQRT_AT_GRADUATION = "9537553584603541409201579820015";

const TICK_INIT = 123546;
const TICK_GRADUATION = 95818;

const WAD = BigInt.fromString("1000000000000000000");

/**
 * Every mock event matchstick hands out carries the same transaction hash
 * and log index, so two trades in one test would share a Trade id and the
 * second would silently overwrite the first. On a real chain that cannot
 * happen. Handing out distinct log indices keeps the ids unique the way
 * they actually are, so a test that creates two trades sees two.
 */
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
  // Deliberately the router, not the trader — that is what v4 puts here, and
  // the mapping has to ignore it in favour of the transaction sender.
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
  e.parameters.push(new ethereum.EventParam("usdc", ethereum.Value.fromUnsignedBigInt(usdc)));
  return e;
}

function createCreatorFeesClaimedEvent(usdc: BigInt): CreatorFeesClaimed {
  const e = changetype<CreatorFeesClaimed>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(TOKEN)));
  e.parameters.push(new ethereum.EventParam("creator", ethereum.Value.fromAddress(CREATOR)));
  e.parameters.push(new ethereum.EventParam("usdc", ethereum.Value.fromUnsignedBigInt(usdc)));
  return e;
}

const TOKEN_ID = TOKEN.toHexString();

/** The token side of a 100-USDC buy. The exact figure does not matter. */
const TOKENS_OUT = bi("22472630624944238063672500");

function launch(): void {
  handleTokenCreated(createTokenCreatedEvent());
}

/** A 100 USDC buy: the hook took 1, so 99 reached the pool. */
function buy100(): string {
  const e = createSwapEvent(
    POOL_ID,
    bi("-99000000000000000000"),
    TOKENS_OUT,
    SQRT_AT_INIT,
    TICK_INIT - 400,
  );
  handleSwap(e);
  return tradeIdOf(e);
}

/** A 50 USDC sell of half the position. The event reports the gross. */
function sellHalf(): string {
  const e = createSwapEvent(
    POOL_ID,
    bi("50000000000000000000"),
    TOKENS_OUT.div(BigInt.fromI32(2)).neg(),
    SQRT_AT_INIT,
    TICK_INIT - 200,
  );
  handleSwap(e);
  return tradeIdOf(e);
}

describe("pool launches", () => {
  beforeEach(() => {
    clearStore();
    nextLogIndex = 1;
  });

  test("a launch records the token, its venue and its pool", () => {
    launch();

    assert.entityCount("Token", 1);
    assert.fieldEquals("Token", TOKEN_ID, "venue", "pool");
    assert.fieldEquals("Token", TOKEN_ID, "symbol", "AROMA");
    assert.fieldEquals("Token", TOKEN_ID, "poolId", POOL_ID.toHexString());
    // The reverse index handleSwap depends on.
    assert.entityCount("PoolRef", 1);
    assert.fieldEquals("PoolRef", POOL_ID.toHexString(), "token", TOKEN_ID);
    assert.fieldEquals("Protocol", "Aroma", "tokenCount", "1");
  });

  test("a swap in someone else's v4 pool is ignored", () => {
    launch();
    handleSwap(
      createSwapEvent(
        OTHER_POOL_ID,
        bi("-99000000000000000000"),
        TOKENS_OUT,
        SQRT_AT_INIT,
        TICK_INIT,
      ),
    );

    // Every v4 swap on the chain reaches this handler. Recording one would
    // attribute a stranger's trade to an Aroma coin.
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
    // The hook charges 1% in beforeSwap, so the event reports 99 and the
    // buyer actually parted with 100. Reporting 99 would understate every
    // buy in the protocol by the fee.
    assert.fieldEquals("Trade", id, "usdc", "100000000000000000000");
    assert.fieldEquals("Trade", id, "fee", "1000000000000000000");
    assert.fieldEquals("Trade", id, "tokens", TOKENS_OUT.toString());
  });

  test("reserve tracks what reached the pool, not what the buyer paid", () => {
    buy100();
    // The fee never enters the pool, so counting it as reserve would inflate
    // graduation progress on every trade.
    assert.fieldEquals("Token", TOKEN_ID, "reserve", "99000000000000000000");
    assert.fieldEquals("Token", TOKEN_ID, "tokensSold", TOKENS_OUT.toString());
    assert.fieldEquals("Token", TOKEN_ID, "volume", "100000000000000000000");
  });

  test("price comes from the pool's sqrt price", () => {
    handleSwap(
      createSwapEvent(POOL_ID, bi("-99000000000000000000"), TOKENS_OUT, SQRT_AT_INIT, TICK_INIT),
    );
    // 1 / (sqrtPriceX96 / 2^96)^2, in WAD. At the opening tick that is
    // $0.00000431255/token — a $4,312.55 market cap on a billion supply.
    assert.fieldEquals("Token", TOKEN_ID, "price", PRICE_AT_INIT);
    assert.fieldEquals("Token", TOKEN_ID, "marketCap", "4312545128081000000000");
  });

  test("the position is credited to the trader, not the router", () => {
    buy100();
    const balanceId = TOKEN_ID + "-" + TRADER.toHexString();
    assert.fieldEquals("Balance", balanceId, "amount", TOKENS_OUT.toString());
    assert.fieldEquals("Balance", balanceId, "costBasis", "100000000000000000000");
    // v4 puts the router in Swap.sender. Crediting that would collapse every
    // trade through one router into a single position.
    assert.entityCount("Balance", 1);
    assert.fieldEquals("Token", TOKEN_ID, "buyerCount", "1");
  });

  test("candles are written for every interval", () => {
    buy100();
    assert.entityCount("Candle", 3); // 5m, 1h, 1d
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
    // 50 USDC leaves the pool; the hook takes 1% in afterSwap, so the seller
    // receives 49.5. Here the event reports the gross, the opposite of a buy.
    const id = sellHalf();

    // Two distinct trades now exist: the buy from beforeEach and this sell.
    assert.entityCount("Trade", 2);
    assert.fieldEquals("Trade", id, "isBuy", "false");
    assert.fieldEquals("Trade", id, "usdc", "49500000000000000000");
    assert.fieldEquals("Trade", id, "fee", "500000000000000000");
  });

  test("a partial sell carries cost basis proportionally", () => {
    sellHalf();

    const balanceId = TOKEN_ID + "-" + TRADER.toHexString();
    // Half the position went, so half the 100 cost went with it. Realised
    // P&L is 49.5 received against 50 of basis.
    assert.fieldEquals("Balance", balanceId, "amount", TOKENS_OUT.div(BigInt.fromI32(2)).toString());
    assert.fieldEquals("Balance", balanceId, "costBasis", "50000000000000000000");
    assert.fieldEquals("Balance", balanceId, "realisedPnl", "-500000000000000000");
  });

  test("selling reduces the reserve by the gross that left the pool", () => {
    sellHalf();
    assert.fieldEquals("Token", TOKEN_ID, "reserve", "49000000000000000000");
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
      createSwapEvent(
        POOL_ID,
        bi("-13800000000000000000000"),
        TOKENS_OUT,
        SQRT_AT_GRADUATION,
        TICK_GRADUATION,
      ),
    );
    assert.fieldEquals("Token", TOKEN_ID, "graduated", "true");
    assert.fieldEquals("Protocol", "Aroma", "graduatedCount", "1");
  });

  test("graduation latches when the price falls back", () => {
    handleSwap(
      createSwapEvent(
        POOL_ID,
        bi("-13800000000000000000000"),
        TOKENS_OUT,
        SQRT_AT_GRADUATION,
        TICK_GRADUATION,
      ),
    );
    // A sell pushes the tick back above graduation. The contract's own view
    // would report false again; the index must not, or a coin would appear
    // to un-graduate.
    handleSwap(
      createSwapEvent(
        POOL_ID,
        bi("1000000000000000000"),
        TOKENS_OUT.neg(),
        SQRT_AT_INIT,
        TICK_GRADUATION + 500,
      ),
    );

    assert.fieldEquals("Token", TOKEN_ID, "graduated", "true");
    // ...and it must not be counted twice.
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

  test("the hook's own event is what settles the fee ledger", () => {
    handleFeeTaken(createFeeTakenEvent(bi("1000000000000000000")));
    // 70% of the 1% fee, matching PoolVault.CREATOR_FEE_SHARE_BPS.
    assert.fieldEquals("Token", TOKEN_ID, "creatorFeesEarned", "700000000000000000");
    assert.fieldEquals("Protocol", "Aroma", "totalFees", "1000000000000000000");
  });

  test("claims are tracked separately from earnings", () => {
    handleFeeTaken(createFeeTakenEvent(bi("1000000000000000000")));
    handleCreatorFeesClaimed(createCreatorFeesClaimedEvent(bi("700000000000000000")));

    assert.fieldEquals("Token", TOKEN_ID, "creatorFeesEarned", "700000000000000000");
    assert.fieldEquals("Token", TOKEN_ID, "creatorFeesClaimed", "700000000000000000");
  });

  test("a fee for a token we never saw launched is ignored", () => {
    clearStore();
    handleFeeTaken(createFeeTakenEvent(bi("1000000000000000000")));
    assert.entityCount("Token", 0);
  });
});

// --- helpers -----------------------------------------------------------

/** Mirrors tradeId() in src/shared.ts. */
function tradeIdOf(e: ethereum.Event): string {
  return e.transaction.hash.toHexString() + "-" + e.logIndex.toString();
}
