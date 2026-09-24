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
    "AromaFactory": {"createToken", "TokenCreated", "TOTAL_SUPPLY"},
    "AromaToken": {
        "name", "symbol", "balanceOf", "totalSupply", "nonces",
        "DOMAIN_SEPARATOR", "permit",
    },
    "PoolFactoryUsdg": {"createToken", "TokenCreated", "TOTAL_SUPPLY", "MAX_DEV_BUY_USDC"},
    "AromaRouterUsdg": {"buy", "sell", "Bought", "Sold"},
    "ClubAuction": {
        "bid", "updateDraft", "withdraw", "claimCreatorFeesFor", "getCurrentClub",
        "pendingReturns", "winnerOf", "roundDuration", "minOpeningBid",
        "minBidIncrementBps", "antiSnipeExtension",
        "ClubOpened", "ClubBid", "ClubDraftUpdated", "ClubLaunched", "ClubVoided",
    },
}


def load_abi(name: str):
    path = ROOT / "contracts" / "out" / f"{name}.sol" / f"{name}.json"
    if not path.exists():
        raise SystemExit(f"missing {path} — run `forge build` in contracts/ first")
    return json.load(open(path))["abi"]


# Not generated from a build artifact: USDG is Robinhood Chain's own token,
# not one of ours, so there is no contracts/out/USDG.sol to read an ABI from.
# Hand-written to the plain EIP-20 + EIP-2612 interface, confirmed against
# Paxos's own usdg-contract README — the same shape AromaToken already
# implements, which is exactly why ClubAuction/AromaRouterUsdg can take a
# permit for USDG the same way CurveManager/AromaRouter already do for the
# launched token.
ERC20_PERMIT_ABI = [
    {
        "type": "function", "name": "name", "stateMutability": "view",
        "inputs": [], "outputs": [{"name": "", "type": "string"}],
    },
    {
        "type": "function", "name": "balanceOf", "stateMutability": "view",
        "inputs": [{"name": "account", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function", "name": "allowance", "stateMutability": "view",
        "inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function", "name": "nonces", "stateMutability": "view",
        "inputs": [{"name": "owner", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function", "name": "DOMAIN_SEPARATOR", "stateMutability": "view",
        "inputs": [], "outputs": [{"name": "", "type": "bytes32"}],
    },
    {
        "type": "function", "name": "permit", "stateMutability": "nonpayable",
        "inputs": [
            {"name": "owner", "type": "address"}, {"name": "spender", "type": "address"},
            {"name": "value", "type": "uint256"}, {"name": "deadline", "type": "uint256"},
            {"name": "v", "type": "uint8"}, {"name": "r", "type": "bytes32"},
            {"name": "s", "type": "bytes32"},
        ],
        "outputs": [],
    },
]


def main() -> None:
    lines = [
        "/**",
        " * ABIs for Aroma's deployed contracts, generated from the Foundry build.",
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

    lines.append(f"export const erc20PermitAbi = {json.dumps(ERC20_PERMIT_ABI, indent=2)} as const;")
    lines.append("")

    (ROOT / "src" / "lib" / "abis.ts").write_text("\n".join(lines), encoding="utf-8")
    print("wrote src/lib/abis.ts")


if __name__ == "__main__":
    main()
