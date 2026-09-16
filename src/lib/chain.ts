import { defineChain } from "@reown/appkit/networks";
import { NETWORK, LOCAL } from "./arc";

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
 *
 * The environment does not get to override a *local* fork. Pointing the app at
 * a fork and having it quietly read a remote chain instead is not a
 * configuration anyone wants, and it is what happened: a leftover testnet URL
 * in .env.local won over 127.0.0.1 and the board came back empty with no hint
 * as to why. The same shape is the real hazard on launch day — a deploy that
 * still carries the testnet URL would serve testnet data from the mainnet
 * site, looking completely normal while showing coins that do not exist. See
 * assertChainMatches() below, which turns that into a loud failure.
 */
const ENV_RPCS = (LOCAL ? "" : (process.env.NEXT_PUBLIC_ARC_RPC_URL ?? ""))
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

export const ARC_RPC_URLS: string[] = ENV_RPCS.length > 0 ? ENV_RPCS : [NETWORK.rpc];

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

/**
 * Confirms an endpoint is actually the chain we think it is.
 *
 * Every address in arc.ts is chain-specific, so an RPC for the wrong chain
 * does not fail — it succeeds, and returns nothing, because our contracts have
 * no code at those addresses over there. The site then renders a working,
 * empty launchpad. That is the worst possible failure: indistinguishable from
 * "no one has launched yet", on the one day when that is a plausible thing to
 * see.
 *
 * Called once per process by the server's read path. The result is cached, so
 * this costs a single eth_chainId per endpoint for the life of the process,
 * and a mismatch throws with both numbers rather than being logged and
 * shrugged off.
 */
const checked = new Map<string, Promise<void>>();

export function assertChainMatches(url: string): Promise<void> {
  let seen = checked.get(url);
  if (!seen) {
    seen = (async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      const body = (await res.json()) as { result?: string };
      const got = Number.parseInt(body.result ?? "0", 16);
      if (got !== NETWORK.id) {
        throw new Error(
          `RPC ${url} is chain ${got}, but this build targets ${NETWORK.name} (${NETWORK.id}). ` +
            `Check NEXT_PUBLIC_ARC_RPC_URL.`,
        );
      }
    })();
    checked.set(url, seen);
  }
  return seen;
}
