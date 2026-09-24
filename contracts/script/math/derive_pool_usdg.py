"""Derives PoolVaultUsdg's tick and liquidity constants, and asserts them.

Same curve as derive_pool.py (see that file for the constant-product-with-
virtual-reserves derivation) with one real difference: the quote currency is
USDG, not native 18-decimal USDC. USDG is a plain ERC-20 on Robinhood Chain,
confirmed at 6 decimals against Paxos's own deployed contract on Etherscan
(0xe343167631d89b6ffc58b88d6b7fb0228795491d) — the same convention as USDC,
not the 18-decimal convention native currency gave the Arc version for free.

That reintroduces exactly the 10^12 decimal gap derive_pool.py's docstring
says the native version made disappear, so every tick constant here differs
from PoolVault.sol's — this is not a copy-paste of that file's numbers, and
must not become one.

Run:  python contracts/script/math/derive_pool_usdg.py

Exits non-zero if any constant in PoolVaultUsdg.sol has drifted from what
this derives.
"""

import sys
from decimal import Decimal, getcontext

getcontext().prec = 70

# --- inputs --------------------------------------------------------------

TOTAL_SUPPLY = Decimal(1_000_000_000)
SALE_SUPPLY = Decimal(800_000_000)
RESERVE_SUPPLY = Decimal(200_000_000)
DECIMALS_BASE = 18  # the launched token
DECIMALS_QUOTE = 6  # USDG, confirmed against Paxos's deployed contract
TARGET_RAISE = Decimal(13_800)
TARGET_OPEN_CAP = Decimal("4312.5")
TARGET_GRAD_CAP = Decimal(69_000)

# --- the choices everything else follows from -----------------------------
# Found by searching the tick grid around the continuous solution for the
# nearest even tick to each target cap; see the reserve floor's own note.

TICK_SPACING = 2
TICK_INIT = 399_870
TICK_GRADUATION = 372_142
TICK_RESERVE_FLOOR = 344_414

RESERVE_LIQUIDITY_MARGIN = 10**9

DECIMAL_FACTOR = Decimal(10) ** (DECIMALS_BASE - DECIMALS_QUOTE)


def sqrt_ratio(tick) -> Decimal:
    return Decimal("1.0001") ** (Decimal(tick) / 2)


def price_at(tick) -> Decimal:
    """USDG per token (human units) at `tick`.

    USDG sorts as currency0 (PoolFactoryUsdg mines the token's address to
    guarantee it), same convention PoolVault uses for native USDC, so price
    is still currency1/currency0 = token-per-USDG in *raw* units. Because the
    two currencies no longer share a decimal count, converting that raw ratio
    to a human USDG-per-token price needs the 10^12 correction v3's 6-decimal
    USDC once needed and the native-USDC version of this system removed.
    """
    return DECIMAL_FACTOR / (Decimal("1.0001") ** tick)


def liquidity_for_token(amount1: Decimal, tick_lower: int, tick_upper: int) -> int:
    return int(amount1 / (sqrt_ratio(tick_upper) - sqrt_ratio(tick_lower)))


def usdg_when_exhausted(liquidity: int, tick_lower: int, tick_upper: int) -> Decimal:
    gained = Decimal(liquidity) * (1 / sqrt_ratio(tick_lower) - 1 / sqrt_ratio(tick_upper))
    return gained / 10**DECIMALS_QUOTE


