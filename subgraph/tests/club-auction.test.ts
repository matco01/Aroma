import {
  assert,
  describe,
  test,
  clearStore,
  beforeEach,
  newMockEvent,
} from "matchstick-as/assembly/index";
import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts";
import {
  ClubOpened,
  ClubBid as ClubBidEvent,
  ClubDraftUpdated,
  ClubLaunched,
  ClubVoided,
} from "../generated/ClubAuction/ClubAuction";
import { Token } from "../generated/schema";
import {
  handleClubOpened,
  handleClubBid,
  handleClubDraftUpdated,
  handleClubLaunched,
  handleClubVoided,
} from "../src/club-auction";

/**
 * Unit tests for the Club auction mappings.
 *
 * The thing worth pinning down here: `handleClubLaunched` assumes
 * `handleTokenCreated` (pool-usdg.ts) has already run in the same
 * transaction and created the `Token` — see club.ts's own header for why
 * that ordering is guaranteed on-chain. These tests create that `Token`
 * directly, standing in for pool-usdg.ts having already handled it, rather
 * than re-running that mapping here.
 */

const BIDDER = Address.fromString("0x1111111111111111111111111111111111111111");
const OTHER_BIDDER = Address.fromString("0x2222222222222222222222222222222222222222");
const TOKEN = Address.fromString("0x3333333333333333333333333333333333333333");

let nextLogIndex: i32 = 1;

function bi(v: string): BigInt {
  return BigInt.fromString(v);
}

