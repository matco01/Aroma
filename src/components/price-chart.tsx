"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SeriesPoint } from "@/lib/use-chain";
import { usd } from "@/lib/format";

/**
 * Market cap over time, as a filled line.
 *
 * Deliberately not candlesticks. A candle needs volume to say anything —
 * with a handful of trades you get two lonely rectangles and a lot of
 * empty grid, while a line reads correctly from the very first trade. It
 * is also the number people actually quote at each other: nobody says a
 * coin is at 0.0000043, they say it is at four thousand.
 *
 * The window buttons pick a span of time, not a bucket size. Price only
 * moves when someone trades, so the series is trade points rather than
 * fixed buckets — a bucket at low volume mostly averages a number with
 * itself.
 */

type Window = { id: string; label: string; seconds: number };

const WINDOWS: Window[] = [
  { id: "5m", label: "5M", seconds: 300 },
  { id: "1h", label: "1H", seconds: 3600 },
  { id: "6h", label: "6H", seconds: 21_600 },
  { id: "1d", label: "1D", seconds: 86_400 },
  { id: "all", label: "ALL", seconds: Infinity },
];

const PAD = { top: 16, right: 56, bottom: 26, left: 10 };

export function PriceChart({
  series,
  /** viewBox height. Sets the aspect ratio, not a pixel size. */
  height = 300,
}: {
  series: SeriesPoint[];
  height?: number;
}) {
  // 1H rather than ALL. A coin's first hours are usually one trade then a
  // long flat wait, and ALL spends most of the panel drawing that — the
  // interesting part gets squeezed into the last few pixels.
  const [windowId, setWindowId] = useState("1h");
  const [hover, setHover] = useState<number | null>(null);

  /**
   * The viewBox is measured, not fixed.
   *
   * A fixed viewBox has to choose between letterboxing (preserving aspect
   * and leaving dead space at the sides, so axis labels stop short of the
   * edge) and scaling to fit (which blows up the text and strokes along
   * with everything else, since they are in viewBox units). Measuring the
   * container avoids the choice: one viewBox unit is one CSS pixel, so the
   * chart fills the panel and nothing is distorted.
   */
  const boxRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(760);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setMeasured(Math.max(320, Math.round(entry.contentRect.width)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const win = WINDOWS.find((w) => w.id === windowId) ?? WINDOWS[4];

  const points = useMemo(() => {
    if (series.length === 0) return [];
    if (win.seconds === Infinity) return series;

    const newest = series[series.length - 1].t;
    const cutoff = newest - win.seconds;
    const inWindow = series.filter((p) => p.t >= cutoff);

    // A window with one point inside it can't draw a line. Reach back for
    // the previous point so the line enters from the left edge instead of
    // the panel going blank on a quiet token.
    if (inWindow.length < 2) {
      const idx = series.findIndex((p) => p.t >= cutoff);
      return series.slice(Math.max(0, idx - 1));
    }
    return inWindow;
  }, [series, win]);

  if (points.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-line bg-surface text-[12px] text-ink-3"
        style={{ height }}
      >
        No trades yet
      </div>
    );
  }

  const width = measured;
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;

  const values = points.map((p) => p.m);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  // A flat series has zero range and would divide by zero; open a window
  // around it so the line sits mid-panel rather than on the floor.
  if (hi - lo < hi * 1e-9) {
    const pad = hi * 0.08 || 1;
    lo -= pad;
    hi += pad;
  } else {
    const pad = (hi - lo) * 0.18;
    lo -= pad;
    hi += pad;
  }

  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const span = Math.max(1, t1 - t0);

  const x = (t: number) => PAD.left + ((t - t0) / span) * plotW;
  const y = (m: number) => PAD.top + (1 - (m - lo) / (hi - lo)) * plotH;

  const xy = points.map((p) => ({ x: x(p.t), y: y(p.m) }));
  const linePath = smoothPath(xy);
  const areaPath = `${linePath} L ${xy[xy.length - 1].x} ${PAD.top + plotH} L ${xy[0].x} ${PAD.top + plotH} Z`;

  const shown = hover !== null ? points[hover] : points[points.length - 1];
  const first = points[0].m;
  const changePct = first > 0 ? ((shown.m - first) / first) * 100 : 0;
  const up = changePct >= 0;
  const stroke = up ? "var(--color-up)" : "var(--color-down)";

  const marker = hover !== null ? xy[hover] : xy[xy.length - 1];

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    // Nearest point rather than a bucket, so hovering anywhere selects the
    // trade you're pointing at.
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < xy.length; i++) {
      const d = Math.abs(xy[i].x - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover(best);
  }

  const gradientId = "aroma-price-fill";

  return (
    <div className="rounded-md border border-line bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 px-3.5 pt-3">
        <div>
          <div className="num text-[24px] leading-none tracking-[-0.02em] text-ink">
            {usd(shown.m)}
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className={`num text-[12px] ${up ? "text-up" : "text-down"}`}>
              {up ? "+" : ""}
              {changePct.toFixed(2)}%
            </span>
            <span className="num text-[11px] text-ink-3">
              {formatTime(shown.t)}
            </span>
          </div>
        </div>

        <div className="flex overflow-hidden rounded-sm border border-line">
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              onClick={() => {
                setWindowId(w.id);
                setHover(null);
              }}
              className={`num px-2.5 py-1 text-[11px] transition-colors ${
                windowId === w.id
                  ? "bg-surface-3 text-ink"
                  : "text-ink-3 hover:text-ink-2"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <div ref={boxRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block w-full"
        style={{ height }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`Market cap over the last ${win.label}, currently ${usd(shown.m)}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Dashed gridlines, labelled on the right where the eye ends up. */}
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={PAD.top + f * plotH}
              y2={PAD.top + f * plotH}
              className="stroke-line"
              strokeWidth={1}
              strokeDasharray="3 4"
            />
            <text
              x={PAD.left + plotW + 8}
              y={PAD.top + f * plotH + 3.5}
              className="fill-ink-3 text-[10px]"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              {usd(hi - f * (hi - lo))}
            </text>
          </g>
        ))}

        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path
          d={linePath}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Crosshair only while pointing, so it doesn't clutter at rest. */}
        {hover !== null && (
          <line
            x1={marker.x}
            x2={marker.x}
            y1={PAD.top}
            y2={PAD.top + plotH}
            className="stroke-line-strong"
            strokeWidth={1}
          />
        )}

        <circle cx={marker.x} cy={marker.y} r={4} fill={stroke} />
        <circle cx={marker.x} cy={marker.y} r={8} fill={stroke} opacity={0.18} />

        {/* Tooltip beside the point rather than only in the header, so the
            value is where the eye already is. Flips to the left of the
            marker near the right edge instead of being clipped. */}
        {hover !== null && (
          <g
            transform={`translate(${
              marker.x > PAD.left + plotW - 110 ? marker.x - 104 : marker.x + 12
            }, ${Math.max(PAD.top + 4, Math.min(marker.y - 28, PAD.top + plotH - 44))})`}
            pointerEvents="none"
          >
            <rect
              width={96}
              height={40}
              rx={4}
              className="fill-surface-3 stroke-line-strong"
              strokeWidth={1}
            />
            <text
              x={8}
              y={17}
              className="fill-ink text-[11.5px]"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              {usd(shown.m)}
            </text>
            <text
              x={8}
              y={31}
              className="fill-ink-3 text-[9.5px]"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              {formatTime(shown.t)}
            </text>
          </g>
        )}

        {/* Time axis: ends plus the middle, which is all that fits legibly. */}
        {[0, 0.5, 1].map((f) => (
          <text
            key={f}
            x={PAD.left + f * plotW}
            y={height - 8}
            textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"}
            className="fill-ink-3 text-[10px]"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            {formatTime(t0 + f * span)}
          </text>
        ))}
      </svg>
      </div>
    </div>
  );
}

/**
 * Monotone cubic path.
 *
 * Not Catmull-Rom or a plain bezier: those overshoot between points, which
 * on a price chart means drawing a dip that never happened. Monotone
 * interpolation is constrained never to invent a high or low the data
 * doesn't contain — the curve stays smooth without lying.
 */
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  if (pts.length === 2) {
    return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;
  }

  const n = pts.length;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = pts[i + 1].x - pts[i].x || 1e-6;
    dx.push(h);
    slope.push((pts[i + 1].y - pts[i].y) / h);
  }

  const m: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i++) {
    // A sign change means a local extremum; a zero tangent pins it there
    // rather than letting the curve sail past.
    if (slope[i - 1] * slope[i] <= 0) {
      m.push(0);
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      m.push((w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]));
    }
  }
  m.push(slope[n - 2]);

  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C ${pts[i].x + h} ${pts[i].y + m[i] * h} ${pts[i + 1].x - h} ${pts[i + 1].y - m[i + 1] * h} ${pts[i + 1].x} ${pts[i + 1].y}`;
  }
  return d;
}

function formatTime(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
