import { NextResponse, type NextRequest } from "next/server";
import { events, RangeTooWide } from "@/lib/server/dex-adapter";
import { hasSubgraph } from "@/lib/server/subgraph";
import { upstreamFailure } from "@/lib/server/upstream";
import { dexRateLimit, EVENTS_PER_WINDOW } from "@/lib/server/dex-limit";

/**
 * Every curve trade in a block range, oldest first.
 *
 * This is the endpoint an indexer actually lives on: it walks forward a range
 * at a time and builds its own history from what comes back, so the two things
 * that matter are that a range is complete and that it is ordered. A missing
 * trade is a wrong candle forever, not a gap that heals on the next poll.
 *
 * Ranges are refused rather than truncated past a limit, for the same reason.
 * A short answer to a wide question looks exactly like a quiet market.
 */

/**
 * Wide enough for an indexer that has fallen a long way behind to catch up in
 * sane steps, narrow enough that one request cannot ask us to scan the chain.
 */
const MAX_SPAN = 100_000;

export async function GET(request: NextRequest) {
  const limited = dexRateLimit(request, "events", EVENTS_PER_WINDOW);
  if (limited) return limited;

  if (!hasSubgraph) {
    return NextResponse.json({ error: "No indexer configured" }, { status: 503 });
  }

  const params = request.nextUrl.searchParams;
  const rawFrom = params.get("fromBlock");
  const rawTo = params.get("toBlock");

  // Presence is checked before conversion, because Number(null) is 0 and 0 is
  // a perfectly good block number. Without this a caller who forgot the
  // parameters gets 200 and an empty list, which reads as "no trades in that
  // range" rather than "you asked wrong" — the exact silent-gap failure this
  // endpoint must never produce.
  if (rawFrom === null || rawTo === null) {
    return NextResponse.json(
      { error: "fromBlock and toBlock are required" },
      { status: 400 },
    );
  }

  const fromBlock = Number(rawFrom);
  const toBlock = Number(rawTo);

  if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlock)) {
    return NextResponse.json(
      { error: "fromBlock and toBlock must be integers" },
      { status: 400 },
    );
  }
  if (fromBlock < 0 || toBlock < fromBlock) {
    return NextResponse.json(
      { error: "toBlock must be greater than or equal to fromBlock" },
      { status: 400 },
    );
  }
  if (toBlock - fromBlock > MAX_SPAN) {
    return NextResponse.json(
      { error: `Ask for at most ${MAX_SPAN} blocks at a time.` },
      { status: 400 },
    );
  }

  try {
    const found = await events(fromBlock, toBlock);
    return NextResponse.json(
      { events: found },
      { headers: { "cache-control": "public, s-maxage=5" } },
    );
  } catch (e) {
    if (e instanceof RangeTooWide) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: upstreamFailure(e) }, { status: 502 });
  }
}
