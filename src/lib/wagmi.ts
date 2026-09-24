import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { activeChain } from "./chain";

/**
 * Wallet + chain wiring.
 *
 * One chain: whichever network.ts selects for this build. Every hook pins its
 * reads and writes to `activeChain` and switches the wallet there before
 * signing, so registering a second chain would only give a wallet somewhere
 * to be that nothing in the app talks to.
 */

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

export const networks = [activeChain] as const;

export const wagmiAdapter = new WagmiAdapter({
  projectId: REOWN_PROJECT_ID,
  networks: [activeChain],
  // Deliberately *not* cookie storage. Cookie-based rehydration needs
  // headers() in the root layout, which opts every route out of static
  // generation — trading 54 prerendered pages for avoiding a brief
  // "Connect" flash on reload. wagmi reconnects from localStorage on the
  // client instead; the flash is the cheaper cost.
  ssr: false,
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;
