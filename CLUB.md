# Launching Aroma on Robinhood Chain

The runbook for going live on Robinhood Chain. Every coin there is an
invite-only **club** (the design is in [CLUBS.md](CLUBS.md)), settled in
USDG, and each one is founded by winning the 24-hour **Club auction**.

What runs where:

| | |
|---|---|
| `ClubAuction` | One round at a time. Bids, draft edits, refunds, `finalize`. |
| `ClubFactoryUsdg` | Deploys the winner's token and pool. Only the auction may call it; the winner is recorded as creator. |
| `ClubVaultUsdg` | The pool's hook. Locks the liquidity, gates buys on membership, splits the 1.5% fee up the invite chain. |
| `ClubRouterUsdg` | Buy, buy with an invite, sell. USDG moves by EIP-2612 permit. |
| `scripts/finalize-club.mjs` | The bot that calls `finalize` when a round ends. |

Arc is not part of this. Its contracts, subgraph and app build are untouched
and still described in [LAUNCH.md](LAUNCH.md) and [CLUBS.md](CLUBS.md); an
Arc build is `NEXT_PUBLIC_AROMA_NETWORK=arc`.

Read the whole thing before starting. Several steps can't be undone.

---

## 0. Before the day

### 0.1 Facts already confirmed

- **PoolManager** `0x8366a39cc670b4001a1121b8f6a443a643e40951` has code on both
  mainnet (4663) and testnet (46630). The deploy script still refuses an
  address with no code.
- **USDG** is `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` on **mainnet**, 6
  decimals, with EIP-2612 permit. **Testnet has no USDG.** Deploy the mock
  (§1) and put its address in `ROBINHOOD_TESTNET_CONTRACTS.usdg`.
- **USDG's permit domain version is not confirmed.** The app asks the token
  for its domain (EIP-5267) and falls back to version `"1"`. The first real
  mainnet bid is the check: if it reverts with `permit failed and no
  allowance`, the domain is wrong.

### 0.2 Decide the economics and the treasury

The auction's round length, minimum opening bid, minimum raise and
anti-snipe extension are constructor arguments, fixed at deploy. The
defaults (24h, 100 USDG, 5%, 5 minutes) are placeholders. Decide the real
values, deploy with them, and keep `AUCTION` in `src/lib/robinhood.ts` in
sync. A mismatch there shows the wrong minimum in the UI; the contract still
enforces its own.

`CLUB_TREASURY` receives every winning bid, permanently. It has no default.

The club fee split (1.5%: 0.3% protocol, 0.1% creator, 1.1% up the invite
chain) and the seat counts are contract constants, identical to Arc's clubs.

### 0.3 Get the contracts reviewed

None of this is audited. The surfaces that hold money:

- `ClubVaultUsdg`'s fee accounting (`beforeSwap`/`afterSwap`/`_creditFee`).
  Fees are kept as ERC-6909 claims on the PoolManager and burned into USDG
  on `claim`, not taken mid-swap. See the contract's header for why.
- `ClubAuction`'s escrow (`bid`/`withdraw`/`finalize`), which holds real USDG
  for up to a day.
- The invite checks (`inviteProblem`, `_admit`, `_traderOf`).

### 0.4 Decide where the finalize bot runs

If `scripts/finalize-club.mjs` is down when a round ends, nothing launches
until it's back. There is no permissionless fallback, by design. Its key must
be the auction's **owner** (the bot checks this at startup). Decide where it
runs and how that key is held before the first real round.

---

## 1. Deploy the contracts

```bash
cd contracts
forge test                              # every suite must pass
python script/math/derive_pool_usdg.py  # must exit 0
```

`contracts/.env` needs `DEPLOYER_PRIVATE_KEY`, `POOL_MANAGER`,
`CLUB_TREASURY`, optionally `PROTOCOL_OWNER` and the `CLUB_*` economics, and
either `USDG_ADDRESS` (mainnet) or `DEPLOY_MOCK_USDG=true` (testnet only; the
script refuses on mainnet).

One script deploys and wires everything:

```bash
forge script script/DeployRobinhood.s.sol --tc DeployRobinhood --rpc-url <rpc>            # dry run
forge script script/DeployRobinhood.s.sol --tc DeployRobinhood --rpc-url <rpc> --broadcast
```

It mines the vault's hook address, deploys the vault, factory, router and
auction, sets the factory and router on the vault once, makes the auction
the factory's only launcher, and opens the first round.

**Record from its output**: every address, the mock USDG address on testnet,
and the block the vault was deployed in. Check that every line under
"Verify wiring" is `true`.

### 1.1 Accept ownership

If `PROTOCOL_OWNER` differs from the deployer, the script only *nominates*
it on the vault and the auction. From that wallet:

```bash
cast send <ClubVaultUsdg> "acceptOwnership()" --rpc-url <rpc>
cast send <ClubAuction>   "acceptOwnership()" --rpc-url <rpc>
```

Until then the deploy key withdraws protocol fees and calls `finalize`. The
finalize bot must run with whichever key owns the auction.

---

## 2. Wire the addresses in

