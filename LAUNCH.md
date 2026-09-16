# Launching the pool system on Arc mainnet

Runbook for 16 September 2026, when Arc mainnet opens publicly.

This covers the **pool system** (`contracts/src/pool/`) — launches that go
straight into a Uniswap v4 pool. The curve system is unaffected and stays on
testnet; see [DEPLOY.md](DEPLOY.md) for the app itself.

Read the whole thing before starting. Several steps can't be undone.

---

## 0. Before the day

Everything here is blocking. None of it can be done on the 16th.

### 0.1 ~~Arc mainnet access~~ — **resolved, 2026-09-16**

`rpc.mainnet.arc.io` is open. It answers `eth_chainId` with `0x13b2` (5042)
and needs no key. The v4 PoolManager at
`0x8366a39cc670b4001a1121b8f6a443a643e40951` carries 48,021 hex chars of code.

Two limits on that endpoint matter, both measured rather than documented:

- **`eth_getLogs` spans at most ~10,000 blocks.** 9,000 succeeds, 10,000 is
  refused with "requested range too large". A second, separate cap rejects any
  query returning more than 2,000 logs, and helpfully names a narrower range in
  the error. `chain-data.ts` chunks at 9,000 and halves on complaint.
- **Blocks are ~0.506s**, so a day of history is ~170,000 blocks. The
  no-indexer fallback costs ~19 requests per event type per day of history,
  which is fine for the first days and untenable after weeks. It is a bridge to
  the subgraph, not a replacement for one.

The one thing still needed on the day is **gas**: the deployer must hold USDC
on Arc mainnet. The full deploy costs well under a dollar (9.94M gas at
~20-49 gwei); $5 is plenty.

### 0.2 Confirm RadarDex indexes Uniswap **v4**

Their docs list only v3 contracts and their launcher creates v3 pools. A
secondary source says they aggregate v2/v3/v4. **This is unresolved**, and it
matters: if their indexer watches only the v3 factory, coins launched here
will not appear on the Arc-native screener that the whole rework was meant to
reach. DexScreener and GeckoTerminal index v4 broadly, so you would not be
invisible everywhere — just where it counts most right now.

Ask them on X. If the answer is "v3 only", stop and reconsider: the v3
version of this system exists in git history and pays creator fees in mixed
currencies rather than pure USDC. That is the trade.

### 0.3 ~~Find the Universal Router address~~ — resolved

Uniswap has published no Universal Router for Arc, so the system ships its
own: `src/pool/AromaRouter.sol`. It also keeps sells to a single signature
(§5.1). Nothing to do here.

### 0.4 ~~Decide: replace the curve, or run both~~ — decided

Pool system only. The curve stays on testnet and nothing the app ships reads
it. The frontend is built for that (§5).

### 0.5 Get the contracts reviewed

`PoolVault` is unaudited, runs on every swap as the pool's hook, and holds
liquidity that can never be withdrawn. The locked liquidity is intended and
is not the risk; the pool's principal is protected by Uniswap's audited
accounting, and a bug in the mint/settle path fails closed. **The exposed
surface is the hook's fee accounting** — `beforeSwap`/`afterSwap`, roughly
120 lines — because fees can be withdrawn. Get at least that reviewed.

### 0.6 ~~Frontend~~ — done, and rehearsed on a fork. See §5.

## 1. Deploy the contracts

**Use `./scripts/go-live.sh`.** It is §1 through §2 as one command: it refuses
to start on an unfunded deployer or a chain that is not 5042, clean-builds,
runs the suite, records the chain head *before* broadcasting, deploys, checks
the hook flags, verifies the deployed runtime code against the build, and only
then writes the addresses and `deployBlock` into `src/lib/arc.ts` and
`subgraph/subgraph.pool.yaml`. It stops before committing, pushing or
accepting ownership.

```bash
./scripts/go-live.sh              # dry run — builds and mines, deploys nothing
./scripts/go-live.sh --broadcast  # the real thing
```

The rest of this section is what that script does, kept because knowing the
steps matters when one of them fails.

```bash
cd contracts
# .env needs: DEPLOYER_PRIVATE_KEY, PROTOCOL_OWNER, POOL_MANAGER,
#             ARC_MAINNET_RPC_URL
forge clean && forge build      # NOT optional — see below
forge test                      # 100 tests must pass (61 curve + 39 pool)
python script/math/derive_pool.py   # must exit 0
```

