"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRouter } from "next/navigation";
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

  /**
   * Polled every 15s, not wagmi's default ~4s.
   *
   * This is the single largest RPC cost the app has, and it is paid per
   * connected user per block-ish rather than once: it was roughly two
   * thirds of everything a connected wallet spends. A balance that updates
   * in fifteen seconds instead of four is indistinguishable while using
   * the app — and the moment it actually matters, after a trade, is not
   * covered by polling at all. refreshBalance() is called explicitly then,
   * which is both faster than any interval and free.
   */
  const { data: balance, refetch } = useBalance({
    address,
    query: { refetchInterval: 15_000 },
  });
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

/**
 * The wallet button, and everything that belongs behind it.
 *
 * It used to disconnect on click, which is a trap: the button showing your
 * balance is the one people press to see their holdings, and pressing it
 * logged them out. Now it opens a menu — address, copy, disconnect — with
 * the address itself going to the portfolio.
 *
 * That is also where the Portfolio nav item went. People look for their
 * own positions under their own wallet, and the nav stays short.
 */
export function ConnectButton() {
  const { connected, address, usdcBalance, connect, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!connected) {
    return (
      <button
        onClick={connect}
        className="h-10 shrink-0 rounded-sm border border-line-strong px-3.5 text-[13.5px] font-medium text-ink transition-colors hover:border-ink-3 hover:bg-surface-2 sm:h-12 sm:px-5 sm:text-[15px]"
      >
        Connect
      </button>
    );
  }

  async function copy() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard access can be refused outright; saying nothing is better
      // than claiming a copy that did not happen.
    }
  }

  function openPortfolio() {
    setOpen(false);
    router.push("/portfolio");
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-sm border bg-surface-2 px-3 transition-colors sm:h-12 sm:gap-2.5 sm:px-4 ${
          open ? "border-line-strong" : "border-line hover:border-line-strong"
        }`}
      >
        <span className="num text-[13px] text-ink sm:text-[14.5px]">{usdExact(usdcBalance)}</span>
        {/* Address is the least useful glance-value in a narrow header — the
            same collapse the "Launch a coin" button already does. */}
        <span className="hidden h-4 w-px bg-line-strong sm:block" />
        <span className="num hidden text-[14.5px] text-ink-2 sm:inline">
          {shortAddr(address!)}
        </span>
        <svg
          width="10"
          height="6"
          viewBox="0 0 8 5"
          aria-hidden
          className={`text-ink-3 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M0.5 0.5 L4 4 L7.5 0.5" fill="none" stroke="currentColor" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="slide-in absolute right-0 z-50 mt-1.5 w-52 overflow-hidden rounded-md border border-line-strong bg-surface py-1 shadow-lg"
        >
          <MenuItem onClick={openPortfolio}>
            <span className="num truncate">{shortAddr(address!)}</span>
            <span className="ml-auto text-[10.5px] text-ink-3">Portfolio</span>
          </MenuItem>

          <MenuItem onClick={copy}>
            {copied ? "Copied" : "Copy address"}
          </MenuItem>

          <div className="my-1 h-px bg-line" />

          <MenuItem
            onClick={() => {
              setOpen(false);
              disconnect();
            }}
            tone="down"
          >
            Disconnect
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  tone = "default",
  children,
}: {
  onClick: () => void;
  tone?: "default" | "down";
  children: React.ReactNode;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-surface-2 ${
        tone === "down" ? "text-down" : "text-ink"
      }`}
    >
      {children}
    </button>
  );
}
