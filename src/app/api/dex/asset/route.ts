import { NextResponse, type NextRequest } from "next/server";
import { asset, USDC_ASSET_ID } from "@/lib/server/dex-adapter";
import { hasSubgraph } from "@/lib/server/subgraph";
import { upstreamFailure } from "@/lib/server/upstream";

/**
 * What one of the two sides of a pair is.
 *
 * Every pair here quotes a launched token against native USDC, so this answers
 * for both: a token address resolves through the index, and the zero address
 * resolves to USDC itself, which is not a token we launched and has no row to
 * look up.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id || !ADDRESS.test(id)) {
    return NextResponse.json({ error: "An asset id is required" }, { status: 400 });
  }

  // Arc's gas token. Native, so there is no contract to read a supply from,
  // and no meaningful total to state — deliberately left out rather than
  // guessed at.
  if (id.toLowerCase() === USDC_ASSET_ID) {
    return NextResponse.json(
      {
        asset: {
          id: USDC_ASSET_ID,
          name: "USD Coin",
          symbol: "USDC",
          metadata: { native: "true" },
        },
      },
      { headers: { "cache-control": "public, s-maxage=3600" } },
    );
  }

  if (!hasSubgraph) {
    return NextResponse.json({ error: "No indexer configured" }, { status: 503 });
  }

  try {
    const found = await asset(id.toLowerCase());
    if (!found) {
      return NextResponse.json({ error: "Unknown asset" }, { status: 404 });
    }
    return NextResponse.json(
      { asset: found },
      { headers: { "cache-control": "public, s-maxage=10" } },
    );
  } catch (e) {
    return NextResponse.json({ error: upstreamFailure(e) }, { status: 502 });
  }
}
