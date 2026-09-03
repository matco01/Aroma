/**
 * A tiny indirection between "open the wallet modal" and AppKit itself.
 *
 * AppKit's `useAppKit()` throws outright if `createAppKit` was never called,
 * and we skip that call when no Reown project ID is configured. Hooks can't
 * be called conditionally, so consumers can't just guard the hook — instead
 * a bridge component (rendered only when AppKit exists) registers its
 * opener here, and callers invoke this plain function.
 *
 * The payoff: wallet.tsx never imports an AppKit hook at all, so the app
 * builds and runs with or without credentials, and there's exactly one
 * branch to reason about rather than one per call site.
 */

let openFn: (() => void) | null = null;

export function registerWalletModalOpener(fn: () => void): void {
  openFn = fn;
}

/** Returns false when no modal is available, so callers can fall back. */
export function openWalletModal(): boolean {
  if (!openFn) return false;
  openFn();
  return true;
}
