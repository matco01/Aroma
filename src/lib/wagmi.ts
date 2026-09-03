import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { arcTestnet } from "@reown/appkit/networks";

/**
 * Wallet + chain wiring for Arc.
 *
 * viem ships Arc as a built-in chain, so there's no hand-rolled chain
 * definition to drift out of sync with reality — `arcTestnet.id` is 5042002,
 * which matches what the live RPC reports.
 *
 * The RPC URL here is what a wallet gets offered when it doesn't already
 * know Arc. It should become a paid, managed endpoint before launch rather
 * than the shared public one — see the infrastructure plan's §1, which
 * calls for two independent providers behind a fallback transport.
 */

export const ARC_RPC_URL =
  process.env.NEXT_PUBLIC_ARC_RPC_URL ?? "https://rpc.testnet.arc.io";

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

export const networks = [arcTestnet] as const;

export const wagmiAdapter = new WagmiAdapter({
  projectId: REOWN_PROJECT_ID,
  networks: [arcTestnet],
  // Deliberately *not* cookie storage. Cookie-based rehydration needs
  // headers() in the root layout, which opts every route out of static
  // generation — trading 54 prerendered pages for avoiding a brief
  // "Connect" flash on reload. wagmi reconnects from localStorage on the
  // client instead; the flash is the cheaper cost.
  ssr: false,
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;
