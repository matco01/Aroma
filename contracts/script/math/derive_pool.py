"""Derives PoolVault's tick and liquidity constants, and asserts them.

The pool system replaces CurveManager's virtual reserves with a Uniswap v4
position, which is the same curve written differently:

    (x + L/sqrt(Pb)) * (y + L*sqrt(Pa)) = L^2

is constant-product with virtual reserves. So the job is not to invent a
curve, it is to find the v4 range that reproduces the one Aroma already has.

Two things make this land almost exactly on the product's existing numbers,
where an earlier Uniswap v3 version of this file could not:

  1. v4 lets a pool choose its own tick spacing. v3's 1% fee tier forces 200,
     and the nearest usable ticks moved the opening cap to $4,256.86 and
     graduation to $69,992.74 - drift of over 1%. At spacing 2 every figure
     lands within 0.01%.

  2. v4 supports native currency, so USDC is address zero at Arc's 18-decimal
     native view rather than the 6-decimal ERC-20 interface v3 would force.
     The 10^12 decimal gap disappears, which is why these ticks sit ~276,310
     away from the v3 version's.

Run:  python contracts/script/math/derive_pool.py

Exits non-zero if any constant in PoolVault.sol has drifted from what this
derives. That is the point of it - these numbers are consequences of the tick
choices, and hand-editing one silently reprices every launch.
"""

import sys
from decimal import Decimal, getcontext

getcontext().prec = 70

# --- inputs, all from the product's existing constants -----------------

TOTAL_SUPPLY = Decimal(1_000_000_000)
SALE_SUPPLY = Decimal(800_000_000)  # 80%, sold across the curve
RESERVE_SUPPLY = Decimal(200_000_000)  # 20%, extends it past graduation
DECIMALS = 18  # both currencies: native USDC and the token
TARGET_RAISE = Decimal(13_800)  # CurveManager.GRADUATION_RAISE_USDC
TARGET_OPEN_CAP = Decimal("4312.5")
TARGET_GRAD_CAP = Decimal(69_000)

# --- the choices everything else follows from --------------------------

TICK_SPACING = 2
TICK_INIT = 123_546  # pool opens here
TICK_GRADUATION = 95_818  # sale position ends here
TICK_RESERVE_FLOOR = 68_090  # reserve ends here, a further ~16x up

# Shaded off the reserve liquidity because the pool rounds the amount it asks
# for *up*, and the two positions together must not exceed a fixed supply.
RESERVE_LIQUIDITY_MARGIN = 10**9


def sqrt_ratio(tick) -> Decimal:
    """sqrt(1.0001^tick), at full precision."""
    return Decimal("1.0001") ** (Decimal(tick) / 2)


def price_at(tick) -> Decimal:
    """USDC per token (human units) at `tick`.

    Native USDC is address zero, so it always sorts first and the pool's own
    price is currency1/currency0 - tokens per USDC. A token getting *more*
    expensive therefore moves the tick *down*, which is the inverse of the
    intuition and the reason TICK_GRADUATION sits below TICK_INIT.

    Both currencies carry 18 decimals, so there is no decimal correction and
    the human price is simply the reciprocal.
    """
    return Decimal(1) / (Decimal("1.0001") ** tick)


def liquidity_for_token(amount1: Decimal, tick_lower: int, tick_upper: int) -> int:
    """L for a position funded entirely in currency1.

    Rounded down, so the pool's own rounding-up of the amount owed cannot push
    the request above the balance available.
    """
    return int(amount1 / (sqrt_ratio(tick_upper) - sqrt_ratio(tick_lower)))


def usdc_when_exhausted(liquidity: int, tick_lower: int, tick_upper: int) -> Decimal:
    """USDC held once the price has crossed the whole range."""
    gained = Decimal(liquidity) * (1 / sqrt_ratio(tick_lower) - 1 / sqrt_ratio(tick_upper))
    return gained / 10**DECIMALS


