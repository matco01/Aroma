"use client";

import { usdPrecise } from "@/lib/format";
import { CURVE } from "@/lib/arc";
import { shortAddr } from "@/lib/format";
import { useCreatorFees } from "@/lib/use-creator-fees";
import type { Coin } from "@/lib/mock";

/**
 * What the creator has made from this coin — shown to everyone.
 *
 * How much a dev has taken out of their own token is exactly the kind of
 * thing a buyer should be able to see without having to go and read the
 * chain. It sits in the same category as dev sells: not an accusation,
 * just a number that should not require trust to obtain. Hiding it would
 * be the strange choice.
 *
 * The claim button is the only creator-gated part. Everyone reads the same
 * figures; one person can act on them.
 */
export function CreatorFees({ coin }: { coin: Coin }) {
  const { accrued, isCreator, claim, phase, error } = useCreatorFees(
    coin.contract,
    coin.creator,
  );

  const busy = phase === "signing" || phase === "pending";
  const earned = coin.creatorFeesEarnedUsd;
  const claimed = coin.creatorFeesClaimedUsd;

  // Unclaimed is read live from the contract for the creator, but derived
  // for everyone else — the index is a second or two behind and that is
  // fine for a public figure, while money you are about to withdraw should
  // be exact.
  const unclaimed = isCreator ? accrued : Math.max(0, earned - claimed);

  return (
    <div className="rounded-md border border-line bg-surface p-3.5">
      <div className="flex items-baseline justify-between">
        <span className="label">Creator fees</span>
        <span className="num text-[11px] text-ink-3">
          {CURVE.creatorFeeShareBps / 100}% of each trade
        </span>
      </div>

      <div className="num mt-1.5 text-[19px] text-ink">{usdPrecise(earned)}</div>
      <p className="mt-0.5 text-[11px] text-ink-3">
        earned by{" "}
        <span className="num">{isCreator ? "you" : shortAddr(coin.creator)}</span>{" "}
        since launch
      </p>

      <dl className="mt-3 space-y-1.5 border-t border-line pt-3">
        <Row label="Withdrawn" value={usdPrecise(claimed)} />
        <Row label="Still in the contract" value={usdPrecise(unclaimed)} />
      </dl>

      {isCreator && (
        <>
          <button
            onClick={claim}
            disabled={busy || unclaimed <= 0}
            className="mt-3 h-9 w-full rounded-sm bg-up text-[12.5px] font-semibold text-bg transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-ink-3"
          >
            {phase === "signing"
              ? "Confirm in wallet…"
              : phase === "pending"
                ? "Claiming…"
                : unclaimed <= 0
                  ? "Nothing to claim yet"
                  : `Claim ${usdPrecise(unclaimed)}`}
          </button>

          {error && (
            <p className="slide-in mt-2.5 rounded-sm border border-down/25 bg-down/8 px-2.5 py-2 text-[11px] text-down">
              {error}
            </p>
          )}
        </>
      )}

    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[12px] text-ink-2">{label}</dt>
      <dd className="num shrink-0 text-[12px] text-ink-2">{value}</dd>
    </div>
  );
}
