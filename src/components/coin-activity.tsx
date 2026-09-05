"use client";

import { useState } from "react";
import type { Holder, Trade } from "@/lib/mock";
import { ago, compact, shortAddr, usd } from "@/lib/format";
import { Chip } from "./primitives";

type Tab = "trades" | "holders";

export function CoinActivity({
  trades,
  holders,
  ticker,
}: {
  trades: Trade[];
  holders: Holder[];
  ticker: string;
}) {
  const [tab, setTab] = useState<Tab>("trades");

  const TABS: { id: Tab; label: string; count: number }[] = [
    { id: "trades", label: "Trades", count: trades.length },
    { id: "holders", label: "Holders", count: holders.length },
  ];

  return (
    <div className="rounded-md border border-line bg-surface">
      <div className="flex items-center gap-1 border-b border-line p-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-sm px-3 py-2.5 text-[12.5px] transition-colors sm:px-2.5 sm:py-1.5 ${
              tab === t.id
                ? "bg-surface-3 text-ink"
                : "text-ink-2 hover:bg-surface-2 hover:text-ink"
            }`}
          >
            {t.label}
            <span className="num ml-1.5 text-[11px] text-ink-3">{t.count}</span>
          </button>
        ))}
      </div>

      {tab === "trades" && <TradesTable trades={trades} ticker={ticker} />}
      {tab === "holders" && <HoldersTable holders={holders} />}
    </div>
  );
}

function TradesTable({ trades, ticker }: { trades: Trade[]; ticker: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px]">
        <thead>
          <tr className="border-b border-line bg-surface-2">
            <Th>Account</Th>
            <Th>Side</Th>
            <Th align="right">USDC</Th>
            <Th align="right">{ticker}</Th>
            <Th align="right">Age</Th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id} className="border-b border-line last:border-0">
              <Td>
                <span className="num text-ink-2">{shortAddr(t.account)}</span>
              </Td>
              <Td>
                <span
                  className={`num text-[11.5px] ${
                    t.side === "buy" ? "text-up" : "text-down"
                  }`}
                >
                  {t.side}
                </span>
              </Td>
              <Td align="right">
                <span className="num text-ink">{usd(t.usd)}</span>
              </Td>
              <Td align="right">
                <span className="num text-ink-2">
                  {compact(Math.round(t.tokens))}
                </span>
              </Td>
              <Td align="right">
                <span className="num text-ink-3">{ago(t.agoSeconds)}</span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HoldersTable({ holders }: { holders: Holder[] }) {
  return (
    <div>
      {holders.map((h, i) => (
        <div
          key={h.account + i}
          className="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-0"
        >
          <span className="num w-5 shrink-0 text-[11px] text-ink-3">
            {i + 1}
          </span>
          <span className="num min-w-0 flex-1 truncate text-[12px] text-ink-2">
            {h.isCurve ? h.account : shortAddr(h.account)}
          </span>
          {h.isCurve && <Chip tone="accent">curve</Chip>}
          {h.isDev && <Chip tone="warn">dev</Chip>}
          <div className="hidden h-[3px] w-24 overflow-hidden rounded-full bg-surface-3 sm:block">
            <div
              className="h-full bg-ink-3"
              style={{ width: `${Math.min(100, h.pctOwned)}%` }}
            />
          </div>
          <span className="num w-12 shrink-0 text-right text-[12px] text-ink">
            {h.pctOwned.toFixed(2)}%
          </span>
        </div>
      ))}
    </div>
  );
}


function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`label px-3.5 py-2 ${align === "right" ? "text-right" : "text-left"}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <td
      className={`px-3.5 py-2 text-[12px] ${align === "right" ? "text-right" : "text-left"}`}
    >
      {children}
    </td>
  );
}
