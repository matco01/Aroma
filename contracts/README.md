# Contracts

Foundry workspace. Solidity 0.8.28, pinned per-file rather than globally so
that `v4-core`, which pins 0.8.26, can be compiled in the same project.

| Contract | What it does |
| --- | --- |
| `AromaToken` | Fixed-supply ERC-20 with `ERC20Permit`. No mint function, no owner. |
| `AromaFactory` | Deploys a token and registers it with the curve in one transaction. |
| `CurveManager` | Every curve, in one contract. Buying, selling, fees, graduation. |
| `LiquidityLocker` | Receives a graduated coin's raise and seeds a Uniswap v4 pool it cannot unwind. |

## Testing

```bash
forge test
```

61 tests. The suite includes an invariant run that exercises
buy/sell/create/graduate/withdraw across 128,000 calls, asserting the curve
stays solvent, never oversells, and that graduation is irreversible.

The graduation tests deploy Uniswap's **real** `PoolManager` through
`vm.deployCode` rather than a mock — a mock written against our own
assumptions would agree with our own mistakes. `test/v4/CompileV4.sol` exists
only to force that artifact to be compiled; nothing imports it.

## Dependencies

`lib/` is not committed, is not a submodule, and has no lockfile, so a fresh
clone cannot build until it is restored.

```bash
forge install foundry-rs/forge-std@v1.16.2
forge install OpenZeppelin/openzeppelin-contracts@v5.7.0
```

`v4-core` was previously unrestorable: the vendored copy reported npm version
1.0.2, which is not a git tag, and matched no published commit. It is now
pinned to a real one.

```bash
git clone https://github.com/Uniswap/v4-core lib/v4-core
git -C lib/v4-core checkout 46c6834698c48bc4a463a86d8420f4eb1d7f3b75
git -C lib/v4-core submodule update --init --recursive
```

Note that the tag `v4.0.0` does **not** work: it predates
`src/types/PoolOperation.sol`, which `LiquidityLocker` imports. That dates the
old vendored copy to somewhere after v4.0.0, which is the one useful thing it
told us.

The whole suite passes against this commit, including the graduation tests
that deploy Uniswap's real `PoolManager`. It is still not byte-identical to
whatever the deployed testnet `LiquidityLocker` was compiled against — that
remains unknowable — so treat a redeploy of *that* contract as a change, not a
rebuild. Nothing else is affected, and a fresh clone now builds.

## Deploying

Copy `.env.example` to `.env` and fill it in. Then:

```bash
forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast --verify
```

`POOL_MANAGER` is the variable that matters. It is immutable once
`LiquidityLocker` is constructed, and the locker has no withdraw function of
any kind — so deploying with it unset or wrong means every coin that graduates
sends its USDC and tokens somewhere nothing can retrieve them from.
`Deploy.s.sol` refuses an address with no code on the target chain. Do not
route around that check.

On Arc testnet, leave it unset: Uniswap v4 is not deployed there, and the
locker handles a zero address by holding graduation funds without seeding a
pool.

## The pool system (`src/pool/`)

A second, independent launch mechanism. Same token, same 1% fee, same 70/30
creator split, same curve — but the curve is Uniswap v4 liquidity rather than
reserves this protocol holds itself, and the coin is therefore indexed by
every screener from its first block.

| Contract | What it does |
| --- | --- |
| `PoolFactory` | Deploys a token and launches its pool in one transaction. |
| `PoolVault` | Creates the pool, owns every position, and is also the hook. |
| `AromaRouter` | Buys and sells, with CurveManager's call shapes. |

### Why v4 rather than v3

Both can host a single-sided launch. Only v4 can pay creators in USDC.

A v3 pool takes its fee from each swap's **input**, so a creator earns USDC on
buys and their own token on sells. Converting those tokens means selling them
into the creator's own pool, and charging in a router instead is avoidable by
anyone who trades directly against the pool — which, on a public pool, is
everyone who wants to.

A hook takes the fee from whichever side is USDC: the input on a buy, the
output on a sell. Every fee is USDC, no token is ever sold, and the charge
lives in the pool so it cannot be routed around. `PoolVault` is that hook,
which is why its address is mined — v4 encodes a hook's permissions in the low
14 bits of its own address.

v4 also lets a pool pick its tick spacing and supports native currency, and
both show up directly in the numbers below.

### The curve is the same curve

A v4 position over `[Pa, Pb]` satisfies

    (x + L/sqrt(Pb)) * (y + L*sqrt(Pa)) = L^2

