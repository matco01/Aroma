# aram contracts

Bonding-curve launchpad contracts for [Arc](https://arc.io), Circle's L1
where USDC is the native gas token.

## Setup

`lib/` is gitignored, so dependencies need restoring after a fresh clone:

```bash
forge install foundry-rs/forge-std --no-git --no-commit
forge install OpenZeppelin/openzeppelin-contracts --no-git --no-commit
forge build
forge test
```

## The contracts

| Contract | Role |
|---|---|
| `AramToken.sol` | The ERC-20 each launch deploys. Fixed 1B supply, no mint function, no owner. ERC20Permit so a sell is one signed transaction. |
| `CurveManager.sol` | One shared contract holding every token's curve state, trading, fees, and graduation. Not one curve per token — cheaper at volume, one audit surface. |
| `AramFactory.sol` | Deploys a token, registers it, and optionally runs the creator's dev-buy, in a single transaction. |

## Economics

Every token launches with identical mechanics — that uniformity *is* the
fairness pitch, so none of these are per-token configurable.

| | |
|---|---|
| Total supply | 1,000,000,000 (fixed) |
| Sold via curve | 800,000,000 |
| Held for graduation LP | 200,000,000 |
| Graduates at | $24,000 raised / $69,000 market cap |
| Creation fee | **Free** — pump.fun charges $0 to create, and taxing creation works against the volume that actually earns |
| Trade fee | 1% on buys and sells (matches Pons) |
| Fee split | 70% to the token's creator, 30% protocol (matches Pons) |
| Graduation fee | $10 flat, skimmed from the raise |
| Dev-buy cap | $2,000 — **placeholder, not a decided number** |

## Curve math

The curve is constant-product with virtual reserves, pump.fun-style. The
virtual reserves are *derived* from the economics above, not chosen —
`script/math/derive_curve.py` solves for them with exact rational
arithmetic and verifies by simulation:

```bash
python script/math/derive_curve.py
```

If any target above changes, re-run that script and update the constants in
`CurveManager.sol`. They are not independent, and
`test_graduationLandsExactlyOnDerivedTargets` will fail if they drift apart.

Rounding is protocol-favouring everywhere (`Math.ceilDiv` on the
invariant-preserving leg), so integer dust always stays with the protocol
rather than being extractable by a trader repeating a trade.
`testFuzz_buyThenSellIsNeverProfitable` is the guard on that.

## Deployed — Arc testnet (chain 5042002)

| Contract | Address |
|---|---|
| CurveManager | `0x4697289C9F954BFf3FD44BC2B27801045Ccc1a5D` |
| AramFactory | `0x371F53a3047e9081b136CfCe29c97689cf531b44` |

(Redeployed 2026-09-03 to add `description` to `TokenCreated`; the earlier
pair at `0xfc63…5540` / `0xaBa7…589B` predates that field.)

Full lifecycle exercised on-chain on 2026-09-03 — launch, dev-buy, public
buy, permit sell, creator-fee claim. Measured costs at ~24 gwei effective:

| Action | Gas | Cost |
|---|---|---|
| Deploy CurveManager | 2,581,360 | 0.0663 USDC |
| Deploy AramFactory | 1,829,601 | 0.0470 USDC |
| `createToken` (with dev-buy) | 1,222,414 | 0.0296 USDC |
| `buy` | 70,096 | 0.0017 USDC |
| `sell` (incl. permit) | 110,423 | 0.0027 USDC |
| `claimCreatorFees` | 37,905 | 0.0009 USDC |

Verified against live chain state rather than docs:

- Chain ID 5042002, base fee exactly 20 gwei — the documented floor is real.
- **Native USDC is 18 decimals, the ERC-20 view is 6** — same balance, ratio
  exactly 1e12, confirmed by reading both for one account. This is the
  assumption the whole contract's accounting rests on.
- Fee split landed at exactly 70/30 on-chain.
- Solvency held to the wei: curve balance `1498335918240201555` equalled
  reserve + protocol pot exactly.

## Testing

```bash
forge test                                   # everything
forge test --match-contract Invariants       # stateful fuzzing only
```

40 unit and fuzz tests, plus 4 stateful invariants exercised over ~128,000
randomly-sequenced calls. The invariants are the ones that matter most,
because they hold against call sequences nobody thought to write:

| Invariant | Why it matters |
|---|---|
| `contractIsAlwaysSolvent` | Native balance always covers every curve reserve + unclaimed creator fee + protocol pot. If this breaks, someone's funds are unbacked. |
| `curveNeverOversells` | Sold supply never exceeds `CURVE_SUPPLY`, so graduation always has its LP reserve intact. |
| `unsoldTokensAreStillHeld` | The contract still holds what it hasn't sold. |
| `graduationIsIrreversible` | A graduated token can't return to trading against supply it no longer holds. |

## Security review notes

No third-party audit. What follows is a self-review, which is not the same
thing — it catches what the author thought to look for.

Findings that were **found and fixed**:

- **`MAX_DEV_BUY_USDC` was never enforced.** Declared as a constant and
  documented as enforced; nothing checked it. A creator could have taken
  most of the curve at its cheapest prices before anyone else knew the
  token existed. Now enforced in `AramFactory.createToken`, with a
  regression test.
- **`graduate()` left `realUsdcReserve` populated** after the USDC had
  physically left the contract, claiming backing that wasn't there. Now
  zeroed; the solvency invariant covers it.
- **`graduationVault` was owner-settable**, meaning the owner key could
  redirect every graduating token's entire raise. Now `immutable`.
- Dust trades that rounded to zero output still charged a fee.
- Ownership was single-step (`Ownable`), so one mistyped transfer would
  permanently lose pause and fee control. Now `Ownable2Step`.
- Emergency pause didn't cover creator fee claims, so it wouldn't have
  contained an active drain.

Accepted, by design:

- **Sandwich/front-running on the curve.** Inherent to a public
  deterministic curve; mitigated by on-chain slippage bounds (enforced,
  not merely displayed) and Arc's sub-second finality.
- **Rounding dust favours the protocol.** Deliberate and fuzz-guarded —
  the alternative is a trader-extractable edge.

## Known gaps before mainnet

- **`graduate()` doesn't seed a real pool.** It sends the raise and LP
  reserve to `graduationVault`. Uniswap v4 is confirmed for Arc *mainnet*
  but is **not deployed on Arc testnet** — the official contract-address
  list has no Uniswap entry — so this genuinely cannot be built and tested
  yet. It can be written against mainnet v4 before aram's own launch.
  Because the vault is now immutable, wiring it up means deploying a new
  CurveManager, which is free to do pre-launch.
- **`depositGraduatedFees()` is open to any caller.** Safe (it can only
  credit value actually attached, never fabricate or redirect funds), but
  should be locked to the token's real v4 hook once one exists.
- **Post-graduation creator fees need that hook.** Ledger and claim path
  work; nothing feeds them after graduation yet.
- **`MAX_DEV_BUY_USDC` ($2,000) and `GRADUATION_FEE_USDC` ($10) are
  placeholders**, not researched numbers.
- **Testnet only.** Deployed and exercised on Arc testnet (launch, dev-buy,
  buy, permit sell, creator-fee claim, all confirmed on-chain, including a
  buy driven through the browser UI). Mainnet is untouched, and graduation
  has never run against real liquidity because reaching it needs $24,000
  and the faucet gives 20 USDC per two hours.
