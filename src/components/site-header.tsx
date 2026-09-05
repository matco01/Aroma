"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ARC_TESTNET } from "@/lib/arc";
import { ConnectButton } from "./wallet";
import { CommandMenu } from "./command-menu";

/**
 * Portfolio is deliberately absent.
 *
 * It is the one page that means nothing until you connect, so as a nav
 * item it is dead weight for every first-time visitor — and "my holdings"
 * is something people look for under their own wallet, not in the site
 * nav. It lives in the wallet menu now, which also keeps this list short:
 * the competition is running seven top-level items and it is the thing
 * that makes their app feel heavy.
 */
const NAV = [
  { href: "/", label: "Board" },
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
        <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-3 px-4">
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
                  className={`rounded-sm px-2.5 py-1.5 text-[13px] transition-colors ${
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
              className="rounded-sm px-2.5 py-1.5 text-[13px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
            >
              Explorer
              <span className="ml-0.5 text-ink-3">↗</span>
            </a>
          </nav>

          <div className="flex-1" />

          <button
            onClick={() => setMenuOpen(true)}
            className="flex h-9 items-center gap-2 rounded-sm border border-line bg-surface px-3 text-ink-3 transition-colors hover:border-line-strong sm:w-60"
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
            className="flex h-9 shrink-0 items-center rounded-sm bg-accent px-3.5 text-[12.5px] font-medium text-white transition-colors hover:bg-accent-hi"
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
 * The wisp, cut off its original backing so it sits on the header rather
 * than in a slightly-wrong square on top of it — the source PNG's
 * background was #030910, close enough to our #0b0c0f to read as a
 * mistake rather than a choice.
 *
 * 22px against 15px text: the wisp is tall and narrow, so matching the cap
 * height would leave it looking smaller than it is.
 */
function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      <Image
        src="/logo.png"
        alt=""
        width={22}
        height={22}
        priority
        className="shrink-0"
      />
      <span className="text-[15.5px] font-semibold tracking-[-0.02em] text-ink">
        Aroma
      </span>
    </span>
  );
}
