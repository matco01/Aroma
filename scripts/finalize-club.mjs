import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  getContractAddress,
  encodeAbiParameters,
  keccak256,
  concatHex,
  zeroHash,
} from "viem";
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
 * needs a CREATE2 salt that lands the launched AromaToken's address above
 * USDG's, because PoolVaultUsdg requires that ordering and USDG (unlike
 * native USDC on Arc) isn't address zero — see PoolFactoryUsdg.sol's NatSpec.
 * Mining that salt is cheap (a coin flip per attempt) and has to happen
 * off-chain, with the exact final name/symbol, which is why it happens here
 * rather than on-chain.
 *
 * Run:  node scripts/finalize-club.mjs
 * Env:  ROBINHOOD_RPC_URL, CLUB_AUCTION_ADDRESS, POOL_FACTORY_USDG_ADDRESS,
 *       POOL_VAULT_USDG_ADDRESS, USDG_ADDRESS, FINALIZE_PRIVATE_KEY,
 *       POLL_INTERVAL_MS (default 15000)
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const CLUB_AUCTION = requireEnv("CLUB_AUCTION_ADDRESS");
const POOL_FACTORY_USDG = requireEnv("POOL_FACTORY_USDG_ADDRESS");
const VAULT_USDG = requireEnv("POOL_VAULT_USDG_ADDRESS");
const USDG = requireEnv("USDG_ADDRESS");
const PK = requireEnv("FINALIZE_PRIVATE_KEY");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 15_000);
const MAX_SALT_ATTEMPTS = 10_000;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} required`);
  return v;
}

function loadAbi(contractName) {
  const p = path.join(
    __dirname,
    "..",
    "contracts",
    "out",
    `${contractName}.sol`,
    `${contractName}.json`,
  );
  if (!fs.existsSync(p)) {
    throw new Error(`missing ${p} — run \`forge build\` in contracts/ first`);
  }
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

const clubAuctionAbi = loadAbi("ClubAuction").abi;
const poolFactoryUsdgAbi = loadAbi("PoolFactoryUsdg").abi;
const aromaTokenArtifact = loadAbi("AromaToken");
const aromaTokenBytecode = aromaTokenArtifact.bytecode.object;

const chain = process.env.ROBINHOOD_NETWORK === "mainnet" ? robinhood : robinhoodTestnet;

const account = privateKeyToAccount(PK);
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC) });

/**
 * Mines a CREATE2 salt for `new AromaToken{salt}(name, symbol, totalSupply,
 * vault)` deployed by `PoolFactoryUsdg`, landing the resulting address
 * above `USDG`'s — the property PoolVaultUsdg.launch requires. Roughly two
 * attempts on average; MAX_SALT_ATTEMPTS is a generous ceiling, not an
 * expected count.
 */
function mineTokenSalt(name, symbol, totalSupply) {
  const constructorArgs = encodeAbiParameters(
    [{ type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }],
    [name, symbol, totalSupply, VAULT_USDG],
  );
  const initCode = concatHex([aromaTokenBytecode, constructorArgs]);
  const bytecodeHash = keccak256(initCode);

  for (let i = 0; i < MAX_SALT_ATTEMPTS; i++) {
    const salt = `0x${i.toString(16).padStart(64, "0")}`;
    const predicted = getContractAddress({
      opcode: "CREATE2",
      from: POOL_FACTORY_USDG,
      salt,
      bytecodeHash,
    });
    if (BigInt(predicted) > BigInt(USDG)) return salt;
  }
  throw new Error("no salt found within MAX_SALT_ATTEMPTS");
}

async function tick() {
  const club = await publicClient.readContract({
    address: CLUB_AUCTION,
    abi: clubAuctionAbi,
    functionName: "getCurrentClub",
  });

  const nowSec = Math.floor(Date.now() / 1000);
  if (club.finalized || nowSec < Number(club.endsAt)) return;

  const zeroAddress = "0x0000000000000000000000000000000000000000";
  let salt = zeroHash;
  if (club.topBidder !== zeroAddress) {
    const totalSupply = await publicClient.readContract({
      address: POOL_FACTORY_USDG,
      abi: poolFactoryUsdgAbi,
      functionName: "TOTAL_SUPPLY",
    });
    salt = mineTokenSalt(club.name, club.symbol, totalSupply);
    console.log(`club #${club.id}: mined salt for "${club.name}" ($${club.symbol})`);
  } else {
    console.log(`club #${club.id}: no bids — voiding`);
  }

  const hash = await walletClient.writeContract({
    address: CLUB_AUCTION,
    abi: clubAuctionAbi,
    functionName: "finalize",
    args: [salt],
  });
  console.log(`club #${club.id}: finalize() sent`, hash);
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`club #${club.id}: finalized`);
}

console.log("finalize-club bot started");
console.log("  club auction:      ", CLUB_AUCTION);
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
