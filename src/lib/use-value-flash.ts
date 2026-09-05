"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Tints a number for a moment when it changes, in the direction it moved.
 *
 * Separate from the trade pulse on purpose. The pulse says "this coin was
 * traded"; this says "this specific figure is not what you were looking at
 * a second ago". They usually fire together, but a market cap can move on
 * a trade that happened to another holder's position, and a figure that
 * changes silently under someone's eyes is how you lose their trust in it.
 *
 * Returns a seq rather than a boolean so the caller can re-key the element
 * and restart the animation on a rapid second change — a CSS animation
 * will not replay just because a class is still applied.
 */
export function useValueFlash(value: number): {
  dir: "up" | "down" | null;
  seq: number;
} {
  const prev = useRef(value);
  const [state, setState] = useState<{ dir: "up" | "down" | null; seq: number }>(
    { dir: null, seq: 0 },
  );

  useEffect(() => {
    if (value === prev.current) return;
    const dir = value > prev.current ? "up" : "down";
    prev.current = value;
    setState((s) => ({ dir, seq: s.seq + 1 }));
  }, [value]);

  return state;
}