**The addresses are already known.** The deployer's nonce on Arc mainnet is 0,
and every address below falls out of that nonce — the Create2Factory by CREATE,
the vault by CREATE2 from it, the factory and router by CREATE after. Two
independent forks of Arc mainnet produced the same three:

| | |
|---|---|
| PoolVault (also the hook) | `0xbD86C2F1bD9EB780d7B59Fa1F4feE04f62d260Cc` |
| PoolFactory | `0x1503ccF70A0E63DAfb47C35076D9408089DF0829` |
| AromaRouter | `0x1c2c40ab442C48bDd9f00Dc344fF44d5B90CbA9e` |

They hold only while the nonce is still 0 and the build is unchanged. If the
broadcast fails partway and is retried, the nonce has moved and every address
changes — which is why `go-live.sh` reads them back out of forge's output
instead of assuming them, and why §1.2 runs before any address is published.

**`forge clean` is mandatory, and so is §1.2.** On 2026-09-15 a rehearsal on a
fork deployed an `AromaRouter` and `PoolFactory` from *before* the
partial-fill fix, with every test green. `new AromaRouter(...)` embeds the
router's bytecode inside the deploy script's own artifact; a
`forge test --match-path` run had recompiled the router and marked it current
in the shared cache without rebuilding the script, so `forge script` said
"No files changed, compilation skipped" and shipped the stale copy. On mainnet
that is a loss-of-funds bug, live. A clean build prevents it and §1.2 proves
it did not happen.

`POOL_MANAGER` is `0x8366a39cc670b4001a1121b8f6a443a643e40951` on Arc
mainnet. **Verify it has code before broadcasting** — the script refuses an
empty address and so does `PoolVault`'s constructor. Do not route around
either.

Dry-run first:

```bash
forge script script/DeployPool.s.sol --tc DeployPool --rpc-url arc_mainnet
```

Then broadcast:

```bash
forge script script/DeployPool.s.sol --tc DeployPool \
  --rpc-url arc_mainnet --broadcast
```

`--tc` is required: the file also carries the small CREATE2 factory the mined
address is deployed through.

**Record from the output** — you need all of these:

| | |
|---|---|
| `PoolVault` address | mined for its hook permission bits |
| `PoolFactory` address | |
| `AromaRouter` address | what the frontend swaps through |
| deployment block | for the subgraph's `startBlock` |
| `hook flags` = `required flags` | must be **8396** on both lines |

If the flags disagree, stop. A hook whose address does not match its
permissions is rejected by the pool manager, and every launch will revert.

### 1.1 Accept ownership

The script only *nominates* the owner (`Ownable2Step`). From the
`PROTOCOL_OWNER` wallet:

```bash
cast send <PoolVault> "acceptOwnership()" --rpc-url arc_mainnet
```

Until this lands, the deploy key still controls fee withdrawal. Confirm:

```bash
cast call <PoolVault> "owner()(address)" --rpc-url arc_mainnet
cast call <PoolVault> "pendingOwner()(address)" --rpc-url arc_mainnet  # 0x0
```

### 1.2 Confirm the bytecode is this repository's — before anything else

```bash
node script/verify-bytecode.mjs "$ARC_MAINNET_RPC_URL" \
  PoolVault=<vault> PoolFactory=<factory> AromaRouter=<router>
```

Compares the runtime code at each address with a fresh build, immutables and
metadata masked. **All three must say PASS.** A FAIL means the chain has a
different contract than the one tested: do not publish the addresses, `forge
clean && forge build`, and redeploy. It was run against the stale fork deploy
above and failed it, and against a clean one and passed it.

### 1.3 Verify on Arcscan

`contracts/foundry.toml` notes that Arcscan's verification API is unconfirmed
and may not be Etherscan-compatible. Check against Arcscan's own docs rather
than assuming `forge verify-contract` works.

---

## 2. Wire the addresses in

### 2.1 `src/lib/arc.ts` — the only file that changes

The mainnet network, pool constants and contract slots already exist. Fill in
`ARC_MAINNET_CONTRACTS`:

| Field | From |
|---|---|
| `poolFactory`, `poolVault`, `aromaRouter` | §1 output, after §1.2 passes |
| `deployBlock` | block the vault was deployed in, as a bigint (`123n`) |