which is constant-product with virtual reserves, the form `CurveManager`
implements directly. `VIRTUAL_USDC_RESERVE` is `L*sqrt(Pa)`, and
`VIRTUAL_TOKEN_RESERVE - CURVE_SUPPLY` is `L/sqrt(Pb)`. Arithmetic, not
analogy.

| | curve system | pool system |
| --- | --- | --- |
| opening cap | $4,312.50 | $4,312.55 |
| graduation cap | $69,000 | $69,005.73 |
| raise | $13,800 | $13,800.65 |

Everything within 0.01%. `script/math/derive_pool.py` derives every constant
and fails if any has drifted from `PoolVault.sol`.

### The 20% reserve

In the curve system, 20% of supply is held back to be the token side of a pool
seeded at graduation. There is no seeding step here, so instead of being
deleted it becomes a second position continuing above the graduation price —
depth for buyers past graduation, earning fees, never migrating. It tops out
near a $1.10M market cap.

### Why there is a router

Uniswap publishes no Universal Router address for Arc — their tables give a
v3 router, a v4 Quoter and a v4 PositionManager, and nothing else. A frontend
cannot swap a v4 pool without one.

The better reason is EIP-2612. `AromaToken` implements it and `CurveManager`
uses it, so selling on the curve is *one* signed transaction rather than
approve-then-sell. Uniswap's router takes ERC-20s through Permit2, a second
approval system with its own signatures and its own allowance state — routing
through it would have made the pool product measurably worse to use than the
curve product it replaces. `AromaRouter.sell` takes the same permit arguments
`CurveManager.sell` does, so the frontend's sell flow is the flow it already
has, pointed at a different address.

It owns nothing, holds no balance between calls, and the vault does not know
it exists. Replacing it later is a frontend change, not a migration.

### The dev-buy

Same mechanic as `AromaFactory`, and for a sharper reason. It looked
removable at first — the pool is live the moment `createToken` returns, so a
creator could simply swap. But that loses the *same-transaction* guarantee:
between the launch and a separate buy, anyone watching the mempool can get
in first. With no snipe guard yet, that left the creator with no protection
at all, which is a worse position than the curve system's.

So `createToken` runs the buy itself, capped at the same `MAX_DEV_BUY_USDC`
the curve uses, with a slippage floor, tokens delivered straight to the
creator, and any unspent value refunded. It pays the ordinary 1% fee — the
creator is not exempt on their own coin.

The swap runs from `PoolFactory` rather than `PoolVault`, even though the
vault already has the unlock machinery. The vault is the pool's hook, so a
swap it initiated would settle the hook's fee against the same account that
owes the swap input. Keeping swapper and hook as different addresses keeps
the deltas separate and the accounting checkable.

### What this system does not do

- **No snipe protection.** Possible here, unlike v3 — a hook could enforce a
  per-swap rule — but not built. A launch is snipeable in its first block.
- **No exact-output sells.** "Give me exactly N USDC for however many tokens
  that takes" is refused rather than approximated, because charging a fee on
  an exact-output *specified* amount means handing back less than the exact
  amount asked for. Every ordinary buy and sell is covered.

### Testing

16 tests against Uniswap's **real deployed PoolManager** on a pinned mainnet
fork, rather than a local build of v4-core — it exercises the bytecode that is
actually running, which is `CompileV4.sol`'s argument about mocks carried one
step further.

```bash
forge test --match-contract PoolLaunchTest
```

Needs an **archive** endpoint, since the fork block is pinned; most free RPCs
serve only recent state and fail with "state at block N is pruned". Ethereum
is the target only because no public Arc mainnet RPC exists yet, and the
substitution is exact rather than approximate: the only thing that matters
about currency0 is that it is the chain's native asset at 18 decimals. On
Ethereum that is ETH, on Arc it is USDC.

What the tests pin down:

- the pool opens at exactly tick 123,546
- launching adds **zero** USDC to the pool manager — it really is single-sided
- buying the sale range out raises ~$13,800, matching `derive_pool.py`
- a sell's fee arrives in USDC and the vault's token balance **does not
  grow**, which is the v3 problem staying fixed
- a pool naming this vault as its hook, but not created by it, cannot be
  initialized

### Deploying

No testnet path — Uniswap is not deployed on Arc testnet at any version.

```bash
forge script script/DeployPool.s.sol --tc DeployPool \n  --rpc-url arc_mainnet --broadcast
```

`--tc` is needed because the file also carries the small CREATE2 factory
the mined address is deployed through.

The script mines a CREATE2 salt so the vault lands on an address carrying
exactly the hook permissions it implements, and asserts the prediction held
before wiring anything up.
