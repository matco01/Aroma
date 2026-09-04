"use client";

import Link from "next/link";
import { ARC_TESTNET, CURVE } from "@/lib/arc";
import { ago, compact, pct, price, shortAddr, usd } from "@/lib/format";
import { useToken } from "@/lib/use-chain";
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
        <Link href="/" className="text-[12px] text-ink-3 hover:text-ink-2">
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
        className="text-[12px] text-ink-3 transition-colors hover:text-ink-2"
      >
        ← Board
      </Link>

      <div className="mt-4">
        <IndexerStatus health={data?.indexer} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0">
          <div className="flex items-start gap-3">
            <CoinArt seed={coin.seed} hue={coin.hue} size={52} radius={6} imageUrl={coin.imageUrl} alt={coin.name} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[19px] font-semibold tracking-[-0.02em] text-ink">
                  {coin.name}
                </h1>
                <span className="num text-[13px] text-ink-2">${coin.ticker}</span>
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
                  className="transition-colors hover:text-ink-2"
                  title={coin.contract}
                >
                  contract {shortAddr(coin.contract)} ↗
                </a>
              </div>
            </div>
            <div className="text-right">
              <div className="num text-[17px] text-ink">{price(coin.priceUsd)}</div>
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
            <PriceChart data={coin.history} />
          </div>

          <div className="mt-4.5">
            <CoinActivity
              trades={trades ?? []}
              holders={holders}
              replies={[]}
              ticker={coin.ticker}
            />
          </div>
        </div>

        <aside className="space-y-4.5 lg:sticky lg:top-16 lg:self-start">
          <TradePanel coin={coin} />

          <CreatorFees coin={coin} />

          <div className="rounded-md border border-line bg-surface p-3.5">
            <GraduationBar
              marketCapUsd={coin.marketCapUsd}
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
      </div>
    </div>
  );
}
