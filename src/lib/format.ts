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

/**
 * A USDC amount that never rounds a real balance to zero, or to more than
 * it is.
 *
 * usdExact fixes two decimals, which is right for a wallet balance and
 * wrong for anything sub-cent: $0.0063 of accrued fees rendered as "$0.01",
 * telling a creator they were claiming more than they were. Money owed to
 * someone should never be rounded up in the direction that flatters us.
 */
export function usdPrecise(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs === 0) return "$0.00";
  // Below a cent, show enough digits for the number to be true.
  if (abs < 0.01) return `${sign}$${abs.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0")}`;
  if (abs < 1) return `${sign}$${abs.toFixed(4)}`;
  return usdExact(n);
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
