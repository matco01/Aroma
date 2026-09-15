import { NextResponse } from "next/server";
import { fetchTokenDetail } from "@/lib/server/board";
import { hasSubgraph } from "@/lib/server/subgraph";
import { indexerLag } from "@/lib/server/lag";
import { upstreamFailure } from "@/lib/server/upstream";
import { fetchTokenFromChain } from "@/lib/chain-data";

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
  const { address } = await params;
  if (!ADDRESS.test(address)) {
    return NextResponse.json({ error: "Not a contract address" }, { status: 400 });
  }

  if (!hasSubgraph) {
    // No indexer — read the chain directly. This used to be a 503, which
    // meant every coin page went dark with the indexer. It is the path the
    // site falls back to if Arc mainnet cannot be indexed yet; see
    // chain-data.ts.
    try {
      const detail = await fetchTokenFromChain(address);
      if (!detail) {
        return NextResponse.json({ error: "Token not found" }, { status: 404 });
      }
      return NextResponse.json({
        ...detail,
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
      });
    } catch (e) {
      return NextResponse.json({ error: upstreamFailure(e) }, { status: 502 });
    }
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
        series: detail.series,
        indexer,
      },
      {
        headers: {
          "cache-control": "public, s-maxage=5, stale-while-revalidate=30",
        },
      },
    );
  } catch (e) {
    const message = upstreamFailure(e);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
