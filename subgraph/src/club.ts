import { TokenCreated } from "../generated/ClubFactory/ClubFactory";
import { PoolRef } from "../generated/schema";
import { getOrCreateToken, getAccount, getProtocol } from "./shared";
import { VENUE_CLUB, CLUB_TRADE_FEE_BPS } from "./constants";

/**
 * Club coins' launch mapping. See CLUBS.md for the design; see pool.ts for
 * why a launch has to be announced before handleSwap can see the coin's
 * first trade.
 *
 * A near-duplicate of pool.ts's handleTokenCreated rather than a shared
 * helper the two call into — CLUBS.md's own frontend duplicated club-trade.ts
 * from pool-trade.ts for the same reason: normal coins' indexing is already
 * verified, and refactoring it to share code with a system that does not
 * exist in production yet is exactly the kind of change that could regress
 * it silently. ClubFactory.TokenCreated is deliberately identical in shape
 * to PoolFactory.TokenCreated (see ClubFactory.sol), which is what makes the
 * two handlers line up field for field below.
 *
 * handleSwap itself needs no club-specific version: it already reads
 * `token.tradeFeeBps` rather than a hardcoded rate, so once this handler
 * registers a club's PoolRef, the existing PoolManager dataSource picks up
 * its trades the same way it does a normal coin's.
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

  // The reverse index handleSwap needs — same PoolRef entity a normal
  // launch writes, so the one PoolManager dataSource resolves both.
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
