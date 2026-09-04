"use client";

import Link from "next/link";
import { useLive } from "@/lib/use-live";
import { shortAddr, usd } from "@/lib/format";

/**
 * The tape. One line, four slots, newest on the left.
 *
 * Every row is a real Bought/Sold event pulled from CurveManager — no
 * invented ticks. Deliberately not a marquee: continuously scrolling text
 * is unreadable and pulls the eye off the board underneath. New trades
 * slide in once and then hold still long enough to actually be read.
 */
export function LiveTape() {
  // Pushed, not polled: the server holds one subscription to the index
  // and fans out, so a hundred open tabs cost the same as one.
  const { trades, connected } = useLive();
  const recent = trades.slice(0, 4);

  return (
    <div className="border-b border-line bg-surface">
      <div className="mx-auto flex h-9 max-w-[1400px] items-center gap-3 overflow-hidden px-4">
        <span className="label flex shrink-0 items-center gap-1.5">
          {/* The dot means what it says — it stops pulsing when the stream
              actually drops, rather than animating regardless. */}
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              connected ? "animate-pulse bg-up" : "bg-ink-3"
            }`}
          />
          Live
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-5">
          {recent.length === 0 && (
            <span className="text-[11.5px] text-ink-3">No trades yet</span>
          )}
          {recent.map((t, i) => (
            <Link
              key={t.id}
              href={`/coin/${t.tokenAddress}`}
              className={`flex shrink-0 items-center gap-1.5 text-[11.5px] ${
                i === 0 ? "slide-in" : ""
              } ${i > 0 ? "hidden md:flex" : ""} ${i > 1 ? "lg:flex" : ""} ${
                i > 2 ? "xl:flex" : ""
              }`}
            >
              <span className={`num ${t.side === "buy" ? "text-up" : "text-down"}`}>
                {t.side === "buy" ? "▲" : "▼"}
              </span>
              <span className="num text-ink-3">{shortAddr(t.account)}</span>
              <span className="text-ink-3">
                {t.side === "buy" ? "bought" : "sold"}
              </span>
              <span className="num text-ink">{usd(t.usd)}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
