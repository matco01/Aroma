#!/usr/bin/env node
/**
 * Confirms the contracts on a chain are the contracts in this repository.
 *
 * Run after every deploy, before telling anyone an address:
 *
 *   forge clean && forge build
 *   node script/verify-bytecode.mjs <rpc-url> PoolVault=0x.. PoolFactory=0x.. AromaRouter=0x..
 *
 * Why this exists. On 2026-09-15 a deploy of the pool system to a local fork
 * shipped an AromaRouter from *before* the partial-fill fix, with every test
 * passing. `new AromaRouter(...)` bakes the router's creation code into the
 * deploy script's own artifact; `forge test --match-path` had recompiled the
 * router and the tests and marked AromaRouter.sol current in the shared cache,
 * without rebuilding the script that embeds it. `forge script` then reported
 * "No files changed, compilation skipped" and deployed the stale copy. On
 * mainnet that would have been a loss-of-funds bug, live, behind a green
 * suite. Nothing in Foundry's output says it happened.
 *
 * So this reads the runtime code actually at each address and compares it
 * with a fresh build's deployedBytecode, byte for byte, with two things
 * masked:
 *
 *   - immutables, which the constructor writes into the code and which differ
 *     per deployment by design (the pool manager, the vault);
 *   - the trailing CBOR metadata, which hashes source paths as well as source
 *     and can differ between machines without the code differing.
 *
 * Anything else that differs is a different contract, and the exit code says
 * so.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "out");

const [rpc, ...pairs] = process.argv.slice(2);
if (!rpc || pairs.length === 0) {
  console.error("usage: node script/verify-bytecode.mjs <rpc-url> Name=0xaddress [Name=0xaddress ...]");
  process.exitCode = 2;
  throw new Error("missing arguments");
}

async function getCode(address, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
      });
      const json = await res.json();
      if (typeof json.result === "string") return json.result.toLowerCase().replace(/^0x/, "");
    } catch {
      // Retried below. Some endpoints drop a request now and then.
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`no answer for eth_getCode(${address}) after ${attempts} attempts`);
}

/** Length of solc's CBOR metadata tail: the last two bytes encode it. */
function metadataLength(hex) {
  if (hex.length < 4) return 0;
  const len = parseInt(hex.slice(-4), 16);
  return (len + 2) * 2 <= hex.length ? (len + 2) * 2 : 0;
}

function mask(hex, ranges) {
  const chars = hex.split("");
  for (const { start, length } of ranges) {
    for (let i = start * 2; i < (start + length) * 2 && i < chars.length; i++) chars[i] = "0";
  }
  return chars.join("");
}

let failed = false;

for (const pair of pairs) {
  const [name, address] = pair.split("=");
  const artifact = JSON.parse(readFileSync(join(OUT, `${name}.sol`, `${name}.json`), "utf8"));
  const expected = artifact.deployedBytecode.object.toLowerCase().replace(/^0x/, "");
  const immutables = Object.values(artifact.deployedBytecode.immutableReferences ?? {}).flat();

  const onchain = await getCode(address);
  if (onchain.length === 0) {
    console.log(`  FAIL  ${name.padEnd(12)} ${address}  no code at this address`);
    failed = true;
    continue;
  }

  const eMeta = metadataLength(expected);
  const oMeta = metadataLength(onchain);
  const eCode = mask(expected.slice(0, expected.length - eMeta), immutables);
  const oCode = mask(onchain.slice(0, onchain.length - oMeta), immutables);

  if (eCode === oCode) {
    const metaSame = expected.slice(-eMeta) === onchain.slice(-oMeta);
    console.log(
      `  PASS  ${name.padEnd(12)} ${address}  ${oCode.length / 2} bytes match this build` +
        (metaSame ? "" : "  (metadata differs: built elsewhere, same code)"),
    );
  } else {
    let firstDiff = 0;
    while (firstDiff < Math.min(eCode.length, oCode.length) && eCode[firstDiff] === oCode[firstDiff]) firstDiff++;
    console.log(
      `  FAIL  ${name.padEnd(12)} ${address}  on-chain ${oCode.length / 2} bytes, this build ${eCode.length / 2} bytes, ` +
        `first difference at byte ${Math.floor(firstDiff / 2)}. NOT the contract in this repository.`,
    );
    failed = true;
  }
}

if (failed) {
  console.log("\n  Do not publish these addresses. Run `forge clean && forge build`, redeploy, and verify again.");
}
// exitCode rather than exit(): on Windows, exiting while fetch's sockets are
// still closing trips a libuv assertion and replaces the code with 127.
process.exitCode = failed ? 1 : 0;
