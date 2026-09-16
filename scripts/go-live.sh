#!/usr/bin/env bash
#
# Deploys the pool system to Arc mainnet and wires the repo to what it
# deployed.
#
# Launch day is the worst time to be reading a runbook and typing addresses
# into three files by hand, so this is LAUNCH.md sections 1 through 3 as one
# command. It is deliberately not clever: every step prints what it did, and
# any failure stops the script before the next one can build on it.
#
#   ./scripts/go-live.sh              # dry run: builds, mines, deploys nothing
#   ./scripts/go-live.sh --broadcast  # the real thing
#
# Needs contracts/.env to hold DEPLOYER_PRIVATE_KEY and PROTOCOL_OWNER.
#
# What it does, in order:
#
#   1. Refuses to start if the deployer cannot pay gas, because a broadcast
#      that dies midway leaves the contracts half-deployed at addresses this
#      script has already promised are deterministic.
#   2. forge clean && forge build. Not optional — `forge script` has deployed
#      stale bytecode from a warm cache before, with the whole suite green.
#   3. Records the chain head *before* broadcasting, which becomes deployBlock
#      and the subgraph's startBlock. Earlier than the truth only costs a few
#      seconds of extra scanning; later would silently miss the first launches.
#   4. Deploys, and reads the three addresses back out of forge's own output
#      rather than recomputing them.
#   5. Verifies the deployed runtime code against this build before any of
#      those addresses go into a file.
#   6. Writes them into src/lib/arc.ts and subgraph/subgraph.pool.yaml, then
#      shows the diff.
#
# It stops short of committing, pushing, or calling acceptOwnership. Those are
# decisions, not steps.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

RPC="${ARC_MAINNET_RPC_URL:-https://rpc.mainnet.arc.io}"
POOL_MANAGER_ADDR="0x8366a39cc670b4001a1121b8f6a443a643e40951"
BROADCAST=""
[ "${1:-}" = "--broadcast" ] && BROADCAST="--broadcast"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

say "0. environment"
[ -f contracts/.env ] || { echo "contracts/.env missing"; exit 1; }
set -a; . ./contracts/.env; set +a
: "${DEPLOYER_PRIVATE_KEY:?not set in contracts/.env}"
export POOL_MANAGER="$POOL_MANAGER_ADDR"

DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
OWNER="${PROTOCOL_OWNER:-$DEPLOYER}"
CHAIN=$(cast chain-id --rpc-url "$RPC")
echo "  rpc:      $RPC (chain $CHAIN)"
echo "  deployer: $DEPLOYER"
echo "  owner:    $OWNER"

[ "$CHAIN" = "5042" ] || { echo "  refusing: expected Arc mainnet (5042)"; exit 1; }

BAL=$(cast balance --rpc-url "$RPC" "$DEPLOYER")
echo "  balance:  $(cast from-wei "$BAL") USDC"
if [ "$BAL" = "0" ]; then
  echo
  echo "  The deployer cannot pay gas. Send USDC on Arc mainnet to:"
  echo "    $DEPLOYER"
  echo "  The full deploy costs well under a dollar; \$5 is plenty."
  exit 1
fi

