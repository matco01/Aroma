"use client";

import { useMemo, useRef, useState } from "react";
import { price as fmtPrice, pct } from "@/lib/format";

const RANGES = ["5m", "1h", "6h", "24h", "All"] as const;
type Range = (typeof RANGES)[number];

/**
 * Price chart, drawn by hand in SVG rather than pulled from a charting library.
 *
 * A library would bring its own type scale, its own tooltip chrome and its own
 * grid colours, and none of them would match this system. Sixty lines of SVG
 * keeps the chart on the same hairline-and-mono grammar as everything else.
 */
export function PriceChart({ data }: { data: number[] }) {
  const [range, setRange] = useState<Range>("24h");
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);

  // Each range is a tail of the same series — enough to make the control real.
  const series = useMemo(() => {
    const slice: Record<Range, number> = {
      "5m": 8,
      "1h": 16,
      "6h": 28,
      "24h": 40,
      All: data.length,
    };
    return data.slice(Math.max(0, data.length - slice[range]));
  }, [data, range]);

  const W = 1000;
  const H = 260;
  const PAD = 8;

  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const step = (W - PAD * 2) / (series.length - 1);

  const pointAt = (i: number) => ({
    x: PAD + i * step,
    y: PAD + (H - PAD * 2) - ((series[i] - min) / span) * (H - PAD * 2),
  });

  const line = series
    .map((_, i) => {
      const p = pointAt(i);
      return `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    })
    .join(" ");

  const first = series[0];
  const last = series[series.length - 1];
  const up = last >= first;
  const stroke = up ? "var(--color-up)" : "var(--color-down)";
  const area = `${line} L${(PAD + (series.length - 1) * step).toFixed(1)} ${H - PAD} L${PAD} ${H - PAD} Z`;

  const activeIndex = hover ?? series.length - 1;
  const activePoint = pointAt(activeIndex);
  const changePct = ((last - first) / first) * 100;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const rel = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round((rel - PAD) / step);
    setHover(Math.max(0, Math.min(series.length - 1, i)));
  }

  return (
    <div className="rounded-md border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="num text-[15px] text-ink">
            {fmtPrice(series[activeIndex])}
          </span>
          <span className={`num text-[12px] ${up ? "text-up" : "text-down"}`}>
            {pct(changePct)}
          </span>
          <span className="label">{range}</span>
        </div>

        <div className="flex items-center gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`num rounded-sm px-2 py-1 text-[11px] transition-colors ${
                range === r
                  ? "bg-surface-3 text-ink"
                  : "text-ink-3 hover:bg-surface-2 hover:text-ink-2"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block h-[260px] w-full cursor-crosshair"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="Price history"
      >
        <defs>
          <linearGradient id="chart-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.13" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Four quiet gridlines. Enough to judge slope, not enough to notice. */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={0}
            x2={W}
            y1={PAD + f * (H - PAD * 2)}
            y2={PAD + f * (H - PAD * 2)}
            stroke="var(--color-line)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        <path d={area} fill="url(#chart-fade)" />
        <path
          d={line}
          fill="none"
          stroke={stroke}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {hover !== null && (
          <line
            x1={activePoint.x}
            x2={activePoint.x}
            y1={0}
            y2={H}
            stroke="var(--color-line-strong)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}

        <circle
          cx={activePoint.x}
          cy={activePoint.y}
          r={3}
          fill={stroke}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
