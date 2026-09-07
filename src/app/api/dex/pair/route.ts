import { NextResponse, type NextRequest } from "next/server";
import { pair } from "@/lib/server/dex-adapter";
import { hasSubgraph } from "@/lib/server/subgraph";
import { upstreamFailure } from "@/lib/server/upstream";
import { dexRateLimit, LOOKUPS_PER_WINDOW } from "@/lib/server/dex-limit";

/**
 * A pair, which here is a coin and its curve.
 *
 * There is no pool contract to name, so the pair is identified by the token
 * address itself — the curve for a token is one-to-one with it, lives in
 * CurveManager's per-token state, and never exists separately.
 *
 * Nothing about a pair changes after creation, so this caches for far longer
 * than anything else in the feed.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function GET(request: NextRequest) {
  const limited = dexRateLimit(request, "pair", LOOKUPS_PER_WINDOW);
  if (limited) return limited;

  if (!hasSubgraph) {
    return NextResponse.json({ error: "No indexer configured" }, { status: 503 });
  }

  const id = request.nextUrl.searchParams.get("id");
  if (!id || !ADDRESS.test(id)) {
    return NextResponse.json({ error: "A pair id is required" }, { status: 400 });
  }

  try {
    const found = await pair(id.toLowerCase());
    if (!found) {
      return NextResponse.json({ error: "Unknown pair" }, { status: 404 });
    }
    return NextResponse.json(
      { pair: found },
      { headers: { "cache-control": "public, s-maxage=60" } },
    );
  } catch (e) {
    return NextResponse.json({ error: upstreamFailure(e) }, { status: 502 });
  }
}