and, in `ARC_MAINNET`, the `explorer` URL once Circle publishes one — empty
hides every explorer link rather than pointing at a dead domain.

While the addresses are empty `poolsDeployed` is false and the site shows
"Launching on Arc mainnet soon" with every launch and trade button disabled.
That is a safe state to deploy the app in before the contracts exist.

`src/lib/abis.ts` and `src/lib/chain.ts` need nothing: the pool ABIs are
generated, and the chain reads its RPC from the environment (§4).

Once Arc mainnet is confirmed to have multicall3 at
`0xcA11bde05977b3631167028862bE2a173976CA11`, it can be declared in
`src/lib/chain.ts` to batch reads. Left undeclared, wagmi makes individual
calls instead — slower, still correct.

### 2.2 `subgraph/subgraph.pool.yaml`

Three `FIXME`s: `PoolFactory` address, `PoolVault` address, and `startBlock`
on all three data sources.

**`startBlock` matters more than usual.** v4 is a singleton, so `handleSwap`
is called for *every swap in every v4 pool on Arc*. Left at 0 it will replay
the entire chain's v4 history before reaching anything of yours. Set it to
the deployment block.

## 3. Deploy the subgraph

```bash
cd subgraph
npm run codegen:pool && npm run build:pool
npm test                      # 17 unit tests; see subgraph/README.md for WSL
```

Deploy as a **separate** Goldsky subgraph — not a new version of
`aroma/1.0.0`. The two cannot be one subgraph: every data source must share a
network, and the curve system is on `arc-testnet` while this is on `arc`.

```bash
goldsky subgraph deploy aroma-pool/1.0.0 --path .   # verify the manifest flag
```

The exact invocation for selecting a non-default manifest has **not been
verified** against Goldsky's CLI. Check it rather than trusting this line.

Then wait for it to sync and confirm a query returns data before pointing
anything at it.

### 3.1 The schema changed

`Token` gained `venue` and `poolId`, and there is a new `PoolRef` entity. The
**curve** subgraph shares this schema, so redeploying it means a full
resync. The existing deployment keeps serving until you cut over, so do the
resync ahead of time and switch `SUBGRAPH_URL` when it has caught up.

---

## 4. Deploy the app

Per [DEPLOY.md](DEPLOY.md) — one container, no replicas. Set/confirm:

| Variable | |
|---|---|
| `SUBGRAPH_URL` | the pool subgraph once synced — **or unset** (below) |
| `NEXT_PUBLIC_ARC_RPC_URL` | Arc **mainnet**, two endpoints for failover |
| `NEXT_PUBLIC_REOWN_PROJECT_ID` | unchanged |
| `PINATA_JWT`, `NEXT_PUBLIC_PINATA_GATEWAY` | unchanged |

The three `NEXT_PUBLIC_*` ones must be set as **build args** as well, or the
browser bundle ships whatever was baked in at image build.

**Both of the first two currently hold testnet values**, locally and very
likely on Railway: `NEXT_PUBLIC_ARC_RPC_URL` is `rpc.testnet.arc.io` and
`SUBGRAPH_URL` is the testnet curve subgraph. Change them before the deploy.

A stale RPC no longer fails quietly. `chain.ts` checks the endpoint's chain id
against the build's once per process, before the first read, and throws naming
both numbers if they disagree — so a testnet URL on a mainnet build takes the
board down instead of serving testnet coins that look real. Loud is the right
failure here, but it is still a failure: set the variable. Leaving
`NEXT_PUBLIC_ARC_RPC_URL` unset is safe, and falls back to
`https://rpc.mainnet.arc.io`.

**Without a subgraph** (unset `SUBGRAPH_URL`), the board and coin pages read
the chain directly — `src/lib/chain-data.ts`, rehearsed on the fork. It is a
contingency, not a mode to stay in: search returns nothing, portfolios and the
live stream answer 503, and every page load scans logs from `deployBlock` —
~19 requests per event type per day of history, since Arc blocks are ~0.5s.
Fine for launch day while Goldsky syncs; point `SUBGRAPH_URL` at the pool
subgraph as soon as it has.

`NEXT_PUBLIC_AROMA_NETWORK` must be **unset** in production. `local` points
the app at a fork on 127.0.0.1.

---

## 5. The frontend — done

Built on this branch against the pool system only.

