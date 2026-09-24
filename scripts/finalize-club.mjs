import { createPublicClient, createWalletClient, http, parseAbi, zeroAddress, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhood, robinhoodTestnet } from "viem/chains";

/**
 * Calls ClubAuction.finalize() once a round's countdown has passed.
 *
 * This is the bot the product's design deliberately depends on rather than
 * a permissionless keeper — see ClubAuction.sol's own header. If this isn't
 * running, or is down when a round ends, nothing launches until it's back;
 * there is no on-chain fallback, by the same design choice.
 *
 * The one piece of real work here, beyond "call finalize": a winning round
 * needs a CREATE2 salt that lands the launched token's address above USDG's,
 * because ClubVaultUsdg requires USDG to be currency0. The salt is mined by
 * asking the deployed factory where each candidate would land
 * (ClubFactoryUsdg.predictToken), never by hashing a local build artifact —
 * the artifact's bytecode is not guaranteed to match what the factory
 * embeds, and a mismatch mines a salt for an address the token never gets.
 * About two tokens in three land above USDG, so this is a call or two.
 *
 * The key must belong to the auction's owner.
 *
 * Run:  node scripts/finalize-club.mjs
 * Env:  CLUB_AUCTION_ADDRESS, FINALIZE_PRIVATE_KEY,
 *       ROBINHOOD_NETWORK ("mainnet" or testnet by default),
 *       ROBINHOOD_RPC_URL (optional), POLL_INTERVAL_MS (default 15000)
 */

const CLUB_AUCTION = requireEnv("CLUB_AUCTION_ADDRESS");
const PK = requireEnv("FINALIZE_PRIVATE_KEY");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 15_000);
const MAX_SALT_ATTEMPTS = 256;

const chain = process.env.ROBINHOOD_NETWORK === "mainnet" ? robinhood : robinhoodTestnet;
const RPC = process.env.ROBINHOOD_RPC_URL || chain.rpcUrls.default.http[0];

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} required`);
  return v;
}

const auctionAbi = parseAbi([
  "function getCurrentClub() view returns ((uint256 id, uint64 endsAt, bool finalized, address topBidder, uint256 topBid, uint256 topDevBuy, uint256 minTokensOut, string name, string symbol, string description, string metadataUri))",
  "function poolFactory() view returns (address)",
  "function usdg() view returns (address)",
  "function owner() view returns (address)",
  "function finalize(bytes32 salt)",
]);
const factoryAbi = parseAbi([
  "function predictToken(string name, string symbol, bytes32 salt) view returns (address)",
]);

const account = privateKeyToAccount(PK);
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC) });

const [factory, usdg, owner] = await Promise.all(
  ["poolFactory", "usdg", "owner"].map((functionName) =>
    publicClient.readContract({ address: CLUB_AUCTION, abi: auctionAbi, functionName }),
  ),
);
if (owner.toLowerCase() !== account.address.toLowerCase()) {
  throw new Error(`keeper ${account.address} is not the auction owner (${owner}) — finalize would revert`);
}

async function mineTokenSalt(name, symbol) {
  for (let i = 0; i < MAX_SALT_ATTEMPTS; i++) {
    const salt = `0x${i.toString(16).padStart(64, "0")}`;
    const predicted = await publicClient.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "predictToken",
      args: [name, symbol, salt],
    });
    if (BigInt(predicted) <= BigInt(usdg)) continue;
    // A salt someone already used for the same name and symbol would collide.
    const code = await publicClient.getCode({ address: predicted });
    if (!code || code === "0x") return salt;
  }
  throw new Error("no salt found within MAX_SALT_ATTEMPTS");
}

async function tick() {
  const club = await publicClient.readContract({
    address: CLUB_AUCTION,
    abi: auctionAbi,
    functionName: "getCurrentClub",
  });

  const nowSec = Math.floor(Date.now() / 1000);
  if (club.finalized || nowSec < Number(club.endsAt)) return;

  let salt = zeroHash;
  if (club.topBidder !== zeroAddress) {
    salt = await mineTokenSalt(club.name, club.symbol);
    console.log(`club #${club.id}: mined salt for "${club.name}" ($${club.symbol})`);
  } else {
    console.log(`club #${club.id}: no bids — voiding`);
  }

  const hash = await walletClient.writeContract({
    address: CLUB_AUCTION,
    abi: auctionAbi,
    functionName: "finalize",
    args: [salt],
  });
  console.log(`club #${club.id}: finalize() sent`, hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`club #${club.id}: finalize reverted`);
  console.log(`club #${club.id}: finalized`);
}

console.log("finalize-club bot started");
console.log("  network:           ", chain.name);
console.log("  club auction:      ", CLUB_AUCTION);
console.log("  factory:           ", factory);
console.log("  keeper account:    ", account.address);
console.log("  poll interval (ms):", POLL_INTERVAL_MS);

for (;;) {
  try {
    await tick();
  } catch (e) {
    console.error("tick failed:", e instanceof Error ? e.message : e);
  }
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}