# The PoolManager is the one address this whole system is pinned to. If it has
# no code, everything below would deploy successfully and then never work.
CODE=$(cast code --rpc-url "$RPC" "$POOL_MANAGER_ADDR")
[ ${#CODE} -gt 2 ] || { echo "  refusing: no Uniswap v4 PoolManager at $POOL_MANAGER_ADDR"; exit 1; }
echo "  v4 manager: ${#CODE} hex chars of code"

say "1. clean build"
(cd contracts && forge clean && forge build)

say "2. tests"
(cd contracts && forge test)

say "3. chain head before broadcast"
DEPLOY_BLOCK=$(cast block-number --rpc-url "$RPC")
echo "  deployBlock will be $DEPLOY_BLOCK"

say "4. deploy ${BROADCAST:-(dry run)}"
OUT="$(cd contracts && forge script script/DeployPool.s.sol --tc DeployPool \
  --rpc-url "$RPC" $BROADCAST --slow 2>&1)"
echo "$OUT" | grep -E "hook flags|required flags|PoolVault:|PoolFactory:|AromaRouter:|factory set:|vault -> mgr:|router -> mgr:|owner now:|owner pending:" || true

pick() { echo "$OUT" | grep -oE "$1: +0x[0-9a-fA-F]{40}" | head -1 | grep -oE "0x[0-9a-fA-F]{40}"; }
VAULT=$(pick "PoolVault"); FACTORY=$(pick "PoolFactory"); ROUTER=$(pick "AromaRouter")
[ -n "$VAULT" ] && [ -n "$FACTORY" ] && [ -n "$ROUTER" ] || { echo "$OUT" | tail -40; exit 1; }

FLAGS=$(echo "$OUT" | grep -oE "hook flags: +[0-9]+" | grep -oE "[0-9]+$")
NEED=$(echo "$OUT" | grep -oE "required flags: +[0-9]+" | grep -oE "[0-9]+$")
[ "$FLAGS" = "$NEED" ] || { echo "  hook flags $FLAGS != required $NEED"; exit 1; }
echo "  hook flags match ($FLAGS)"

if [ -z "$BROADCAST" ]; then
  echo
  echo "  Dry run only. Nothing was deployed and no file was changed."
  echo "  Re-run with --broadcast to go live."
  exit 0
fi

say "5. verify deployed bytecode"
(cd contracts && node script/verify-bytecode.mjs "$RPC" \
  "PoolVault=$VAULT" "PoolFactory=$FACTORY" "AromaRouter=$ROUTER")

say "6. wire the repo to what was deployed"
python - "$VAULT" "$FACTORY" "$ROUTER" "$DEPLOY_BLOCK" <<'PY'
import io, re, sys
vault, factory, router, block = sys.argv[1:5]

p = "src/lib/arc.ts"
s = io.open(p, encoding="utf-8").read()
head, sep, tail = s.partition("export const ARC_MAINNET_CONTRACTS")
assert sep, "ARC_MAINNET_CONTRACTS not found"
body, sep2, rest = tail.partition("};")
for key, val in (("poolFactory", factory), ("poolVault", vault), ("aromaRouter", router)):
    body, n = re.subn(rf'({key}: )"[^"]*"', rf'\1"{val}"', body, count=1)
    assert n == 1, key
body, n = re.subn(r'(deployBlock: )\d+n', rf'\g<1>{block}n', body, count=1)
assert n == 1, "deployBlock"
io.open(p, "w", encoding="utf-8").write(head + sep + body + sep2 + rest)
print("  src/lib/arc.ts updated")

p = "subgraph/subgraph.pool.yaml"
s = io.open(p, encoding="utf-8").read()
# Each data source is `name: X` ... `address: "0x.."` ... `startBlock: N`.
for name, addr in (("PoolFactory", factory), ("PoolVault", vault)):
    s, n = re.subn(
        rf'(name: {name}\n(?:.*\n)*?\s+address: )"0x[0-9a-fA-F]*"',
        rf'\1"{addr}"', s, count=1)
    assert n == 1, name
s = re.sub(r'startBlock: \d+', f'startBlock: {block}', s)
io.open(p, "w", encoding="utf-8").write(s)
print("  subgraph/subgraph.pool.yaml updated (all three startBlocks)")
PY

git --no-pager diff --stat src/lib/arc.ts subgraph/subgraph.pool.yaml
git --no-pager diff src/lib/arc.ts

say "live"
cat <<EOF
  PoolVault    $VAULT
  PoolFactory  $FACTORY
  AromaRouter  $ROUTER
  deployBlock  $DEPLOY_BLOCK

  Still to do, in this order:

  1. Accept ownership, from $OWNER:
       cast send --rpc-url $RPC --private-key <owner key> \\
         $VAULT "acceptOwnership()"
     Until this lands the deployer still controls fee withdrawal.

  2. On Railway, before the deploy that follows:
       NEXT_PUBLIC_ARC_RPC_URL = $RPC   (set it as a build arg too)
       SUBGRAPH_URL            = empty, until the subgraph has synced
     A build still carrying the testnet URL now fails loudly rather than
     serving testnet coins, but it does fail — set it first.

  3. Commit and push master. Railway deploys from it.

  4. Deploy the subgraph:
       cd subgraph && npx graph deploy --node <goldsky> subgraph.pool.yaml
     Then set SUBGRAPH_URL once it reports synced.

  5. Smoke test per LAUNCH.md section 6: launch one coin with a small dev buy
     and confirm the opening tick is 123546.
EOF