| Piece | Where |
|---|---|
| Network, pool constants, contract slots | `src/lib/arc.ts`, `src/lib/chain.ts` |
| Buys, sells, launches, fee claims | `src/lib/pool-trade.ts` (plain functions), hooks in `use-trade.ts`, `use-creator-fees*.ts` |
| Live previews and "can this fill" | `src/lib/pool-math.ts` |
| Chain-read fallback for board and coin pages | `src/lib/chain-data.ts` |

Worth knowing:

- **Quotes are simulations of the exact router call**, not the Quoter and not
  client maths, so the slippage floor is what the chain would produce. Sells
  sign the permit first, simulate with it, then send.
- **The wallet is switched to Arc before every transaction**, and asked to add
  the network if it has never seen it. Nothing did this before; most wallets
  arrive on another chain.
- **A reverted transaction is reported as a failure.** The curve flow reported
  any mined transaction as success.
- **Graduation no longer disables trading** — in a pool it is a price level.
- **The trade fee is inside the amount sent, not on top.** The curve panel
  overstated every buy by 1%.
- **Oversized trades are blocked in the panel** ("Too large for the pool")
  before a wallet prompt, matching the router's refusal.
- **`/api/dex/*` serves curve coins only.** Its reserve maths is the curve's
  and would publish false depth for a pool; pool coins are indexed as ordinary
  v4 pools (docs §Indexing).
- Gas figures in the UI are measured on the fork (buy 138,866, sell 166,960,
  launch with first buy 1,594,140) but priced at testnet's ~24 gwei. Adjust
  once mainnet shows its gas price.

### 5.1 Rehearsing on a fork

How to re-run the whole rehearsal after any change.

Fork **Arc**, not Ethereum. Ethereum was the fork target only while Arc
mainnet was closed and Ethereum was the one chain with v4 deployed. Now that
Arc is open, forking it exercises the PoolManager the contracts will actually
meet, at the state they will actually meet it in.

```bash
anvil --fork-url https://rpc.mainnet.arc.io --port 8545
# anvil keeps the forked chain's id, so this fork answers 5042, not 31337.
cast rpc anvil_setBalance <deployer> 0x56BC75E2D63100000 --rpc-url http://127.0.0.1:8545
cd contracts && POOL_MANAGER=0x8366a39cc670b4001a1121b8f6a443a643e40951 \
  forge script script/DeployPool.s.sol --tc DeployPool \
  --rpc-url http://127.0.0.1:8545 --broadcast --slow

NEXT_PUBLIC_AROMA_NETWORK=local NEXT_PUBLIC_LOCAL_CHAIN_ID=5042 \
NEXT_PUBLIC_LOCAL_POOL_FACTORY=<factory> NEXT_PUBLIC_LOCAL_POOL_VAULT=<vault> \
NEXT_PUBLIC_LOCAL_AROMA_ROUTER=<router> NEXT_PUBLIC_LOCAL_DEPLOY_BLOCK=<block> \
SUBGRAPH_URL= npm run build && npx next start -p 3012
```

`NEXT_PUBLIC_LOCAL_CHAIN_ID=5042` is not optional — `chain.ts` checks the
endpoint's chain id against the build's before reading anything, and a fork of
Arc is 5042 where local mode defaults to anvil's 31337.

**Test `next start`, not `next dev`.** Under `next dev` the HMR socket drops
repeatedly in headless Chromium and the client never issues its board query, so
the board sits on "Reading the chain…" forever. That is a dev-server artifact,
not a bug, and it looks exactly like a real one. `next start` is also what
Railway runs.

Then drive a real buy through the UI:

```bash
BASE=http://127.0.0.1:3012 ARC_RPC=http://127.0.0.1:8545 CHAIN_ID_HEX=0x13b2 \
COIN_NAME=<name> COIN_TICKER=<TICKER> BUY_USDC=2 \
DEPLOYER_PRIVATE_KEY=<a funded anvil key> node scripts/trade-check.mjs
```

Results from 2026-09-15, against an Ethereum fork: `pool-trade.ts` driven
directly — launch, buy, permit sell, claim, the cap, a mined revert — 22/22,
with tokens and USDC received equal to the simulated quote to the wei and
pool-math previews within 0.00000%. The site itself in a browser with a wallet
starting on chain 1 — launch through the form, auto-switch, buy, sell,
oversized buy blocked, no sideways scroll on four pages at 390px — 17/17, plus
503s from the endpoints that need an index.

