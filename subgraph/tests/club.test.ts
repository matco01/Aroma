import {
  assert,
  describe,
  test,
  clearStore,
  beforeEach,
  newMockEvent,
} from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { TokenCreated as ClubTokenCreated } from "../generated/ClubFactory/ClubFactory";
import { TokenCreated as PoolTokenCreated } from "../generated/PoolFactory/PoolFactory";
import { Swap } from "../generated/PoolManager/PoolManager";
import { handleTokenCreated as handleClubTokenCreated } from "../src/club";
import { handleTokenCreated as handlePoolTokenCreated, handleSwap } from "../src/pool";

/**
 * Unit tests for club indexing — the part of CLUBS.md's "Before clubs go
 * live" checklist this change closes: a club launch registering its Token
 * and PoolRef, and handleSwap reconstructing a club trade's fee at 1.5%
 * rather than the 1% every normal coin charges.
 *
 * handleSwap itself is pool.ts's, shared by both venues — these tests exist
 * to prove that sharing is safe: a club token's rate must never leak onto a
 * normal token's swap or vice versa, since both arrive at the same handler
 * from the same PoolManager singleton.
 */

const CLUB_TOKEN = Address.fromString("0x1111111111111111111111111111111111111111");
const POOL_TOKEN = Address.fromString("0x5555555555555555555555555555555555555555");
const CREATOR = Address.fromString("0x2222222222222222222222222222222222222222");
const TRADER = Address.fromString("0x3333333333333333333333333333333333333333");
const ROUTER = Address.fromString("0x4444444444444444444444444444444444444444");
const CLUB_POOL_ID = Bytes.fromHexString(
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
);
const NORMAL_POOL_ID = Bytes.fromHexString(
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
);

const TOKENS_OUT = BigInt.fromString("22472630624944238063672500");

let nextLogIndex: i32 = 1;

function bi(v: string): BigInt {
  return BigInt.fromString(v);
}

function createClubLaunchEvent(): ClubTokenCreated {
  const e = changetype<ClubTokenCreated>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(CLUB_TOKEN)));
  e.parameters.push(new ethereum.EventParam("creator", ethereum.Value.fromAddress(CREATOR)));
  e.parameters.push(
    new ethereum.EventParam("poolId", ethereum.Value.fromFixedBytes(CLUB_POOL_ID)),
  );
  e.parameters.push(new ethereum.EventParam("name", ethereum.Value.fromString("Club Coin")));
  e.parameters.push(new ethereum.EventParam("symbol", ethereum.Value.fromString("CLUB")));
  e.parameters.push(new ethereum.EventParam("description", ethereum.Value.fromString("a club")));
  e.parameters.push(new ethereum.EventParam("metadataUri", ethereum.Value.fromString("ipfs://c")));
  e.parameters.push(
    new ethereum.EventParam("devBuyUsdc", ethereum.Value.fromUnsignedBigInt(BigInt.zero())),
  );
  return e;
}

function createPoolLaunchEvent(): PoolTokenCreated {
  const e = changetype<PoolTokenCreated>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(POOL_TOKEN)));
  e.parameters.push(new ethereum.EventParam("creator", ethereum.Value.fromAddress(CREATOR)));
  e.parameters.push(
    new ethereum.EventParam("poolId", ethereum.Value.fromFixedBytes(NORMAL_POOL_ID)),
  );
  e.parameters.push(new ethereum.EventParam("name", ethereum.Value.fromString("Normal Coin")));
  e.parameters.push(new ethereum.EventParam("symbol", ethereum.Value.fromString("NORM")));
  e.parameters.push(new ethereum.EventParam("description", ethereum.Value.fromString("a coin")));
  e.parameters.push(new ethereum.EventParam("metadataUri", ethereum.Value.fromString("ipfs://n")));
  e.parameters.push(
    new ethereum.EventParam("devBuyUsdc", ethereum.Value.fromUnsignedBigInt(BigInt.zero())),
  );
  return e;
}

function createSwapEvent(poolId: Bytes, amount0: BigInt, amount1: BigInt): Swap {
  const e = changetype<Swap>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("id", ethereum.Value.fromFixedBytes(poolId)));
  e.parameters.push(new ethereum.EventParam("sender", ethereum.Value.fromAddress(ROUTER)));
  e.parameters.push(new ethereum.EventParam("amount0", ethereum.Value.fromSignedBigInt(amount0)));
  e.parameters.push(new ethereum.EventParam("amount1", ethereum.Value.fromSignedBigInt(amount1)));
  e.parameters.push(
    new ethereum.EventParam(
      "sqrtPriceX96",
      ethereum.Value.fromUnsignedBigInt(bi("38151600112934443872199254736162")),
    ),
  );
  e.parameters.push(
    new ethereum.EventParam("liquidity", ethereum.Value.fromUnsignedBigInt(bi("1000"))),
  );
  e.parameters.push(new ethereum.EventParam("tick", ethereum.Value.fromI32(123546)));
  e.parameters.push(new ethereum.EventParam("fee", ethereum.Value.fromI32(0)));
  e.transaction.from = TRADER;
  e.logIndex = BigInt.fromI32(nextLogIndex);
  nextLogIndex++;
  return e;
}

