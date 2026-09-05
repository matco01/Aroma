# Deploying Aroma

One long-lived container. Not serverless, and not replicated — see
"Why one process" below before changing either.

## Railway

1. New project → Deploy from GitHub repo. Railway detects the `Dockerfile`
   and builds from it; no buildpack configuration needed.
2. Set the service variables below.
3. Add the three `NEXT_PUBLIC_*` ones as **build args** as well. They are
   inlined into the client bundle at build time, so setting them only as
   runtime variables leaves the browser bundle with the values that were
   present when the image was built.
4. Generate a domain, then put Cloudflare in front of it, proxied.

## Variables

| Variable | Required | Notes |
|---|---|---|
| `SUBGRAPH_URL` | yes | Goldsky query endpoint. Without it the app falls back to reading the chain directly — it works, but a board page takes seconds instead of milliseconds. |
| `PINATA_JWT` | for image uploads | Write access to the Pinata account. Server-side only; never expose it. Without it `/api/upload` returns 503 and coins launch without pictures. |
| `NEXT_PUBLIC_ARC_RPC_URL` | recommended | Comma-separate two endpoints to get automatic failover. Defaults to the public Arc RPC, which is rate-limited. |
| `NEXT_PUBLIC_REOWN_PROJECT_ID` | recommended | Reown Cloud project. Without it wallet connection falls back to whatever the browser has injected. |
| `NEXT_PUBLIC_PINATA_GATEWAY` | recommended | Dedicated gateway hostname. Defaults to `gateway.pinata.cloud`, which is heavily shared and slow. |

Contract addresses are **not** environment variables — they live in
`src/lib/arc.ts`. Pointing the app at a different deployment is a code
change and a rebuild, deliberately: an address that decides where money
goes should be reviewable in a diff, not editable in a dashboard.

## Why one process

`src/lib/server/live.ts` runs a single poller that feeds every connected
browser, so indexer load stays flat no matter how many people are
watching. `subgraph.ts` caches in memory, and `rate-limit.ts` counts in
memory. All three assume one process.

Running replicas silently breaks all three: one poller per replica, cache
hit rate collapses, and the upload rate limit multiplies by the replica
count. **Scale vertically, not horizontally**, until the cache and rate
limiter move to Redis and SSE fan-out moves to pub/sub.

Measured on one production process: 1,000 concurrent SSE connections at
246 MB RSS, board page 1,363 req/s, cached API responses in 1-3 ms. The
ceiling before that rewrite is roughly 3,000-5,000 concurrent viewers,
where the event loop starts stalling on broadcast bursts.

## Health

- `GET /api/board?limit=1` — exercises the indexer path end to end.
- `GET /api/live` — should stay open and emit `event: update` frames.

## Before a public launch

- Put Cloudflare in front, proxied. Static assets then serve from their
  edge rather than counting against Railway egress, which is the single
  largest cost at traffic.
- Confirm `PROTOCOL_OWNER` on the deployed contracts is a wallet you
  control. It is the only address that can withdraw protocol fees.
