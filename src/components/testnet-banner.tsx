"use client";

import { useSyncExternalStore } from "react";
import { ARC_TESTNET } from "@/lib/arc";

/**
 * The one thing a first-time visitor has to know.
 *
 * Two facts, and the second is the useful one: this is a test network, and
 * you cannot do anything here without test funds. Somebody arriving from a
 * link, connecting a wallet, and finding a zero balance has no way to guess
 * that a faucet exists — so the faucet is a link in the banner rather than
 * a line in the footer nobody scrolls to.
 *
 * Above the header and not sticky. The header is already 124px, and a
 * permanent second bar would spend a tenth of a laptop screen on something
 * you only need to read once. It scrolls away and stays gone.
 *
 * Dismissal is remembered per browser. Nagging someone who has already
 * understood is how a banner teaches people to ignore banners — which
 * matters for the day there is something urgent to say.
 */

const KEY = "aroma:testnet-banner";

/**
 * Whether the banner is dismissed lives in localStorage, which the server
 * cannot read — so the two render differently on purpose.
 *
 * useSyncExternalStore says exactly that, natively, with no effect and no
 * second render pass. The same reasoning as the mount check in wallet.tsx.
 */
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function isOpen(): boolean {
  try {
    return localStorage.getItem(KEY) !== "dismissed";
  } catch {
    // Private window, or site data blocked. Showing it is the safer
    // failure — worse to hide a testnet warning than to repeat it.
    return true;
  }
}

/** Hidden during SSR, so a dismissed banner never flashes on load. */
const isClosedOnServer = () => false;

export function TestnetBanner() {
  const show = useSyncExternalStore(subscribe, isOpen, isClosedOnServer);

  if (!show) return null;

  function dismiss() {
    try {
      localStorage.setItem(KEY, "dismissed");
    } catch {
      // It reappears next visit. A small cost, and nothing to do about it.
    }
    for (const l of listeners) l();
  }

  return (
    <div className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-4 py-2">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] leading-relaxed">
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 shrink-0 rounded-full bg-warn" />
            <span className="font-medium text-warn">Test network</span>
          </span>
          <span className="text-ink-2">
            Coins here are worth nothing and balances are test funds.
          </span>
          <a
            href={ARC_TESTNET.faucet}
            target="_blank"
            rel="noreferrer"
            className="text-ink underline decoration-line-strong underline-offset-2 transition-colors hover:decoration-ink-2"
          >
            Get test USDC from Circle&apos;s faucet ↗
          </a>
        </span>

        <button
          onClick={dismiss}
          aria-label="Dismiss"
          className="-mr-1 shrink-0 rounded-xs p-2 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-2"
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path
              d="M1.5 1.5L10.5 10.5M10.5 1.5L1.5 10.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