const CLUB_TOKEN_ID = CLUB_TOKEN.toHexString();
const POOL_TOKEN_ID = POOL_TOKEN.toHexString();

describe("club launches", () => {
  beforeEach(() => {
    clearStore();
    nextLogIndex = 1;
  });

  test("a club launch records venue, fee rate and pool ref", () => {
    handleClubTokenCreated(createClubLaunchEvent());

    assert.fieldEquals("Token", CLUB_TOKEN_ID, "venue", "club");
    assert.fieldEquals("Token", CLUB_TOKEN_ID, "tradeFeeBps", "150");
    assert.entityCount("PoolRef", 1);
    assert.fieldEquals("PoolRef", CLUB_POOL_ID.toHexString(), "token", CLUB_TOKEN_ID);
  });

  test("a normal launch still records the 1% rate, unaffected by clubs existing", () => {
    handleClubTokenCreated(createClubLaunchEvent());
    handlePoolTokenCreated(createPoolLaunchEvent());

    assert.fieldEquals("Token", POOL_TOKEN_ID, "venue", "pool");
    assert.fieldEquals("Token", POOL_TOKEN_ID, "tradeFeeBps", "100");
  });
});

describe("club swaps", () => {
  beforeEach(() => {
    clearStore();
    nextLogIndex = 1;
    handleClubTokenCreated(createClubLaunchEvent());
  });

  test("a 1000 USDC club buy reconstructs its gross at 1.5%, not 1%", () => {
    // The hook takes 1.5% in beforeSwap: 15 of 1000 USDC, so 985 reaches the
    // pool. Reconstructing at the normal-coin 1% rate would wrongly recover
    // 995/0.99 ≈ 1005.05, not 1000 — this is the exact bug CLUBS.md flags.
    const e = createSwapEvent(CLUB_POOL_ID, bi("-985000000000000000000"), TOKENS_OUT);
    handleSwap(e);

    const id = e.transaction.hash.toHexString() + "-" + e.logIndex.toString();
    assert.fieldEquals("Trade", id, "usdc", "1000000000000000000000");
    assert.fieldEquals("Trade", id, "fee", "15000000000000000000");
  });

  test("a club sell takes 1.5% on the gross leaving the pool", () => {
    const e = createSwapEvent(
      CLUB_POOL_ID,
      bi("1000000000000000000000"),
      TOKENS_OUT.neg(),
    );
    handleSwap(e);

    const id = e.transaction.hash.toHexString() + "-" + e.logIndex.toString();
    assert.fieldEquals("Trade", id, "fee", "15000000000000000000");
    assert.fieldEquals("Trade", id, "usdc", "985000000000000000000");
  });

  test("an ambiguous net picks the larger gross, same tie-break as the 1% case", () => {
    // At 1.5%, both 333 and 334 floor to a fee that leaves net 329 — the
    // same kind of one-in-many collision the 1% formula has at net ≡ 99.
    // src/lib/chain-data.ts's grossFromNet resolves this by picking the
    // larger; this is a direct port of that function, so it must agree.
    const e = createSwapEvent(CLUB_POOL_ID, bi("-329"), TOKENS_OUT);
    handleSwap(e);

    const id = e.transaction.hash.toHexString() + "-" + e.logIndex.toString();
    assert.fieldEquals("Trade", id, "usdc", "334");
    assert.fieldEquals("Trade", id, "fee", "5");
  });
});

describe("mixed venues on one PoolManager", () => {
  beforeEach(() => {
    clearStore();
    nextLogIndex = 1;
    handleClubTokenCreated(createClubLaunchEvent());
    handlePoolTokenCreated(createPoolLaunchEvent());
  });

  test("a normal coin's buy is still reconstructed at 1%, not 1.5%", () => {
    // Guards against the fee rate leaking from whichever token's swap the
    // handler processed most recently — a real risk once tradeFeeBps is a
    // per-token field read at handler time rather than a module constant.
    const e = createSwapEvent(NORMAL_POOL_ID, bi("-99000000000000000000"), TOKENS_OUT);
    handleSwap(e);

    const id = e.transaction.hash.toHexString() + "-" + e.logIndex.toString();
    assert.fieldEquals("Trade", id, "usdc", "100000000000000000000");
    assert.fieldEquals("Trade", id, "fee", "1000000000000000000");
  });

  test("trading both in sequence charges each its own rate", () => {
    const clubBuy = createSwapEvent(CLUB_POOL_ID, bi("-985000000000000000000"), TOKENS_OUT);
    handleSwap(clubBuy);
    const poolBuy = createSwapEvent(NORMAL_POOL_ID, bi("-99000000000000000000"), TOKENS_OUT);
    handleSwap(poolBuy);

    const clubId = clubBuy.transaction.hash.toHexString() + "-" + clubBuy.logIndex.toString();
    const poolId = poolBuy.transaction.hash.toHexString() + "-" + poolBuy.logIndex.toString();
    assert.fieldEquals("Trade", clubId, "fee", "15000000000000000000");
    assert.fieldEquals("Trade", poolId, "fee", "1000000000000000000");
  });
});
