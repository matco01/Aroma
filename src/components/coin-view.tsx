"use client";

import Link from "next/link";
import { POOL } from "@/lib/arc";
import { NETWORK, clubsDeployed, explorerUrl } from "@/lib/network";
import { ago, compact, pct, price, shortAddr, usd } from "@/lib/format";
import { useToken } from "@/lib/use-chain";
import type { Coin } from "@/lib/mock";
import { IndexerStatus } from "./indexer-status";
import { CoinArt } from "./coin-art";
import { CopyAddress } from "./copy-address";
import { Chip, Stat } from "./primitives";
import { PriceChart } from "./price-chart";
import { TradePanel } from "./trade-panel";
import { CreatorFees } from "./creator-fees";
import { ClubPanel } from "./club-panel";
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
            {NETWORK.name}.
          </p>
        </div>
      </div>
    );
  }

  const up = coin.change24hPct >= 0;
  const tokenUrl = explorerUrl(`/token/${coin.contract}`);

  // Holders come from trade history rather than a balance index — good
  // enough to show, but it counts buyers, not current holders. A real
  // holder list needs the indexer (plan §4).
  type HolderRow = { account: string; pctOwned: number };
  const holders: HolderRow[] = (trades ?? [])
    .filter((t) => t.side === "buy")
    .reduce<HolderRow[]>((acc, t) => {
      const existing = acc.find((h) => h.account === t.account);
      const share = (t.tokens / POOL.totalSupply) * 100;
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

      {/* Four items, so a phone gets identity, then the trade panel, then
          the chart, then the table — in that order.

          The panel sits above the chart rather than below it because the
          page exists to be traded on. A chart is what you look at once you
          have decided to care; the buy box is what you came for, and on a
          phone anything below the fold may as well not be there. Desktop is
          untouched: explicit placement at lg keeps column one as identity,
          chart, table with the panel spanning all three rows beside it. */}
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
                {clubsDeployed && coin.club && <Chip tone="accent">club</Chip>}
              </div>
              <div className="num mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-3">
                <span>
                  by <span className="text-ink-2">{shortAddr(coin.creator)}</span>
                </span>
                <span>·</span>
                <span>{ago(coin.createdAgoSeconds)} old</span>
                {/* Copyable always; linked only once there is an explorer to
                    link to — see explorerUrl. Copying is the part that matters:
                    the address is what anyone sharing or checking a coin needs,
                    and Arc has no public explorer yet, so a link on its own
                    would leave phones with no way to get it at all.

                    The separator rides with the address rather than sitting as
                    its own flex item, because at phone width the line wraps
                    here and a lone "·" was landing on the row above. */}
                <span className="inline-flex items-center gap-x-2">
                  <span>·</span>
                  <CopyAddress address={coin.contract} />
                  {tokenUrl && (
                    <a
                      href={tokenUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="-my-1.5 inline-block py-1.5 transition-colors hover:text-ink-2"
                      title="View on the explorer"
                    >
                      ↗
                    </a>
                  )}
                </span>
              </div>
            </div>
            <div className="text-right">
              <div className="num text-[24px] text-ink sm:text-[20px]">{price(coin.priceUsd)}</div>
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

        </div>

        {/* min-w-0 is load-bearing. A grid item defaults to min-width:auto,
            so without it the trade panel's min-content width sets the track
            for the whole single-column mobile layout — and drags the left
            column out with it, scrolling the entire page sideways. */}
        <aside className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:sticky lg:top-[calc(var(--header-h)+16px)] lg:self-start">
          <TradePanel coin={coin} />
        </aside>

        {/* Carded on a phone, bare on desktop. Stacked single-column the
            chart sits between two bordered panels with nothing of its own,
            so it reads as a gap rather than a section. On desktop it has a
            whole column to itself and needs no help. */}
        <div className="min-w-0 rounded-lg border border-line bg-surface p-3 lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0 lg:col-start-1 lg:row-start-2">
          <PriceChart series={data?.series ?? []} />
        </div>

        {/* Everything that is context rather than action. Split out of the
            sidebar so that on a phone the chart lands directly under the
            swap box: creator fees and pool details are things you
            read once, and three cards between the buy button and the price
            is three cards of scrolling to check the price before buying.
            On desktop they sit under the panel exactly as before. */}
        <div className="min-w-0 space-y-4.5 lg:col-start-2 lg:row-start-3">
          {clubsDeployed && coin.club ? <ClubPanel coin={coin} /> : <CreatorFees coin={coin} />}

          {/* What replaced the graduation bar.

              The bar measured how far a coin was from selling its first 800M
              tokens, and called that "graduation" — a word that on every other
              launchpad means migrating off a curve onto a real DEX. Here there
              is no curve and nothing to migrate, so the milestone described a
              move that had already happened at launch, which was worse than
              saying nothing. What a buyer actually needs to know about this
              pool is what remains. */}
          <div className="rounded-md border border-line bg-surface p-3.5">
            <span className="label">Liquidity</span>
            <p className="mt-2 text-[12px] leading-relaxed text-ink-2">
              {coin.ticker} has traded in its own Uniswap v4 pool since the block
              it was created. The liquidity was put there at launch and nobody
              can withdraw it — not the creator, not Aroma.
            </p>
          </div>

          {tokenUrl && (
            <a
              href={tokenUrl}
              target="_blank"
              rel="noreferrer"
              className="flex h-9 items-center justify-center rounded-md border border-line text-[12px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
            >
              View on Arcscan ↗
            </a>
          )}
        </div>

        <div className="min-w-0 lg:col-start-1 lg:row-start-3">
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
