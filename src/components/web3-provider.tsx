"use client";

import { useEffect, useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAppKit, useAppKit } from "@reown/appkit/react";
import { arcTestnet } from "@reown/appkit/networks";
import {
  wagmiAdapter,
  wagmiConfig,
  REOWN_PROJECT_ID,
  hasReownProject,
} from "@/lib/wagmi";
import { registerWalletModalOpener } from "@/lib/appkit-bridge";

/**
 * AppKit is initialized once at module scope, not inside the component —
 * calling createAppKit on every render would rebuild the modal singleton.
 *
 * Skipped entirely without a project ID: AppKit throws on an empty one, and
 * a missing credential shouldn't take the whole app down. Injected wallets
 * still work through wagmi in that state.
 */
if (hasReownProject) {
  createAppKit({
    adapters: [wagmiAdapter],
    networks: [arcTestnet],
    defaultNetwork: arcTestnet,
    projectId: REOWN_PROJECT_ID,
    metadata: {
      name: "Aroma",
      description: "Launch and trade fixed-supply tokens on Arc.",
      url: "https://Aroma.fun",
      icons: [],
    },
    features: {
      analytics: false,
      // Email and social sign-in stay off deliberately. AppKit can turn
      // them on with a flag, but they create embedded smart-account
      // wallets rather than plain EOAs — a different account type to test
      // against. Wallet-only first, matching Pons.
      email: false,
      socials: false,
    },
    themeMode: "dark",
    themeVariables: {
      // Match the app's own tokens so the modal doesn't look bolted on.
      "--w3m-accent": "#3d7dff",
      "--w3m-border-radius-master": "2px",
      "--w3m-font-family":
        "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
    },
  });
}

/**
 * Publishes AppKit's modal opener so wallet.tsx can trigger it without
 * importing an AppKit hook. Rendered only when AppKit was initialized —
 * conditional *rendering* is fine where a conditional hook call would not
 * be.
 */
function AppKitBridge() {
  const { open } = useAppKit();
  useEffect(() => {
    registerWalletModalOpener(open);
  }, [open]);
  return null;
}

export function Web3Provider({ children }: { children: ReactNode }) {
  // One QueryClient per browser session. Created in state rather than at
  // module scope so a server render can't leak cached data between users.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Chain data goes stale fast; refetching on focus keeps a
            // balance from sitting wrong after the user trades elsewhere.
            staleTime: 10_000,
            retry: 2,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {hasReownProject && <AppKitBridge />}
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
