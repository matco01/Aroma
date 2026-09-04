import { NextResponse, type NextRequest } from "next/server";
import { fetchPortfolio } from "@/lib/server/board";
import { hasSubgraph } from "@/lib/server/subgraph";
import { indexerLag } from "@/lib/server/lag";

/**
 * One wallet's holdings.
 *
 * The address is a public identifier and the data is derived from public
 * chain events — nothing here is privileged. It is still a per-address
 * query, so it caches on its own key rather than sharing the board's.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function GET(request: NextRequest) {
  if (!hasSubgraph) {
    return NextResponse.json(
      { error: "No subgraph configured. Set SUBGRAPH_URL." },
      { status: 503 },
    );
  }

  const address = request.nextUrl.searchParams.get("address");
  if (!address || !ADDRESS.test(address)) {
    return NextResponse.json({ error: "A wallet address is required" }, { status: 400 });
  }

  try {
    const { holdings, meta } = await fetchPortfolio(address);
    const indexer = await indexerLag(meta);
    return NextResponse.json(
      { holdings, indexer },
      { headers: { "cache-control": "private, max-age=5" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
