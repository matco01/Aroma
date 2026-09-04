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
}: {
  seed: number;
  hue: number;
  size?: number;
  radius?: number;
  imageUrl?: string;
  alt?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (imageUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- the source is
      // an arbitrary IPFS gateway, which next/image cannot optimise without
      // allowlisting every gateway a creator might use.
      <img
        src={imageUrl}
        alt={alt}
        width={size}
        height={size}
        onError={() => setFailed(true)}
        loading="lazy"
        className="shrink-0 object-cover"
        style={{ width: size, height: size, borderRadius: radius }}
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

  const bg = `hsl(${hue} 32% 13%)`;
  const fg = `hsl(${hue} 52% 62%)`;
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
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden
      style={{ borderRadius: radius, background: bg, flex: "0 0 auto" }}
    >
      {rects}
    </svg>
  );
}
