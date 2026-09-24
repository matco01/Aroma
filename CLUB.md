# Launching the Club auction on Robinhood Chain

Runbook for going live with the Club: a 24-hour auction gating every launch,
settled in USDG, on Robinhood Chain. Supersedes [LAUNCH.md](LAUNCH.md) —
that runbook was written for an Arc mainnet launch that never happened once
the target chain changed. Arc's curve and pool systems are untouched and
still described there; this covers only what replaced them as the live
product.

Read the whole thing before starting. Several steps can't be undone, and two
of the facts below are marked **UNVERIFIED** for a reason — confirm them
before broadcasting anything real, the same discipline LAUNCH.md applied to
Arc's own PoolManager address.

---

## 0. Before the day

### 0.1 Confirm the PoolManager address — **UNVERIFIED, hard blocker**

`0x8366a39cc670b4001a1121b8f6a443a643e40951` surfaced repeatedly during
research as Uniswap v4's PoolManager on Robinhood Chain (chain id 4663) —
but it is *byte-for-byte* the same address this codebase already used for
Arc, which is either a real canonical cross-chain deployment or a
research-tool echo that couldn't be independently confirmed against a block
explorer. `DeployPoolUsdg.s.sol`'s own `require(poolManager.code.length > 0)`
will refuse to deploy against an address with no code at all — it cannot
confirm the code *is* PoolManager.

Confirm it properly: check Uniswap's own deployments registry
(`developers.uniswap.org/docs/protocols/v4/deployments`) against a source you
trust, or verify the contract on `robinhoodchain.blockscout.com` yourself.

### 0.2 Confirm USDG's address on testnet — **UNVERIFIED**

`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` is confirmed on Robinhood Chain
**mainnet** (Robinhood's own `docs.robinhood.com/chain/contracts/`, cross-checked
twice). `src/lib/robinhood.ts`'s `ROBINHOOD_TESTNET_CONTRACTS.usdg` carries the
same value over to testnet *unverified* — check it independently (e.g.
`usdg.symbol()` against a real testnet RPC) before trusting a testnet balance
this app shows, or a testnet bid this app sends.

### 0.3 Decide the economics

`ClubAuction`'s round duration, minimum opening bid, minimum bid increment
and anti-snipe extension are constructor arguments, not contract constants —
see `ClubAuction.sol`'s NatSpec for why (no owner-tunable economics after
deploy, matching the project's existing philosophy). The values wired into
`src/lib/robinhood.ts`'s `CLUB` object (24h, 100 USDG, 5%, 5 minutes) are
placeholders, not derived from anything. Decide the real ones before running
`DeployClub.s.sol`, and keep `CLUB` in sync afterward — a mismatch there is a
UI showing the wrong minimum, not a contract accepting the wrong bid, but
it's still worth getting right.

### 0.4 Decide the treasury address

`DeployClub.s.sol` takes `CLUB_TREASURY` from the environment with no
default. This is where every winning bid goes, permanently — get the address
right before the first round ever finalizes.

### 0.5 Get the contracts reviewed

None of `PoolVaultUsdg`, `PoolFactoryUsdg`, `AromaRouterUsdg` or `ClubAuction`
have been audited. The same surface LAUNCH.md flagged for the native pool
system applies again here — `PoolVaultUsdg`'s hook fee accounting
(`beforeSwap`/`afterSwap`) — plus `ClubAuction`'s own escrow accounting
(`bid`/`withdraw`/`finalize`), which holds real USDG for up to 24 hours at a
time. Get at least those reviewed.

### 0.6 Confirm the finalize bot's hosting