def main() -> int:
    for tick in (TICK_INIT, TICK_GRADUATION, TICK_RESERVE_FLOOR):
        assert tick % TICK_SPACING == 0, f"tick {tick} is off the {TICK_SPACING} grid"
        assert -887272 <= tick <= 887272, f"tick {tick} is out of range"
    assert TICK_RESERVE_FLOOR < TICK_GRADUATION < TICK_INIT, "ticks are out of order"

    sale_liquidity = liquidity_for_token(
        SALE_SUPPLY * 10**DECIMALS_BASE, TICK_GRADUATION, TICK_INIT
    )
    reserve_liquidity = (
        liquidity_for_token(
            RESERVE_SUPPLY * 10**DECIMALS_BASE, TICK_RESERVE_FLOOR, TICK_GRADUATION
        )
        - RESERVE_LIQUIDITY_MARGIN
    )

    open_cap = price_at(TICK_INIT) * TOTAL_SUPPLY
    grad_cap = price_at(TICK_GRADUATION) * TOTAL_SUPPLY
    top_cap = price_at(TICK_RESERVE_FLOOR) * TOTAL_SUPPLY
    raise_usdg = usdg_when_exhausted(sale_liquidity, TICK_GRADUATION, TICK_INIT)
    reserve_usdg = usdg_when_exhausted(reserve_liquidity, TICK_RESERVE_FLOOR, TICK_GRADUATION)

    def pct(got, want):
        return (got / want - 1) * 100

    print(f"tick spacing        {TICK_SPACING}")
    print(f"sale position       ticks [{TICK_GRADUATION}, {TICK_INIT}]")
    print(
        f"  opens at          ${open_cap:>12,.2f} cap  "
        f"(target ${TARGET_OPEN_CAP:>9,.2f}, {pct(open_cap, TARGET_OPEN_CAP):+.4f}%)"
    )
    print(
        f"  graduates at      ${grad_cap:>12,.2f} cap  "
        f"(target ${TARGET_GRAD_CAP:>9,.0f}, {pct(grad_cap, TARGET_GRAD_CAP):+.4f}%)"
    )
    print(
        f"  raises            ${raise_usdg:>12,.2f}      "
        f"(target ${TARGET_RAISE:>9,.0f}, {pct(raise_usdg, TARGET_RAISE):+.4f}%)"
    )
    print(f"  SALE_LIQUIDITY    {sale_liquidity}")
    print()
    print(f"reserve position    ticks [{TICK_RESERVE_FLOOR}, {TICK_GRADUATION}]")
    print(f"  tops out at       ${top_cap:>12,.0f} cap")
    print(f"  raises a further  ${reserve_usdg:>12,.0f} if fully bought")
    print(f"  RESERVE_LIQUIDITY {reserve_liquidity}")

    failures = []

    def check(label, got, want):
        if got != want:
            failures.append(f"  {label}\n    derived  {got}\n    in .sol  {want}")

    # Mirror of the constants in src/pool-usdg/PoolVaultUsdg.sol.
    check("SALE_LIQUIDITY", sale_liquidity, 2215087395449222952)
    check("RESERVE_LIQUIDITY", reserve_liquidity, 2215167855639966831)

    sale_tokens = Decimal(sale_liquidity) * (sqrt_ratio(TICK_INIT) - sqrt_ratio(TICK_GRADUATION))
    reserve_tokens = Decimal(reserve_liquidity) * (
        sqrt_ratio(TICK_GRADUATION) - sqrt_ratio(TICK_RESERVE_FLOOR)
    )
    deposited = (sale_tokens + reserve_tokens) / 10**DECIMALS_BASE
    if deposited > TOTAL_SUPPLY:
        failures.append(f"  deposits exceed supply by {deposited - TOTAL_SUPPLY} tokens")
    print()
    print(f"deposits            {deposited:,.9f} of {TOTAL_SUPPLY:,}")
    print(f"  dust left over    {TOTAL_SUPPLY - deposited:,.9f}")

    drift = abs(raise_usdg / TARGET_RAISE - 1)
    if drift > Decimal("0.001"):
        failures.append(f"  raise drifts {drift * 100:.4f}% from target, over the 0.1% bound")

    if failures:
        print("\nDRIFT DETECTED:\n" + "\n".join(failures))
        return 1
    print("\nall constants match PoolVaultUsdg.sol")
    return 0


if __name__ == "__main__":
    sys.exit(main())
