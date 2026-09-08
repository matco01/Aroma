# Aroma

A bonding-curve launchpad on [Arc](https://arc.network), Circle's L1, where USDC
is the native gas token — so every price is already a dollar.

Live at **[aroma.money](https://aroma.money)** (Arc testnet).

- **Web** — Next.js 16 App Router, Tailwind v4, wagmi + viem + Reown AppKit
- **Contracts** — Foundry, Solidity 0.8.28, in [`contracts/`](contracts/)
- **Indexer** — a Goldsky subgraph, in [`subgraph/`](subgraph/)

Read [`AGENTS.md`](AGENTS.md) before writing code: this is a newer Next.js than
most references describe.

## Setting up a fresh machine

Needs Node >=22 and, for contract work, [Foundry](https://getfoundry.sh) and
Python 3 (one script uses it).

```bash
git clone https://github.com/matco01/Aroma.git
cd Aroma
npm install
```

### Secrets

Two files hold configuration and neither is in git, by design. Copy the
templates and fill them in:

```bash
cp .env.example .env.local              # the web app
cp contracts/.env.example contracts/.env # only needed to deploy contracts
```

Every value except the deployer key can be read back from the Railway
project's variables, which is the fastest way to set up a second machine.
**The deployer private key exists nowhere but your own copy** — move it
through a password manager, never through a chat window or a commit.

`.env.local` may still contain `ANTHROPIC_API_KEY` and `CIRCLE_API` on older
machines. Nothing reads them any more; they are left over from a reverted
experiment and can be deleted.

### Contract dependencies

`contracts/lib/` is not committed, is not a submodule, and has no lockfile, so
a fresh clone has none of it and `forge build` fails until it is restored.

Two of the three restore cleanly:

```bash
cd contracts
forge install foundry-rs/forge-std@v1.16.2
forge install OpenZeppelin/openzeppelin-contracts@v5.7.0
```

**`v4-core` does not.** The installed copy reports package version 1.0.2, but
that is an npm version and the repository has only ever tagged `v4.0.0`, whose
`PoolManager.sol` differs from ours — 393 lines against 395, different hash —
and no commit in the recent history of that file matches either. So the copy
this project builds against cannot be identified from anything published, and
`forge install Uniswap/v4-core` would fetch something else.

This matters more than it looks. `LiquidityLocker` is compiled against these
sources, so a different `v4-core` means different graduation bytecode from the
one the tests and the testnet deployment exercised.

**Until that is resolved, copy `contracts/lib/v4-core/` across from a machine
that already has it rather than installing it**, and treat pinning it properly
— vendoring the directory into git, or a submodule at an identified commit —
as a prerequisite for the mainnet deploy rather than a cleanup task.

With all three present, `forge test` runs 61 tests. The graduation tests run
against Uniswap's real `PoolManager`, deployed in-process — not a mock.

## Running it

```bash
npm run dev          # web app on :3000
cd contracts && forge test
cd subgraph && npm run codegen && npm run build
```

Building the standalone output locally needs one manual step Next does not do
for you — static assets are not copied into `.next/standalone`, so a
`node .next/standalone/server.js` will serve pages with no CSS until you copy
`.next/static` and `public/` in beside it. The Docker build handles this; a
hand-run local server does not.

## Deployed on Arc testnet (chain 5042002)

All verified on Arcscan. Addresses live in [`src/lib/arc.ts`](src/lib/arc.ts),
which every other file reads rather than repeating them.

| Contract | Address |
| --- | --- |
| CurveManager | `0xEF036a1167e307b413a7F79AFC7d6A774Df8AC07` |
| AromaFactory | `0xc11f086E1e45b3589b1F2B95FA8069Bc2a58D772` |
| LiquidityLocker | `0xeb80Abd167739E93393935863f035C94f8B667fF` |

## Public APIs

Both documented at [aroma.money/docs](https://aroma.money/docs).

- `/api/dex/*` — a read-only feed of curve trading, shaped the way DEX
  Screener's indexer polls, so anyone can index Aroma without asking.
- `CurveManager` itself — `buy`, `sell` and on-chain quote functions, for bots
  and terminals. Every coin is on one address, so a single log filter covers
  all of them.

## Before mainnet

Arc mainnet launches 2026-09-16. Deployment is one variable — `POOL_MANAGER`
in `contracts/.env` — and one hard prerequisite:

> **Do not deploy until Uniswap v4's PoolManager is confirmed live on Arc
> mainnet and verified to have code at the address you are using.** It is
> immutable once `LiquidityLocker` is constructed, and the locker has no
> withdraw function. Deploying without it means every coin that graduates
> sends its USDC and tokens somewhere nothing can retrieve them from.

`Deploy.s.sol` refuses an address with no code on the target chain. Don't route
around that check.
