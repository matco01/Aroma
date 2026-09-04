"use client";

import { usdPrecise } from "@/lib/format";
import { CURVE } from "@/lib/arc";
import { useCreatorFees } from "@/lib/use-creator-fees";

/**
 * The creator's own earnings on their token.
 *
 * Renders only for the recorded creator — everyone else sees nothing, so
 * it doesn't read as a privileged control panel bolted onto a public page.
 *
 * Worth stating plainly in the copy that fees accrue whether or not anyone
 * claims them: they sit in the contract earmarked to the creator, and the
 * claim is permissionless. Nobody has to be trusted to release them.
 */
export function CreatorFees({
  tokenAddress,
  creator,
  ticker,
}: {
  tokenAddress: string;
  creator: string;
  ticker: string;
}) {
  const { accrued, isCreator, claim, phase, error } = useCreatorFees(tokenAddress, creator);

  if (!isCreator) return null;

  const busy = phase === "signing" || phase === "pending";
  const nothingToClaim = accrued <= 0;

  return (
    <div className="rounded-md border border-line bg-surface p-3.5">
      <div className="flex items-baseline justify-between">
        <span className="label">Your creator fees</span>
        <span className="num text-[11px] text-ink-3">
          {CURVE.creatorFeeShareBps / 100}% of each trade
        </span>
      </div>

      <div className="num mt-1.5 text-[19px] text-ink">{usdPrecise(accrued)}</div>

      <button
        onClick={claim}
        disabled={busy || nothingToClaim}
        className="mt-3 h-9 w-full rounded-sm bg-up text-[12.5px] font-semibold text-bg transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-ink-3"
      >
        {phase === "signing"
          ? "Confirm in wallet…"
          : phase === "pending"
            ? "Claiming…"
            : nothingToClaim
              ? "Nothing to claim yet"
              : `Claim ${usdPrecise(accrued)}`}
      </button>

      {error && (
        <p className="slide-in mt-2.5 rounded-sm border border-down/25 bg-down/8 px-2.5 py-2 text-[11px] text-down">
          {error}
        </p>
      )}

      <p className="mt-3 text-[10.5px] leading-relaxed text-ink-3">
        You earn {CURVE.creatorFeeShareBps / 100}% of every {ticker} trade fee, for
        as long as it trades. Fees accrue in the contract whether or not you
        claim — nobody can withhold them, and claiming is permissionless.
      </p>
    </div>
  );
}
