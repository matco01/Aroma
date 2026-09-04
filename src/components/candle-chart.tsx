"use client";

import { useMemo, useState } from "react";
import type { Candle } from "@/lib/use-chain";
import { price as fmtPrice, usd } from "@/lib/format";

/**
 * OHLC candles, drawn as SVG.
 *
 * No charting library. A candlestick is two rectangles and a line, the
 * data is already bucketed by the indexer, and every library that draws
 * one arrives with a canvas renderer, a theme system and a few hundred
 * kilobytes — on a page whose whole job is to load fast on a phone.
 *
 * The hard part of a price chart this early is not the drawing, it's that
 * a fresh coin has one candle and a flat line. Both are handled explicitly
 * rather than left to look broken.
 */

const PAD = { top: 8, right: 52, bottom: 18, left: 8 };

export function CandleChart({
  candles,
  interval,
  height = 260,
}: {
  candles: Candle[];
  interval: number;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const view = useMemo(() => {
    if (candles.length === 0) return null;

    let lo = Math.min(...candles.map((c) => c.l));
    let hi = Math.max(...candles.map((c) => c.h));

    // A single candle, or a run of identical ones, gives a zero-height
    // range and would divide by zero. Open the window around the price so
    // the candle sits mid-frame instead of collapsing onto the axis.
    if (hi - lo < hi * 1e-9) {
      const pad = hi * 0.05 || 1e-9;
      lo -= pad;
      hi += pad;
    } else {
      const pad = (hi - lo) * 0.12;
      lo -= pad;
      hi += pad;
    }
    return { lo, hi };
  }, [candles]);

  if (candles.length === 0 || !view) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-line bg-surface text-[12px] text-ink-3"
        style={{ height }}
      >
        No trades yet
      </div>
    );
  }

  const width = 720;
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const { lo, hi } = view;

  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * plotH;
  // Cap the width so three candles don't render as three fat slabs.
  const slot = plotW / Math.max(candles.length, 12);
  const bodyW = Math.max(1.5, Math.min(slot * 0.66, 18));

  const last = candles[candles.length - 1];
  const first = candles[0];
  const up = last.c >= first.o;

  const shown = hover !== null ? candles[hover] : last;

  return (
    <div className="rounded-md border border-line bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-3.5 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="num text-[15px] text-ink">{fmtPrice(shown.c)}</span>
          <span className={`num text-[12px] ${up ? "text-up" : "text-down"}`}>
            {up ? "+" : ""}
            {first.o > 0 ? (((last.c - first.o) / first.o) * 100).toFixed(1) : "0.0"}%
          </span>
        </div>
        <div className="num flex items-center gap-3 text-[10.5px] text-ink-3">
          <span>O {fmtPrice(shown.o)}</span>
          <span>H {fmtPrice(shown.h)}</span>
          <span>L {fmtPrice(shown.l)}</span>
          <span>C {fmtPrice(shown.c)}</span>
          <span className="text-ink-2">Vol {usd(shown.v)}</span>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ height }}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`Price chart, ${candles.length} candles at ${intervalLabel(interval)} each`}
      >
        {/* Gridlines first so candles sit above them. */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1={PAD.left}
            x2={PAD.left + plotW}
            y1={PAD.top + f * plotH}
            y2={PAD.top + f * plotH}
            className="stroke-line"
            strokeWidth={1}
          />
        ))}

        {[0, 0.5, 1].map((f) => (
          <text
            key={f}
            x={PAD.left + plotW + 6}
            y={PAD.top + f * plotH + 3.5}
            className="fill-ink-3 text-[9px]"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            {fmtPrice(hi - f * (hi - lo))}
          </text>
        ))}

        {candles.map((c, i) => {
          const cx = PAD.left + slot * (i + 0.5);
          const rising = c.c >= c.o;
          const cls = rising ? "fill-up stroke-up" : "fill-down stroke-down";
          const bodyTop = y(Math.max(c.o, c.c));
          const bodyBottom = y(Math.min(c.o, c.c));
          return (
            <g
              key={c.t}
              className={cls}
              opacity={hover === null || hover === i ? 1 : 0.45}
              onMouseEnter={() => setHover(i)}
            >
              {/* Generous invisible hit area — candles are thin and a
                  1.5px target is not pointable. stroke="none" is load
                  bearing: the group sets stroke-up/stroke-down for the
                  wicks, and without it this rect draws a full-height box
                  around every candle. */}
              <rect
                x={cx - slot / 2}
                y={PAD.top}
                width={slot}
                height={plotH}
                fill="transparent"
                stroke="none"
              />
              <line x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} strokeWidth={1} />
              <rect
                x={cx - bodyW / 2}
                y={bodyTop}
                width={bodyW}
                /* A doji would otherwise be invisible at zero height. */
                height={Math.max(1, bodyBottom - bodyTop)}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function intervalLabel(seconds: number): string {
  if (seconds >= 86400) return "1d";
  if (seconds >= 3600) return "1h";
  return "5m";
}
