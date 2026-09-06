import type { NextRequest } from "next/server";
import { subscribe } from "@/lib/server/live";
import { hasSubgraph } from "@/lib/server/subgraph";
import { clientKey } from "@/lib/server/rate-limit";

/**
 * Server-sent events for the live tape.
 *
 * SSE rather than WebSockets: this is one-directional (the server has news,
 * the client never talks back), it rides ordinary HTTP so proxies and CDNs
 * don't need special handling, and browsers reconnect on their own. A
 * WebSocket would be a heavier mechanism for strictly less.
 */

export const dynamic = "force-dynamic";
/** Streaming needs the Node runtime, not the edge's buffered responses. */
export const runtime = "nodejs";

const HEARTBEAT_MS = 25_000;

export async function GET(request: NextRequest) {
  if (!hasSubgraph) {
    return new Response("Live updates need a configured indexer", { status: 503 });
  }

  const encoder = new TextEncoder();

  /**
   * Whether subscribe() accepted us. ReadableStream calls start()
   * synchronously while it is being constructed, so this is settled by the
   * time the constructor returns and can still decide the status code. A
   * refusal has to be a 503 that EventSource backs off from, not a 200 that
   * closes immediately and gets retried in a tight loop.
   */
  let refused = false;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const send = (data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // The client vanished mid-write; cleanup below handles it.
          closed = true;
        }
      };

      const unsubscribe = subscribe((event) => {
        send(`event: update\ndata: ${JSON.stringify(event)}\n\n`);
      }, clientKey(request));

      if (!unsubscribe) {
        refused = true;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
        return;
      }

      // Comment frames keep intermediaries from treating a quiet stream as
      // dead. A market with no trades for a minute is normal; a proxy
      // closing the connection over it is not.
      const heartbeat = setInterval(() => send(`: keep-alive\n\n`), HEARTBEAT_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      request.signal.addEventListener("abort", cleanup);
    },
  });

  if (refused) {
    return new Response("Too many open streams. Try again shortly.", {
      status: 503,
      headers: { "retry-after": "30" },
    });
  }

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx and similar buffer by default, which would defeat streaming.
      "x-accel-buffering": "no",
    },
  });
}
