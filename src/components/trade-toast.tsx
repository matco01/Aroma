"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CoinArt } from "./coin-art";

export type TradeToastData = {
  id: number;
  side: "buy" | "sell";
  ticker: string;
  tokens: string;
  usd: string;
  seed: number;
  hue: number;
};

type Phase = "enter" | "shown" | "exit";

/**
 * Floating trade confirmation, pump.fun-style: token art, a direction badge,
 * one sentence, gone in a few seconds. It lives outside the trade panel's own
 * layout flow (fixed positioning) so it reads as a system notification, not
 * another line item in the ticket.
 *
 * Same floating-layer language as the command menu: bg-surface + a stronger
 * hairline, no shadow — elevation still comes from contrast, not blur.
 *
 * Rendered through a portal to document.body, which is not cosmetic. This
 * component is returned from inside the coin page's <aside>, and that aside
 * is position:sticky — which creates a stacking context. A fixed child
 * cannot escape one: z-50 then ranks the toast only against its siblings
 * inside the sidebar, and the whole sidebar paints below the header. The
 * confirmation for a trade someone just paid for was rendering underneath
 * the top bar. The portal moves it to the document root, where its z-index
 * is measured against the header rather than against the sidebar.
 */
export function TradeToast({
  data,
  onDone,
}: {
  data: TradeToastData;
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("enter");

  // Mounts once per toast — the parent keys this component by data.id, so a
  // new trade gets a fresh mount (and a fresh "enter" phase) rather than this
  // effect reaching back to reset state on an existing instance.
  useEffect(() => {
    const toShown = requestAnimationFrame(() => setPhase("shown"));
    const toExit = setTimeout(() => setPhase("exit"), 4000);
    return () => {
      cancelAnimationFrame(toShown);
      clearTimeout(toExit);
    };
  }, []);

  useEffect(() => {
    if (phase !== "exit") return;
    const t = setTimeout(onDone, 200);
    return () => clearTimeout(t);
  }, [phase, onDone]);

  const visible = phase === "shown";
  const up = data.side === "buy";

  // document does not exist while rendering on the server, so the portal
  // waits for the client. A toast only ever appears in response to a click,
  // so there is nothing to show on a first server render anyway.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="pointer-events-none fixed inset-x-4 top-[calc(var(--header-h)+12px)] z-[60] flex justify-center sm:inset-x-auto sm:right-5 sm:justify-end">
      <div
        role="status"
        className={`pointer-events-auto flex w-full max-w-[360px] items-center gap-3 rounded-md border border-line-strong bg-surface p-3.5 transition-all duration-200 ease-out ${
          visible ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0"
        }`}
      >
        <span className="relative shrink-0">
          <CoinArt seed={data.seed} hue={data.hue} size={36} radius={9} />
          <span
            className={`absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border-2 border-surface ${
              up ? "bg-up" : "bg-down"
            }`}
          >
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden>
              <path
                d="M1.5 4.2L3 5.7L6.5 2.2"
                stroke="var(--color-bg)"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </span>

        <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink">
          {up ? "Bought" : "Sold"} <span className="num">{data.tokens}</span>{" "}
          <span className="num">{data.ticker}</span> for{" "}
          <span className="num font-medium">{data.usd}</span>
        </p>

        <button
          onClick={() => setPhase("exit")}
          aria-label="Dismiss"
          className="shrink-0 rounded-xs p-1 text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink-2"
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path
              d="M1.5 1.5L10.5 10.5M10.5 1.5L1.5 10.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>,
    document.body,
  );
}
