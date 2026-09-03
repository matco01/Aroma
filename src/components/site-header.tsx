"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ARC_TESTNET } from "@/lib/arc";
import { ConnectButton } from "./wallet";
import { CommandMenu } from "./command-menu";

const NAV = [
  { href: "/", label: "Board" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/create", label: "Create" },
] as const;

export function SiteHeader() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setMenuOpen((v) => !v);
      }
      if (e.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      {/* Solid background, not a blurred translucent one. Blur over a scrolling
          data table is noise, and it is the most over-used generated-UI effect. */}
      <header className="sticky top-0 z-40 border-b border-line bg-bg">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-4">
          <Link href="/" className="flex items-center gap-2">
            <Wordmark />
          </Link>

          <nav className="hidden items-center gap-0.5 md:flex">
            {NAV.map((item) => {
              const active =
                item.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-sm px-2.5 py-1.5 text-[12.5px] transition-colors ${
                    active
                      ? "text-ink"
                      : "text-ink-2 hover:bg-surface-2 hover:text-ink"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
            <a
              href={ARC_TESTNET.explorer}
              target="_blank"
              rel="noreferrer"
              className="rounded-sm px-2.5 py-1.5 text-[12.5px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
            >
              Explorer
              <span className="ml-0.5 text-ink-3">↗</span>
            </a>
          </nav>

          <div className="flex-1" />

          <button
            onClick={() => setMenuOpen(true)}
            className="flex h-8 items-center gap-2 rounded-sm border border-line bg-surface px-2.5 text-ink-3 transition-colors hover:border-line-strong sm:w-56"
            aria-label="Search tokens"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            <span className="hidden flex-1 text-left text-[12px] sm:block">
              Search
            </span>
            <kbd className="num hidden rounded-xs border border-line px-1 text-[10px] sm:block">
              ⌘K
            </kbd>
          </button>

          <Link
            href="/create"
            className="flex h-8 shrink-0 items-center rounded-sm bg-accent px-3 text-[12px] font-medium text-white transition-colors hover:bg-accent-hi"
          >
            <span className="hidden sm:inline">Launch a coin</span>
            <span className="sm:hidden">Launch</span>
          </Link>

          <ConnectButton />
        </div>
      </header>

      {menuOpen && <CommandMenu onClose={() => setMenuOpen(false)} />}
    </>
  );
}

/**
 * The mark is a bonding curve drawn as three rising bars inside a square —
 * the shape of the thing the product actually does. No gradient, no glow.
 */
function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <rect width="18" height="18" rx="5" fill="var(--color-accent)" />
        <rect x="4" y="10" width="2.5" height="4" rx="1" fill="#fff" opacity="0.55" />
        <rect x="7.75" y="7" width="2.5" height="7" rx="1" fill="#fff" opacity="0.8" />
        <rect x="11.5" y="4" width="2.5" height="10" rx="1" fill="#fff" />
      </svg>
      <span className="text-[15px] font-semibold tracking-[-0.02em] text-ink">
        aram
      </span>
    </span>
  );
}
