/**
 * Drives src/lib/club-trade.ts — the functions the site itself calls — against
 * a local fork with the club contracts deployed.
 *
 *   NEXT_PUBLIC_AROMA_NETWORK=local NEXT_PUBLIC_LOCAL_CHAIN_ID=5042 \
 *   NEXT_PUBLIC_LOCAL_CLUB_FACTORY=0x.. NEXT_PUBLIC_LOCAL_CLUB_VAULT=0x.. \
 *   NEXT_PUBLIC_LOCAL_CLUB_ROUTER=0x.. RPC=http://127.0.0.1:8549 \
 *   npx tsx scripts/club-trade-check.ts
 *
 * The point is the join between this file and the contracts, which the Solidity
 * tests cannot see: that the EIP-712 invite a wallet signs from the typed data
 * here hashes to exactly what ClubVault verifies, that an invite survives being
 * packed into a link and read back out, and that each flow does what the UI
 * will say it did. Signing goes through viem's signTypedData, which computes the
 * digest from the typed data independently — the same way a browser wallet does.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import type { Ctx } from "../src/lib/pool-trade";

const RPC = process.env.RPC ?? "http://127.0.0.1:8549";
const MNEMONIC = "test test test test test test test test test test test junk";

const chain = defineChain({
  id: 5042,
  name: "Arc fork",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

async function main() {
  // Imported after env is in place: arc.ts reads the contract addresses at load.
  const club = await import("../src/lib/club-trade");
  const { CLUB_CONTRACTS } = await import("../src/lib/arc");
  const { clubVaultAbi, aromaTokenAbi } = await import("../src/lib/abis");

  const publicClient = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;

  const account = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
  const fund = (a: Address) =>
    publicClient.request({
      method: "anvil_setBalance" as never,
      params: [a, "0x21E19E0C9BAB2400000"] as never,
    });

  function ctxFor(i: number): Ctx {
    const acct = account(i);
    const wallet = createWalletClient({ account: acct, chain, transport: http(RPC) });
    return {
      publicClient,
      account: acct.address,
      write: (args) => wallet.writeContract(args as never),
      sign: (args) => wallet.signTypedData(args as never),
    };
  }

  // Account 0 carries an EIP-7702 delegation on Arc mainnet — the case the
  // vault's signature check was fixed for — so it is the creator on purpose.
  const creator = ctxFor(0);
  const alice = ctxFor(41);
  const bob = ctxFor(42);
  const stranger = ctxFor(43);
  for (const c of [creator, alice, bob, stranger]) await fund(c.account);
  console.log(`  vault ${CLUB_CONTRACTS.clubVault}`);
  console.log(`  creator ${creator.account}  code: ${((await publicClient.getCode({ address: creator.account })) ?? "0x").slice(0, 10)}`);

  // ---- launch
  const { token } = await club.createClub(creator, {
    name: "Harness Club",
    symbol: "HARN",
    description: "",
    metadataUri: "",
    devBuy: 5n * 10n ** 18n,
  });
  check("createClub returns the token", Boolean(token), token ?? "");
  const t = token as Address;
  const cs = await club.clubStatus(publicClient, t, creator.account);
  check("creator is a member with 10 seats", cs.isMember && cs.seatsTotal === 10, `${cs.seatsLeft} left`);

  // ---- invite, through a link and back
  const invite = await club.signInvite(creator, t);
  const link = club.encodeInvite(invite);
  const back = club.decodeInvite(link);
  check(
    "invite survives the link round trip",
    !!back &&
      back.inviter.toLowerCase() === invite.inviter.toLowerCase() &&
      back.nonce === invite.nonce &&
      back.deadline === invite.deadline &&
      back.signature.toLowerCase() === invite.signature.toLowerCase(),
    `${link.length} chars`,
  );
  check("a garbage link decodes to null", club.decodeInvite("not-an-invite") === null);

  const onChainDigest = (await publicClient.readContract({
    address: CLUB_CONTRACTS.clubVault as Address,
    abi: clubVaultAbi,
    functionName: "inviteDigest",
    args: [t, invite.inviter, invite.nonce, invite.deadline],
  })) as Hex;
  check(
    "the wallet's EIP-712 signature is valid for the vault's digest",
    (await club.inviteProblem(publicClient, t, alice.account, back!)) === "",
    `digest ${onChainDigest.slice(0, 12)}…`,
  );

  // ---- a stranger cannot buy
  let refused = "";
  try {
    await club.buy(stranger, { token: t, usdc: 3n * 10n ** 18n, slippagePct: 1 });
  } catch (e) {
    refused = club.clubReason(String((e as Error).message)) ?? String(e).slice(0, 80);
  }
  check("a non-member is refused, with a sentence", refused.startsWith("This is an invite-only club"), refused);

  // ---- alice joins with the link
  await club.buy(alice, { token: t, usdc: 10n * 10n ** 18n, slippagePct: 1, invite: back });
  const as = await club.clubStatus(publicClient, t, alice.account);
  check("alice joined through the link", as.isMember, `inviter ${as.inviter.slice(0, 8)}…`);
  check("alice was placed under the creator", as.inviter.toLowerCase() === creator.account.toLowerCase());
  check("alice has her own 3 seats", as.seatsTotal === 3 && as.seatsLeft === 3);
  check(
    "one of the creator's seats was used",
    (await club.clubStatus(publicClient, t, creator.account)).seatsLeft === 9,
  );

  // ---- the same link again, by someone already in: an ordinary buy
  const seatsBefore = (await club.clubStatus(publicClient, t, creator.account)).seatsLeft;
  await club.buy(alice, { token: t, usdc: 2n * 10n ** 18n, slippagePct: 1, invite: back });
  check(
    "reusing the link as a member spends no seat",
    (await club.clubStatus(publicClient, t, creator.account)).seatsLeft === seatsBefore,
  );

  // ---- alice invites bob; bob's trades pay alice
  const aliceLink = club.encodeInvite(await club.signInvite(alice, t));
  await club.buy(bob, { token: t, usdc: 10n * 10n ** 18n, slippagePct: 1, invite: club.decodeInvite(aliceLink) });
  const aliceBefore = await club.clubClaimable(publicClient, alice.account);
  await club.buy(bob, { token: t, usdc: 100n * 10n ** 18n, slippagePct: 1 });
  const aliceEarned = (await club.clubClaimable(publicClient, alice.account)) - aliceBefore;
  // 150 bps, of which 110 is the tree, of which level 1 takes two thirds.
  const fee = (100n * 10n ** 18n * 150n) / 10_000n;
  const tree = fee - (fee * 30n) / 150n - (fee * 10n) / 150n;
  check("bob's buy pays alice level-1 share", aliceEarned === (tree * 2n) / 3n, `$${Number(aliceEarned) / 1e18}`);

  // ---- bob sells
  const held = (await publicClient.readContract({
    address: t,
    abi: aromaTokenAbi,
    functionName: "balanceOf",
    args: [bob.account],
  })) as bigint;
  const { usdcOut } = await club.sell(bob, { token: t, amount: held / 2n, slippagePct: 1 });
  check("bob sells half through the permit flow", usdcOut > 0n, `$${(Number(usdcOut) / 1e18).toFixed(4)}`);

  // ---- claim
  const owed = await club.clubClaimable(publicClient, alice.account);
  const balBefore = await publicClient.getBalance({ address: alice.account });
  await club.claimClubEarnings(alice);
  const balAfter = await publicClient.getBalance({ address: alice.account });
  check("alice claims her earnings", (await club.clubClaimable(publicClient, alice.account)) === 0n && balAfter > balBefore - 10n ** 16n, `$${Number(owed) / 1e18}`);

  // ---- revoke kills outstanding links
  await club.revokeInvites(creator, t);
  const after = await club.inviteProblem(publicClient, t, stranger.account, back!);
  check("revoking cancels the creator's old link", after === "invite revoked", after);

  console.log(failures === 0 ? "\n  all passed" : `\n  ${failures} FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
