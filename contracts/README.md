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

**`v4-core` cannot currently be restored this way.** The vendored copy reports
npm version 1.0.2, but that is not a git tag — the repository has only ever
tagged `v4.0.0`, whose `PoolManager.sol` is 393 lines to our 395 with a
different hash, and no commit in the recent history of that file matches ours
either. What `LiquidityLocker` compiles against therefore cannot be identified
from anything published, and `forge install Uniswap/v4-core` would fetch
something else.

That is a correctness problem rather than an inconvenience: a different
`v4-core` is different graduation bytecode from the one the tests and the
testnet deployment exercised. Until it is pinned properly — vendored into git,
or a submodule at an identified commit — copy `lib/v4-core/` from a machine
that already has it, and treat resolving it as a prerequisite for deploying to
mainnet.

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