`scripts/finalize-club.mjs` is load-bearing in a way nothing in the native
pool system was: if it's down when a round's countdown ends, *nothing
launches* until it's back — there's no permissionless fallback, by design
(see the script's own header). Decide where it runs and how its
`FINALIZE_PRIVATE_KEY` is held before the first real round opens, not after.

---

## 1. Deploy the contracts

```bash
cd contracts
# .env needs: DEPLOYER_PRIVATE_KEY, PROTOCOL_OWNER, POOL_MANAGER,
#             USDG_ADDRESS, CLUB_TREASURY
forge test                              # existing suites must pass
python script/math/derive_pool_usdg.py  # must exit 0
```

Two deploys, in order:

```bash
forge script script/DeployPoolUsdg.s.sol --tc DeployPoolUsdg --rpc-url robinhood_testnet
# then, once addresses are recorded (see §2):
forge script script/DeployClub.s.sol --tc DeployClub --rpc-url robinhood_testnet
```

Dry-run first (drop `--broadcast`), same as `DeployPool.s.sol` — both scripts
follow that one's shape exactly: `DeployPoolUsdg` mines a CREATE2 salt for
`PoolVaultUsdg`'s hook permission bits the same way, and `--tc` is required
for the same reason (a small CREATE2 factory shares the file).

**Record from `DeployPoolUsdg`'s output**: `PoolVaultUsdg`, `PoolFactoryUsdg`,
`AromaRouterUsdg` addresses, the deployment block, and confirm `hook flags`
equal `required flags` (must be **8396**, identical to Arc's pool system —
`PoolVaultUsdg` implements the exact same hook callbacks).

**Record from `DeployClub`'s output**: the `ClubAuction` address, and the
first Club's id/deadline it prints on construction.

### 1.1 Accept ownership

Both `PoolVaultUsdg` and `ClubAuction` use `Ownable2Step`, so the deploy
script only *nominates* `PROTOCOL_OWNER`. From that wallet:

```bash
cast send <PoolVaultUsdg> "acceptOwnership()" --rpc-url robinhood_testnet
cast send <ClubAuction> "acceptOwnership()" --rpc-url robinhood_testnet
```

Until this lands, the deploy key controls fee withdrawal on the vault and
`finalize()` on the auction.

---

## 2. Wire the addresses in

### 2.1 `src/lib/robinhood.ts`

Fill in `ROBINHOOD_TESTNET_CONTRACTS` (or `ROBINHOOD_MAINNET_CONTRACTS`) with
every address from §1 — they're placeholder zero addresses until then, each
commented `// FIXME`. Update `deployBlock` to the block `PoolVaultUsdg`
deployed in. Update `CLUB` if §0.3's real economics differ from the
placeholders.

### 2.2 `src/lib/abis.ts`

Already generated against these contracts (`npm run abis`) — re-run only if
a contract's interface changes after this point.

### 2.3 `subgraph/subgraph.robinhood.yaml`

Four `FIXME`s: the real network slug (see below), and the `PoolFactoryUsdg`/
`PoolVaultUsdg`/`ClubAuction` addresses plus their `startBlock`s — the
`PoolManager` data source's address is already filled in, carrying the same
§0.1 unverified caveat.

**The network slug is unconfirmed.** It cannot be `arc` or `arc-testnet` —
every data source in one manifest must share a network, and this is a
different chain from both. Confirm Goldsky's (or your indexer's) actual slug
for Robinhood Chain before deploying.

**`startBlock` matters more than usual**, same reason as Arc's pool manifest:
v4 is a singleton, so `handleSwap` fires for every swap in every v4 pool on
the whole chain. Left at 0 it replays the chain's entire v4 history first.

---

## 3. Deploy the subgraph

```bash
cd subgraph
npm run codegen:robinhood && npm run build:robinhood
```

Testing needs a temporary swap: `matchstick.yaml` points at
`subgraph.pool.yaml` (Arc), because Matchstick only compiles against one
manifest at a time and that's the one `pool.test.ts` needs. To run
`pool-usdg.test.ts`/`club.test.ts`, point it at `subgraph.robinhood.yaml`
instead, run `npm test`, then point it back — don't leave it swapped, or
`pool.test.ts` stops compiling.

Deploy as a **separate** subgraph, not a new version of `aroma/1.0.0` or
`aroma-pool/1.0.0` — three genuinely different networks (Arc testnet, Arc
mainnet, Robinhood Chain) cannot be one subgraph.

```bash
goldsky subgraph deploy aroma-club/1.0.0 --path .   # verify the manifest flag
```

Wait for it to sync and confirm a query returns data before pointing
anything at it.

