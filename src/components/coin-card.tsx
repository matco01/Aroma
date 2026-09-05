import Link from "next/link";
import type { Coin } from "@/lib/mock";
import { CURVE } from "@/lib/arc";
import { ago, compact, pct, shortAddr, usd } from "@/lib/format";
import { CoinArt } from "./coin-art";
import { GraduationBar, Sparkline } from "./primitives";

function progressOf(coin: Coin): number {
  return coin.graduated
    ? 100
    : Math.min(100, (coin.raisedUsd / CURVE.graduationTargetUsd) * 100);
}

/**
 * Grid card, led by the art.
 *
 * The art used to be a 40px square in the corner, which made every card
 * about ninety percent grey text and the board a wall of it. The token's
 * picture is the only element on this page carrying any colour, and it was
 * the smallest thing on the card. Now it leads: a full-width square, with
 * the numbers beneath it.
 *
 * The description went with it. Two lines of prose per card is what made
 * the grid feel like a document rather than a market, and the description
 * is on the coin page where someone reading it has actually asked.
 *
 * Hover still changes border and background only — nothing lifts, scales or
 * casts a shadow. On a board of these, those effects turn into static.
 */
/**
 * Under an hour old.
 *
 * On a launchpad, new *is* the signal — the coins worth looking at are
 * usually the ones that just appeared, and on a board sorted by anything
 * else they are invisible. Colouring the age gives the eye somewhere to
 * land without adding a badge, a border or another row.
 */
const FRESH_SECONDS = 3600;

export function CoinCard({ coin }: { coin: Coin }) {
  const up = coin.change24hPct >= 0;
  const progress = progressOf(coin);
  const fresh = coin.createdAgoSeconds < FRESH_SECONDS;

  return (
    <Link
      href={`/coin/${coin.id}`}
      className="group flex flex-col rounded-md border border-line bg-surface p-2 transition-colors hover:border-line-strong hover:bg-surface-2"
    >
      {/* Inset with its own corners rather than bleeding to the card edge.
          The card then frames the art instead of the art cutting the card
          in half, and the small margin reads as one layer sitting on
          another — which is what makes a grid of these feel composed
          rather than tiled. */}
      <div className="relative aspect-square w-full overflow-hidden rounded-sm bg-bg">
        <CoinArt
          seed={coin.seed}
          hue={coin.hue}
          size={512}
          radius={0}
          imageUrl={coin.imageUrl}
          alt={coin.name}
          className="h-full w-full object-cover"
        />

        {coin.graduated && (
          <span className="absolute left-2 top-2 rounded-xs bg-bg/80 px-2 py-1 text-[11px] font-medium text-up backdrop-blur-sm">
            graduated
          </span>
        )}

        <span
          className={`num absolute right-2 top-2 rounded-xs bg-bg/80 px-2 py-1 text-[11.5px] backdrop-blur-sm ${
            up ? "text-up" : "text-down"
          }`}
        >
          {pct(coin.change24hPct)}
        </span>
      </div>

      <div className="flex flex-1 flex-col px-2 pb-1 pt-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[14.5px] font-medium leading-tight text-ink">
              {coin.name}
            </div>
            <div className="num mt-1 truncate text-[12px] text-ink-2">
              ${coin.ticker}
            </div>
          </div>
          <Sparkline data={coin.history} up={up} width={56} height={18} />
        </div>

        {/* "MC" earns its place: without it the biggest number on the card
            is unlabelled, and market cap and volume are easy to confuse. */}
        <div className="mt-2 flex items-baseline gap-1.5">
          <span className="num text-[19px] leading-none text-ink">
            {usd(coin.marketCapUsd)}
          </span>
          <span className="num text-[11px] text-ink-3">MC</span>
        </div>

        <div className="mt-2.5 flex items-center gap-2">
          <GraduationBar
            raisedUsd={coin.raisedUsd}
            graduated={coin.graduated}
          />
          <span
            className={`num shrink-0 text-[11.5px] ${
              coin.graduated ? "text-up" : "text-ink-3"
            }`}
          >
            {progress.toFixed(0)}%
          </span>
        </div>

        {/* Contract and age. The address is what someone pastes into a
            wallet or explorer, and it is the one identifier that cannot be
            faked by a copycat using the same name and picture. */}
        <div className="num mt-auto flex items-center justify-between gap-2 pt-3 text-[11px]">
          <span className="truncate text-ink-3">{shortAddr(coin.contract)}</span>
          <span className={`shrink-0 ${fresh ? "text-up" : "text-ink-2"}`}>
            {ago(coin.createdAgoSeconds)}
          </span>
        </div>
      </div>
    </Link>
  );
}

/* Dense list row — same data, roughly a third of the height. */
export function CoinRow({ coin }: { coin: Coin }) {
  const up = coin.change24hPct >= 0;
  const progress = progressOf(coin);

  return (
    <Link
      href={`/coin/${coin.id}`}
      className="flex items-center gap-3 border-b border-line px-3.5 py-2.5 transition-colors hover:bg-surface-2"
    >
      <CoinArt
        seed={coin.seed}
        hue={coin.hue}
        size={28}
        radius={4}
        imageUrl={coin.imageUrl}
        alt={coin.name}
      />

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
        <GraduationBar
          raisedUsd={coin.raisedUsd}
          graduated={coin.graduated}
        />
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
