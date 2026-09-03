#!/usr/bin/env python3
"""
Generates src/lib/abis.ts from the Foundry build output.

Deliberately trimmed rather than dumping full ABIs: the frontend only ever
calls a handful of functions, and shipping every internal getter and event
to the browser is bundle weight for nothing. Adding a new call in the UI
means adding its name to WANT below and re-running.

    forge build && python scripts/gen-abis.py
"""

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent

WANT = {
    "CurveManager": {
        "buy", "sell", "quoteBuy", "quoteSell", "tokenState", "creatorFeesAccrued",
        "claimCreatorFees", "graduate", "GRADUATION_RAISE_USDC", "CURVE_SUPPLY",
        "TOTAL_SUPPLY", "TRADE_FEE_BPS", "CREATOR_FEE_SHARE_BPS", "MAX_DEV_BUY_USDC",
        "Bought", "Sold", "Graduated", "TokenRegistered",
    },
    "AramFactory": {"createToken", "TokenCreated", "TOTAL_SUPPLY"},
    "AramToken": {
        "name", "symbol", "balanceOf", "totalSupply", "nonces",
        "DOMAIN_SEPARATOR", "permit",
    },
}


def load_abi(name: str):
    path = ROOT / "contracts" / "out" / f"{name}.sol" / f"{name}.json"
    if not path.exists():
        raise SystemExit(f"missing {path} — run `forge build` in contracts/ first")
    return json.load(open(path))["abi"]


def main() -> None:
    lines = [
        "/**",
        " * ABIs for aram's deployed contracts, generated from the Foundry build.",
        " *",
        " * Regenerate with `npm run abis` after any contract change — these are",
        " * trimmed to what the frontend actually calls, so a new function used in",
        " * the UI needs adding to the WANT list in scripts/gen-abis.py first.",
        " */",
        "",
    ]

    for contract, names in WANT.items():
        abi = load_abi(contract)
        kept = [e for e in abi if e.get("name") in names]
        missing = names - {e.get("name") for e in kept}
        if missing:
            raise SystemExit(f"{contract}: requested names not found in ABI: {sorted(missing)}")
        print(f"{contract}: kept {len(kept)}/{len(abi)} entries")
        var = contract[0].lower() + contract[1:]
        lines.append(f"export const {var}Abi = {json.dumps(kept, indent=2)} as const;")
        lines.append("")

    (ROOT / "src" / "lib" / "abis.ts").write_text("\n".join(lines), encoding="utf-8")
    print("wrote src/lib/abis.ts")


if __name__ == "__main__":
    main()
