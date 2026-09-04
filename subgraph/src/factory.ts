import { TokenCreated } from "../generated/AromaFactory/AromaFactory";
import { getOrCreateToken, getAccount, getProtocol } from "./shared";

/**
 * A launch.
 *
 * Deliberately only writes the metadata fields. Curve state is owned by the
 * trade handlers, so if a Bought ever lands first this fills in the name
 * rather than resetting a reserve back to zero.
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
  token.save();

  getAccount(event.params.creator, event.block.timestamp);

  if (isNew) {
    const protocol = getProtocol();
    protocol.tokenCount = protocol.tokenCount + 1;
    protocol.save();
  }
}
