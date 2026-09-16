<div align="center">

# Aroma

**A launchpad on [Arc](https://arc.network), Circle's L1 — where USDC is the gas token, so every price is already a dollar.**

[aroma.money](https://aroma.money) · [Docs](https://aroma.money/docs) · [@Aromadotmoney](https://x.com/Aromadotmoney)

![The board](docs/board.png)

</div>

---

Anyone can launch a coin in one transaction. The whole supply goes straight
into the coin's own Uniswap v4 pool, so it trades from the first block — here,
and anywhere else that reads Uniswap. The liquidity is locked forever, and
nobody has to put up any USDC to start it.

## Why Arc changes the design

Most launchpads price coins in a volatile asset. A coin "up 40%" might mean
the coin moved, or the quote asset moved, and a trader has to hold two prices
in their head to know which.

Arc uses **USDC as its native gas token**. The asset you pay fees with and the
asset you price in are the same dollar-denominated stablecoin, which changes
real things rather than just the marketing:

- **Prices are dollars, not ratios.** A $69,005.73 market cap is $69,005.73 —
  no conversion, no second asset moving underneath it.
- **Buying is one transaction.** Native USDC arrives as `msg.value`, so there
  is no approval step before a buy. Selling is one transaction too, via an
  EIP-2612 permit signed in the same click.
- **The pool needs no wrapper.** Uniswap v4 supports native currency directly,
  so every pool is `native USDC / token` with no WETH-style wrapped contract in
  between.
- **Decimals are the sharp edge.** Native USDC is 18 decimals while its ERC-20
  interface is 6. The pools are built on the 18-decimal native view, so the
  gap never reaches the maths.

## How a coin works

```
launch ─────────────────────────▶ trading in its own pool, forever
1B minted, all of it              price rises as people buy
into a v4 pool                    buyers' USDC becomes the liquidity
```

There is no second stage. **No bonding curve, no graduation, no migration** —
the coin is in a real Uniswap v4 pool from the block it is created, and it
stays in that same pool. Most launchpads sell through a private curve contract
first and move to a DEX later; the whole point of this design is that there is
nothing to move.

A launch mints **1,000,000,000** tokens with no mint function and no admin key
over the coin, and deposits them as **single-sided liquidity**: ranges of
prices above the opening price, funded only with the token. As people buy, the
price walks up through those ranges and the pool collects their USDC.

The price behaves the way people expect a launchpad's price to behave, without
a curve contract existing anywhere: inside a range, a Uniswap position *is* a
constant-product curve with virtual reserves, which is the same maths a bonding
curve implements — expressed as Uniswap liquidity rather than as a contract of
our own. The supply sits in two ranges. The first 800,000,000 tokens span the
16x from a $4,312.55 opening cap to $69,005.73; the last 200,000,000 continue
above that to about $1.1M. Nothing happens at the boundary between them except
that the depth changes. Those figures aren't round because they're where
Uniswap's ticks actually land, and they're stated as they are.

Trades pay **1%, always in USDC**, split 70/30 to the coin's creator and the
protocol. The pool's own fee is zero; a hook takes the fee from whichever side
of the trade is USDC, so no token is ever sold to pay anyone — and because the
fee lives in the pool, it applies whichever app or router sends the trade.

**Nobody can pull the liquidity, including us.** Every position is owned by
`PoolVault`, which has no function that removes liquidity. A creator can still
sell their own holdings, which is shown on the coin's page alongside the fees
they have earned.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Web | Next.js 16 (App Router), React, TypeScript | Server-rendered coin pages so crawlers and unfurlers see real content |
| Styling | Tailwind v4 with `@theme` tokens | One palette, no component library, no generated-looking UI |
| Wallet | wagmi + viem + Reown AppKit | Wallet-first; switches visitors onto Arc before they sign anything |
| Liquidity | Uniswap v4, one hook | Native USDC pairs, and fees that can be taken in USDC on both sides |
| Contracts | Foundry, Solidity 0.8.28 | Tested against Uniswap's real deployed PoolManager on a fork, not a mock |
| Indexer | Goldsky subgraph (AssemblyScript) | Prices, trades, holders and candles, precomputed rather than aggregated per query |
| Live data | Server-sent events over one shared poller | One upstream poll feeds every viewer, so load is flat in the number of tabs |
| Media | IPFS via Pinata, `sharp`-normalised | Coin images outlive us |
| Hosting | Docker on Railway, Cloudflare in front | One long-lived process — see [DEPLOY.md](DEPLOY.md) |

## Decisions worth explaining

**A pool from the first block, not a curve contract.** An earlier version of
this project sold coins through a bonding curve contract of our own and seeded
a pool once the coin graduated. That made every coin invisible to screeners and
terminals until it graduated, because the trades happened inside a contract
nobody had an adapter for. A single-sided v4 position is the same price curve
expressed as Uniswap liquidity, so the coin is indexed from its first trade —
every Aroma trade is a `Swap` event from Uniswap's own canonical `PoolManager`,
not from anything of ours.

**v4 rather than v3, because of fees.** A v3 pool takes its fee from each
swap's input, so a creator would earn USDC on buys and their own token on
sells, and paying them in USDC would mean selling those tokens into their own
pool. A v4 hook takes the fee from whichever side is USDC. `PoolVault` is that
hook, which is why its address is mined: v4 encodes a hook's permissions in the
low bits of its own address.

**Quotes are simulations of the exact call.** The site quotes a trade by
simulating the router call it is about to send, so the slippage floor is the
number the chain would produce — real pool, real hook fee, real checks. No
client-side estimate sets a limit.

**All or nothing.** A trade the pool cannot fill completely reverts rather
than filling part of it. Found in review: a partial fill used to leave the
unfilled USDC in the router with no way out — 425,992 of a 500,000 USDC buy on
a fork.

**Deploys are checked against the repo.** A rehearsal once deployed a stale
router behind a green test suite, because Foundry's cache had rebuilt the
contract but not the script that embeds it.
[`verify-bytecode.mjs`](contracts/script/verify-bytecode.mjs) compares what is
actually on-chain with a fresh build before any address is published.

**Numbers live in one place.** `src/lib/arc.ts` holds the pool constants, and
the UI, the docs page, the structured data and `llms.txt` all read from them.
`derive_pool.py` derives the contract's constants and fails if they drift.

## Repo

```
src/app          routes, API handlers, metadata
src/components   UI
src/lib          chain config, pool maths, the trade layer
src/lib/server   subgraph client, IPFS, rate limiting, live poller
contracts/       Foundry workspace — see contracts/README.md
subgraph/        Goldsky subgraph
```

## Contracts

| Contract | What it does |
| --- | --- |
| `PoolFactory` | Deploys a token and launches its pool in one transaction, with the creator's optional first buy inside it. |
| `PoolVault` | Creates each pool, owns every position, and is the pool's hook. |
| `AromaRouter` | Buys and sells, with one-transaction permit sells. Holds nothing between trades. |

Live on **Arc mainnet** (chain `5042`), deployed in block 21,108,966:

| | |
| --- | --- |
| `PoolFactory` | [`0x1503ccF70A0E63DAfb47C35076D9408089DF0829`](https://aroma.money/docs) |
| `PoolVault` (also the hook) | [`0xbD86C2F1bD9EB780d7B59Fa1F4feE04f62d260Cc`](https://aroma.money/docs) |
| `AromaRouter` | [`0x1c2c40ab442C48bDd9f00Dc344fF44d5B90CbA9e`](https://aroma.money/docs) |
| Uniswap v4 `PoolManager` | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |

The vault's address carries hook flags `8396`, which is exactly the set of
callbacks it implements — v4 encodes a hook's permissions in the low bits of
its address, so the address had to be mined to match. Every contract's runtime
code was checked byte for byte against a clean build before these addresses
were published.

100 contract tests pass. The pool system's run against Uniswap's deployed
`PoolManager` on a mainnet fork, and the site's own trade code has been driven
end to end against the same fork — launch, buy, sell and fee claims, with every
fill matching its quote to the wei.

## Status

**Live** since 2026-09-16, alongside Arc's own public mainnet launch. The
contracts have not been independently audited.

How it is deployed is written up in [DEPLOY.md](DEPLOY.md) and, for launch
day, [LAUNCH.md](LAUNCH.md). The contract workspace has its own notes in
[contracts/README.md](contracts/README.md).

## License

[Business Source License 1.1](LICENSE), converting to MIT on 2030-09-08.
