import Link from "next/link";
import type { Coin } from "@/lib/mock";
import { CURVE } from "@/lib/arc";
import { ago, compact, pct, usd } from "@/lib/format";
import { CoinArt } from "./coin-art";
import { GraduationBar, Sparkline } from "./primitives";

/* Grid card. Hover changes border and background only — nothing lifts, scales
   or casts a shadow. On a 48-card board those effects turn into visual static. */
export function CoinCard({ coin }: { coin: Coin }) {
  const up = coin.change24hPct >= 0;
  const progress = coin.graduated
    ? 100
    : Math.min(100, ((coin.marketCapUsd - CURVE.startingMarketCapUsd) / (CURVE.graduationMarketCapUsd - CURVE.startingMarketCapUsd)) * 100);

  return (
    <Link
      href={`/coin/${coin.id}`}
      className="group flex flex-col rounded-md border border-line bg-surface p-3.5 transition-colors hover:border-line-strong hover:bg-surface-2"
    >
      <div className="flex items-start gap-3">
        <CoinArt seed={coin.seed} hue={coin.hue} size={40} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium text-ink">
            {coin.name}
          </div>
          <div className="num mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-3">
            <span className="text-ink-2">${coin.ticker}</span>
            <span>·</span>
            <span>{ago(coin.createdAgoSeconds)}</span>
            {coin.graduated && (
              <>
                <span>·</span>
                <span className="text-up">graduated</span>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`num text-[12px] ${up ? "text-up" : "text-down"}`}>
            {pct(coin.change24hPct)}
          </span>
          <Sparkline data={coin.history} up={up} width={64} height={20} />
        </div>
      </div>

      <p className="mt-3 line-clamp-2 min-h-[2.6em] text-[12px] leading-relaxed text-ink-2">
        {coin.description}
      </p>

      <div className="mt-3.5 grid grid-cols-3 gap-2.5">
        <MiniStat label="Mcap" value={usd(coin.marketCapUsd)} />
        <MiniStat label="Vol 24h" value={usd(coin.volume24hUsd)} />
        <MiniStat label="Holders" value={compact(coin.holders)} />
      </div>

      <div className="mt-3.5 flex items-center gap-2">
        <GraduationBar marketCapUsd={coin.marketCapUsd} graduated={coin.graduated} />
        <span
          className={`num shrink-0 text-[10.5px] ${
            coin.graduated ? "text-up" : "text-ink-3"
          }`}
        >
          {progress.toFixed(0)}%
        </span>
      </div>
    </Link>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="label">{label}</div>
      <div className="num mt-px truncate text-[12px] text-ink">{value}</div>
    </div>
  );
}

/* Dense list row — same data, roughly a third of the height. */
export function CoinRow({ coin }: { coin: Coin }) {
  const up = coin.change24hPct >= 0;
  const progress = coin.graduated
    ? 100
    : Math.min(100, ((coin.marketCapUsd - CURVE.startingMarketCapUsd) / (CURVE.graduationMarketCapUsd - CURVE.startingMarketCapUsd)) * 100);

  return (
    <Link
      href={`/coin/${coin.id}`}
      className="flex items-center gap-3 border-b border-line px-3.5 py-2.5 transition-colors hover:bg-surface-2"
    >
      <CoinArt seed={coin.seed} hue={coin.hue} size={26} radius={3} />

      <div className="min-w-0 flex-[2]">
        <div className="truncate text-[12.5px] text-ink">{coin.name}</div>
        <div className="num truncate text-[10.5px] text-ink-3">
          ${coin.ticker} · {ago(coin.createdAgoSeconds)}
        </div>
      </div>

      <p className="hidden min-w-0 flex-[3] truncate text-[11.5px] text-ink-3 lg:block">
        {coin.description}
      </p>

      <div className="num w-20 shrink-0 text-right text-[12px] text-ink">
        {usd(coin.marketCapUsd)}
      </div>
      <div className="num hidden w-20 shrink-0 text-right text-[12px] text-ink-2 sm:block">
        {usd(coin.volume24hUsd)}
      </div>
      <div className="num hidden w-14 shrink-0 text-right text-[12px] text-ink-2 md:block">
        {compact(coin.holders)}
      </div>
      <div
        className={`num w-16 shrink-0 text-right text-[12px] ${
          up ? "text-up" : "text-down"
        }`}
      >
        {pct(coin.change24hPct)}
      </div>

      <div className="hidden w-24 shrink-0 items-center gap-2 sm:flex">
        <GraduationBar marketCapUsd={coin.marketCapUsd} graduated={coin.graduated} />
        <span
          className={`num shrink-0 text-[10.5px] ${
            coin.graduated ? "text-up" : "text-ink-3"
          }`}
        >
          {progress.toFixed(0)}%
        </span>
      </div>
    </Link>
  );
}
