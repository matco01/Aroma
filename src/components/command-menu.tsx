"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSearch } from "@/lib/use-chain";
import { usd, pct } from "@/lib/format";
import { CoinArt } from "./coin-art";

/**
 * Search is the primary navigation on a board with hundreds of tokens, so it
 * gets a real keyboard surface rather than a decorative input. Both reference
 * launchpads put a visible ⌘K in the header for exactly this reason.
 */
export function CommandMenu({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  // Searches the whole index, not whatever happens to be in memory. An
  // empty query returns the most-traded tokens, so the menu is useful the
  // moment it opens.
  const { data, isFetching } = useSearch(q);
  const results = data?.tokens ?? [];

  // The menu is mounted only while it is open, so "reset on open" is just
  // fresh component state — no effect needed to clear the query or refocus.
  const selected = Math.min(active, Math.max(0, results.length - 1));

  function go(id: string) {
    router.push(`/coin/${id}`);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") return onClose();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % results.length);
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    }
    if (e.key === "Enter" && results[selected]) {
      e.preventDefault();
      go(results[selected].id);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-bg/70 px-4 pt-[12vh]"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-md border border-line-strong bg-surface"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Search tokens"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <SearchIcon />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            autoFocus
            placeholder="Search name, ticker or contract address"
            className="h-11 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
          />
          <kbd className="num rounded-xs border border-line px-1 text-[10px] text-ink-3">
            esc
          </kbd>
        </div>

        <div className="max-h-[52vh] overflow-y-auto py-1">
          {results.length === 0 && (
            <div className="px-3 py-6 text-center text-[12px] text-ink-3">
              {isFetching
                ? "Searching…"
                : q.trim()
                  ? `No token matches “${q.trim()}”.`
                  : "No tokens launched yet."}
            </div>
          )}
          {results.map((c, i) => (
            <button
              key={c.id}
              onClick={() => go(c.id)}
              onMouseEnter={() => setActive(i)}
              className={`flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left ${
                i === selected ? "bg-surface-2" : ""
              }`}
            >
              <CoinArt seed={c.seed} hue={c.hue} size={24} radius={3} imageUrl={c.imageUrl} alt={c.name} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-ink">
                  {c.name}
                </span>
                <span className="num block text-[11px] text-ink-3">
                  ${c.ticker}
                </span>
              </span>
              <span className="num text-right text-[11.5px] text-ink-2">
                {usd(c.marketCapUsd)}
              </span>
              <span
                className={`num w-14 text-right text-[11.5px] ${
                  c.change24hPct >= 0 ? "text-up" : "text-down"
                }`}
              >
                {pct(c.change24hPct)}
              </span>
            </button>
          ))}
        </div>

        {/* Keyboard-only, so it is a row of instructions a phone can never
            follow. Hidden until there is a keyboard to use. */}
        <div className="hidden items-center gap-3 border-t border-line px-3 py-1.5 text-[10px] text-ink-3 sm:flex">
          <span>
            <Key>↑</Key>
            <Key>↓</Key> navigate
          </span>
          <span>
            <Key>↵</Key> open
          </span>
        </div>
      </div>
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mr-1 inline-block min-w-[14px] rounded-xs border border-line px-1 text-center text-[10px]">
      {children}
    </kbd>
  );
}

function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="4.5" stroke="var(--color-ink-3)" strokeWidth="1.3" />
      <path
        d="M10.5 10.5L14 14"
        stroke="var(--color-ink-3)"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
