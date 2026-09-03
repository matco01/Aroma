"use client";

import Link from "next/link";
import { useAllTrades } from "@/lib/use-chain";
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
  const { data: trades } = useAllTrades();
  const recent = (trades ?? []).slice(0, 4);

  return (
    <div className="border-b border-line bg-surface">
      <div className="mx-auto flex h-9 max-w-[1400px] items-center gap-3 overflow-hidden px-4">
        <span className="label flex shrink-0 items-center gap-1.5">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-up" />
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