1. **`src/lib/robinhood.ts`**: fill in `ROBINHOOD_TESTNET_CONTRACTS` (or
   `_MAINNET_`): `clubVault`, `clubFactory`, `clubRouter`, `clubAuction`,
   `deployBlock`, and `usdg` on testnet. Until they're set the app shows
   "coming soon" and sends nothing.
2. **`src/lib/abis.ts`**: already generated. Re-run `npm run abis` after
   `forge build` only if a contract interface changes.
3. **`subgraph/subgraph.robinhood.yaml`**: the `ClubFactoryUsdg`,
   `ClubVaultUsdg` and `ClubAuction` addresses, and every `startBlock` set to
   the vault's deploy block. Left at 0, the PoolManager source replays every
   v4 swap on the chain first.
4. **The network slug is unconfirmed.** The manifest says `robinhood`;
   confirm Goldsky's actual slug for chain 4663 / 46630.

---

## 3. Deploy the subgraph

```bash
cd subgraph
npm run codegen:robinhood && npm run build:robinhood
npx graph test -r -c   # then run matchstick (WSL on Windows)
```

Matchstick compiles against whatever is in `generated/`. Run both
`codegen:pool` and `codegen:robinhood` first so every test file finds its
types; all suites run together.

Deploy as its own subgraph, not a version of the Arc ones:

```bash
goldsky subgraph deploy aroma-robinhood/1.0.0 --path build-robinhood/
```

Wait for it to sync and confirm a query returns data before pointing the
app at it.

---

## 4. Deploy the app

Per [DEPLOY.md](DEPLOY.md). Set:

| Variable | |
|---|---|
| `NEXT_PUBLIC_AROMA_NETWORK` | `robinhood-testnet`, then `robinhood` for mainnet |
| `NEXT_PUBLIC_ROBINHOOD_RPC_URL` | two providers, comma-separated; Alchemy-backed first |
| `SUBGRAPH_URL` | the Robinhood subgraph, once synced |
| `NEXT_PUBLIC_REOWN_PROJECT_ID`, `PINATA_JWT`, `NEXT_PUBLIC_PINATA_GATEWAY` | unchanged |

`NEXT_PUBLIC_*` values must also be build args, or the browser bundle ships
whatever was baked in at image build.

Run the finalize bot as its own long-lived process:

```bash
CLUB_AUCTION_ADDRESS=0x… FINALIZE_PRIVATE_KEY=0x… ROBINHOOD_NETWORK=mainnet \
  node scripts/finalize-club.mjs
```

It reads the factory and USDG from the auction, mines the token's CREATE2
salt by asking the deployed factory (`predictToken`), and finalizes.

---

## 5. Smoke test, in this order

On **testnet** first. Nothing on mainnet until every step has passed once.

1. `/club` shows the round `DeployRobinhood` opened, with a live countdown.
2. **Bid small.** One signature (the permit), then the transaction. The bid
   list and top bidder update within seconds.
3. **Outbid from a second wallet.** The first wallet's refund appears and
   **Withdraw** pays it.
4. **Edit the draft as the top bidder.** The change shows without a new bid,
   and the bid amount is unchanged.
5. **Bid inside the anti-snipe window.** The deadline extends.
6. **Let the bot finalize a round with a small first buy.** A coin appears
   on the board; the winner holds the first-buy tokens; the winning bid is
   in the treasury; the coin page shows the winner as a member with 10 of 10
   invites.
7. **Invite.** As the winner, create an invite link on the coin page. Open
   it in a third wallet, buy at least $1: it joins, the winner has 9 invites
   left, the new member has 3.
8. **Check the gate.** A fourth wallet with no invite cannot buy: the panel
   says "Invite only". It can still sell tokens it is sent.
9. **Earnings.** After the invited wallet trades, the winner's club
   earnings show on the coin page and **Claim** pays USDG.
10. **Revoke.** Cancel the winner's links; the old link now fails with
    "cancelled", and existing members are unaffected.
11. **Let a round close with no bids.** It voids and the next round opens.

---

## 6. If it goes wrong

**Nothing about a launched coin can be undone.** Liquidity is locked by
construction, test coins included.

What you can do:

- **Stop launches** by stopping the finalize bot. The current round still
  takes bids until its deadline; nothing launches after that.
- **Point `SUBGRAPH_URL` back** at whatever served before.

There is no path that recovers funds from a bad launch, or from USDG sent to
the wrong address.

---

## Known gaps

- **Unaudited contracts.**
- **Nothing has run on Robinhood Chain yet.** The Foundry suites fork
  Ethereum mainnet for a real PoolManager and use a mock USDG; that is exact
  for v4's mechanics, including a PoolManager that holds no USDG, but it is
  not the chain itself.
- **The finalize bot is a single point of failure** for launching (§0.4).
- **USDG's permit domain version** is read from the token, not confirmed
  (§0.1).
- **The Goldsky network slug** is unconfirmed (§2).
- **No snipe protection** beyond the winner's own first buy, which runs
  inside the launch transaction. Other buyers need an invite, which slows
  bots down but doesn't stop a determined one.
