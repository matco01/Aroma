import "server-only";
import { createPublicClient } from "viem";
import { arcTestnet } from "@reown/appkit/networks";
import { arcTransport } from "../transport";
import type { SubgraphMeta } from "./subgraph";

/**
 * How far behind the chain the index is.
 *
 * This exists because indexer lag is a *correctness* problem dressed up as
 * a performance one. A board served from an index three minutes behind
 * shows prices that have already moved, and someone will size a trade
 * against them. Better to say "data is N seconds behind" than to render
 * stale numbers as though they were live.
 *
 * The chain head is cached hard: it costs an RPC call, it is identical for
 * every viewer, and Arc produces blocks fast enough that a couple of
 * seconds of imprecision changes no decision.
 */

const client = createPublicClient({
  chain: arcTestnet,
  transport: arcTransport(),
});

/** Arc's observed block time. Used to turn a block delta into seconds. */
const SECONDS_PER_BLOCK = 0.42;

/** Below this the index is effectively live; the UI says nothing. */
const HEALTHY_BLOCKS = 60;
/** Past this, the UI should actively warn rather than quietly note. */
const STALE_BLOCKS = 600;

let headCache: { block: number; expires: number } | null = null;
const HEAD_TTL_MS = 10_000;

export type IndexerHealth = {
  indexedBlock: number;
  headBlock: number | null;
  blocksBehind: number | null;
  secondsBehind: number | null;
  status: "live" | "lagging" | "stale" | "unknown";
  hasIndexingErrors: boolean;
};

async function chainHead(): Promise<number | null> {
  const now = Date.now();
  if (headCache && headCache.expires > now) return headCache.block;
  try {
    const block = Number(await client.getBlockNumber());
    headCache = { block, expires: now + HEAD_TTL_MS };
    return block;
  } catch {
    // A head we cannot read is not a reason to fail the board — report
    // unknown lag and serve the data.
    return null;
  }
}

export async function indexerLag(meta: SubgraphMeta): Promise<IndexerHealth> {
  const head = await chainHead();

  if (head === null) {
    return {
      indexedBlock: meta.indexedBlock,
      headBlock: null,
      blocksBehind: null,
      secondsBehind: null,
      status: "unknown",
      hasIndexingErrors: meta.hasIndexingErrors,
    };
  }

  const behind = Math.max(0, head - meta.indexedBlock);
  const status =
    meta.hasIndexingErrors || behind > STALE_BLOCKS
      ? "stale"
      : behind > HEALTHY_BLOCKS
        ? "lagging"
        : "live";

  return {
    indexedBlock: meta.indexedBlock,
    headBlock: head,
    blocksBehind: behind,
    secondsBehind: Math.round(behind * SECONDS_PER_BLOCK),
    status,
    hasIndexingErrors: meta.hasIndexingErrors,
  };
}
