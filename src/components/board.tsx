"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  useBoard,
  type BoardFilter,
  type BoardSort,
} from "@/lib/use-chain";
import { CURVE } from "@/lib/arc";
import { usd } from "@/lib/format";
import { CoinCard, CoinRow } from "./coin-card";
import { IndexerStatus } from "./indexer-status";
import { useValueFlash } from "@/lib/use-value-flash";

type View = "grid" | "list";

const FILTERS: { id: BoardFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "climbing", label: "Climbing" },
  { id: "graduated", label: "Graduated" },
];

const SORTS: { id: BoardSort; label: string }[] = [
  { id: "buys", label: "Recent buys" },
  { id: "new", label: "Newest" },
  { id: "mcap", label: "Market cap" },
  { id: "volume", label: "Volume" },
];

const PAGE_SIZE = 24;

/**
 * The board.
 *
 * Filtering, sorting and paging are all server-side now. They used to be a
 * useMemo over every token that existed, which cannot paginate — you can't
 * page a sort the database didn't do — and which rendered the entire
 * corpus into the DOM. A page at a time keeps both the query and the tab
 * bounded however many tokens exist.
 */
export function Board() {
  const [filter, setFilter] = useState<BoardFilter>("all");
  const [sort, setSort] = useState<BoardSort>("buys");
  const [view, setView] = useState<View>("grid");
  const [page, setPage] = useState(0);

  const { data, isLoading, isFetching, error } = useBoard({
    filter,
    sort,
    limit: PAGE_SIZE,
    skip: page * PAGE_SIZE,
  });

  // Changing what you're looking at returns you to the first page — page 3
  // of "Graduated" is meaningless after switching to "Newest". Done in the
  // handlers rather than an effect so there's no render with a stale page
  // against fresh criteria.
  function changeFilter(next: BoardFilter) {
    setFilter(next);
    setPage(0);
  }

  function changeSort(next: BoardSort) {
    setSort(next);
    setPage(0);
  }

  const coins = data?.tokens ?? [];
  const arrivals = useArrivals(coins, `${filter}:${sort}:${page}`);
  const stats = data?.stats;
  const total = stats?.tokenCount ?? 0;
  const hasMore = data?.hasMore ?? false;
  const showing = coins.length > 0;

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
              onClick={() => changeFilter(f.id)}
            >
              {f.label}
            </ChipButton>
          ))}
        </ChipGroup>

        <span className="h-3.5 w-px bg-line" />

        <ChipGroup>
          {SORTS.map((s) => (
            <ChipButton key={s.id} active={sort === s.id} onClick={() => changeSort(s.id)}>
              {s.label}
            </ChipButton>
          ))}
        </ChipGroup>

        <div className="flex-1" />

        {/* Stats inline rather than a block above the grid. They are worth a
            glance and not worth a row of their own — a card each with the
            label stacked over the value is the shape of a dashboard, and
            this is a market. */}
        <div className="num flex items-center gap-2.5 text-[11.5px] text-ink-3">
          {stats && (
            <>
              <span>
                <span className="text-ink-2">{stats.tokenCount}</span> tokens
              </span>
              <span className="text-line-strong">/</span>
              <span>
                <FlashingValue value={stats.totalVolumeUsd} /> vol
              </span>
              <span className="hidden text-line-strong sm:inline">/</span>
              <span className="hidden sm:inline">
                <span className="text-ink-2">{stats.graduatedCount}</span> graduated
              </span>
              <span className="hidden text-line-strong lg:inline">/</span>
              <span className="hidden lg:inline">
                graduates at{" "}
                <span className="text-ink-2">
                  {usd(CURVE.graduationMarketCapUsd)}
                </span>
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
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

      <div className="mt-4">
        <IndexerStatus health={data?.indexer} />
      </div>

      {isLoading && <p className="mt-6 text-[12.5px] text-ink-3">Reading the chain…</p>}

      {error && (
        <p className="mt-6 text-[12.5px] text-down">
          Couldn&apos;t load the board. {(error as Error).message.slice(0, 140)}
        </p>
      )}

      {!isLoading && !error && coins.length === 0 && (
        <div className="mt-6 rounded-md border border-line bg-surface px-6 py-16 text-center">
          <p className="text-[13px] text-ink">
            {filter === "graduated" ? "Nothing has graduated yet" : "Nothing launched yet"}
          </p>
          <p className="mt-1 text-[12px] text-ink-2">
            {filter === "graduated"
              ? "Tokens appear here once they complete the curve."
              : "Be the first — launching is free, you only pay gas."}
          </p>
        </div>
      )}

      {showing &&
        (view === "grid" ? (
          <div
            className={`mt-4 grid grid-cols-2 gap-2.5 transition-opacity sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 ${
              isFetching ? "opacity-60" : ""
            }`}
          >
            {coins.map((c) => (
              <div key={c.id} className={arrivals.has(c.id) ? "card-enter" : ""}>
                <CoinCard coin={c} />
              </div>
            ))}
          </div>
        ) : (
          <div
            className={`mt-4 overflow-hidden rounded-md border border-line bg-surface transition-opacity ${
              isFetching ? "opacity-60" : ""
            }`}
          >
            <ListHeader />
            {coins.map((c) => (
              <div key={c.id} className={arrivals.has(c.id) ? "slide-in" : ""}>
                <CoinRow coin={c} />
              </div>
            ))}
          </div>
        ))}

      {(page > 0 || hasMore) && (
        <div className="mt-4 flex items-center justify-between border-t border-line pt-3">
          <PageButton disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            ← Previous
          </PageButton>
          <span className="num text-[11px] text-ink-3">
            {page * PAGE_SIZE + 1}–{page * PAGE_SIZE + coins.length}
            {total > 0 && ` of ${total}`}
          </span>
          <PageButton disabled={!hasMore} onClick={() => setPage((p) => p + 1)}>
            Next →
          </PageButton>
        </div>
      )}
    </section>
  );
}