function createClubOpenedEvent(clubId: i32, endsAt: string): ClubOpened {
  const e = changetype<ClubOpened>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(
    new ethereum.EventParam("clubId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(clubId))),
  );
  e.parameters.push(
    new ethereum.EventParam("endsAt", ethereum.Value.fromUnsignedBigInt(bi(endsAt))),
  );
  return e;
}

function createClubBidEvent(
  clubId: i32,
  bidder: Address,
  bidAmount: string,
  devBuyUsdc: string,
  endsAt: string,
): ClubBidEvent {
  const e = changetype<ClubBidEvent>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(
    new ethereum.EventParam("clubId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(clubId))),
  );
  e.parameters.push(new ethereum.EventParam("bidder", ethereum.Value.fromAddress(bidder)));
  e.parameters.push(
    new ethereum.EventParam("bidAmount", ethereum.Value.fromUnsignedBigInt(bi(bidAmount))),
  );
  e.parameters.push(
    new ethereum.EventParam("devBuyUsdc", ethereum.Value.fromUnsignedBigInt(bi(devBuyUsdc))),
  );
  e.parameters.push(
    new ethereum.EventParam("endsAt", ethereum.Value.fromUnsignedBigInt(bi(endsAt))),
  );
  e.logIndex = BigInt.fromI32(nextLogIndex);
  nextLogIndex++;
  return e;
}

function createClubDraftUpdatedEvent(
  clubId: i32,
  bidder: Address,
  name: string,
  symbol: string,
  description: string,
  metadataUri: string,
): ClubDraftUpdated {
  const e = changetype<ClubDraftUpdated>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(
    new ethereum.EventParam("clubId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(clubId))),
  );
  e.parameters.push(new ethereum.EventParam("bidder", ethereum.Value.fromAddress(bidder)));
  e.parameters.push(new ethereum.EventParam("name", ethereum.Value.fromString(name)));
  e.parameters.push(new ethereum.EventParam("symbol", ethereum.Value.fromString(symbol)));
  e.parameters.push(
    new ethereum.EventParam("description", ethereum.Value.fromString(description)),
  );
  e.parameters.push(
    new ethereum.EventParam("metadataUri", ethereum.Value.fromString(metadataUri)),
  );
  return e;
}

function createClubLaunchedEvent(
  clubId: i32,
  token: Address,
  winner: Address,
  winningBid: string,
  devBuyUsdc: string,
): ClubLaunched {
  const e = changetype<ClubLaunched>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(
    new ethereum.EventParam("clubId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(clubId))),
  );
  e.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(token)));
  e.parameters.push(new ethereum.EventParam("winner", ethereum.Value.fromAddress(winner)));
  e.parameters.push(
    new ethereum.EventParam("winningBid", ethereum.Value.fromUnsignedBigInt(bi(winningBid))),
  );
  e.parameters.push(
    new ethereum.EventParam("devBuyUsdc", ethereum.Value.fromUnsignedBigInt(bi(devBuyUsdc))),
  );
  return e;
}

function createClubVoidedEvent(clubId: i32): ClubVoided {
  const e = changetype<ClubVoided>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(
    new ethereum.EventParam("clubId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(clubId))),
  );
  return e;
}

/** Stands in for pool-usdg.ts's handleTokenCreated having already run. */
function seedToken(): void {
  const token = new Token(TOKEN.toHexString());
  token.address = TOKEN;
  token.creator = BIDDER;
  token.name = "Aroma Coin";
  token.symbol = "AROMA";
  token.description = "";
  token.metadataUri = "";
  token.createdAt = BigInt.zero();
  token.createdAtBlock = BigInt.zero();
  token.createdTx = TOKEN;
  token.venue = "pool";
  token.tradeFeeBps = BigInt.fromI32(100);
  token.poolId = null;
  token.clubId = null;
  token.reserve = BigInt.zero();
  token.tokensSold = BigInt.zero();
  token.price = BigInt.zero();
  token.marketCap = BigInt.zero();
  token.progressBps = 0;
  token.price24hAgo = BigInt.zero();
  token.graduated = false;
  token.volume = BigInt.zero();
  token.tradeCount = 0;
  token.buyerCount = 0;
  token.lastTradeAt = BigInt.zero();
  token.creatorFeesEarned = BigInt.zero();
  token.creatorFeesClaimed = BigInt.zero();
  token.save();
}

describe("Club lifecycle", () => {
  beforeEach(() => {
    clearStore();
    nextLogIndex = 1;
  });

  test("opening a Club records its id and deadline", () => {
    handleClubOpened(createClubOpenedEvent(1, "1000"));
    assert.fieldEquals("Club", "1", "endsAt", "1000");
    assert.fieldEquals("Club", "1", "finalized", "false");
    assert.fieldEquals("Club", "1", "void", "false");
  });

  test("a bid records the new top bidder and creates history", () => {
    handleClubOpened(createClubOpenedEvent(1, "1000"));
    handleClubBid(createClubBidEvent(1, BIDDER, "200000000", "0", "1000"));

    assert.fieldEquals("Club", "1", "topBidder", BIDDER.toHexString());
    assert.fieldEquals("Club", "1", "topBid", "200000000");
    assert.entityCount("ClubBid", 1);
  });

  test("an outbid replaces the top bidder", () => {
    handleClubOpened(createClubOpenedEvent(1, "1000"));
    handleClubBid(createClubBidEvent(1, BIDDER, "200000000", "0", "1000"));
    handleClubBid(createClubBidEvent(1, OTHER_BIDDER, "300000000", "0", "1000"));

    assert.fieldEquals("Club", "1", "topBidder", OTHER_BIDDER.toHexString());
    assert.fieldEquals("Club", "1", "topBid", "300000000");
    assert.entityCount("ClubBid", 2);
  });

  test("an anti-snipe bid extends the recorded deadline", () => {
    handleClubOpened(createClubOpenedEvent(1, "1000"));
    handleClubBid(createClubBidEvent(1, BIDDER, "200000000", "0", "1300"));
    assert.fieldEquals("Club", "1", "endsAt", "1300");
  });

  test("a bid's own draft update sets the Club's identity", () => {
    handleClubOpened(createClubOpenedEvent(1, "1000"));
    handleClubBid(createClubBidEvent(1, BIDDER, "200000000", "0", "1000"));
    handleClubDraftUpdated(
      createClubDraftUpdatedEvent(1, BIDDER, "Aroma Coin", "AROMA", "a real coin", "ipfs://x"),
    );

    assert.fieldEquals("Club", "1", "name", "Aroma Coin");
    assert.fieldEquals("Club", "1", "symbol", "AROMA");
    assert.fieldEquals("Club", "1", "description", "a real coin");
    assert.fieldEquals("Club", "1", "metadataUri", "ipfs://x");
  });

  test("a pure edit overwrites the draft without touching the bid", () => {
    handleClubOpened(createClubOpenedEvent(1, "1000"));
    handleClubBid(createClubBidEvent(1, BIDDER, "200000000", "0", "1000"));
    handleClubDraftUpdated(
      createClubDraftUpdatedEvent(1, BIDDER, "Aroma Coin", "AROMA", "v1", ""),
    );
    handleClubDraftUpdated(
      createClubDraftUpdatedEvent(1, BIDDER, "Aroma Coin V2", "AROMA2", "v2", "ipfs://y"),
    );

    assert.fieldEquals("Club", "1", "name", "Aroma Coin V2");
    assert.fieldEquals("Club", "1", "topBid", "200000000");
  });

  test("finalize records the launch and marks the Club finalized", () => {
    seedToken();
    handleClubOpened(createClubOpenedEvent(1, "1000"));
    handleClubBid(createClubBidEvent(1, BIDDER, "200000000", "0", "1000"));
    handleClubLaunched(createClubLaunchedEvent(1, TOKEN, BIDDER, "200000000", "0"));

    assert.fieldEquals("Club", "1", "finalized", "true");
    assert.fieldEquals("Club", "1", "token", TOKEN.toHexString());
    assert.fieldEquals("Club", "1", "void", "false");
    // The Token gets its clubId set, linking it back the other way.
    assert.fieldEquals("Token", TOKEN.toHexString(), "clubId", "1");
    assert.fieldEquals("Token", TOKEN.toHexString(), "venue", "pool");
  });

  test("a round with no bids voids rather than launching", () => {
    handleClubOpened(createClubOpenedEvent(1, "1000"));
    handleClubVoided(createClubVoidedEvent(1));

    assert.fieldEquals("Club", "1", "finalized", "true");
    assert.fieldEquals("Club", "1", "void", "true");
    assert.entityCount("Token", 0);
  });

  test("the next Club is a separate entity from the one before it", () => {
    handleClubOpened(createClubOpenedEvent(1, "1000"));
    handleClubVoided(createClubVoidedEvent(1));
    handleClubOpened(createClubOpenedEvent(2, "2000"));

    assert.entityCount("Club", 2);
    assert.fieldEquals("Club", "2", "finalized", "false");
  });
});
