import { NextResponse, type NextRequest } from "next/server";
import {
  fetchBoardPage,
  fetchTapeTrades,
  type BoardFilter,
  type BoardSort,
} from "@/lib/server/board";
import { hasSubgraph } from "@/lib/server/subgraph";
import { indexerLag } from "@/lib/server/lag";
import { fetchBoardData } from "@/lib/chain-data";
import { upstreamFailure } from "@/lib/server/upstream";
import { POOL } from "@/lib/arc";

/**
 * The board, served once for everyone.
 *
 * Filtering, sorting and paging all happen in the index — the browser
 * receives a page, not a corpus. Responses carry an `indexer` block so the
 * UI can say when it is showing stale data: an indexer that has fallen
 * behind is a correctness problem, not a performance one, because people
 * would otherwise trade on prices that have already moved.
 */

const FILTERS: BoardFilter[] = ["all", "climbing", "graduated"];
const SORTS: BoardSort[] = ["buys", "new", "mcap", "volume"];
const MAX_SKIP = 5_000;
const MAX_LIMIT = 60;

function pick<T extends string>(value: string | null, allowed: T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const filter = pick(params.get("filter"), FILTERS, "all");
  const sort = pick(params.get("sort"), SORTS, "buys");
  // Clamped, not just floored. An unbounded skip is a distinct cache key
  // per value, so ?skip=1..1000000 was a way to grow the server cache
  // without limit. The indexer will not paginate this deep anyway.
  const skip = Math.min(MAX_SKIP, Math.max(0, Number(params.get("skip") ?? 0) || 0));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(params.get("limit") ?? 24) || 24));
  const withTape = params.get("tape") !== "0";

  if (!hasSubgraph) {
    // No indexer configured — read the chain directly so a fresh clone
    // still renders. Slow and rate-limited by design; see chain-data.ts.
    try {
      const { tokens, trades } = await fetchBoardData();
      // Most recent trade per coin, for the default "recent buys" sort.
      const lastTrade = new Map<string, number>();
      for (const t of trades) {
        if (!lastTrade.has(t.tokenAddress)) lastTrade.set(t.tokenAddress, t.timestamp);
      }
      const byFilter =
        filter === "climbing"
          ? tokens.filter((t) => !t.graduated)
          : filter === "graduated"
            ? tokens.filter((t) => t.graduated)
            : tokens;
      // Sorted here rather than ignored. The fallback used to return creation
      // order whatever was asked, which is a board that does not respond to
      // its own tabs.
      const filtered = [...byFilter].sort((a, b) =>
        sort === "mcap"
          ? b.marketCapUsd - a.marketCapUsd
          : sort === "volume"
            ? b.volume24hUsd - a.volume24hUsd
            : sort === "new"
              ? a.createdAgoSeconds - b.createdAgoSeconds
              : (lastTrade.get(b.contract) ?? 0) - (lastTrade.get(a.contract) ?? 0),
      );
      return NextResponse.json({
        tokens: filtered.slice(skip, skip + limit),
        trades: withTape ? trades.slice(0, 12) : [],
        stats: {
          tokenCount: tokens.length,
          tradeCount: trades.length,
          graduatedCount: tokens.filter((t) => t.graduated).length,
          totalVolumeUsd: trades.reduce((sum, t) => sum + t.usd, 0),
          totalFeesUsd: trades.reduce((sum, t) => sum + t.usd, 0) * (POOL.tradeFeeBps / 10_000),
        },
        indexer: {
          indexedBlock: 0,
          headBlock: null,
          blocksBehind: null,
          secondsBehind: null,
          // Read from the chain itself a few seconds ago, so there is no
          // index to be behind. "unknown" put a can't-reach-the-chain
          // warning on every page served this way, which is the opposite
          // of true.
          status: "live" as const,
          hasIndexingErrors: false,
        },
        hasMore: filtered.length > skip + limit,
      });
    } catch (e) {
      const message = upstreamFailure(e);
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  try {
    const [page, tape] = await Promise.all([
      fetchBoardPage({ filter, sort, limit, skip }),
      withTape ? fetchTapeTrades(12) : Promise.resolve([]),
    ]);

    const indexer = await indexerLag(page.meta);

    return NextResponse.json(
      { ...page, trades: tape, indexer },
      {
        headers: {
          // Shared caches may serve this briefly, and may keep serving a
          // stale copy while revalidating — far better than a cold miss
          // stampeding the upstream.
          "cache-control": "public, s-maxage=5, stale-while-revalidate=30",
        },
      },
    );
  } catch (e) {
    const message = upstreamFailure(e);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
