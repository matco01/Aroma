#!/usr/bin/env python3
"""
Derives the constant-product bonding curve's virtual reserves from Aroma's
existing product constants (src/lib/arc.ts's CURVE object), and verifies the
result by simulating the full curve before any Solidity gets written.

Why this exists as a standalone, runnable artifact rather than a comment in
the Solidity file: the virtual reserves are irrational-looking numbers (not
round), so they need to be *derived*, not guessed, and a future auditor (or
future us) needs to be able to re-run this and get the same numbers back
out, rather than trusting a magic constant with no shown derivation.

Model: pump.fun-style constant-product curve with virtual reserves.
  effective_usdc  = v_usdc + real_usdc_raised
  effective_token = v_token - tokens_sold
  invariant: effective_usdc * effective_token = k = v_usdc * v_token  (constant)

Only a fraction of TOTAL_SUPPLY is ever sold via the curve — the rest is
reserved, unsold, specifically to pair with the raised USDC when seeding the
graduation Uniswap v4 pool. (Real pump.fun does the same thing: ~793M/1B on
the curve, ~207M reserved for the pool. Their split isn't round; this one is
a deliberately chosen round number, not reverse-engineered from anyone
else's exact constants.) Without this reserve, there would be nothing left
to pair with the raised USDC at graduation.
"""

from fractions import Fraction as F

# ---- Inputs: must match src/lib/arc.ts's CURVE object exactly -------------
TOTAL_SUPPLY = F(1_000_000_000)          # CURVE.totalSupply
GRAD_RAISE_USD = F(13_800)               # CURVE.graduationTargetUsd
GRAD_MARKET_CAP_USD = F(69_000)          # CURVE.graduationMarketCapUsd

# The curve/LP split. 80/20 looks like a round number picked for taste, but
# it is not free: see PRICE CONTINUITY below. Given a $69,000 graduation, an
# 80/20 split *forces* the raise to be $13,800, and vice versa. The two
# constants are one decision, not two.
CURVE_SUPPLY = F(800_000_000)            # tokens sellable via the curve
LP_RESERVE_SUPPLY = TOTAL_SUPPLY - CURVE_SUPPLY   # reserved for graduation LP

GRADUATION_FEE_USD = F(10)               # flat fee skimmed from the raise

# ---- PRICE CONTINUITY ----------------------------------------------------
#
# The constraint this file originally missed, and the reason the raise moved
# from $24,000 to $13,800.
#
# At graduation the pool is seeded with the raise and the unsold tokens, so
# the price it opens at is  raise / lpReserve.  For that to equal the price
# the curve just closed at (mcap / totalSupply), the reserve must satisfy:
#
#     lpReserve / totalSupply == raise / gradMcap
#
# Nothing else is adjustable. With $24,000 and a 20% reserve the pool opened
# at a $119,950 market cap against a curve that closed at $69,000 — a 73.8%
# gap handed to whoever held through migration, paid for by whoever bought
# into the fresh pool. `assert_price_continuity` below now fails loudly
# rather than letting that ship again.

WEI = F(10) ** 18   # internal accounting precision (plan §3: 18-decimal, matches Arc's native USDC decimals)


def derive_virtual_reserves():
    """
    Solve for (v_usdc, v_token) such that, starting from a curve with zero
    real reserves, exactly GRAD_RAISE_USD raised sells exactly CURVE_SUPPLY
    tokens and lands at exactly GRAD_MARKET_CAP_USD market cap.

    market cap = price * TOTAL_SUPPLY  (full FDV, not just curve-sold supply)
    price_at_graduation = GRAD_MARKET_CAP_USD / TOTAL_SUPPLY

    Two equations (invariant conservation + graduation price), two unknowns
    (v_usdc, v_token) — solved symbolically below, exact rational arithmetic
    throughout (no floating point anywhere in this derivation).
    """
    R = GRAD_RAISE_USD
    S = CURVE_SUPPLY
    P = GRAD_MARKET_CAP_USD / TOTAL_SUPPLY  # target spot price at graduation

    # Let x = v_usdc + R. Solving the system (see module docstring for the
    # two source equations) collapses to a single linear equation in x:
    #   x * (S/R - 1/P) = S
    coefficient = S / R - 1 / P
    x = S / coefficient

    v_usdc = x - R
    v_token = (S / R) * x

    return v_usdc, v_token, P


def assert_price_continuity():
    """
    The graduation pool must open at the price the curve closed at.

    Tolerance is 0.5%: the only permitted gap is the flat graduation fee
    leaving the raise ($10 of $13,800 = 0.07%). Anything larger means the
    supply split and the raise target have drifted apart.
    """
    grad_price = GRAD_MARKET_CAP_USD / TOTAL_SUPPLY
    pool_price = (GRAD_RAISE_USD - GRADUATION_FEE_USD) / LP_RESERVE_SUPPLY
    gap_pct = (pool_price / grad_price - 1) * 100

    required_lp = TOTAL_SUPPLY * GRAD_RAISE_USD / GRAD_MARKET_CAP_USD
    print("=== Price continuity at graduation ===")
    print(f"  curve closes at  : ${float(grad_price * TOTAL_SUPPLY):,.2f} market cap")
    print(f"  pool opens at    : ${float(pool_price * TOTAL_SUPPLY):,.2f} market cap")
    print(f"  gap              : {float(gap_pct):+.3f}%  "
          f"(the ${float(GRADUATION_FEE_USD):,.0f} graduation fee)")
    print(f"  LP reserve       : {float(LP_RESERVE_SUPPLY):,.0f} "
          f"(continuity requires {float(required_lp):,.0f})")

    assert abs(gap_pct) < F(1, 2), (
        f"graduation price gap {float(gap_pct):+.2f}% exceeds 0.5%. "
        f"With a ${float(GRAD_RAISE_USD):,.0f} raise and a "
        f"${float(GRAD_MARKET_CAP_USD):,.0f} graduation, the LP reserve must be "
        f"{float(required_lp):,.0f} tokens, not {float(LP_RESERVE_SUPPLY):,.0f}."
    )
    print("  OK - the handover is smooth.")
    print()


