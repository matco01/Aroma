# Launching the pool system on Arc mainnet

Runbook for 16 September 2026, when Arc mainnet opens publicly.

This covers the **pool system** (`contracts/src/pool/`) — launches that go
straight into a Uniswap v4 pool. The curve system is unaffected and stays on
testnet; see [DEPLOY.md](DEPLOY.md) for the app itself.

Read the whole thing before starting. Several steps can't be undone.

---

## 0. Before the day

Everything here is blocking. None of it can be done on the 16th.

### 0.1 Arc mainnet access — **hard blocker**

`rpc.mainnet.arc.io` returns **403** today; the testnet endpoint returns 200.
Circle's own node software (`circlefin/arc-node`) ships no mainnet chain
config, and QuickNode and dRPC carry testnet only. The network is live — Arc
mainnet is chain **5042** and Uniswap, RadarDex and others are deployed on it
— but access is gated.

Ask in Discord: **https://discord.com/invite/buildonarc**

Get an endpoint **days early, not on the 16th.** Launch day should be when
users arrive, not when you discover whether the hook settles correctly on
Arc. Set `ARC_MAINNET_RPC_URL` in `contracts/.env`.

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

### 0.4 Decide: replace the curve, or run both

The subgraph writes identical entities for both venues, so the board, the API
and the DEX Screener adapter work either way. Running both means the trade
panel branches on `Token.venue`; replacing means it does not. **Running both
is the smaller change and the safer launch** — the curve keeps working while
the pool path proves itself.

### 0.5 Get the contracts reviewed

`PoolVault` is unaudited, runs on every swap as the pool's hook, and holds
liquidity that can never be withdrawn. The locked liquidity is intended and
is not the risk; the pool's principal is protected by Uniswap's audited
accounting, and a bug in the mint/settle path fails closed. **The exposed
surface is the hook's fee accounting** — `beforeSwap`/`afterSwap`, roughly
120 lines — because fees can be withdrawn. Get at least that reviewed.

### 0.6 Frontend — see §5. It is the long pole.

---

## 1. Deploy the contracts

```bash
cd contracts
# .env needs: DEPLOYER_PRIVATE_KEY, PROTOCOL_OWNER, POOL_MANAGER,
#             ARC_MAINNET_RPC_URL
forge test                      # 84 tests must pass
python script/math/derive_pool.py   # must exit 0
```

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

### 1.2 Verify on Arcscan

`contracts/foundry.toml` notes that Arcscan's verification API is unconfirmed
and may not be Etherscan-compatible. Check against Arcscan's own docs rather
than assuming `forge verify-contract` works.

---

## 2. Wire the addresses in

### 2.1 `src/lib/arc.ts`

Add an `ARC_MAINNET` chain entry (id **5042**) and an
`ARC_MAINNET_CONTRACTS` block with `poolVault`, `poolFactory`, `aromaRouter`,
`poolManager` and `deployBlock`. Contract addresses are deliberately code,
not environment variables — see [DEPLOY.md](DEPLOY.md) for why.

`src/lib/wagmi.ts` needs the mainnet chain too; it currently hardcodes the
testnet RPC.

### 2.2 `src/lib/abis.ts`

Add `PoolFactory`, `PoolVault` and `AromaRouter` to the `WANT` list in
`scripts/gen-abis.py`, then:

```bash
cd contracts && forge build && cd .. && npm run abis
```

Minimum names: `createToken`, `TokenCreated`, `MAX_DEV_BUY_USDC`,
`claimCreatorFees`, `launches`, `poolKey`, `TICK_GRADUATION`, `creatorOf`,
and the router's `buy` and `sell`.

### 2.3 `subgraph/subgraph.pool.yaml`

Three `FIXME`s: `PoolFactory` address, `PoolVault` address, and `startBlock`
on all three data sources.

**`startBlock` matters more than usual.** v4 is a singleton, so `handleSwap`
is called for *every swap in every v4 pool on Arc*. Left at 0 it will replay
the entire chain's v4 history before reaching anything of yours. Set it to
the deployment block.

