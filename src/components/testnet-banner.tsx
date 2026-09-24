"use client";

import { useSyncExternalStore } from "react";
import { NETWORK, auctionDeployed } from "@/lib/network";

/**
 * The one line a visitor needs about the network.
 *
 * Aroma runs on Robinhood Chain, so the banner says what's true there:
 *
 *   - before the club contracts are deployed: clubs are coming, so a visitor
 *     who finds an empty auction page knows why;
 *   - on testnet once they are: the funds are worth nothing — which stays
 *     true, and worth saying, until mainnet;
 *   - on mainnet: nothing. A banner that is always there is one nobody reads.
 *
 * Above the header and not sticky, and dismissal is remembered per message,
 * so dismissing "coming soon" does not also silence whatever comes next.
 */

type Message = { key: string; tone: string; label: string; body: string };

function currentMessage(): Message | null {
  if (!auctionDeployed) {
    return {
      key: "aroma:banner:club-coming",
      tone: "text-accent-2",
      label: `Coming to ${NETWORK.name}`,
      body: "Clubs open here once their contracts are deployed.",
    };
  }
  if (!NETWORK.testnet) return null;
  return {
    key: "aroma:banner:testnet",
    tone: "text-warn",
    label: NETWORK.name,
    body: "Test funds only — nothing here is worth anything.",
  };
}

const MESSAGE = currentMessage();

const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function isOpen(): boolean {
  if (!MESSAGE) return false;
  try {
    return localStorage.getItem(MESSAGE.key) !== "dismissed";
  } catch {
    // Private window, or site data blocked. Showing it is the safer failure.
    return true;
  }
}

/** Hidden during SSR, so a dismissed banner never flashes on load. */
const isClosedOnServer = () => false;

export function TestnetBanner() {
  const show = useSyncExternalStore(subscribe, isOpen, isClosedOnServer);

  if (!show || !MESSAGE) return null;

  function dismiss() {
    try {
      localStorage.setItem(MESSAGE!.key, "dismissed");
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
            <span className={`size-1.5 shrink-0 rounded-full bg-current ${MESSAGE.tone}`} />
            <span className={`font-medium ${MESSAGE.tone}`}>{MESSAGE.label}</span>
          </span>
          <span className="text-ink-2">{MESSAGE.body}</span>
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
