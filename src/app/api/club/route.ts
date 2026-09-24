import { NextResponse } from "next/server";
import { fetchCurrentClub, fetchPastClubs } from "@/lib/server/club";
import { hasSubgraph } from "@/lib/server/subgraph";
import { upstreamFailure } from "@/lib/server/upstream";

/**
 * The live Club plus recent history, served once for every viewer.
 *
 * No direct-chain fallback here, unlike /api/board: `chain-data.ts`'s
 * fallback reader exists for a board that predates any indexer at all, and
 * reading a single mutable struct (ClubAuction.getCurrentClub()) doesn't
 * carry the same case for it — the subgraph is expected to exist before
 * this route is ever pointed at anything real.
 */
export async function GET() {
  if (!hasSubgraph) {
    return NextResponse.json({ error: "SUBGRAPH_URL is not configured" }, { status: 503 });
  }

  try {
    const [current, past] = await Promise.all([fetchCurrentClub(), fetchPastClubs(10)]);
    return NextResponse.json(
      { current, past },
      {
        headers: {
          "cache-control": "public, s-maxage=5, stale-while-revalidate=15",
        },
      },
    );
  } catch (e) {
    const message = upstreamFailure(e);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