---

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
| `SUBGRAPH_URL` | the new pool subgraph, once synced |
| `NEXT_PUBLIC_ARC_RPC_URL` | Arc **mainnet**, two endpoints for failover |
| `NEXT_PUBLIC_REOWN_PROJECT_ID` | unchanged |
| `PINATA_JWT`, `NEXT_PUBLIC_PINATA_GATEWAY` | unchanged |

The three `NEXT_PUBLIC_*` ones must be set as **build args** as well, or the
browser bundle ships whatever was baked in at image build.

---

## 5. The frontend

**This is the largest remaining piece and none of it is done.** 26 files
reference the curve. The ones that must change:

### 5.1 The trade path — `src/lib/use-trade.ts`

Smaller than it looks, because `AromaRouter` was written to mirror
`CurveManager`'s call shapes.

- **Buys**: `CurveManager.buy(token, recipient, minTokensOut)` becomes
  `AromaRouter.buy{value}(token, minTokensOut)`. Native USDC in, so still no
  approval.
- **Sells**: `AromaRouter.sell(token, tokenAmount, minUsdcOut,
  permitDeadline, v, r, s)` — **the same signature CurveManager.sell has.**
  The existing EIP-2612 flow (read `nonces`, `signTypedData`, submit) is
  unchanged apart from the spender address. No Permit2, no second approval
  system, still one signed transaction.
- **Quotes** are the only real change. `quoteBuy`/`quoteSell` are view calls
  on CurveManager; the pool equivalent is Uniswap's v4 Quoter
  (`0x8dc178ef…`), which is a *simulated* call — quote with `eth_call`, not
  `useReadContract`, and expect it to revert-and-return rather than behave
  like a view.

### 5.2 Launching — `src/components/create-form.tsx`

`AromaFactory.createToken(name, symbol, description, uri, devBuyUsdc,
minDevTokensOut, guard)` becomes `PoolFactory.createToken(name, symbol,
description, uri, devBuyUsdc, minTokensOut)`. The `LaunchGuard` struct is
gone — there is no snipe protection on the pool path. Remove those inputs or
hide them for pool launches.

The dev-buy still exists and is still capped at `MAX_DEV_BUY_USDC`, so that
part of the form is unchanged.

### 5.3 Creator fees — `use-creator-fees.ts`, `use-creator-fees-batch.ts`

`CurveManager.creatorFeesAccrued(token)` becomes
`PoolVault.launches(token).creatorUsdc`. Claiming is
`PoolVault.claimCreatorFees(token)`, which pays **native USDC** rather than
transferring — the receiving wallet must accept a plain value transfer.

### 5.4 Reads that assume curve state

`board.ts`, `coin-view.tsx`, `trade-panel.tsx`, `coin-card.tsx`,
`portfolio-view.tsx`, `chain-data.ts` all read `reserve`/`tokensSold`/
`progressBps`. The subgraph populates those for pool tokens too, so
**anything reading from the subgraph keeps working**. Only the paths that
call the chain directly need changing.

### 5.5 `src/lib/server/dex-adapter.ts`

Its own header says it covers "exactly the window nothing else can see" and
stops at graduation. For pool tokens that window does not exist — they are
indexed from block zero. Decide whether it serves both venues or curve
tokens only, and say so in the header.

### 5.6 Copy

`docs-view.tsx`, `terms/page.tsx`, `llms.txt`, `structured-data.tsx` and
`site-footer.tsx` all describe a bonding curve and a graduation event. Pool
coins have neither in the same sense — the curve is the pool, and graduation
is a price level rather than an event.

---

## 6. Smoke test, in this order

Do all of it with a real but small dev-buy before announcing anything.

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
- **`Swap.sender` is the router, not the trader**, so the subgraph credits
  `transaction.from`. Correct for EOAs, wrong for smart-contract wallets and
  bundlers.
- **The contracts are unaudited.**
- **Nothing has ever run on Arc.** The tests fork Ethereum mainnet, which is
  exact for the mechanics — the only thing that matters about currency0 is
  that it is the chain's 18-decimal native asset — but it is not Arc.