---

## 4. Deploy the app

Per [DEPLOY.md](DEPLOY.md) for the container/infra shape. Set/confirm:

| Variable | |
|---|---|
| `SUBGRAPH_URL` | the new Club subgraph, once synced |
| `NEXT_PUBLIC_ROBINHOOD_RPC_URL` | Robinhood Chain, ideally an Alchemy-backed URL per Robinhood's own recommendation |
| `NEXT_PUBLIC_REOWN_PROJECT_ID` | unchanged |
| `PINATA_JWT`, `NEXT_PUBLIC_PINATA_GATEWAY` | unchanged |

The `NEXT_PUBLIC_*` ones must be set as **build args** too, or the browser
bundle ships whatever was baked in at image build — same caveat DEPLOY.md
already documents for Arc's RPC var.

Run `scripts/finalize-club.mjs` as a small long-lived process alongside the
app container (see §0.6) — it is not part of the Next.js app and needs its
own process.

---

## 5. Smoke test, in this order

Against **testnet only** — do not touch mainnet until every step below has
passed once.

1. **Confirm the app shows the Club.** `/club` should show a live countdown
   from the round `DeployClub` opened.
2. **Place a small real bid.** Confirm one signature (permit, no separate
   approve), confirm `topBidder`/`topBid` update within a few seconds.
3. **Outbid it from a second wallet**, confirm the first bidder's refund
   appears via `pendingReturns` and that `withdraw()` actually pays it.
4. **Edit the draft as the top bidder.** Confirm `updateDraft` doesn't touch
   the bid amount, and that the change shows up without a new bid.
5. **Bid inside the anti-snipe window** (or shorten `CLUB.roundDurationSeconds`
   for this test only) and confirm the deadline actually extends.
6. **Let the bot finalize a round with a small dev-buy.** Confirm: a real
   coin appears on the board; the *winner* — not `ClubAuction` — holds the
   dev-buy tokens; the winning bid landed in the treasury wallet, not the
   coin's pool.
7. **Buy and sell the launched coin** through the board's trade panel.
   Confirm the price moves the expected direction and the fee split matches
   §0.3/`POOL_USDG`.
8. **Call `claimCreatorFeesFor`** (anyone can call it) and confirm the
   payout reaches the winner, not the caller.
9. **Let a round close with no bids.** Confirm it voids cleanly and the next
   Club opens with a fresh id.
10. **Check the screeners.** DexScreener/GeckoTerminal should pick the
    launched pool up on their own — see the docs page's own note on why no
    custom feed is needed here, unlike the old curve.

---

## 6. If it goes wrong

**Nothing about a launched coin can be undone.** Liquidity is locked by
construction, same as Arc's pool system — that applies to test coins too.

What you *can* do:

- **Stop new rounds from mattering** by stopping the finalize bot — no
  permissionless keeper exists, so no round finalizes without it (§0.6).
  Bidding on the *current* round still works until its own deadline; nothing
  after that launches until the bot is running again.
- **Point the frontend away from ClubAuction** to take launching out of the
  live product entirely, the same way `/create` already redirects away from
  the dormant permissionless flow.
- **Point `SUBGRAPH_URL` back** at whichever subgraph was serving before.

There is no path that recovers funds from a bad launch, or from USDG sent to
the wrong address.

---

## Known gaps at launch

- **No snipe protection**, at all — not even the opt-in tax the old curve
  system offered. A launch is snipeable from its first block.
- **`PoolManager`'s address is unverified** (§0.1). Confirm it before mainnet
  use, not after.
- **USDG's testnet address is unverified** (§0.2).
- **The finalize bot is a single point of failure** for launching, by design
  (§0.6) — there is deliberately no permissionless fallback.
- **The contracts are unaudited.**
- **Nothing has run on Robinhood Chain yet.** The Foundry tests fork Ethereum
  mainnet for a real deployed `PoolManager`, which is exact for v4's
  mechanics but is not Robinhood Chain itself.
- **The `/api/dex/*` feed does not cover Club launches** — see the docs
  page's Data API section for why it doesn't need to.