def simulate_buy(v_usdc, v_token, real_usdc, tokens_sold, usdc_in):
    """One constant-product buy: usdc in, tokens out. Exact fractions."""
    eff_usdc = v_usdc + real_usdc
    eff_token = v_token - tokens_sold
    k = v_usdc * v_token
    new_eff_usdc = eff_usdc + usdc_in
    new_eff_token = k / new_eff_usdc
    tokens_out = eff_token - new_eff_token
    return real_usdc + usdc_in, tokens_sold + tokens_out


def main():
    assert_price_continuity()

    v_usdc, v_token, target_price = derive_virtual_reserves()

    start_price = v_usdc / v_token
    start_mcap = start_price * TOTAL_SUPPLY
    print("=== What a trader actually sees ===")
    print(f"  starting market cap : ${float(start_mcap):,.2f}")
    print(f"  graduation          : ${float(GRAD_MARKET_CAP_USD):,.2f}")
    print(f"  upside              : {float(GRAD_MARKET_CAP_USD / start_mcap):.2f}x")
    print()

    print("=== Derived virtual reserves (exact) ===")
    print(f"v_usdc  = {v_usdc}  ~= {float(v_usdc):,.6f} USDC")
    print(f"v_token = {v_token}  ~= {float(v_token):,.6f} tokens")
    print()

    # ---- Verify: simulate the curve from zero to graduation, in steps ----
    print("=== Simulation: buying in $500 increments to graduation ===")  # noqa
    real_usdc = F(0)
    tokens_sold = F(0)
    step = F(500)
    row = 0
    while real_usdc < GRAD_RAISE_USD:
        buy = min(step, GRAD_RAISE_USD - real_usdc)
        real_usdc, tokens_sold = simulate_buy(
            v_usdc, v_token, real_usdc, tokens_sold, buy
        )
        price = (v_usdc + real_usdc) / (v_token - tokens_sold)
        market_cap = price * TOTAL_SUPPLY
        row += 1
        if row % 8 == 0 or real_usdc >= GRAD_RAISE_USD:
            print(
                f"  raised=${float(real_usdc):>10,.2f}  "
                f"sold={float(tokens_sold):>15,.2f}  "
                f"price=${float(price):.8f}  "
                f"mcap=${float(market_cap):>10,.2f}"
            )

    print()
    print("=== Graduation check (must match arc.ts's CURVE exactly) ===")
    final_price = (v_usdc + real_usdc) / (v_token - tokens_sold)
    final_mcap = final_price * TOTAL_SUPPLY
    print(f"  tokens sold at graduation : {float(tokens_sold):,.4f} "
          f"(target {float(CURVE_SUPPLY):,.0f}, "
          f"diff {float(tokens_sold - CURVE_SUPPLY):.10f})")
    print(f"  usdc raised at graduation : {float(real_usdc):,.4f} "
          f"(target {float(GRAD_RAISE_USD):,.0f})")
    print(f"  market cap at graduation  : ${float(final_mcap):,.4f} "
          f"(target ${float(GRAD_MARKET_CAP_USD):,.0f}, "
          f"diff {float(final_mcap - GRAD_MARKET_CAP_USD):.10f})")

    # ---- Sanity: tokens left for the LP after graduation ----
    tokens_remaining = TOTAL_SUPPLY - tokens_sold
    print(f"  tokens reserved for LP    : {float(tokens_remaining):,.4f} "
          f"(target {float(LP_RESERVE_SUPPLY):,.0f})")
    print(f"  LP seed                  : {float(real_usdc):,.2f} USDC + "
          f"{float(tokens_remaining):,.2f} tokens")

    # ---- Solidity constants (18-decimal fixed point) ----
    print()
    print("=== Solidity constants (18-decimal fixed point, rounded to nearest wei) ===")
    v_usdc_wei = round(v_usdc * WEI)
    v_token_wei = round(v_token * WEI)
    total_supply_wei = round(TOTAL_SUPPLY * WEI)
    curve_supply_wei = round(CURVE_SUPPLY * WEI)
    lp_reserve_wei = round(LP_RESERVE_SUPPLY * WEI)
    grad_raise_wei = round(GRAD_RAISE_USD * WEI)

    print(f"uint256 constant VIRTUAL_USDC_RESERVE  = {v_usdc_wei};  // {float(v_usdc):.6f} USDC")
    print(f"uint256 constant VIRTUAL_TOKEN_RESERVE = {v_token_wei};  // {float(v_token):.6f} tokens")
    print(f"uint256 constant TOTAL_SUPPLY          = {total_supply_wei};")
    print(f"uint256 constant CURVE_SUPPLY          = {curve_supply_wei};")
    print(f"uint256 constant LP_RESERVE_SUPPLY     = {lp_reserve_wei};")
    print(f"uint256 constant GRADUATION_RAISE_USDC = {grad_raise_wei};  // "
          f"{float(GRAD_RAISE_USD):,.0f} USDC")

    # Precision check: how far off is the rounded-to-wei version from exact?
    rounding_error_usd = abs(F(v_usdc_wei) / WEI - v_usdc)
    print()
    print(f"Rounding error from wei-quantization: {float(rounding_error_usd):.2e} USDC "
          f"(negligible — far below any displayed precision)")


if __name__ == "__main__":
    main()
