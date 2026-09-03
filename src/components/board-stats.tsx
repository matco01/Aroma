"use client";

import { CURVE } from "@/lib/arc";
import { compact, usd } from "@/lib/format";
import { useTokens } from "@/lib/use-chain";

/**
 * Board-level totals, aggregated client-side from the same query the board
 * itself uses — so the numbers and the grid can never disagree, and there's
 * one fetch rather than two.
 */
export function BoardStats() {
  const { data: tokens } = useTokens();
  const all = tokens ?? [];

  const volume = all.reduce((sum, c) => sum + c.volume24hUsd, 0);
  const graduated = all.filter((c) => c.graduated).length;
  const buyers = all.reduce((sum, c) => sum + c.holders, 0);

  return (
    <dl className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <HeadStat label="Tokens" value={String(all.length)} />
      <HeadStat label="Volume" value={usd(volume)} />
      <HeadStat label="Buyers" value={compact(buyers)} />
      <HeadStat label="Graduated" value={`${graduated}`} sub={`of ${all.length}`} />
      {/* Least load-bearing stat; first to go when space runs out. */}
      <div className="hidden sm:block">
        <HeadStat
          label="Graduates at"
          value={usd(CURVE.graduationTargetUsd)}
          sub="raised"
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
