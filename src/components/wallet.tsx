"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useAccount, useBalance, useConnect, useDisconnect } from "wagmi";
import { injected } from "wagmi/connectors";
import { openWalletModal } from "@/lib/appkit-bridge";
import { shortAddr, usdExact } from "@/lib/format";

/**
 * The app's wallet surface — entirely real now.
 *
 * wagmi + Reown AppKit against Arc, reading the native USDC balance at 18
 * decimals (the ERC-20 view's 6 decimals is a display concern that never
 * enters this file). No simulated balance and no local position ledger:
 * holdings are read from each token's own contract and trades broadcast
 * through CurveManager, so there is nothing left here to fake.
 */

type WalletState = {
  address: string | null;
  usdcBalance: number;
  connected: boolean;
  connect: () => void;
  disconnect: () => void;
  /** Re-reads the native balance — call after a trade settles. */
  refreshBalance: () => void;
};

const Ctx = createContext<WalletState | null>(null);

const noopSubscribe = () => () => {};

/**
 * False during SSR and on the first client render, true afterwards.
 *
 * wagmi reconnects from localStorage synchronously, so without this the
 * server renders "Connect" while the client's first paint renders a
 * balance — a hydration mismatch React rightly complains about.
 * useSyncExternalStore expresses "server and client differ here, on
 * purpose" natively, with no effect and no extra render pass.
 */
function useMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const mounted = useMounted();
  const { address: wagmiAddress, isConnected: wagmiConnected } = useAccount();
  const { connect: wagmiConnect } = useConnect();
  const { disconnect: wagmiDisconnect } = useDisconnect();

  // Hold the pre-hydration shape until mounted so SSR output matches.
  const address = mounted ? wagmiAddress : undefined;
  const isConnected = mounted && wagmiConnected;

  const { data: balance, refetch } = useBalance({ address });
  const usdcBalance = mounted && balance ? Number(balance.value) / 1e18 : 0;

  const connect = useCallback(() => {
    // AppKit's modal when it's configured (browser wallets, WalletConnect,
    // mobile); otherwise whatever the browser has injected, so the app
    // stays usable without credentials.
    if (!openWalletModal()) {
      wagmiConnect({ connector: injected() });
    }
  }, [wagmiConnect]);

  const disconnect = useCallback(() => {
    wagmiDisconnect();
  }, [wagmiDisconnect]);

  const refreshBalance = useCallback(() => {
    refetch();
  }, [refetch]);

  const value = useMemo(
    () => ({
      address: address ?? null,
      usdcBalance,
      connected: isConnected,
      connect,
      disconnect,
      refreshBalance,
    }),
    [address, usdcBalance, isConnected, connect, disconnect, refreshBalance],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet must be used inside WalletProvider");
  return v;
}

export function ConnectButton() {
  const { connected, address, usdcBalance, connect, disconnect } = useWallet();

  if (!connected) {
    return (
      <button
        onClick={connect}
        className="h-8 rounded-sm border border-line-strong px-3 text-[12px] font-medium text-ink transition-colors hover:border-ink-3 hover:bg-surface-2"
      >
        Connect
      </button>
    );
  }

  return (
    <button
      onClick={disconnect}
      title={`${usdExact(usdcBalance)} · ${address} · disconnect`}
      className="flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-sm border border-line bg-surface-2 px-3 transition-colors hover:border-line-strong"
    >
      <span className="num text-[12px] text-ink">{usdExact(usdcBalance)}</span>
      {/* Address is the least useful glance-value in a narrow header — the
          same collapse the "Launch a coin" button already does. */}
      <span className="hidden h-3 w-px bg-line-strong sm:block" />
      <span className="num hidden text-[12px] text-ink-2 sm:inline">
        {shortAddr(address!)}
      </span>
    </button>
  );
}
