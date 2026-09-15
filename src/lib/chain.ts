import { defineChain } from "@reown/appkit/networks";
import { NETWORK } from "./arc";

/**
 * The one chain the app talks to, defined once.
 *
 * Wallet wiring, the server's chain-head reads and the no-indexer fallback
 * each used to import Arc testnet on their own, so moving to mainnet meant
 * finding every one of them. They all read this now.
 *
 * Built here rather than taken from viem's `arc`: viem defines Arc mainnet
 * with no RPC, no explorer and no multicall, and a wallet asked to add a
 * chain with no RPC has nothing to add.
 *
 * multicall3 is deliberately not declared. It has not been confirmed on Arc
 * mainnet, and wagmi falls back to individual calls when a chain declares
 * none — slower for a batch read, but correct, where declaring an address
 * with no code behind it makes every batch fail. Add it once verified.
 */

/**
 * Every RPC endpoint we're willing to use, best first.
 *
 * Comma-separate NEXT_PUBLIC_ARC_RPC_URL to supply more than one. Reads are
 * cheap to retry, but the write path touches money — a single provider having
 * a bad minute should not mean nobody can sell. Two independent providers is
 * the point.
 */
export const ARC_RPC_URLS: string[] = (process.env.NEXT_PUBLIC_ARC_RPC_URL ?? NETWORK.rpc)
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

/** First endpoint — what a wallet is offered when adding the network. */
export const ARC_RPC_URL = ARC_RPC_URLS[0] ?? NETWORK.rpc;

export const hasRpcFallback = ARC_RPC_URLS.length > 1;

export const activeChain = defineChain({
  id: NETWORK.id,
  caipNetworkId: `eip155:${NETWORK.id}`,
  chainNamespace: "eip155",
  name: NETWORK.name,
  nativeCurrency: NETWORK.currency,
  rpcUrls: { default: { http: [ARC_RPC_URL] } },
  ...(NETWORK.explorer
    ? { blockExplorers: { default: { name: "Arcscan", url: NETWORK.explorer } } }
    : {}),
});
