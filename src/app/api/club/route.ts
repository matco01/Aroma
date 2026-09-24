import { NextResponse } from "next/server";
import { fetchCurrentClub } from "@/lib/server/club";
import { clubDemoEnabled, demoClub } from "@/lib/server/club-demo";
import { hasSubgraph } from "@/lib/server/subgraph";
import { upstreamFailure } from "@/lib/server/upstream";

/**
 * The live Club and every bid placed on it, served once for every viewer.
 *
 * No direct-chain fallback here, unlike /api/board: `chain-data.ts`'s
 * fallback reader exists for a board that predates any indexer at all, and
 * a bid history is exactly the kind of event log that needs one — the
 * subgraph is expected to exist before this route points at anything real.
 */
export async function GET() {
  if (clubDemoEnabled) {
    return NextResponse.json(demoClub(), { headers: { "cache-control": "no-store" } });
  }

  if (!hasSubgraph) {
    return NextResponse.json({ error: "SUBGRAPH_URL is not configured" }, { status: 503 });
  }

  try {
    const live = await fetchCurrentClub();
    return NextResponse.json(
      { current: live?.club ?? null, bids: live?.bids ?? [] },
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
