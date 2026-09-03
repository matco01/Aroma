#!/usr/bin/env python3
"""
Reports what the current curve parameters actually imply for a trader:
starting market cap, upside to graduation, and — the one that matters most —
whether the graduation pool gets seeded at the same price the curve ended at.

A launchpad curve has three numbers people feel: where a coin starts, where
it graduates, and whether the jump into the DEX pool is smooth. Two of those
were never checked when the reserves were derived.
"""

from fractions import Fraction as F

TOTAL_SUPPLY = F(1_000_000_000)
GRAD_RAISE = F(24_000)
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
report(CURVE_SUPPLY, GRAD_RAISE, GRAD_MCAP, label="as deployed (800M / 200M)")

f = lp_fraction_for_continuity(GRAD_RAISE, GRAD_MCAP)
print(f"For a smooth handover the LP reserve must be {float(f)*100:.1f}% of supply,")
print(f"i.e. {float(f*TOTAL_SUPPLY):,.0f} tokens — not {float(LP_RESERVE):,.0f}.")
print()

print("=" * 64)
print("OPTION A — fix continuity, keep $24k raise and $69k graduation")
print("=" * 64)
report(TOTAL_SUPPLY * (1 - f), GRAD_RAISE, GRAD_MCAP, label="continuous split")

print("=" * 64)
print("OPTION B — pump.fun-like shape (lower raise => steeper curve)")
print("=" * 64)
# pump.fun reserves ~20.7% for the pool, which by the identity above means
# raise/mcap ~= 0.207.
for raise_target in [F(8_000), F(12_000), F(14_000)]:
    frac = lp_fraction_for_continuity(raise_target, GRAD_MCAP)
    report(
        TOTAL_SUPPLY * (1 - frac),
        raise_target,
        GRAD_MCAP,
        label=f"${float(raise_target):,.0f} raise -> $69k graduation",
    )

print("=" * 64)
print("REFERENCE — pump.fun's real curve, for comparison")
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
