"use client";

import { useState } from "react";

/**
 * A token's picture.
 *
 * Renders the creator's uploaded image when there is one, and otherwise a
 * symmetric identicon derived from the token's own address. Saturation on
 * the generated art is kept low on purpose — 48 of these on one board must
 * not read as a bag of skittles.
 *
 * The fallback is not only for tokens without an image. IPFS gateways
 * fail, and a broken-image icon on every card is far worse than art that
 * was always going to be fine: onError quietly drops back rather than
 * leaving a hole where the token should be.
 */
export function CoinArt({
  seed,
  hue,
  size = 40,
  radius = 6,
  imageUrl,
  alt = "",
  className,
}: {
  seed: number;
  hue: number;
  size?: number;
  radius?: number;
  imageUrl?: string;
  alt?: string;
  /** Set to fill a container instead of rendering at `size`. */
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (imageUrl && !failed) {
    return (
      /* The source is an arbitrary IPFS gateway, which next/image cannot
         optimise without allowlisting every gateway a creator might use. */
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt={alt}
        width={size}
        height={size}
        onError={() => setFailed(true)}
        loading="lazy"
        className={className ?? "shrink-0 object-cover"}
        style={
          className
            ? undefined
            : { width: size, height: size, borderRadius: radius }
        }
      />
    );
  }

  const grid = 5;
  const half = Math.ceil(grid / 2);
  const cells: boolean[] = [];

  // Same mulberry32 as the data layer so art is stable across renders.
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (let y = 0; y < grid; y++) {
    for (let x = 0; x < half; x++) cells[y * half + x] = rnd() > 0.45;
  }

  /**
   * The pattern was drawn for a 40px avatar. Filling a 300px card with it
   * turns a 5x5 grid into slabs of colour — a board of them reads as a bag
   * of skittles and drowns out the coins that have real art.
   *
   * So at fill size it recedes: a much darker ground, a calmer mark, and
   * the pattern inset rather than bleeding to the edges. It becomes a
   * placeholder that looks deliberate, and a coin whose creator uploaded
   * something actually stands out — which is the right incentive anyway.
   */
  const filling = Boolean(className);
  const bg = filling ? `hsl(${hue} 26% 9%)` : `hsl(${hue} 32% 13%)`;
  const fg = filling ? `hsl(${hue} 34% 42%)` : `hsl(${hue} 52% 62%)`;
  const unit = 100 / grid;

  const rects = [];
  for (let y = 0; y < grid; y++) {
    for (let x = 0; x < grid; x++) {
      const mx = x < half ? x : grid - 1 - x;
      if (!cells[y * half + mx]) continue;
      rects.push(
        <rect
          key={`${x}-${y}`}
          x={x * unit}
          y={y * unit}
          width={unit + 0.4}
          height={unit + 0.4}
          fill={fg}
        />,
      );
    }
  }

  return (
    <svg
      width={className ? undefined : size}
      height={className ? undefined : size}
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
      className={className}
      style={
        className
          ? { background: bg }
          : { borderRadius: radius, background: bg, flex: "0 0 auto" }
      }
    >
      {filling ? (
        /* Inset to the middle so the mark sits in space rather than
           tiling the whole card. */
        <g transform="translate(26 26) scale(0.48)">{rects}</g>
      ) : (
        rects
      )}
    </svg>
  );
}
