import { NextResponse } from "next/server";
import { fetchTokenDetail } from "@/lib/server/board";
import { hasSubgraph } from "@/lib/server/subgraph";
import { indexerLag } from "@/lib/server/lag";

/**
 * One token, its trades and its price history — a single indexed read.
 *
 * The chart used to be rebuilt in the browser by replaying every trade the
 * token ever had. The index records the spot price at each trade, so the
 * series is now read rather than derived.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  if (!hasSubgraph) {
    return NextResponse.json(
      { error: "No subgraph configured. Set SUBGRAPH_URL." },
      { status: 503 },
    );
  }

  const { address } = await params;
  if (!ADDRESS.test(address)) {
    return NextResponse.json({ error: "Not a contract address" }, { status: 400 });
  }

  try {
    const detail = await fetchTokenDetail(address);
    if (!detail.coin) {
      return NextResponse.json({ error: "Token not found" }, { status: 404 });
    }

    const indexer = await indexerLag(detail.meta);

    return NextResponse.json(
      {
        coin: detail.coin,
        trades: detail.trades,
        candles: detail.candles,
        interval: detail.interval,
        indexer,
      },
      {
        headers: {
          "cache-control": "public, s-maxage=5, stale-while-revalidate=30",
        },
      },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
