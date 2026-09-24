# Clubs on Robinhood Chain

> **Superseded.** This spec settled clubs on Robinhood in native ETH and let
> anyone launch one. What was built instead settles in **USDG** and launches
> a club only by winning the 24-hour **Club auction**: see
> [CLUB.md](CLUB.md) for the runbook and `contracts/src/club/*Usdg.sol` for
> the contracts. Kept for the reasoning; where the two disagree, CLUB.md and
> the code are current.

A second chain for club coins. Normal Aroma coins stay Arc-only — this is
scoped to clubs, and only clubs, the same way clubs itself stayed scoped to a
mode of the launchpad rather than a change to it. See [CLUBS.md](CLUBS.md) for
everything about club coins that doesn't depend on which chain they're on;
this document only covers what's different for one deployed on Robinhood
Chain instead of Arc.

**Status:** spec stage. Nothing here is built. This settles the decisions that
have to be made before any contract or frontend work starts, the way
[CLUBS.md](CLUBS.md) settled its open questions before `ClubVault.sol` was
written. See [Open](#open) for what's still unresolved and
[Before this is built](#before-this-is-built) for the order to do it in.

---

## Why not just point the existing contracts at a new RPC

Arc's whole design leans on one fact: **USDC is Arc's native gas token.**
`ClubVault.sol` encodes that literally —
`Currency public constant USDC = Currency.wrap(address(0))`, v4's own name for
"this pool's currency0 is whatever token is native to the chain it's
deployed on." That works on Arc because native-there is USDC. It is not a
config value; it's the reason a buy is one transaction with no approval, and
the reason a coin's market cap is already a dollar figure with no oracle.

Robinhood Chain's native gas token is **ETH**, not a stablecoin. That single
fact is the entire scope of this document — everything below is either a
direct consequence of it or a decision it forces.

---

## What's true about Robinhood Chain

Confirmed from Robinhood's own docs (`docs.robinhood.com/chain`):

| | Mainnet | Testnet |
| --- | --- | --- |
| Chain ID | 4663 | 46630 |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Sequencer feed (WS) | `wss://feed.mainnet.chain.robinhood.com` | `wss://feed.testnet.chain.robinhood.com` |
| Explorer | `robinhoodchain.blockscout.com` | `explorer.testnet.chain.robinhood.com` |
| Native currency | ETH, 18 decimals | ETH, 18 decimals |
| Went live | 2026-07-01 | 2026-02-10 |

It's an Arbitrum Orbit chain (Robinhood's docs say "Arbitrum Dedicated
Blockchains"), EVM-compatible, first-come-first-served sequencing (no MEV
reordering), Alchemy as the recommended RPC provider alongside the public
endpoint. Uniswap is listed as its public DEX.

**Confirmed by direct check, not by search result:**

- **Uniswap v4's `PoolManager` is live on Robinhood Chain mainnet at
  `0x8366a39cc670b4001a1121b8f6a443a643e40951`** — the same address as on Arc.
  Checked with `eth_getCode` against both chains' public RPCs directly
  (`rpc.mainnet.chain.robinhood.com` and `rpc.mainnet.arc.io`): the runtime
  bytecode is **byte-for-byte identical**, 48,031 bytes on each. That's the
  address `POOL_CONTRACTS.poolManager` already points at for Arc today, which
  this project already trusts — so an identical bytecode match transitively
  confirms Robinhood Chain's copy is the same contract, not a coincidence of
  a shared address (expected, since v4 deploys via CREATE2 with a fixed salt
  and lands on the same address on every chain it's run on). This is the same
  kind of check `verify-bytecode.mjs` does, just against a live reference
  instead of a fresh Foundry build. Worth re-running the same check against a
  fresh build directly, the way `verify-bytecode.mjs` does for Arc, before
  any deploy ships — this confirms it's *the same* contract as Arc's, not
  that Arc's own copy is what its source claims.
- **Whether Robinhood's settlement stablecoin (reportedly USDG, not USDC) has
  any bearing here.** It doesn't, given the decision below — noted only so
  nobody rediscovers it mid-implementation and wonders whether Aroma should
  be quoting in USDG instead. It was considered and set aside; see next
  section.
- **Blockscout's verification API shape.** Likely Etherscan-compatible (most
  Blockscout instances offer this), but `contracts/foundry.toml`'s
  `[etherscan]` section for Arc testnet is itself marked unconfirmed, so this
  needs its own check rather than assuming it matches Arc's eventual answer.

---

## Decision: quote in native ETH, not USDG

Two ways to give a Robinhood Chain club coin a dollar-shaped quote asset:

1. **Native ETH** (`Currency.wrap(address(0))`, same as Arc). Mechanically
   identical to the existing contracts — same pool geometry, same
   `msg.value` buy, same hook fee-taking logic. Prices float in ETH, which
   means a coin's dollar-denominated market cap moves when ETH moves, on top
   of whatever the coin itself does.
2. **USDG as an ERC-20 quote.** Keeps the "price is a dollar" pitch that Arc
   coins get for free. Costs the thing Arc's native-USDC design exists to
   avoid: an ERC-20 quote asset needs an approval before a v4 pool can pull
   it, so a buy becomes two transactions (or one, if USDG supports EIP-2612
   permits — unconfirmed) instead of one `msg.value` call. It also means a
   different hook: `PoolVault`/`ClubVault`'s fee-taking (`poolManager.take` on
   `currency0`) doesn't care whether currency0 is native or ERC-20, but the
   buy-side router does, and `AromaRouter`/`ClubRouter`'s native-value path
   would need an ERC-20 variant beside it, not instead of it, since Arc still
   needs the native path.

