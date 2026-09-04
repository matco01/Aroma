import { NextResponse, type NextRequest } from "next/server";
import { searchTokens, fetchBoardPage } from "@/lib/server/board";
import { hasSubgraph } from "@/lib/server/subgraph";

/**
 * Token search.
 *
 * An empty query returns the most-traded tokens rather than nothing — the
 * command menu opens before anyone types, and a blank panel is a worse
 * answer than a useful default.
 */

const MAX_TERM = 64;

export async function GET(request: NextRequest) {
  if (!hasSubgraph) {
    return NextResponse.json({ tokens: [] });
  }

  const raw = request.nextUrl.searchParams.get("q") ?? "";
  const q = raw.slice(0, MAX_TERM).trim();

  try {
    if (q.length === 0) {
      const page = await fetchBoardPage({
        filter: "all",
        sort: "volume",
        limit: 8,
        skip: 0,
      });
      return NextResponse.json({ tokens: page.tokens });
    }

    const tokens = await searchTokens(q, 8);
    return NextResponse.json(
      { tokens },
      { headers: { "cache-control": "public, s-maxage=10, stale-while-revalidate=60" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json({ error: message, tokens: [] }, { status: 502 });
  }
}
