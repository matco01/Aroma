"use client";

import type { IndexerHealth } from "@/lib/use-chain";

/**
 * Says so when the board is behind the chain.
 *
 * Deliberately renders nothing while the index is live — a permanent
 * "healthy" badge is noise that trains people to ignore the spot where the
 * warning will appear. It speaks only when the data on screen is old
 * enough to change a decision, because a stale price someone sizes a trade
 * against is a correctness failure, not a slow page.
 */
export function IndexerStatus({ health }: { health: IndexerHealth | undefined }) {
  if (!health || health.status === "live") return null;

  const tone =
    health.status === "stale"
      ? "border-down/30 bg-down/10 text-down"
      : "border-warn/30 bg-warn/10 text-warn";

  const detail =
    health.status === "unknown"
      ? "Can't reach the chain to check how current this is."
      : health.hasIndexingErrors
        ? "The indexer hit an error and has stopped keeping up."
        : `Prices are about ${formatBehind(health.secondsBehind)} behind the chain.`;

  return (
    <div
      role="status"
      className={`slide-in mb-4 flex items-start gap-2 rounded-md border px-3 py-2 text-[12px] ${tone}`}
    >
      <span aria-hidden className="mt-px">
        ⚠
      </span>
      <span className="leading-relaxed">
        {detail}{" "}
        <span className="opacity-70">
          Trades still execute against the live curve — only what you see here is
          delayed.
        </span>
      </span>
    </div>
  );
}

function formatBehind(seconds: number | null): string {
  if (seconds === null) return "some way";
  if (seconds < 90) return `${seconds}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 90) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}
