"use client";

import Link from "next/link";
import { usdPrecise } from "@/lib/format";
import { CURVE } from "@/lib/arc";
import { useCreatorFeesBatch } from "@/lib/use-creator-fees-batch";
import type { Coin } from "@/lib/mock";
import { CoinArt } from "./coin-art";

/**
 * Coins this wallet launched, and the fees waiting on them.
 *
 * The point is not having to remember which of your coins earned
 * something — a creator with a dozen launches should not be checking
 * twelve pages to find the two with money on them.
 */
export function CreatedCoins({ created }: { created: Coin[] }) {
  const { unclaimed, total, claimableCount, claimAll, sweep } =
    useCreatorFeesBatch(created);

  if (created.length === 0) return null;

  const sweeping = sweep.current > 0;

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-3">
        <div>
          <h2 className="text-[14px] font-medium text-ink">Coins you created</h2>
          <p className="mt-0.5 text-[11.5px] text-ink-2">
            You earn {CURVE.creatorFeeShareBps / 100}% of every trade fee, for as
            long as they trade.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="label">Unclaimed</div>
            <div className="num text-[15px] text-ink">{usdPrecise(total)}</div>
          </div>
          <button
            onClick={claimAll}
            disabled={sweeping || claimableCount === 0}
            className="h-9 rounded-sm bg-up px-3.5 text-[12.5px] font-semibold text-bg transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-ink-3"
          >
            {sweeping
              ? `Claiming ${sweep.current} of ${sweep.total}…`
              : claimableCount === 0
                ? "Nothing to claim"
                : `Claim all (${claimableCount})`}
          </button>
        </div>
      </div>

      {claimableCount > 1 && !sweeping && (
        <p className="mt-2 text-[10.5px] text-ink-3">
          Claiming is one transaction per coin, so your wallet will ask{" "}
          {claimableCount} times. You can stop part-way and keep whatever
          already went through.
        </p>
      )}

      {sweep.error && (
        <p className="slide-in mt-2 rounded-sm border border-down/25 bg-down/8 px-2.5 py-2 text-[11px] text-down">
          {sweep.error}
        </p>
      )}

      <div className="mt-3 overflow-hidden rounded-md border border-line bg-surface">
        {unclaimed.map(({ coin, amount }) => (
          <Link
            key={coin.id}
            href={`/coin/${coin.id}`}
            className="flex items-center gap-3 border-b border-line px-3.5 py-3 transition-colors last:border-0 hover:bg-surface-2"
          >
            <CoinArt
              seed={coin.seed}
              hue={coin.hue}
              size={26}
              radius={3}
              imageUrl={coin.imageUrl}
              alt={coin.name}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] text-ink">{coin.name}</div>
              <div className="num text-[10.5px] text-ink-3">${coin.ticker}</div>
            </div>

            <div className="hidden text-right sm:block">
              <div className="label">Earned</div>
              <div className="num text-[12px] text-ink-2">
                {usdPrecise(coin.creatorFeesEarnedUsd)}
              </div>
            </div>

            <div className="w-24 text-right">
              <div className="label">Unclaimed</div>
              <div
                className={`num text-[12px] ${amount > 0 ? "text-up" : "text-ink-3"}`}
              >
                {usdPrecise(amount)}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
