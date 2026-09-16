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
      <div className={`num mt-1 truncate text-[17px] ${color}`}>{value}</div>
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
    accent: "border-accent-2/40 text-accent-2 bg-accent-2-dim",
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
