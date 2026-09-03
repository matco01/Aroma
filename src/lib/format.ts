/**
 * Every formatter here is pure and deterministic — no Date.now(), no Intl
 * locale sniffing — so the server and client render identical strings and
 * hydration stays quiet.
 */

export function usd(n: number): string {
  const a = Math.abs(n);
  if (a >= 1_000_000_000) return `$${trim(n / 1_000_000_000)}B`;
  if (a >= 1_000_000) return `$${trim(n / 1_000_000)}M`;
  if (a >= 1_000) return `$${trim(n / 1_000)}K`;
  if (a >= 0.01 || n === 0) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

/** Exact dollars with separators. For balances and totals, where rounding lies. */
export function usdExact(n: number): string {
  const [whole, cents] = Math.abs(n).toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${n < 0 ? "-" : ""}$${grouped}.${cents}`;
}

function trim(n: number): string {
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
}

/** Prices on a bonding curve start absurdly small. Show them without lying. */
export function price(n: number): string {
  if (n >= 1) return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  const s = n.toFixed(12).replace(/0+$/, "");
  const m = /^0\.(0+)(\d+)$/.exec(s);
  if (!m) return `$${s}`;
  // $0.0₇1234 — the subscript form traders already read on DEX screeners.
  return `$0.0${sub(m[1].length)}${m[2].slice(0, 4)}`;
}

const SUBS = "₀₁₂₃₄₅₆₇₈₉";
function sub(n: number): string {
  return String(n)
    .split("")
    .map((d) => SUBS[Number(d)])
    .join("");
}

export function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

export function compact(n: number): string {
  if (n >= 1_000_000_000) return `${trim(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}K`;
  return String(n);
}

/** Takes seconds-ago as a number so nothing depends on the current clock. */
export function ago(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
