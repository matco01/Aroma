import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { robinhoodTestnet } from "@reown/appkit/networks";

/**
 * Wallet + chain wiring for Robinhood Chain.
 *
 * `arc.ts`/the old wagmi config (Arc) is untouched elsewhere in the repo —
 * this file is the one piece of shared wallet infrastructure that has to
 * point at the live chain, so it now points at Robinhood Chain instead.
 *
 * viem ships Robinhood Chain as a built-in chain (`robinhood`/
 * `robinhoodTestnet` in viem/chains, re-exported from
 * `@reown/appkit/networks`), the same way it already shipped Arc — no
 * hand-rolled chain definition to drift out of sync with reality.
 *
 * Testnet by default, matching the project's own verification-first stance
 * on this new chain: nothing here has been confirmed end-to-end yet (see
 * src/lib/robinhood.ts's FIXME addresses), so mainnet is opt-in via env var,
 * not the default a `git clone` gets.
 */

const PUBLIC_ROBINHOOD_TESTNET_RPC = "https://rpc.testnet.chain.robinhood.com";

/**
 * Every RPC endpoint we're willing to use, best first — same reasoning as
 * Arc's ARC_RPC_URLS: reads are cheap to retry, but a single provider having
 * a bad minute should not mean nobody can trade.
 */
export const ROBINHOOD_RPC_URLS: string[] = (
  process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL ?? PUBLIC_ROBINHOOD_TESTNET_RPC
)
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

export const ROBINHOOD_RPC_URL = ROBINHOOD_RPC_URLS[0] ?? PUBLIC_ROBINHOOD_TESTNET_RPC;

export const hasRpcFallback = ROBINHOOD_RPC_URLS.length > 1;

export const REOWN_PROJECT_ID = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "";
export const hasReownProject = REOWN_PROJECT_ID.length > 0;

export const activeChain = robinhoodTestnet;

export const networks = [robinhoodTestnet] as const;

export const wagmiAdapter = new WagmiAdapter({
  projectId: REOWN_PROJECT_ID,
  networks: [robinhoodTestnet],
  // Deliberately *not* cookie storage — same reasoning as Arc's config:
  // cookie rehydration needs headers() in the root layout, which opts every
  // route out of static generation. wagmi reconnects from localStorage on
  // the client instead.
  ssr: false,
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;
