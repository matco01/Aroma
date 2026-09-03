"use client";

import { useMemo, useState } from "react";
import { type Coin } from "@/lib/mock";
import { useTokens } from "@/lib/use-chain";
import { CoinCard, CoinRow } from "./coin-card";

type Filter = "all" | "climbing" | "graduated";
type Sort = "buys" | "new" | "mcap" | "volume";
type View = "grid" | "list";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "climbing", label: "Climbing" },
  { id: "graduated", label: "Graduated" },
];

const SORTS: { id: Sort; label: string }[] = [
  { id: "buys", label: "Recent buys" },
  { id: "new", label: "Newest" },
  { id: "mcap", label: "Market cap" },
  { id: "volume", label: "Volume" },
];

export function Board() {
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("buys");
  const [view, setView] = useState<View>("grid");
  const { data: tokens, isLoading, error } = useTokens();

  const coins = useMemo(() => {
    let pool: Coin[] = tokens ?? [];
    if (filter === "climbing") pool = pool.filter((c) => !c.graduated);
    if (filter === "graduated") pool = pool.filter((c) => c.graduated);

    const sorted = [...pool];
    if (sort === "new") sorted.sort((a, b) => a.createdAgoSeconds - b.createdAgoSeconds);
    if (sort === "mcap") sorted.sort((a, b) => b.marketCapUsd - a.marketCapUsd);
    if (sort === "volume") sorted.sort((a, b) => b.volume24hUsd - a.volume24hUsd);
    if (sort === "buys") {
      // Volume weighted against age: what is actually being bought right now.
      const heat = (c: Coin) => c.volume24hUsd / Math.max(600, c.createdAgoSeconds);
      sorted.sort((a, b) => heat(b) - heat(a));
    }
    return sorted;
  }, [tokens, filter, sort]);

  return (
    <section>
      {/* Controls sit on one hairline rule. Chips, not dropdowns — a dropdown
          hides the current state behind a click, and sort state is something
          you want to read at a glance while scanning. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-line pb-3">
        <ChipGroup>
          {FILTERS.map((f) => (
            <ChipButton
              key={f.id}
              active={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </ChipButton>
          ))}
        </ChipGroup>

        <span className="h-3.5 w-px bg-line" />

        <ChipGroup>
          {SORTS.map((s) => (
            <ChipButton
              key={s.id}
              active={sort === s.id}
              onClick={() => setSort(s.id)}
            >
              {s.label}
            </ChipButton>
          ))}
        </ChipGroup>

        <div className="flex-1" />

        <div className="flex items-center gap-2">
          <span className="num text-[11px] text-ink-3">
            {coins.length} tokens
          </span>
          <div className="flex overflow-hidden rounded-sm border border-line">
            <ViewButton active={view === "grid"} onClick={() => setView("grid")} label="Grid view">
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                <rect x="0.5" y="0.5" width="4.5" height="4.5" rx="1" fill="currentColor" />
                <rect x="7" y="0.5" width="4.5" height="4.5" rx="1" fill="currentColor" />
                <rect x="0.5" y="7" width="4.5" height="4.5" rx="1" fill="currentColor" />
                <rect x="7" y="7" width="4.5" height="4.5" rx="1" fill="currentColor" />
              </svg>
            </ViewButton>
            <ViewButton active={view === "list"} onClick={() => setView("list")} label="List view">
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                <rect x="0.5" y="1" width="11" height="1.6" rx="0.8" fill="currentColor" />
                <rect x="0.5" y="5.2" width="11" height="1.6" rx="0.8" fill="currentColor" />
                <rect x="0.5" y="9.4" width="11" height="1.6" rx="0.8" fill="currentColor" />
              </svg>
            </ViewButton>
          </div>
        </div>
      </div>

      {isLoading && (
        <p className="mt-6 text-[12.5px] text-ink-3">Reading the chain…</p>
      )}

      {error && (
        <p className="mt-6 text-[12.5px] text-down">
          Couldn&apos;t reach Arc. {(error as Error).message.slice(0, 120)}
        </p>
      )}

      {!isLoading && !error && coins.length === 0 && (
        <div className="mt-6 rounded-md border border-line bg-surface px-6 py-16 text-center">
          <p className="text-[13px] text-ink">Nothing launched yet</p>
          <p className="mt-1 text-[12px] text-ink-2">
            Be the first — launching is free, you only pay gas.
          </p>
        </div>
      )}

      {!isLoading && coins.length > 0 && (view === "grid" ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {coins.map((c) => (
            <CoinCard key={c.id} coin={c} />
          ))}
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-md border border-line bg-surface">
          <ListHeader />
          {coins.map((c) => (
            <CoinRow key={c.id} coin={c} />
          ))}
        </div>
      ))}
    </section>
  );
}

function ListHeader() {
  return (
    <div className="flex items-center gap-3 border-b border-line bg-surface-2 px-3.5 py-2">
      <span className="w-[26px] shrink-0" />
      <span className="label flex-[2]">Token</span>
      <span className="label hidden flex-[3] lg:block">Description</span>
      <span className="label w-20 shrink-0 text-right">Mcap</span>
      <span className="label hidden w-20 shrink-0 text-right sm:block">Vol 24h</span>
      <span className="label hidden w-14 shrink-0 text-right md:block">Holders</span>
      <span className="label w-16 shrink-0 text-right">24h</span>
      <span className="label hidden w-24 shrink-0 sm:block">Curve</span>
    </div>
  );
}

function ChipGroup({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-1">{children}</div>;
}

function ChipButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-sm px-2.5 py-1.5 text-[12px] transition-colors ${
        active
          ? "bg-surface-3 text-ink"
          : "text-ink-2 hover:bg-surface-2 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function ViewButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`flex h-6 w-7 items-center justify-center transition-colors ${
        active ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink-2"
      }`}
    >
      {children}
    </button>
  );
}