function PageButton({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="h-10 rounded-sm border border-line px-3 text-[12px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-ink-2 sm:h-8"
    >
      {children}
    </button>
  );
}

function ChipGroup({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-0.5">{children}</div>;
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
      className={`rounded-sm px-3 py-2.5 text-[13px] transition-colors sm:py-1.5 ${
        active
          ? "bg-accent-2-dim text-accent-2"
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
      className={`flex h-9 w-10 items-center justify-center transition-colors sm:h-7 sm:w-8 ${
        active ? "bg-accent-2-dim text-accent-2" : "text-ink-3 hover:text-ink-2"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Column widths here must mirror CoinRow exactly, including which columns
 * hide at which breakpoint. They had drifted: the header advertised a
 * Price column the row never rendered, so every label sat above the wrong
 * number — market cap under "Price", volume under "Market cap", and so on
 * down the line.
 */
function ListHeader() {
  return (
    <div className="hidden items-center gap-3 border-b border-line bg-surface-2 px-3.5 py-2 sm:flex">
      <span className="w-7 shrink-0" />
      <span className="label flex-[2]">Token</span>
      <span className="label hidden flex-[3] lg:block" />
      <span className="label w-20 shrink-0 text-right">Market cap</span>
      <span className="label hidden w-20 shrink-0 text-right sm:block">Volume</span>
      <span className="label hidden w-14 shrink-0 text-right md:block">Holders</span>
      <span className="label w-16 shrink-0 text-right">Change</span>
      <span className="label hidden w-24 shrink-0 sm:block">Curve</span>
    </div>
  );
}

/**
 * Which coins on screen were not on screen a moment ago.
 *
 * The first list is never an arrival — everything is new when you have
 * just loaded the page, and animating all of it in is a page transition,
 * not a signal. Only what appears afterwards gets to move.
 *
 * `view` is the same idea one level up. Paging to the next page, or
 * re-sorting, replaces the entire id list, and without resetting here
 * every card would animate in as though twenty coins had just launched.
 * A new view primes exactly like a first load.
 *
 * Keyed off the ids alone: a coin whose price changed has not arrived,
 * and re-animating it on every trade would make the grid twitch.
 */
function useArrivals(coins: { id: string }[], view: string): Set<string> {
  const ids = useMemo(() => coins.map((c) => c.id).join(","), [coins]);
  const known = useRef<Set<string> | null>(null);
  const lastView = useRef(view);
  const [arrivals, setArrivals] = useState<Set<string>>(new Set());

  useEffect(() => {
    const current = ids ? ids.split(",") : [];
    if (!current.length) return;

    if (known.current === null || lastView.current !== view) {
      lastView.current = view;
      known.current = new Set(current);
      setArrivals(new Set());
      return;
    }

    const fresh = current.filter((id) => !known.current!.has(id));
    // Track everything present, so paging back and forth does not make
    // already-seen coins animate again.
    for (const id of current) known.current.add(id);
    if (fresh.length) setArrivals(new Set(fresh));
  }, [ids, view]);

  return arrivals;
}

/** A figure in the stats run that tints when it moves. */
function FlashingValue({ value }: { value: number }) {
  const flash = useValueFlash(value);
  return (
    <span
      key={flash.seq}
      className={`text-ink-2 ${
        flash.dir
          ? `value-flash ${flash.dir === "up" ? "flash-tone-up" : "flash-tone-down"}`
          : ""
      }`}
    >
      {usd(value)}
    </span>
  );
}
