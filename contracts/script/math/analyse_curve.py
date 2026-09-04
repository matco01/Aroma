#!/usr/bin/env python3
"""
Reports what the current curve parameters actually imply for a trader:
starting market cap, upside to graduation, and — the one that matters most —
whether the graduation pool gets seeded at the same price the curve ended at.

A launchpad curve has three numbers people feel: where a coin starts, where
it graduates, and whether the handover into the DEX pool is smooth. The
original derivation checked only the middle one, which is how a 73.8% price
jump at graduation survived to a deployed contract.

Run this after touching any curve constant. derive_curve.py asserts
continuity and will fail outright; this prints the trader-facing numbers so
a change that is merely *bad* rather than *broken* is still visible.
"""

from fractions import Fraction as F

TOTAL_SUPPLY = F(1_000_000_000)
GRAD_RAISE = F(13_800)
GRAD_MCAP = F(69_000)
CURVE_SUPPLY = F(800_000_000)
LP_RESERVE = TOTAL_SUPPLY - CURVE_SUPPLY
GRAD_FEE = F(10)


def virtual_reserves(curve_supply, raise_target, grad_mcap, total_supply):
    """Same solve as derive_curve.py, parameterised so we can explore."""
    P = grad_mcap / total_supply
    coefficient = curve_supply / raise_target - 1 / P
    x = curve_supply / coefficient
    return x - raise_target, (curve_supply / raise_target) * x


def report(curve_supply, raise_target, grad_mcap, total_supply=TOTAL_SUPPLY, label=""):
    v_usdc, v_token = virtual_reserves(curve_supply, raise_target, grad_mcap, total_supply)
    lp_reserve = total_supply - curve_supply

    start_price = v_usdc / v_token
    start_mcap = start_price * total_supply
    grad_price = grad_mcap / total_supply

    # Price the DEX pool opens at, if seeded with the raise and the unsold
    # tokens. For no jump at graduation this must equal the curve's final
    # price.
    seed_usdc = raise_target - GRAD_FEE
    pool_price = seed_usdc / lp_reserve
    pool_mcap = pool_price * total_supply

    print(f"--- {label} ---")
    print(f"  curve supply / LP reserve : {float(curve_supply):,.0f} / {float(lp_reserve):,.0f}"
          f"  (LP is {float(lp_reserve/total_supply)*100:.1f}% of supply)")
    print(f"  starting market cap       : ${float(start_mcap):,.0f}")
    print(f"  graduation market cap     : ${float(grad_mcap):,.0f}")
    print(f"  upside, launch->graduation: {float(grad_mcap/start_mcap):.2f}x")
    print(f"  pool opens at market cap  : ${float(pool_mcap):,.0f}")
    jump = (pool_mcap / grad_mcap - 1) * 100
    verdict = "continuous" if abs(float(jump)) < 0.5 else f"JUMP {float(jump):+.1f}%"
    print(f"  curve -> pool price       : {verdict}")
    print()


def lp_fraction_for_continuity(raise_target, grad_mcap):
    """
    For the pool to open at the curve's closing price, the tokens held back
    must satisfy  raise / lpReserve == gradPrice,  which reduces to
    lpReserve/totalSupply == raise/gradMcap. Nothing else is free.
    """
    return raise_target / grad_mcap


print("=" * 64)
print("CURRENT PARAMETERS")
print("=" * 64)
report(CURVE_SUPPLY, GRAD_RAISE, GRAD_MCAP, label="as deployed (800M / 200M, $13,800 raise)")
report(CURVE_SUPPLY, F(24_000), GRAD_MCAP, label="the original $24,000 raise, for contrast")

required_lp = TOTAL_SUPPLY * GRAD_RAISE / GRAD_MCAP
print(f"Continuity requires an LP reserve of {float(required_lp):,.0f} tokens "
      f"({float(required_lp/TOTAL_SUPPLY)*100:.1f}% of supply);")
print(f"the deployed reserve is {float(LP_RESERVE):,.0f}. These agree, which is")
print("why the $13,800 raise is not a number anyone picked - it is forced by")
print("the 20% reserve and the $69,000 graduation.")
print()

print("=" * 64)
print("REFERENCE - pump.fun's real curve, for comparison")
print("=" * 64)
# 30 virtual SOL, 1.073B virtual tokens, ~85 SOL to graduate, 793.1M sold.
sol = F(150)  # rough USD; only the ratios matter
v_sol, v_tok = F(30), F(1_073_000_000)
start = (v_sol / v_tok) * sol * TOTAL_SUPPLY
grad = ((v_sol + 85) / (v_tok - F(793_100_000))) * sol * TOTAL_SUPPLY
print(f"  starting market cap       : ${float(start):,.0f}")
print(f"  graduation market cap     : ${float(grad):,.0f}")
print(f"  upside, launch->graduation: {float(grad/start):.2f}x")
print(f"  LP reserve                : {float((TOTAL_SUPPLY-793_100_000)/TOTAL_SUPPLY)*100:.1f}% of supply")
print()
print("aram now sits close to that shape: $4,313 -> $69,000 is 16.0x, and the")
print("LP reserve is 20% against pump.fun's 20.7%.")
