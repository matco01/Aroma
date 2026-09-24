import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { robinhoodTestnet } from "@reown/appkit/networks";
import { activeChain as arcChain } from "./chain";

/**
 * Wallet + chain wiring.
 *
 * Two chains are registered, not one, and the order matters:
 *
 *   - Robinhood Chain (`liveChain`) is where the Club auction runs, and is
 *     the default — it is what a fresh visitor's wallet is asked to use.
 *   - Arc (`chain.ts`'s `activeChain`) is where the pool system this
 *     replaced was built to launch. Its hooks (use-trade, use-creator-fees)
 *     pin every read and write to Arc's chain id and switch the wallet
 *     before signing, so Arc has to stay registered here or those calls
 *     have no chain to resolve against.
 *
 * Testnet by default for Robinhood Chain, matching the project's own
 * verification-first stance on it: nothing there has run end-to-end yet
 * (see src/lib/robinhood.ts's FIXME addresses).
 */

const PUBLIC_ROBINHOOD_TESTNET_RPC = "https://rpc.testnet.chain.robinhood.com";

/**
 * Every Robinhood Chain RPC endpoint we're willing to use, best first —
 * same reasoning as chain.ts's ARC_RPC_URLS: reads are cheap to retry, but a
 * single provider having a bad minute should not mean nobody can bid.
 */
export const ROBINHOOD_RPC_URLS: string[] = (
  process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL ?? PUBLIC_ROBINHOOD_TESTNET_RPC
)
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

export const ROBINHOOD_RPC_URL = ROBINHOOD_RPC_URLS[0] ?? PUBLIC_ROBINHOOD_TESTNET_RPC;

/**
 * viem's built-in definition, with the RPC a wallet is offered replaced by
 * ours — viem's default is the public, rate-limited endpoint.
 */
export const liveChain = {
  ...robinhoodTestnet,
  rpcUrls: { default: { http: [ROBINHOOD_RPC_URL] } },
};

/**
 * Reown Cloud project ID. Free, from cloud.reown.com.
 *
 * AppKit cannot initialize without one, so when it's absent we fall back to
 * wagmi's injected connector alone — browser wallets (MetaMask, Rabby)
 * still work, WalletConnect and the AppKit modal don't. That keeps the app
 * runnable for anyone who clones this without credentials, instead of
 * crashing on boot with a config error.
 */
export const REOWN_PROJECT_ID = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "";
export const hasReownProject = REOWN_PROJECT_ID.length > 0;

export const networks = [liveChain, arcChain] as const;

export const wagmiAdapter = new WagmiAdapter({
  projectId: REOWN_PROJECT_ID,
  networks: [liveChain, arcChain],
  // Deliberately *not* cookie storage. Cookie-based rehydration needs
  // headers() in the root layout, which opts every route out of static
  // generation — trading 54 prerendered pages for avoiding a brief
  // "Connect" flash on reload. wagmi reconnects from localStorage on the
  // client instead; the flash is the cheaper cost.
  ssr: false,
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;
