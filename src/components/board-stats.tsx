"use client";

import { CURVE } from "@/lib/arc";
import { compact, usd } from "@/lib/format";
import { useBoard } from "@/lib/use-chain";

/**
 * Board-level totals, read from the index's own counters.
 *
 * Shares the board's query key, so the header and the grid are served from
 * one request and cannot disagree. The counters are protocol-wide, not a
 * sum over the current page — which matters the moment the board is
 * paginated.
 */
export function BoardStats() {
  // Shares the board's query, so the header and the grid can never
  // disagree — and the totals are the index's own counters rather than a
  // sum over whichever page happens to be loaded.
  const { data } = useBoard({ filter: "all", sort: "buys", limit: 24, skip: 0 });
  const stats = data?.stats;

  const volume = stats ? stats.totalVolumeUsd : 0;
  const graduated = stats ? stats.graduatedCount : 0;
  const tokenCount = stats ? stats.tokenCount : 0;
  const trades = stats ? stats.tradeCount : 0;

  return (
    <dl className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <HeadStat label="Tokens" value={String(tokenCount)} />
      <HeadStat label="Volume" value={usd(volume)} />
      <HeadStat label="Trades" value={compact(trades)} />
      <HeadStat label="Graduated" value={`${graduated}`} sub={`of ${tokenCount}`} />
      {/* Least load-bearing stat; first to go when space runs out. */}
      <div className="hidden sm:block">
        {/* Market cap, not the raise. "Graduates at $13.8K raised" answers a
            question nobody asks — what people want to know is where the
            token lands. The raise is the curve's internal measure and
            belongs on the progress bar, not in the headline. */}
        <HeadStat
          label="Graduates at"
          value={usd(CURVE.graduationMarketCapUsd)}
          sub="market cap"
        />
      </div>
    </dl>
  );
}

function HeadStat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="num mt-0.5 text-[14px] text-ink">
        {value}
        {sub && <span className="ml-1 text-[11px] text-ink-3">{sub}</span>}
      </dd>
    </div>
  );
}
