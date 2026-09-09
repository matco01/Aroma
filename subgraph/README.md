# Subgraph

Two manifests, one schema.

| Manifest | Network | Indexes |
| --- | --- | --- |
| `subgraph.yaml` | `arc-testnet` | the curve system — `AromaFactory`, `CurveManager` |
| `subgraph.pool.yaml` | `arc-mainnet` | the pool system — `PoolFactory`, `PoolManager`, `PoolVault` |

They are two deployments rather than one because every data source in a
subgraph must share a network, and these cannot: the pool system needs
Uniswap, which is not deployed on Arc testnet at any version.

Both write **the same entities** — `Token`, `Trade`, `Balance`, `Candle`,
`Protocol` — so the board, `/api/*` and the DEX Screener adapter work across
both venues without knowing which produced a row. `Token.venue` is `"curve"`
or `"pool"`, and exists for labelling rather than for branching.

```bash
npm run codegen && npm run build            # curve
npm run codegen:pool && npm run build:pool  # pool
npm test                                    # matchstick unit tests
```

`codegen` overwrites `generated/` for whichever manifest it is given, so run
the matching pair before a build.

## Before deploying the pool subgraph

`subgraph.pool.yaml` carries three `FIXME`s that come from the `DeployPool`
output: `PoolFactory`'s address, `PoolVault`'s address, and the block they
were deployed in. `PoolVault`'s address is mined for its hook permission
bits, so it is neither guessable nor stable across redeploys.

`startBlock` matters more here than on the curve side. v4 is a singleton, so
`handleSwap` is called for **every swap in every v4 pool on the chain**, not
only ours — left at the PoolManager's own deployment block it would replay
all of them before reaching anything of Aroma's.

## Tests

`tests/pool.test.ts` covers the three things most likely to be wrong and
silent when wrong:

- **the sign convention.** v4's `Swap` amounts are the *swapper's* deltas,
  not the pool's — the event's own NatSpec says the opposite. Getting this
  backwards inverts every buy and sell.
- **the fee reconstruction.** The hook charges before the swap on a buy and
  after it on a sell, so the event reports net one way and gross the other.
- **the cost-basis carry** on a partial sell.

### Running them on Windows

`graph test` has no native Windows binary and its platform table only maps
Ubuntu 22 and 24, so on Windows or a newer Ubuntu it fails before it starts.
Under WSL, fetch the binary directly and run it:

```bash
mkdir -p .bin
curl -sL -o .bin/matchstick \
  https://github.com/LimeChain/matchstick/releases/download/0.6.0/binary-linux-22
chmod +x .bin/matchstick
sudo apt-get install -y libpq5   # matchstick links against libpq
./.bin/matchstick
```

`matchstick.yaml` points it at `subgraph.pool.yaml`; the binary is
gitignored.