**Decided: native ETH.** It reuses the contracts, the router, and the pool
math as they exist today — the only chain-specific number that has to change
is the anti-dust join floor (next section). The tradeoff is real and worth
saying plainly: **a Robinhood Chain club coin's dollar value will move with
ETH's price**, independent of anything happening in the coin's own pool. That
contradicts the pitch Arc coins get ("a coin up 40% means the coin moved, not
the quote asset") — it just doesn't contradict it badly enough to justify a
second router and an approval step for a clubs-only feature. If normal coins
ever come to Robinhood Chain, this trade-off is worth reopening; USDG-as-quote
is the option to pick up again if that happens.

---

## What has to change in the contracts

**Not a new contract design.** `ClubVault.sol`, `ClubFactory.sol` and
`ClubRouter.sol` are deployed as-is, chain by chain, the same way
`DeployClub.s.sol` already deploys them beside the pool system rather than
inside it. The pool geometry (ticks, liquidity, the 1.5%/tree fee split) is
identical on both chains — none of it references USDC specifically, all of
it references currency0, whatever currency0 is.

**One real bug if deployed unchanged: the dollar-denominated constants.**

| Constant | Where | Current value | What it means on Arc | What it would mean on Robinhood Chain, unchanged |
| --- | --- | --- | --- | --- |
| `MIN_JOIN_USDC` | `ClubVault.sol:108` | `1e18` | $1 floor on a join buy, so a seat can't be burned for nothing | **1 ETH** floor — several thousand dollars, making every invite link impossible to redeem |
| `MAX_DEV_BUY_USDC` | `ClubFactory.sol:29` | `2_000e18` | $2,000 cap on a creator's opening dev buy | **2,000 ETH** cap — no cap at all in practice |

Both are `constant`, baked into bytecode at compile time — not something
`DeployClub.s.sol`'s existing `POOL_MANAGER` env var pattern can fix, because
that script only supplies deploy-time *addresses*, not economic constants.
The fix is to make both **`immutable`, set in the constructor**, the same
shape as `poolManager` already is. `DeployClub.s.sol` would read them from
new env vars (`MIN_JOIN_WEI`, `MAX_DEV_BUY_WEI` or similar) the same way it
reads `POOL_MANAGER` today, defaulting to today's values so an Arc redeploy
is unaffected. This is a small, scoped contract change — it doesn't touch
pool geometry or the hook flags DeployClub mines for, so a redeploy on Arc
with the same inputs produces the same behavior, just via a constructor arg
instead of a compile-time constant.

**What the ETH-denominated values should actually be is an open question** —
see [Open](#open). A round wei amount chosen once will drift in dollar terms
as ETH's price moves, same as the ETH-quoting decision above; that's accepted,
not a bug to solve.

**Naming, while the file is open anyway.** `USDC`, `usdc`, `protocolUsdc`,
error strings like `"USDC transfer failed"` — all cosmetic, all currently
correct on Arc only because Arc's native currency happens to be USDC. None of
it is part of the ABI's function selectors (parameter names don't affect
encoding), so it's not a compatibility concern, but a contract literally
named `USDC` that holds ETH on Robinhood Chain's explorer is the kind of
thing that misleads anyone reading it who isn't in on the joke. Worth a
rename to something currency-neutral (`NATIVE`, `quoteToken`, whatever reads
best) in the same change that makes the two constants immutable, not as a
separate pass.

---

## What has to change in deploy tooling

- **`contracts/foundry.toml`** needs `robinhood_mainnet` and
  `robinhood_testnet` entries under `[rpc_endpoints]`, matching the existing
  `arc_mainnet`/`arc_testnet` pattern — env-var-backed, not hardcoded, same
  reasoning as the comment already there about Arc mainnet's RPC not being
  publishable. Robinhood Chain's *is* public
  (`rpc.mainnet.chain.robinhood.com`), so the default can actually be filled
  in here rather than left as a bare `${VAR}` — still worth allowing an
  override for an Alchemy key, since the public endpoint carries no SLA.
- **`[etherscan]`** needs a Blockscout entry once its verification API is
  confirmed compatible (see [Open](#open)).
- **`DeployClub.s.sol` needs no structural change** beyond taking the two new
  constructor args above — it already takes `POOL_MANAGER` from the
  environment and mines a fresh hook-permission salt at deploy time, which is
  exactly the "verify what's actually going to be on-chain" work a second
  deployment needs anyway. The mined vault address will differ from Arc's;
  that's expected, not a bug to chase.
- **Rehearse on Robinhood Chain testnet (46630) first**, the same way the
  pool system was proven on Arc testnet before Arc mainnet existed. Unlike
  Arc testnet — which has no Uniswap deployment at all, forcing the pool
  system's rehearsal onto an Ethereum-mainnet fork instead — Robinhood Chain
  testnet is a real Orbit deployment, so if Uniswap v4 is genuinely live on
  Robinhood mainnet it's worth checking whether it's live on testnet too. If
  it isn't, the existing local-Ethereum-fork rehearsal path
  (`NEXT_PUBLIC_AROMA_NETWORK=local` in `src/lib/arc.ts`) covers Robinhood
  Chain's contracts exactly as well as it covers Arc's, since both just need
  "native currency, 18 decimals, v4 deployed" — which is all that pattern
  was ever asserting.

---

## What has to change in the frontend

This is the part of the codebase least prepared for this. `src/lib/arc.ts`
and `src/lib/chain.ts` are built, deliberately, around **one chain, defined
once** — `NETWORK`, `POOL_CONTRACTS`, `activeChain`, `assertChainMatches` are
all singular globals, and `chain.ts` says so explicitly in its own comment.
Clubs being chain-selectable means:

- **`CLUB_CONTRACTS` becomes keyed by chain ID**, not a flat object —
  `{ [5042]: {...}, [4663]: {...} }` — with `clubsDeployed` becoming
  per-chain too. `ARC_MAINNET_CLUB_CONTRACTS` stays exactly as it is for Arc;
  a sibling `ROBINHOOD_MAINNET_CLUB_CONTRACTS` is added beside it, empty
  until deployed, same convention.
- **wagmi/AppKit needs a second chain configured**, not just the one
  `activeChain`. Today's `chain.ts` assumes a visitor is always switched onto
  the one chain the app talks to before signing anything (per the README);
  a club-coin page for a Robinhood Chain coin needs to prompt a switch to
  *that* chain specifically, while every normal-coin page keeps targeting
  Arc only. This is a chain-switcher UI problem as much as a config one —
  today there is nothing to switch between.
- **`assertChainMatches` needs to run per-chain.** Its entire reason to
  exist — an RPC for the wrong chain succeeds and returns nothing, rendering
  a working, empty launchpad instead of failing loud — applies exactly as
  much to a Robinhood Chain RPC silently pointed at the wrong network. Two
  chains means two cached assertions, not one.
- **The RPC-fallback convention (comma-separated, two providers) applies to
  Robinhood Chain too** — `NEXT_PUBLIC_ARC_RPC_URL` gets a
  `NEXT_PUBLIC_ROBINHOOD_RPC_URL` sibling, same reasoning: a public endpoint
  with no SLA is exactly the case this convention exists for.
- **`src/lib/chain-data.ts`, `club-trade.ts`, `use-club.ts`** all currently
  read `CLUB_CONTRACTS` and `NETWORK` as flat singular values. Each read
  needs to know *which* chain the coin it's looking at lives on — probably
  a `chainId` field carried alongside a club coin's address wherever the
  frontend has one, and threaded through to whichever `publicClient` matches.
- **The board and coin pages need to show which chain a club coin is on.**
  Same instinct as the existing club badge — a visitor should never be
  surprised by which network a buy button is about to ask them to sign on.

None of this touches normal-coin code paths, by scope, but it does mean the
"one chain, defined once" architecture that `chain.ts` currently documents
as a feature has to become "one chain for normal coins, a chain per club
coin" — worth being honest that this is the larger half of the engineering
work here, bigger than the contract change above.

---

## What has to change in indexing

Clubs aren't indexed on Arc yet at all — CLUBS.md's own
[Before clubs go live](CLUBS.md#before-clubs-go-live) already lists "the
production subgraph does not index the club factory" as the blocker before
*any* club coin can appear on the board. Robinhood Chain inherits that same
prerequisite, plus its own:

- **Goldsky needs to support Robinhood Chain as a network** for a subgraph
  manifest to target it — `subgraph.pool.yaml`'s own comments note that The
  Graph's network slug for Arc is `arc`, distinct from `arc-mainnet`; whatever
  Robinhood Chain's equivalent slug is has to be confirmed before a manifest
  can be written, the same way `arc-mainnet` was confirmed rather than
  guessed.
- **This should be built once, for both chains, not twice.** Since Arc's
  club indexing doesn't exist yet either, the schema and mapping logic
  (`subgraph/src/club.ts` or wherever it lands) should be written
  chain-agnostically from the start — a manifest per chain, same schema and
  mappings, the same relationship `subgraph.pool.yaml` already has to a
  hypothetical `subgraph.club.yaml`. Building Arc's club indexing first and
  retrofitting Robinhood Chain later would mean redoing the schema design
  work twice.
- **The no-indexer fallback path matters more here than it does for Arc.** A
  brand-new chain's subgraph will lag behind by definition while it's being
  built and rehearsed; `src/lib/chain-data.ts`'s direct-chain-read path is
  what a Robinhood Chain club coin runs on until that catches up, same as it
  is today for anyone running without `SUBGRAPH_URL` set at all.

---

## Open

- **What the ETH-denominated join floor and dev-buy cap should be.** Not a
  technical question — a product one, same shape as CLUBS.md's own "creator
  seats" decision. A fixed wei amount is simplest and matches how the Arc
  constants work today (fixed at deploy time, not oracle-fed), but will read
  as an odd, drifting dollar amount as ETH's price moves. Whether that's
  worth an oracle-based floor instead is worth deciding before, not after,
  `DeployClub.s.sol` grows the constructor args to support it.
- **Goldsky's Robinhood Chain support and network slug.** Blocks indexing
  specifically; doesn't block contracts or the frontend chain-switcher work,
  which can proceed on the no-indexer path.
- **Blockscout's verification API shape**, for `[etherscan]` in
  `foundry.toml`.
- **Where a Robinhood Chain club coin sits on the board relative to Arc
  coins.** CLUBS.md already deferred the equivalent question for club coins
  generally; this adds "which chain" as a second axis to whatever answer
  that question eventually gets.

## Before this is built

1. ~~Verify Uniswap v4's `PoolManager` is actually live on Robinhood Chain.~~
   Done — confirmed live on mainnet at the same address as Arc, bytecode
   byte-for-byte identical (see above). Still worth checking testnet (46630)
   before rehearsing step 5 there, since mainnet being live doesn't guarantee
   testnet is.
2. Settle the join-floor and dev-buy-cap values (previous section).
3. Make `MIN_JOIN_USDC` and `MAX_DEV_BUY_USDC` constructor args instead of
   constants, defaulting to today's values, so an Arc redeploy is
   unaffected.
4. Add `robinhood_mainnet` / `robinhood_testnet` to `foundry.toml`.
5. Rehearse the whole flow on Robinhood Chain testnet, the same battery
   CLUBS.md ran on an Arc mainnet fork — `club-trade-check.ts` and
   `club-check.mjs` should both run unchanged against it, since neither
   script assumes anything USDC-specific beyond the currency being native.
6. Build club indexing — chain-agnostically — resolving Arc's own
   outstanding blocker at the same time.
7. Generalize `CLUB_CONTRACTS`/`clubsDeployed` to be chain-keyed, and build
   the chain-switcher UI. This is the largest single piece of work in this
   document.
8. Deploy to Robinhood Chain mainnet, verify bytecode, accept ownership,
   fill in `ROBINHOOD_MAINNET_CLUB_CONTRACTS` — the same three-step turn-on
   sequence CLUBS.md ends with for Arc.