Re-run on 2026-09-16 against a fork of **Arc mainnet**, which is what the
numbers below describe:

| | |
|---|---|
| Deploy | hook flags 8396 = required 8396; all wiring true; ownership nominated |
| Launch + dev buy | 1,593,996 gas |
| Buy | 137,849 gas |
| Sell | 139,246 gas |
| Bytecode | all three contracts byte-identical to a fresh build |
| Fee split | $0.611855 creator / $0.262224 protocol = exactly 70/30, USDC only |
| Pricing | $50 dev buy filled at $4.403e-6 against a $4.3126e-6 opening; each later buy higher |
| Board, no indexer | 6 launches read straight from the chain; raised = dev buy less the 1% fee ($120 -> $118.80) |
| Browser buy | click -> signed tx -> $2.00 spent, toast "Bought 436K MDNT for $2.00", trade in the table |

The vault holds 90,286,731,106 wei of the launched token afterwards —
0.000000090 of one token. That is the rounding dust `derive_pool.py` reports,
not a fee; fees are USDC and only USDC.

## 6. Smoke test, in this order

Do all of it with a real but small dev-buy before announcing anything, and
only after §1.2 has passed.

1. **Launch a throwaway coin** with a ~$5 dev-buy. Confirm one transaction
   creates the token, the pool, both positions, and delivers tokens to the
   creator.
2. **Check it is single-sided**: the pool holds ~1,000,000,000 tokens and
   **zero USDC** beyond your dev-buy.
3. **Check the opening tick is exactly 123,546.** `PoolVault` asserts this,
   so a wrong value reverts rather than mispricing — but confirm it landed.
4. **Buy and sell from a second wallet.** Confirm the price moves *down* in
   tick terms as the token appreciates.
5. **Confirm fees are USDC only.** After a sell, `PoolVault`'s native balance
   grows and its balance of the launched token does **not**. This is the
   whole reason the system is on v4.
6. **Claim creator fees** to a wallet you control.
7. **Confirm the subgraph indexed all of it** — token, trades, candles,
   balances, `venue: "pool"`.
8. **Check the screeners.** DexScreener and GeckoTerminal should pick the
   pool up without being asked. RadarDex is the open question from §0.2.
9. **Only then** apply for RadarDex's metadata/badge integration: they want
   factory address, a public token API, and a square logo.

---

## 7. If it goes wrong

**Nothing about a launched coin can be undone.** Liquidity is locked by
construction and `PoolVault` has no withdraw path — that is the product, and
it applies to your test coins too.

What you *can* do:

- **Stop new launches** by pointing the frontend away from `PoolFactory`.
  There is no pause switch on the contracts, deliberately.
- **Roll back the app** to the previous image; the curve system on testnet is
  untouched throughout.
- **Point `SUBGRAPH_URL` back** at the curve subgraph.

There is no path that recovers funds from a bad launch. Hence §0.5 and the
small dev-buy in §6.

---

## Known gaps at launch

Accepted, but say them out loud rather than discovering them:

- **No snipe protection.** A launch is snipeable in its first block. The
  same-transaction dev-buy is the only thing protecting a creator, and it
  only protects the creator.
- **Exact-output sells revert.** "Give me exactly N USDC for however many
  tokens that takes" is refused rather than approximated, by both the hook
  and the router. Some aggregator routes will fail against the pool.
- **`AromaRouter` is ours, not Uniswap's.** Aggregators route through
  their own contracts and are unaffected, but anything that expects a
  Universal Router on Arc will not find one.
- **A router trade that cannot fill completely reverts.** A buy past the
  top of the pool's liquidity (~$69k in from launch) or a sell of more than
  ever left the pool is refused with "insufficient liquidity" rather than
  partly filled. Before this check a 500,000 USDC buy on a fork settled
  ~$69k and left 425,992 USDC in the router with no way out. Third-party
  routers that allow partial fills still pay the hook's fee on the amount
  *specified*, not the amount filled.
- **`Swap.sender` is the router, not the trader**, so the subgraph credits
  `transaction.from`. Correct for EOAs, wrong for smart-contract wallets and
  bundlers.
- **The contracts are unaudited.**
- **Nothing has ever run on Arc.** The tests fork Ethereum mainnet, which is
  exact for the mechanics — the only thing that matters about currency0 is
  that it is the chain's 18-decimal native asset — but it is not Arc.
