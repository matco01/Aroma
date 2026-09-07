import { NextResponse } from "next/server";
import { latestBlock } from "@/lib/server/dex-adapter";
import { hasSubgraph } from "@/lib/server/subgraph";
import { upstreamFailure } from "@/lib/server/upstream";

/**
 * The most recent block this feed can answer for.
 *
 * An indexer polls this first and then asks for events up to it, so the number
 * has to be the *indexed* head rather than the chain's — promising a block we
 * have not indexed would make the caller ask for events that exist on chain
 * and are missing here, and read the gap as no trading.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  if (!hasSubgraph) {
    return NextResponse.json({ error: "No indexer configured" }, { status: 503 });
  }

  try {
    const block = await latestBlock();
    return NextResponse.json(
      { block },
      { headers: { "cache-control": "public, s-maxage=2" } },
    );
  } catch (e) {
    return NextResponse.json({ error: upstreamFailure(e) }, { status: 502 });
  }
}
