"use client";

import Link from "next/link";
import { ARC_TESTNET, CURVE } from "@/lib/arc";
import { ago, compact, pct, price, shortAddr, usd } from "@/lib/format";
import { useToken } from "@/lib/use-chain";
import type { Coin } from "@/lib/mock";
import { IndexerStatus } from "./indexer-status";
import { CoinArt } from "./coin-art";
import { Chip, GraduationBar, Stat } from "./primitives";
import { PriceChart } from "./price-chart";
import { TradePanel } from "./trade-panel";
import { CreatorFees } from "./creator-fees";
import { CoinActivity } from "./coin-activity";

export function CoinView({ address }: { address: string }) {
  const { data, isLoading, error } = useToken(address);
  const coin = data?.coin;
  const trades = data?.trades;

  if (isLoading) {
    return (
      <div className="mx-auto max-w-[1400px] px-4 py-10">
        <p className="text-[12.5px] text-ink-3">Reading the chain…</p>
      </div>
    );
  }

  if (error || !coin) {
    return (
      <div className="mx-auto max-w-[1400px] px-4 py-10">
        <Link href="/" className="-my-2 inline-block py-2 text-[12px] text-ink-3 hover:text-ink-2">
          ← Board
        </Link>
        <div className="mt-6 rounded-md border border-line bg-surface px-6 py-16 text-center">
          <p className="text-[13px] text-ink">Token not found</p>
          <p className="mt-1 text-[12px] text-ink-2">
            Nothing at{" "}
            <span className="num">{shortAddr(address)}</span> on{" "}
            {ARC_TESTNET.name}.
          </p>
        </div>
      </div>
    );
  }

  const up = coin.change24hPct >= 0;
  const remaining = Math.max(0, CURVE.graduationTargetUsd - coin.raisedUsd);

  // Holders come from trade history rather than a balance index — good
  // enough to show, but it counts buyers, not current holders. A real
  // holder list needs the indexer (plan §4).
  type HolderRow = { account: string; pctOwned: number };
  const holders: HolderRow[] = (trades ?? [])
    .filter((t) => t.side === "buy")
    .reduce<HolderRow[]>((acc, t) => {
      const existing = acc.find((h) => h.account === t.account);
      const share = (t.tokens / CURVE.totalSupply) * 100;
      if (existing) existing.pctOwned += share;
      else acc.push({ account: t.account, pctOwned: share });
      return acc;
    }, [])
    .sort((a, b) => b.pctOwned - a.pctOwned);

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6">
      <Link
        href="/"
        className="-my-2 inline-block py-2 text-[12px] text-ink-3 transition-colors hover:text-ink-2"
      >
        ← Board
      </Link>

      <div className="mt-4">
        <IndexerStatus health={data?.indexer} />
      </div>

      {/* Three items, not two, so the phone can put the trade panel between
          the chart and the trades table. Stacked in DOM order a two-column
          layout buries the buy box under the whole activity table, which on
          a phone is most of a screen of scrolling to reach the one control
          the page exists for. Explicit placement at lg keeps the desktop
          layout exactly as it was: chart and table in column one, panel
          spanning both rows in column two. */}
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <div className="flex items-start gap-3">
            <CoinArt seed={coin.seed} hue={coin.hue} size={52} radius={6} imageUrl={coin.imageUrl} alt={coin.name} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">
                  {coin.name}
                </h1>
                <span className="num text-[14px] text-ink-2">${coin.ticker}</span>
                {/* Only "graduated" earns a chip. "on curve · 0%" was noise
                    beside the name — the state is already obvious from the
                    curve panel, and a 0% badge on a fresh coin reads as a
                    failure rather than a starting point. */}
                {coin.graduated && <Chip tone="up">graduated</Chip>}
              </div>
              <div className="num mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-3">
                <span>
                  by <span className="text-ink-2">{shortAddr(coin.creator)}</span>
                </span>
                <span>·</span>
                <span>{ago(coin.createdAgoSeconds)} old</span>
                <span>·</span>
                <a
                  href={`${ARC_TESTNET.explorer}/token/${coin.contract}`}
                  target="_blank"
                  rel="noreferrer"
                  className="-my-1.5 inline-block py-1.5 transition-colors hover:text-ink-2"
                  title={coin.contract}
                >
                  contract {shortAddr(coin.contract)} ↗
                </a>
              </div>
            </div>
            <div className="text-right">
              <div className="num text-[20px] text-ink">{price(coin.priceUsd)}</div>
              <div className={`num text-[12px] ${up ? "text-up" : "text-down"}`}>
                {pct(coin.change24hPct)} <span className="text-ink-3">all</span>
              </div>
            </div>
          </div>

          {coin.description && (
            <p className="mt-3 max-w-2xl text-[12.5px] leading-relaxed text-ink-2">
              {coin.description}
            </p>
          )}

          <CoinLinks links={coin.links} />

          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3.5 rounded-md border border-line bg-surface p-3.5 sm:grid-cols-4">
            <Stat label="Market cap" value={usd(coin.marketCapUsd)} />
            <Stat label="Volume" value={usd(coin.volume24hUsd)} />
            <Stat label="Buyers" value={compact(coin.holders)} />
            <Stat
              label="Change"
              value={pct(coin.change24hPct)}
              tone={up ? "up" : "down"}
            />
          </div>

          <div className="mt-4.5">
<PriceChart series={data?.series ?? []} />
          </div>
        </div>

        {/* min-w-0 is load-bearing. A grid item defaults to min-width:auto,
            so without it the trade panel's min-content width sets the track
            for the whole single-column mobile layout — and drags the left
            column out with it, scrolling the entire page sideways. */}
        <aside className="min-w-0 space-y-4.5 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:sticky lg:top-[calc(var(--header-h)+16px)] lg:self-start">
          <TradePanel coin={coin} />

          <CreatorFees coin={coin} />

          <div className="rounded-md border border-line bg-surface p-3.5">
            <GraduationBar
              raisedUsd={coin.raisedUsd}
              graduated={coin.graduated}
              showLabel
            />
            <p className="mt-3 text-[12px] leading-relaxed text-ink-2">
              {coin.graduated ? (
                <>
                  This token graduated. Its liquidity moved into a permanently
                  locked pool.
                </>
              ) : (
                <>
                  {usd(remaining)} more into the curve and {coin.ticker}{" "}
                  graduates: liquidity migrates to a permanently locked pool at
                  a {usd(CURVE.graduationMarketCapUsd)} market cap. Until then
                  every buy and sell runs against the curve.
                </>
              )}
            </p>
          </div>

          <a
            href={`${ARC_TESTNET.explorer}/token/${coin.contract}`}
            target="_blank"
            rel="noreferrer"
            className="flex h-9 items-center justify-center rounded-md border border-line text-[12px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
          >
            View on Arcscan ↗
          </a>
        </aside>

        {/* Last in DOM, so on a phone it lands below the trade panel; back
            under the chart in column one on desktop. */}
        <div className="min-w-0 lg:col-start-1 lg:row-start-2">
          <CoinActivity
            trades={trades ?? []}
            holders={holders}
            ticker={coin.ticker}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Where a coin claims to live.
 *
 * Beside the description rather than tucked in a corner, because links are
 * most of what a coin is judged on — a launch with no X account reads as a
 * rug, and someone deciding that should not have to hunt for the absence.
 *
 * Every href here came from a stranger. The server already discarded
 * anything that was not an http(s) URL, so a javascript: URL cannot reach
 * this; rel="noreferrer nofollow" covers the rest. The label is ours, never
 * the creator's text, so a link cannot pretend to be a different one.
 */
function CoinLinks({ links }: { links: Coin["links"] }) {
  const items = [
    { href: links.website, label: "Website" },
    { href: links.x, label: "X" },
    { href: links.telegram, label: "Telegram" },
  ].filter((l) => l.href);

  if (items.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {items.map((l) => (
        <a
          key={l.label}
          href={l.href}
          target="_blank"
          rel="noreferrer nofollow"
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line px-3 text-[12.5px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
        >
          {l.label}
          <span className="text-ink-3">↗</span>
        </a>
      ))}
    </div>
  );
}
