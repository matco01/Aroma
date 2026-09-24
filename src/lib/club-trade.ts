import {
  bytesToHex,
  decodeEventLog,
  hexToBytes,
  parseAbi,
  zeroAddress,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  aromaTokenAbi,
  clubFactoryAbi,
  clubRouterAbi,
  clubRouterUsdgAbi,
  clubVaultAbi,
  erc20PermitAbi,
} from "./abis";
import { CLUB } from "./arc";
import { CLUB_CONTRACTS, SETTLEMENT } from "./network";
import { OPENING_PRICE_USD, previewBuy } from "./pool-math";
import { applySlippage, type Ctx } from "./pool-trade";

/**
 * Club coins' write side, as plain functions. See CLUBS.md for the design and
 * pool-trade.ts for the conventions this follows.
 *
 * This deliberately duplicates pool-trade's buy and sell rather than
 * generalising them over a router address. Those two functions carry every
 * normal coin's trades today, and a refactor done to add a feature is the kind
 * of change that breaks the thing that already worked. The duplication is a
 * page of code; the risk it avoids is the live trading path.
 *
 * Two settlement currencies, one set of functions. On Arc a buy sends native
 * USDC as value. On Robinhood it pulls USDG through ClubRouterUsdg with an
 * EIP-2612 permit, so it is still one signature and one transaction. The
 * vault's reads and the invite format are identical on both, because
 * ClubVaultUsdg keeps ClubVault's interface.
 */

const router = () => CLUB_CONTRACTS.clubRouter as Address;
const factory = () => CLUB_CONTRACTS.clubFactory as Address;
const vault = () => CLUB_CONTRACTS.clubVault as Address;

async function confirm(publicClient: PublicClient, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Transaction reverted on-chain");
  return receipt;
}

// ---------------------------------------------------------------------------
// Invites
//
// An invite is an EIP-712 signature: free to make, no transaction. It travels
// in a link, and it is a bearer instrument — whoever buys with it first gets a
// seat, up to however many seats the inviter has left.
// ---------------------------------------------------------------------------

export type Invite = {
  inviter: Address;
  nonce: bigint;
  deadline: bigint;
  signature: Hex;
};

/**
 * Invite <-> the string that goes in a link.
 *
 * Packed bytes, base64url: inviter (20) · nonce (8) · deadline (8) · signature
 * (65) — 101 bytes, 135 characters. Separate query parameters would be ~200
 * and read as a wall of hex; a link people paste into Telegram should be as
 * short as it can honestly be. Nonce and deadline fit in 64 bits by any margin
 * that matters: one is a revocation counter, the other a unix timestamp.
 */
