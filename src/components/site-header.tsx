"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ARC_TESTNET } from "@/lib/arc";
import { ConnectButton } from "./wallet";
import { CommandMenu } from "./command-menu";

/**
 * Two items. Create is absent too — it was a nav link pointing at the
 * same page as the button sitting a few pixels to its right, so one of
 * them was always redundant, and the button is the one that looks like an
 * action.
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
        <div className="mx-auto flex h-[76px] max-w-[1400px] items-center gap-2 px-3 sm:h-(--header-h) sm:gap-4 sm:px-5">
          <Link href="/" className="mr-2 flex items-center gap-2.5">
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
                  className={`rounded-sm px-3 py-2 text-[16px] transition-colors ${
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
              className="rounded-sm px-3 py-2 text-[16px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
            >
              Explorer
              <span className="ml-0.5 text-ink-3">↗</span>
            </a>
          </nav>

          <div className="flex-1" />

          <button
            onClick={() => setMenuOpen(true)}
            className="flex h-10 items-center gap-2.5 rounded-sm border border-line bg-surface px-3 text-ink-3 transition-colors hover:border-line-strong sm:h-12 sm:w-72 sm:px-3.5"
            aria-label="Search tokens"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            <span className="hidden flex-1 text-left text-[14px] sm:block">
              Search
            </span>
            <kbd className="num hidden rounded-xs border border-line px-1.5 py-0.5 text-[11.5px] sm:block">
              ⌘K
            </kbd>
          </button>

          {/* The one fully-rounded thing in an interface built on square
              corners. That contrast is the point: it marks the primary
              action without having to be louder than everything else. */}
          <Link
            href="/create"
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-accent pl-3 pr-4 text-[13.5px] font-medium text-white transition-colors hover:bg-accent-hi sm:h-12 sm:gap-2 sm:pl-4 sm:pr-5 sm:text-[15px]"
          >
            <svg width="13" height="13" viewBox="0 0 11 11" aria-hidden>
              <path
                d="M5.5 1v9M1 5.5h9"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
            Create
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
 * background was a cool near-black, close enough to the page to read as a
 * mistake rather than a choice — and further off now that the page ground
 * is warm.
 *
 * 44px against 24px text: the wisp is tall and narrow, so matching the cap
 * height would leave it looking smaller than it is. It is also sized
 * against the 48px controls across the bar rather than against the
 * wordmark alone — at 34px it was the lightest object in a header built
 * out of 48px ones, which is what made the left side look unfinished.
 */
function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      <Image
        src="/logo.png"
        alt=""
        width={44}
        height={44}
        priority
        className="size-[30px] shrink-0 sm:size-[44px]"
      />
      <span className="text-[18px] font-semibold tracking-[-0.02em] text-ink sm:text-[24px]">
        Aroma
      </span>
    </span>
  );
}
