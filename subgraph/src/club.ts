import { BigInt } from "@graphprotocol/graph-ts";
import {
  ClubOpened,
  ClubBid as ClubBidEvent,
  ClubDraftUpdated,
  ClubLaunched,
  ClubVoided,
} from "../generated/ClubAuction/ClubAuction";
import { Club, ClubBid, Token } from "../generated/schema";
import { ZERO, VENUE_POOL } from "./constants";
import { tradeId } from "./shared";

/**
 * The Club auction's mappings — one 24-hour round at a time, gating every
 * launch. `Club.name`/`symbol`/`description`/`metadataUri` always reflect
 * the *current* draft; there's no per-bid history of what it looked like
 * earlier, since nothing downstream needs it and it would mean keying every
 * edit to whichever bid happened to be active at the time.
 *
 * Event ordering within one transaction matters here in a way it doesn't for
 * the pool mappings: `ClubAuction.bid()` emits `ClubBid` and then
 * `ClubDraftUpdated` in that order (see `ClubAuction.sol`), and
 * `finalize()`'s `TokenCreated` (handled by pool-usdg.ts) always precedes its
 * own `ClubLaunched` — the inner `PoolFactoryUsdg.createToken` call, and the
 * event it emits, complete before `ClubAuction` emits anything of its own.
 * `handleClubLaunched` relies on that: by the time it runs, `pool-usdg.ts`'s
 * `handleTokenCreated` has already created the `Token` with its identity
 * fields set.
 */

function getOrCreateClub(clubId: BigInt, timestamp: BigInt): Club {
  const id = clubId.toString();
  let club = Club.load(id);
  if (club == null) {
    club = new Club(id);
    club.openedAt = timestamp;
    club.endsAt = timestamp;
    club.finalized = false;
    club.void = false;
    club.topBidder = null;
    club.topBid = ZERO;
    club.topDevBuy = ZERO;
    club.name = "";
    club.symbol = "";
    club.description = "";
    club.metadataUri = "";
    club.token = null;
    club.save();
  }
  return club;
}

export function handleClubOpened(event: ClubOpened): void {
  const club = getOrCreateClub(event.params.clubId, event.block.timestamp);
  club.endsAt = event.params.endsAt;
  club.save();
}

export function handleClubBid(event: ClubBidEvent): void {
  const club = getOrCreateClub(event.params.clubId, event.block.timestamp);
  club.topBidder = event.params.bidder;
  club.topBid = event.params.bidAmount;
  club.topDevBuy = event.params.devBuyUsdc;
  club.endsAt = event.params.endsAt;
  club.save();

  const bid = new ClubBid(tradeId(event));
  bid.club = club.id;
  bid.bidder = event.params.bidder;
  bid.bidAmount = event.params.bidAmount;
  bid.devBuyUsdc = event.params.devBuyUsdc;
  bid.endsAt = event.params.endsAt;
  bid.timestamp = event.block.timestamp;
  bid.save();
}

/**
 * Fires for both a fresh bid's draft (bid() emits this right after ClubBid)
 * and a pure edit (updateDraft()'s only event) — one handler either way,
 * since both just mean "this is the draft now".
 */
export function handleClubDraftUpdated(event: ClubDraftUpdated): void {
  const club = getOrCreateClub(event.params.clubId, event.block.timestamp);
  club.name = event.params.name;
  club.symbol = event.params.symbol;
  club.description = event.params.description;
  club.metadataUri = event.params.metadataUri;
  club.save();
}

export function handleClubLaunched(event: ClubLaunched): void {
  const club = getOrCreateClub(event.params.clubId, event.block.timestamp);
  club.finalized = true;
  club.token = event.params.token;
  club.save();

  // handleTokenCreated (pool-usdg.ts) always runs first in this same
  // transaction — see this file's header — so the Token already exists with
  // its identity fields set. This just records where it came from.
  const token = Token.load(event.params.token.toHexString());
  if (token == null) return;
  token.venue = VENUE_POOL;
  token.clubId = event.params.clubId;
  token.save();
}

export function handleClubVoided(event: ClubVoided): void {
  const club = getOrCreateClub(event.params.clubId, event.block.timestamp);
  club.finalized = true;
  club.void = true;
  club.save();
}
