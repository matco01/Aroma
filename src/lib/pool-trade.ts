import { decodeEventLog, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { aromaRouterAbi, aromaTokenAbi, poolFactoryAbi, poolVaultAbi } from "./abis";
import { POOL, POOL_CONTRACTS } from "./arc";
import { OPENING_PRICE_USD, previewBuy } from "./pool-math";

/**
 * The pool system's write side, as plain functions.
 *
 * No React in here on purpose. The hooks in use-trade.ts and
 * use-creator-fees.ts own the component state and call these; a script can
 * call exactly the same functions against a local fork, which is how the
 * money-moving code gets tested as the code the site runs rather than as a
 * copy of it.
 *
 * Quotes come from simulating the router call that is about to be sent, not
 * from Uniswap's Quoter and not from client-side maths. Simulation runs the
 * real pool, the real hook fee and the router's own checks — including its
 * refusal to fill a trade partially — so the number that sets the slippage
 * floor is the number the chain would produce. It also removes a dependency
 * on a Quoter address nobody has verified on Arc.
 */

export type TxPhase = "idle" | "quoting" | "signing" | "pending" | "success" | "error";

type WriteArgs = {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
};

export type Ctx = {
  publicClient: PublicClient;
  account: Address;
  /** Sends a transaction and returns its hash. wagmi's writeContractAsync fits. */
  write: (args: WriteArgs) => Promise<Hex>;
  /** Signs EIP-712 typed data. wagmi's signTypedDataAsync fits. */
  sign?: (args: {
    domain: { name: string; version: string; chainId: number; verifyingContract: Address };
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<Hex>;
  onPhase?: (phase: TxPhase) => void;
};

const router = () => POOL_CONTRACTS.aromaRouter as Address;
const factory = () => POOL_CONTRACTS.poolFactory as Address;
const vault = () => POOL_CONTRACTS.poolVault as Address;

/** Floor of a quote after slippage, in basis points of precision. */
export function applySlippage(amount: bigint, slippagePct: number): bigint {
  const keepBps = BigInt(Math.max(0, Math.round((100 - slippagePct) * 100)));
  return (amount * keepBps) / 10_000n;
}

/**
 * Waits for a transaction and fails if it reverted.
 *
 * waitForTransactionReceipt resolves for a reverted transaction exactly as it
 * does for a successful one. The curve flow checked nothing further, so a
 * trade that reverted on-chain — a slippage floor hit between quote and
 * inclusion — was reported as a success.
 */
async function confirm(publicClient: PublicClient, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error("Transaction reverted on-chain");
  }
  return receipt;
}

export async function buy(
  ctx: Ctx,
  p: { token: Address; usdc: bigint; slippagePct: number },
): Promise<{ hash: Hex; tokensOut: bigint }> {
  ctx.onPhase?.("quoting");
  // Simulated with a zero floor so it reports what the trade actually gets.
  const { result } = await ctx.publicClient.simulateContract({
    address: router(),
    abi: aromaRouterAbi,
    functionName: "buy",
    args: [p.token, 0n],
    value: p.usdc,
    account: ctx.account,
  });
  const quoted = result as bigint;
  const minOut = applySlippage(quoted, p.slippagePct);

  ctx.onPhase?.("signing");
  const hash = await ctx.write({
    address: router(),
    abi: aromaRouterAbi as Abi,
    functionName: "buy",
    args: [p.token, minOut],
    value: p.usdc,
  });

  ctx.onPhase?.("pending");
  await confirm(ctx.publicClient, hash);
  return { hash, tokensOut: quoted };
}

export async function sell(
  ctx: Ctx,
  p: { token: Address; amount: bigint; slippagePct: number },
): Promise<{ hash: Hex; usdcOut: bigint }> {
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

  // The permit comes first. Unlike a buy, a sell cannot be simulated without
  // one — the router pulls the tokens with it — and the permit does not
  // commit to a minimum, so signing it before quoting costs nothing: the
  // same signature is then used for the simulation and for the real call.
  ctx.onPhase?.("signing");
  const signature = await ctx.sign({
    domain: {
      name,
      version: "1",
      chainId: ctx.publicClient.chain!.id,
      verifyingContract: p.token,
    },
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
    message: {
      owner: ctx.account,
      spender: router(),
      value: p.amount,
      nonce,
      deadline,
    },
  });
  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const v = parseInt(signature.slice(130, 132), 16);

  ctx.onPhase?.("quoting");
  const { result } = await ctx.publicClient.simulateContract({
    address: router(),
    abi: aromaRouterAbi,
    functionName: "sell",
    args: [p.token, p.amount, 0n, deadline, v, r, s],
    account: ctx.account,
  });
  const quoted = result as bigint;
  const minOut = applySlippage(quoted, p.slippagePct);

  ctx.onPhase?.("signing");
  const hash = await ctx.write({
    address: router(),
    abi: aromaRouterAbi as Abi,
    functionName: "sell",
    args: [p.token, p.amount, minOut, deadline, v, r, s],
  });

  ctx.onPhase?.("pending");
  await confirm(ctx.publicClient, hash);
  return { hash, usdcOut: quoted };
}

/**
 * Deploys a token, creates its pool, and optionally runs the creator's own
 * first buy — one transaction.
 *
 * The first buy's floor is set from the pool maths rather than left at zero.
 * Nobody can trade before a pool that does not exist yet, so there is no
 * price movement to protect against; the floor is there so that a wrong
 * constant anywhere between this file and PoolVault reverts the launch
 * instead of quietly handing the creator fewer tokens than they were shown.
 */
export async function createToken(
  ctx: Ctx,
  p: { name: string; symbol: string; description: string; metadataUri: string; devBuy: bigint },
): Promise<{ hash: Hex; token: Address | null }> {
  let minTokensOut = 0n;
  if (p.devBuy > 0n) {
    const expected = previewBuy(OPENING_PRICE_USD, Number(p.devBuy) / 1e18).out;
    minTokensOut = BigInt(Math.floor(expected * 0.99)) * 10n ** 18n;
  }

  ctx.onPhase?.("signing");
  const hash = await ctx.write({
    address: factory(),
    abi: poolFactoryAbi as Abi,
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
      const decoded = decodeEventLog({ abi: poolFactoryAbi, data: log.data, topics: log.topics });
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

/** Unclaimed creator fees for a token, in 18-decimal native USDC. */
export async function creatorFees(publicClient: PublicClient, token: Address): Promise<bigint> {
  const launch = (await publicClient.readContract({
    address: vault(),
    abi: poolVaultAbi,
    functionName: "launches",
    args: [token],
  })) as readonly [Address, Hex, bigint, bigint];
  return launch[2];
}

export async function claimCreatorFees(ctx: Ctx, token: Address): Promise<Hex> {
  ctx.onPhase?.("signing");
  const hash = await ctx.write({
    address: vault(),
    abi: poolVaultAbi as Abi,
    functionName: "claimCreatorFees",
    args: [token],
  });
  ctx.onPhase?.("pending");
  await confirm(ctx.publicClient, hash);
  return hash;
}

/**
 * A sentence out of a wallet or contract rejection, rather than a wall of
 * hex.
 *
 * Contract revert strings are matched by substring because viem nests them
 * several causes deep and words them differently between a simulation and a
 * receipt.
 */
export function readableError(e: unknown): string {
  const msg = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? "")}` : String(e);
  const has = (s: string) => msg.toLowerCase().includes(s);

  if (/user rejected|denied transaction|rejected the request|user denied/i.test(msg)) {
    return "Rejected in wallet";
  }
  if (has("insufficient liquidity")) {
    return `The pool can't fill a trade that size. Try a smaller amount.`;
  }
  if (has("dev buy exceeds cap")) {
    return `The first buy is capped at $${POOL.maxDevBuyUsd.toLocaleString("en-US")}`;
  }
  if (has("slippage")) return "Price moved — try again";
  if (has("insufficient funds")) return "Not enough USDC for this trade plus gas";
  if (has("unknown token")) return "This coin isn't an Aroma launch";
  if (has("permit failed")) return "The signature wasn't accepted — try again";
  if (has("not creator")) return "Only this coin's creator can claim its fees";
  if (has("usdc transfer failed")) return "Your wallet couldn't receive the USDC";
  if (has("no usdc sent") || has("tokenamount=0")) return "Amount too small to trade";
  if (has("reverted on-chain")) return "The transaction reverted — nothing was spent but gas";
  if (has("chain mismatch") || has("does not match the target chain")) {
    return "Switch your wallet to Arc to continue";
  }

  const first = (e as { shortMessage?: string })?.shortMessage ?? msg.split("\n")[0];
  return first.slice(0, 140);
}