def main() -> int:
    for tick in (TICK_INIT, TICK_GRADUATION, TICK_RESERVE_FLOOR):
        assert tick % TICK_SPACING == 0, f"tick {tick} is off the {TICK_SPACING} grid"
        assert -887272 <= tick <= 887272, f"tick {tick} is out of range"
    assert TICK_RESERVE_FLOOR < TICK_GRADUATION < TICK_INIT, "ticks are out of order"

    sale_liquidity = liquidity_for_token(SALE_SUPPLY * 10**DECIMALS, TICK_GRADUATION, TICK_INIT)
    reserve_liquidity = (
        liquidity_for_token(RESERVE_SUPPLY * 10**DECIMALS, TICK_RESERVE_FLOOR, TICK_GRADUATION)
        - RESERVE_LIQUIDITY_MARGIN
    )

    open_cap = price_at(TICK_INIT) * TOTAL_SUPPLY
    grad_cap = price_at(TICK_GRADUATION) * TOTAL_SUPPLY
    top_cap = price_at(TICK_RESERVE_FLOOR) * TOTAL_SUPPLY
    raise_usdc = usdc_when_exhausted(sale_liquidity, TICK_GRADUATION, TICK_INIT)
    reserve_usdc = usdc_when_exhausted(reserve_liquidity, TICK_RESERVE_FLOOR, TICK_GRADUATION)

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
        f"  raises            ${raise_usdc:>12,.2f}      "
        f"(target ${TARGET_RAISE:>9,.0f}, {pct(raise_usdc, TARGET_RAISE):+.4f}%)"
    )
    print(f"  SALE_LIQUIDITY    {sale_liquidity}")
    print()
    print(f"reserve position    ticks [{TICK_RESERVE_FLOOR}, {TICK_GRADUATION}]")
    print(f"  tops out at       ${top_cap:>12,.0f} cap")
    print(f"  raises a further  ${reserve_usdc:>12,.0f} if fully bought")
    print(f"  RESERVE_LIQUIDITY {reserve_liquidity}")

    # --- the assertions that make this a check, not a printout ---------

    failures = []

    def check(label, got, want):
        if got != want:
            failures.append(f"  {label}\n    derived  {got}\n    in .sol  {want}")

    # Mirror of the constants in src/pool/PoolVault.sol.
    check("SALE_LIQUIDITY", sale_liquidity, 2215084467296721841999892)
    check("RESERVE_LIQUIDITY", reserve_liquidity, 2215164928381102038775570)

    # There is deliberately no sqrt-price constant to check. The v3 version of
    # this system carried one, and it opened every pool a tick low: Uniswap's
    # getSqrtPriceAtTick drifts ~1e-9 above the exact ratio at large ticks, so
    # feeding it the mathematically correct value floors to the wrong tick.
    # PoolVault now calls TickMath itself, which removes the constant and the
    # entire class of bug with it.

    # The whole supply must fit. If the two positions want more than a billion
    # tokens between them, the second modifyLiquidity reverts on-chain.
    sale_tokens = Decimal(sale_liquidity) * (sqrt_ratio(TICK_INIT) - sqrt_ratio(TICK_GRADUATION))
    reserve_tokens = Decimal(reserve_liquidity) * (
        sqrt_ratio(TICK_GRADUATION) - sqrt_ratio(TICK_RESERVE_FLOOR)
    )
    deposited = (sale_tokens + reserve_tokens) / 10**DECIMALS
    if deposited > TOTAL_SUPPLY:
        failures.append(f"  deposits exceed supply by {deposited - TOTAL_SUPPLY} tokens")
    print()
    print(f"deposits            {deposited:,.9f} of {TOTAL_SUPPLY:,}")
    print(f"  dust left over    {TOTAL_SUPPLY - deposited:,.9f}")

    # The raise is the number the product promises, so it gets the tightest
    # bound. Tick quantisation costs ~0.005% here, against v3's ~0.07%.
    drift = abs(raise_usdc / TARGET_RAISE - 1)
    if drift > Decimal("0.001"):
        failures.append(f"  raise drifts {drift * 100:.4f}% from target, over the 0.1% bound")

    if failures:
        print("\nDRIFT DETECTED:\n" + "\n".join(failures))
        return 1
    print("\nall constants match PoolVault.sol")
    return 0


if __name__ == "__main__":
    sys.exit(main())
