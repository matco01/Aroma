"use client";

import { useState } from "react";
import { shortAddr } from "@/lib/format";

/**
 * The contract address, as something you can actually take away.
 *
 * It was a `<span>` with the full address in a `title`, which works on a
 * desktop with a pointer and nowhere else. On a phone there was no way to get a
 * coin's address off the page at all — no tap target, no tooltip, and no
 * explorer link either, since Arc has no public explorer to link to. The
 * address is what anyone sharing or checking a coin needs, so it has to be
 * copyable first and readable second.
 *
 * Clipboard writes can be refused, and a button that silently does nothing is
 * worse than no button, so a failed copy reveals the full address instead —
 * selectable by hand, which is the thing the copy was for.
 */
export function CopyAddress({ address, label = "contract" }: { address: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "revealed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setState("copied");
      setTimeout(() => setState((s) => (s === "copied" ? "idle" : s)), 1400);
    } catch {
      setState("revealed");
    }
  }

  if (state === "revealed") {
    return (
      <span className="num text-ink-2 select-all break-all" title={address}>
        {address}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={address}
      aria-label={`Copy ${label} address ${address}`}
      // -my/py keeps a 44px tap target without changing the line's height.
      // nowrap/shrink-0 keep the label, the address and the icon on one line:
      // inside a wrapping flex row the button is happy to break mid-address,
      // which turns a copyable thing into a two-line smear.
      className="-my-1.5 inline-flex shrink-0 items-center gap-1 whitespace-nowrap py-1.5 transition-colors hover:text-ink-2"
    >
      {label} {shortAddr(address)}
      <span aria-hidden className={state === "copied" ? "text-up" : "text-ink-3"}>
        {state === "copied" ? "✓" : "⧉"}
      </span>
      <span className="sr-only" role="status">
        {state === "copied" ? "Address copied" : ""}
      </span>
    </button>
  );
}