export function encodeInvite(invite: Invite): string {
  const bytes = new Uint8Array(101);
  bytes.set(hexToBytes(invite.inviter), 0);
  new DataView(bytes.buffer).setBigUint64(20, invite.nonce);
  new DataView(bytes.buffer).setBigUint64(28, invite.deadline);
  bytes.set(hexToBytes(invite.signature), 36);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Null for anything that is not a well-formed invite, rather than throwing. */
export function decodeInvite(text: string | null | undefined): Invite | null {
  if (!text || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    if (bin.length !== 101) return null;
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const inviter = bytesToHex(bytes.slice(0, 20)) as Address;
    if (inviter === zeroAddress) return null;
    return {
      inviter,
      nonce: view.getBigUint64(20),
      deadline: view.getBigUint64(28),
      signature: bytesToHex(bytes.slice(36, 101)),
    };
  } catch {
    return null;
  }
}

/**
 * Signs an invite for `token` and checks it before handing it back.
 *
 * The check matters more than it looks. A wallet that signs for the wrong
 * chain, or a smart-account wallet whose ERC-1271 answer the vault does not
 * accept, produces a link that looks perfectly good and fails for every person
 * who clicks it. Asking the vault now means the member finds out, not their
 * friends.
 */
export async function signInvite(ctx: Ctx, token: Address): Promise<Invite> {
  if (!ctx.sign) throw new Error("A signer is required to create an invite");

  const nonce = (await ctx.publicClient.readContract({
    address: vault(),
    abi: clubVaultAbi,
    functionName: "inviteNonce",
    args: [token, ctx.account],
  })) as bigint;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + CLUB.inviteTtlSeconds);

  ctx.onPhase?.("signing");
  const signature = await ctx.sign({
    domain: {
      name: "Aroma Clubs",
      version: "1",
      chainId: ctx.publicClient.chain!.id,
      verifyingContract: vault(),
    },
    types: {
      Invite: [
        { name: "token", type: "address" },
        { name: "inviter", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Invite",
    message: { token, inviter: ctx.account, nonce, deadline },
  });

  const invite: Invite = { inviter: ctx.account, nonce, deadline, signature };
  // Checked on behalf of nobody in particular: the zero address is never a
  // member, so every rule but "already a member" applies.
  const problem = await inviteProblem(ctx.publicClient, token, zeroAddress, invite);
  if (problem) throw new Error(problem);
  return invite;
}

/** Why an invite would not admit `invitee` — or "" if it would. */
export async function inviteProblem(
  publicClient: PublicClient,
  token: Address,
  invitee: Address,
  invite: Invite,
): Promise<string> {
  return (await publicClient.readContract({
    address: vault(),
    abi: clubVaultAbi,
    functionName: "inviteProblem",
    args: [token, invitee, invite.inviter, invite.nonce, invite.deadline, invite.signature],
  })) as string;
}

export async function revokeInvites(ctx: Ctx, token: Address): Promise<Hex> {
  ctx.onPhase?.("signing");
  const hash = await ctx.write({
    address: vault(),
    abi: clubVaultAbi as Abi,
    functionName: "revokeInvites",
    args: [token],
  });
  ctx.onPhase?.("pending");
  await confirm(ctx.publicClient, hash);
  return hash;
}

// ---------------------------------------------------------------------------
// Membership and earnings
// ---------------------------------------------------------------------------

export type ClubStatus = {
  isMember: boolean;
  inviter: Address;
  seatsTotal: number;
  seatsLeft: number;
};

export async function clubStatus(
  publicClient: PublicClient,
  token: Address,
  account: Address,
): Promise<ClubStatus> {
  const read = (functionName: "isMember" | "inviterOf" | "seatsOf" | "seatsLeft") =>
    publicClient.readContract({
      address: vault(),
      abi: clubVaultAbi,
      functionName,
      args: [token, account],
    });
  const [isMember, inviter, seatsTotal, seatsLeft] = await Promise.all([
    read("isMember"),
    read("inviterOf"),
    read("seatsOf"),
    read("seatsLeft"),
  ]);
  return {
    isMember: isMember as boolean,
    inviter: inviter as Address,
    seatsTotal: Number(seatsTotal),
    seatsLeft: Number(seatsLeft),
  };
}

/** Everything `account` can withdraw, across every club it earns from. */
export async function clubClaimable(publicClient: PublicClient, account: Address): Promise<bigint> {
  return (await publicClient.readContract({
    address: vault(),
    abi: clubVaultAbi,
    functionName: "claimable",
    args: [account],
  })) as bigint;
}

export async function claimClubEarnings(ctx: Ctx): Promise<Hex> {
  ctx.onPhase?.("signing");
  const hash = await ctx.write({
    address: vault(),
    abi: clubVaultAbi as Abi,
    functionName: "claim",
    args: [],
  });
  ctx.onPhase?.("pending");
  await confirm(ctx.publicClient, hash);
  return hash;
}

// ---------------------------------------------------------------------------
// Permits (Robinhood)
// ---------------------------------------------------------------------------

type Permit = { deadline: bigint; v: number; r: Hex; s: Hex };

/** What the router is passed when an allowance already covers the amount. */
const NO_PERMIT: Permit = { deadline: 0n, v: 0, r: zeroHash, s: zeroHash };

const eip5267Abi = parseAbi([
  "function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])",
]);

/**
 * The token's own EIP-712 domain, asked for rather than assumed.
 *
 * A permit signed under the wrong domain is not refused by the wallet; it is
 * refused by the chain, after the user has signed, as a bare revert. USDG's
 * deployed version string has not been confirmed, so the token is asked
 * (EIP-5267) and "1" — OpenZeppelin's default, which AromaToken uses — is only
 * the fallback for a token that cannot answer.
 */
async function permitDomain(publicClient: PublicClient, token: Address) {
  try {
    const [, name, version, chainId, verifyingContract] = await publicClient.readContract({
      address: token,
      abi: eip5267Abi,
      functionName: "eip712Domain",
    });
    return { name, version, chainId: Number(chainId), verifyingContract };
  } catch {
    const name = (await publicClient.readContract({
      address: token,
      abi: erc20PermitAbi,
      functionName: "name",
    })) as string;
    return { name, version: "1", chainId: publicClient.chain!.id, verifyingContract: token };
  }
}

/**
 * A permit for `spender` to take `value` of `token`, or NO_PERMIT when the
 * allowance already covers it — someone who approved once should not be asked
 * to sign on every trade. Also what a Club bid pays with.
 */
export async function permitFor(ctx: Ctx, token: Address, spender: Address, value: bigint): Promise<Permit> {
  const allowance = (await ctx.publicClient.readContract({
    address: token,
    abi: erc20PermitAbi,
    functionName: "allowance",
    args: [ctx.account, spender],
  })) as bigint;
  if (allowance >= value) return NO_PERMIT;
  if (!ctx.sign) throw new Error("A signer is required to authorise this trade");

  const [domain, nonce] = await Promise.all([
    permitDomain(ctx.publicClient, token),
    ctx.publicClient.readContract({
      address: token,
      abi: erc20PermitAbi,
      functionName: "nonces",
      args: [ctx.account],
    }) as Promise<bigint>,
  ]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  ctx.onPhase?.("signing");
  const signature = await ctx.sign({
    domain,
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner: ctx.account, spender, value, nonce, deadline },
  });
  return {
    deadline,
    r: `0x${signature.slice(2, 66)}` as Hex,
    s: `0x${signature.slice(66, 130)}` as Hex,
    v: parseInt(signature.slice(130, 132), 16),
  };
}

async function buyUsdg(
  ctx: Ctx,
  p: { token: Address; usdc: bigint; slippagePct: number; invite?: Invite | null },
): Promise<{ hash: Hex; tokensOut: bigint }> {
  const permit = await permitFor(ctx, SETTLEMENT.token as Address, router(), p.usdc);
  const invite = p.invite
    ? {
        inviter: p.invite.inviter,
        nonce: p.invite.nonce,
        deadline: p.invite.deadline,
        signature: p.invite.signature,
      }
    : null;
  const functionName = invite ? "buyWithInvite" : "buy";
  const args = (minOut: bigint) =>
    invite ? [p.token, p.usdc, minOut, invite, permit] : [p.token, p.usdc, minOut, permit];

  ctx.onPhase?.("quoting");
  const { result } = await ctx.publicClient.simulateContract({
    address: router(),
    abi: clubRouterUsdgAbi,
    functionName,
    args: args(0n) as never,
    account: ctx.account,
  });
  const quoted = result as bigint;

  ctx.onPhase?.("signing");
  const hash = await ctx.write({
    address: router(),
    abi: clubRouterUsdgAbi as Abi,
    functionName,
    args: args(applySlippage(quoted, p.slippagePct)),
  });

  ctx.onPhase?.("pending");
  await confirm(ctx.publicClient, hash);
  return { hash, tokensOut: quoted };
}

async function sellUsdg(
  ctx: Ctx,
  p: { token: Address; amount: bigint; slippagePct: number },
): Promise<{ hash: Hex; usdcOut: bigint }> {
  const permit = await permitFor(ctx, p.token, router(), p.amount);

  ctx.onPhase?.("quoting");
  const { result } = await ctx.publicClient.simulateContract({
    address: router(),
    abi: clubRouterUsdgAbi,
    functionName: "sell",
    args: [p.token, p.amount, 0n, permit],
    account: ctx.account,
  });
  const quoted = result as bigint;

  ctx.onPhase?.("signing");
  const hash = await ctx.write({
    address: router(),
    abi: clubRouterUsdgAbi as Abi,
    functionName: "sell",
    args: [p.token, p.amount, applySlippage(quoted, p.slippagePct), permit],
  });

  ctx.onPhase?.("pending");
  await confirm(ctx.publicClient, hash);
  return { hash, usdcOut: quoted };
}

// ---------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------

/**
 * Buys a club coin. With an invite, and when the buyer is not yet a member,
 * this is also how they join — the seat is consumed only if the buy goes
 * through. For someone already in, the invite is ignored and it is an ordinary
 * buy, so a link clicked twice does not fail.
 */
export async function buy(
  ctx: Ctx,
  p: { token: Address; usdc: bigint; slippagePct: number; invite?: Invite | null },
): Promise<{ hash: Hex; tokensOut: bigint }> {
  if (!SETTLEMENT.native) return buyUsdg(ctx, p);
  const withInvite = Boolean(p.invite);
  const args = (minOut: bigint) =>
    withInvite
      ? [p.token, minOut, p.invite!.inviter, p.invite!.nonce, p.invite!.deadline, p.invite!.signature]
      : [p.token, minOut];
  const functionName = withInvite ? "buyWithInvite" : "buy";

  ctx.onPhase?.("quoting");
  const { result } = await ctx.publicClient.simulateContract({
    address: router(),
    abi: clubRouterAbi,
    functionName,
    args: args(0n) as never,
    value: p.usdc,
    account: ctx.account,
  });
  const quoted = result as bigint;
  const minOut = applySlippage(quoted, p.slippagePct);

  ctx.onPhase?.("signing");
  const hash = await ctx.write({
    address: router(),
    abi: clubRouterAbi as Abi,
    functionName,
    args: args(minOut),
    value: p.usdc,
  });

  ctx.onPhase?.("pending");
  await confirm(ctx.publicClient, hash);
  return { hash, tokensOut: quoted };
}

/** Identical to pool-trade's sell, through the club router. Open to anyone holding. */
export async function sell(
  ctx: Ctx,
  p: { token: Address; amount: bigint; slippagePct: number },
): Promise<{ hash: Hex; usdcOut: bigint }> {
  if (!SETTLEMENT.native) return sellUsdg(ctx, p);
  if (!ctx.sign) throw new Error("A signer is required to sell");

  const [name, nonce] = await Promise.all([
    ctx.publicClient.readContract({
      address: p.token,
      abi: aromaTokenAbi,
      functionName: "name",
    }) as Promise<string>,
    ctx.publicClient.readContract({
      address: p.token,
      abi: aromaTokenAbi,
      functionName: "nonces",
      args: [ctx.account],
    }) as Promise<bigint>,
  ]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  ctx.onPhase?.("signing");
  const signature = await ctx.sign({
    domain: { name, version: "1", chainId: ctx.publicClient.chain!.id, verifyingContract: p.token },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner: ctx.account, spender: router(), value: p.amount, nonce, deadline },
  });
  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const v = parseInt(signature.slice(130, 132), 16);

  ctx.onPhase?.("quoting");
  const { result } = await ctx.publicClient.simulateContract({
    address: router(),
    abi: clubRouterAbi,
    functionName: "sell",
    args: [p.token, p.amount, 0n, deadline, v, r, s],
    account: ctx.account,
  });
  const quoted = result as bigint;
  const minOut = applySlippage(quoted, p.slippagePct);

  ctx.onPhase?.("signing");
  const hash = await ctx.write({
    address: router(),
    abi: clubRouterAbi as Abi,
    functionName: "sell",
    args: [p.token, p.amount, minOut, deadline, v, r, s],
  });

  ctx.onPhase?.("pending");
  await confirm(ctx.publicClient, hash);
  return { hash, usdcOut: quoted };
}

/**
 * Launches a club coin on Arc. The caller becomes its creator, with 10 seats.
 *
 * Not on Robinhood: there a club is founded by winning the Club auction, and
 * ClubFactoryUsdg accepts launches from the auction contract alone.
 */
export async function createClub(
  ctx: Ctx,
  p: { name: string; symbol: string; description: string; metadataUri: string; devBuy: bigint },
): Promise<{ hash: Hex; token: Address | null }> {
  if (!SETTLEMENT.native) throw new Error("On Robinhood Chain, clubs are launched by winning the Club auction");
  let minTokensOut = 0n;
  if (p.devBuy > 0n) {
    const expected = previewBuy(OPENING_PRICE_USD, Number(p.devBuy) / 1e18, CLUB.tradeFeeBps).out;
    minTokensOut = BigInt(Math.floor(expected * 0.99)) * 10n ** 18n;
  }

  ctx.onPhase?.("signing");
  const hash = await ctx.write({
    address: factory(),
    abi: clubFactoryAbi as Abi,
    functionName: "createToken",
    args: [p.name, p.symbol, p.description, p.metadataUri, p.devBuy, minTokensOut],
    value: p.devBuy,
  });

  ctx.onPhase?.("pending");
  const receipt = await confirm(ctx.publicClient, hash);

  let token: Address | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== factory().toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: clubFactoryAbi, data: log.data, topics: log.topics });
      if (decoded.eventName === "TokenCreated") {
        token = (decoded.args as { token: Address }).token;
        break;
      }
    } catch {
      // Not the event we are looking for.
    }
  }
  return { hash, token };
}

/**
 * The club-specific refusals, in words. Anything not club-shaped falls through
 * to pool-trade's readableError, which the hooks call afterwards.
 */
export function clubReason(message: string): string | null {
  const m = message.toLowerCase();
  if (m.includes("invite only")) return "This is an invite-only club. You need an invite link to buy.";
  if (m.includes("invite expired")) return "This invite has expired. Ask for a new link.";
  if (m.includes("invite revoked")) return "This invite was cancelled by the person who sent it.";
  if (m.includes("no seats left")) return "This invite is full — every seat has been taken.";
  if (m.includes("bad invite signature")) return "This invite link is damaged or wasn't signed properly.";
  if (m.includes("inviter not a member")) return "Whoever sent this invite isn't a member of the club.";
  if (m.includes("join buy too small")) return `Joining takes a buy of at least $${CLUB.minJoinUsd}.`;
  if (m.includes("already a member")) return "You're already a member.";
  if (m.includes("permit failed and no allowance")) {
    return `Your ${SETTLEMENT.symbol} approval didn't go through. Try the trade again.`;
  }
  return null;
}
