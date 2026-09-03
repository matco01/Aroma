"use client";

import Link from "next/link";
import { CURVE } from "@/lib/arc";
import { compact, pct, price, usd, usdExact } from "@/lib/format";
import { usePortfolio, type Holding } from "@/lib/use-portfolio";
import { CoinArt } from "./coin-art";
import { GraduationBar } from "./primitives";
import { useWallet } from "./wallet";

export function PortfolioView() {
  const { connected, connect, usdcBalance } = useWallet();
  const { data: holdings, isLoading } = usePortfolio();

  if (!connected) {
    return (
      <EmptyState
        title="Connect your wallet"
        body="Your holdings live in your wallet, not on aram's servers. Connect to see what you hold."
        action={
          <button
            onClick={connect}
            className="h-8 rounded-sm bg-accent px-3 text-[12.5px] font-medium text-white transition-colors hover:bg-accent-hi"
          >
            Connect wallet
          </button>
        }
      />
    );
  }

  if (isLoading) {
    return (
      <div className="rounded-md border border-line bg-surface px-6 py-16 text-center">
        <p className="text-[12.5px] text-ink-3">Reading your balances…</p>
      </div>
    );
  }

  const rows = holdings ?? [];

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No holdings yet"
        body="Buy into a token on the curve and it shows up here."
        action={
          <Link
            href="/"
            className="flex h-8 items-center rounded-sm bg-accent px-3 text-[12.5px] font-medium text-white transition-colors hover:bg-accent-hi"
          >
            Browse the board
          </Link>
        }
      />
    );
  }

  const holdingsValue = rows.reduce((s, r) => s + r.valueUsd, 0);
  const totalCost = rows.reduce((s, r) => s + r.costUsd, 0);
  const totalPnl = holdingsValue - totalCost;
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
  const netWorth = holdingsValue + usdcBalance;

  return (
    <div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3.5 rounded-md border border-line bg-surface p-3.5 sm:grid-cols-4">
        <SummaryStat label="Net worth" value={usd(netWorth)} />
        <SummaryStat label="In positions" value={usd(holdingsValue)} />
        <SummaryStat label="USDC balance" value={usdExact(usdcBalance)} />
        <SummaryStat
          label="Unrealised P&L"
          value={`${usd(totalPnl)} (${pct(totalPnlPct)})`}
          tone={totalPnl >= 0 ? "up" : "down"}
        />
      </div>

      <div className="mt-4 overflow-hidden rounded-md border border-line bg-surface">
        <div className="hidden items-center gap-3 border-b border-line bg-surface-2 px-3.5 py-2 sm:flex">
          <span className="w-[26px] shrink-0" />
          <span className="label flex-[2]">Token</span>
          <span className="label w-24 shrink-0 text-right">Holding</span>
          <span className="label w-24 shrink-0 text-right">Avg cost</span>
          <span className="label w-24 shrink-0 text-right">Value</span>
          <span className="label w-28 shrink-0 text-right">P&L</span>
          <span className="label hidden w-24 shrink-0 md:block">Curve</span>
        </div>

        {rows.map((h) => (
          <PositionRow key={h.coin.id} holding={h} />
        ))}
      </div>

      <p className="mt-2.5 text-[10.5px] leading-relaxed text-ink-3">
        Balances read from each token&apos;s contract. Cost basis is
        reconstructed from your trades on aram, so tokens received by
        transfer show no recorded cost.
      </p>
    </div>
  );
}

function PositionRow({ holding }: { holding: Holding }) {
  const { coin, tokens, valueUsd, costUsd, pnlUsd, pnlPct } = holding;
  const up = pnlUsd >= 0;
  const progress = coin.graduated
    ? 100
    : Math.min(100, (coin.raisedUsd / CURVE.graduationTargetUsd) * 100);

  return (
    <Link
      href={`/coin/${coin.id}`}
      className="flex flex-col gap-2 border-b border-line px-3.5 py-3 transition-colors last:border-0 hover:bg-surface-2 sm:flex-row sm:items-center sm:gap-3"
    >
      <div className="flex items-center gap-2.5 sm:flex-[2]">
        <CoinArt seed={coin.seed} hue={coin.hue} size={26} radius={3} />
        <div className="min-w-0">
          <div className="truncate text-[12.5px] text-ink">{coin.name}</div>
          <div className="num text-[10.5px] text-ink-3">${coin.ticker}</div>
        </div>
      </div>

      <Cell label="Holding" className="text-ink-2">
        {compact(Math.round(tokens))}
      </Cell>
      <Cell label="Avg cost" className="text-ink-2">
        {costUsd > 0 && tokens > 0 ? price(costUsd / tokens) : "—"}
      </Cell>
      <Cell label="Value" className="text-ink">
        {usd(valueUsd)}
      </Cell>

      <div className="flex items-center justify-between text-[12px] sm:contents">
        <span className="label sm:hidden">P&amp;L</span>
        <span
          className={`num w-28 shrink-0 sm:text-right ${up ? "text-up" : "text-down"}`}
        >
          {costUsd > 0 ? (
            <>
              {usd(pnlUsd)} <span className="text-[10.5px]">({pct(pnlPct)})</span>
            </>
          ) : (
            "—"
          )}
        </span>
      </div>

      <div className="hidden w-24 shrink-0 items-center gap-2 md:flex">
        <GraduationBar raisedUsd={coin.raisedUsd} graduated={coin.graduated} />
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

function Cell({
  label,
  className,
  children,
}: {
  label: string;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between text-[12px] sm:contents">
      <span className="label sm:hidden">{label}</span>
      <span className={`num w-24 shrink-0 sm:text-right ${className}`}>{children}</span>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "up" | "down";
}) {
  const color = tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-ink";
  return (
    <div className="min-w-0">
      <div className="label">{label}</div>
      <div className={`num mt-0.5 truncate text-[15px] ${color}`}>{value}</div>
    </div>
  );
}

function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-md border border-line bg-surface px-6 py-16 text-center">
      <h2 className="text-[14px] font-medium text-ink">{title}</h2>
      <p className="mt-1.5 max-w-sm text-[12px] leading-relaxed text-ink-2">{body}</p>
      <div className="mt-4">{action}</div>
    </div>
  );
}
