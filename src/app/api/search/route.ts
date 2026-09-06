import { NextResponse, type NextRequest } from "next/server";
import { searchTokens, fetchBoardPage } from "@/lib/server/board";
import { hasSubgraph } from "@/lib/server/subgraph";
import { upstreamFailure } from "@/lib/server/upstream";

/**
 * Token search.
 *
 * An empty query returns the most-traded tokens rather than nothing — the
 * command menu opens before anyone types, and a blank panel is a worse
 * answer than a useful default.
 */

const MAX_TERM = 64;

/**
 * Characters a coin name or ticker can plausibly contain.
 *
 * Anything else is dropped rather than rejected, so a stray character in a
 * pasted string still searches for the rest of it instead of erroring.
 *
 * This is not injection defence — the term travels as a GraphQL variable and
 * is never interpolated into a query. It is about what happens upstream: the
 * indexer sits behind its own WAF, and a term containing markup trips it, so
 * the search returned a 502 to anyone who typed a "<" into the box. Stripping
 * characters that cannot appear in a name anyway keeps a harmless query from
 * looking like an attack to somebody else's firewall.
 */
const UNSEARCHABLE = /[^\p{L}\p{N} ._:'-]/gu;

export async function GET(request: NextRequest) {
  if (!hasSubgraph) {
    return NextResponse.json({ tokens: [] });
  }

  const raw = request.nextUrl.searchParams.get("q") ?? "";
  const q = raw.slice(0, MAX_TERM).replace(UNSEARCHABLE, "").trim();

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
    const message = upstreamFailure(e);
    return NextResponse.json({ error: message, tokens: [] }, { status: 502 });
  }
}
