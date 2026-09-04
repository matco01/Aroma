import { CURVE } from "@/lib/arc";
import { usd } from "@/lib/format";

/* ---------------------------------------------------------------------------
   Graduation progress.
   This is the single most important number on the board — it is the only thing
   that tells you whether a token is still on the curve or trading on a DEX —
   so it gets a permanent slot on every card rather than living in a tooltip.
   --------------------------------------------------------------------------- */
export function GraduationBar({
  marketCapUsd,
  graduated,
  showLabel = false,
}: {
  marketCapUsd: number;
  graduated: boolean;
  showLabel?: boolean;
}) {
  // Progress measured in market cap, not the raise.
  //
  // The raise is the curve's internal number and the actual graduation
  // trigger, but "$0.45 of $13.8K raised" means nothing to someone
  // deciding whether to buy. Market cap is the number they already hold in
  // their head, so both the label and the bar use it — a bar measuring one
  // thing while its label reads another is worse than either alone.
  //
  // Consequence worth knowing: this bar is convex. Constant-product means
  // price accelerates as supply sells, so market cap covers its first half
  // slowly and its second half fast. Half the money in is about a third of
  // the way up the bar. That is the real shape of the curve, not a
  // distortion of it.
  const span = CURVE.graduationMarketCapUsd - CURVE.startingMarketCapUsd;
  const pctDone = graduated
    ? 100
    : Math.max(
        0,
        Math.min(100, ((marketCapUsd - CURVE.startingMarketCapUsd) / span) * 100),
      );

  return (
    <div className="w-full">
      {showLabel && (
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="label">
            {graduated ? "Graduated" : "Bonding curve"}
          </span>
          <span className="num text-[11px] text-ink-2">
            {usd(marketCapUsd)}
            <span className="text-ink-3">
              {" / "}
              {usd(CURVE.graduationMarketCapUsd)} mcap
            </span>
          </span>
        </div>
      )}
      <div className="h-[4px] w-full overflow-hidden rounded-full bg-surface-3">
        <div
          className={graduated ? "h-full bg-up" : "h-full bg-accent"}
          style={{ width: `${pctDone}%` }}
        />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Sparkline. Stroke only — no gradient fill, no dots, no animation.
   --------------------------------------------------------------------------- */
export function Sparkline({
  data,
  up,
  width = 76,
  height = 26,
}: {
  data: number[];
  up: boolean;
  width?: number;
  height?: number;
}) {
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const step = width / (data.length - 1);
  const d = data
    .map((v, i) => {
      const x = i * step;
      const y = height - ((v - min) / span) * (height - 2) - 1;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} aria-hidden className="overflow-visible">
      <path
        d={d}
        fill="none"
        stroke={up ? "var(--color-up)" : "var(--color-down)"}
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
   Label-over-value stat. Used in every header strip.
   --------------------------------------------------------------------------- */
export function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  tone?: "default" | "up" | "down";
}) {
  const color =
    tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-ink";
  return (
    <div className="min-w-0">
      <div className="label">{label}</div>
      <div className={`num mt-0.5 truncate text-[13px] ${color}`}>{value}</div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Status chip. The one place a pill radius is allowed.
   --------------------------------------------------------------------------- */
export function Chip({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "accent" | "up" | "warn";
}) {
  const tones = {
    neutral: "border-line text-ink-2",
    accent: "border-accent/40 text-accent bg-accent-dim",
    up: "border-up/30 text-up bg-up/8",
    warn: "border-warn/30 text-warn bg-warn/8",
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
