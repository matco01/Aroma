import { chromium } from "playwright";
import fs from "node:fs";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Drives a real buy through the UI, end to end, against Arc testnet.
 *
 * The injected provider here actually signs: it holds the deployer key and
 * forwards eth_sendTransaction / eth_signTypedData_v4 to a viem wallet
 * client. So clicking "Buy" in the browser produces a genuine on-chain
 * transaction, not a simulation — which is the only way to know the whole
 * path works.
 */

const BASE = process.env.BASE || "http://localhost:3111";
const OUT = process.env.OUT || ".";
const RPC = process.env.ARC_RPC || "https://rpc.testnet.arc.io";
const PK = process.env.DEPLOYER_PRIVATE_KEY;
if (!PK) throw new Error("DEPLOYER_PRIVATE_KEY required");

fs.mkdirSync(OUT, { recursive: true });

const account = privateKeyToAccount(PK);
const CHAIN_ID_HEX = "0x4cef52";

const errors = [];
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 2 });

// The page-side shim just relays every request over a binding into Node,
// where the real signing happens.
await ctx.exposeBinding("__walletRpc", async (_source, { method, params }) => {
  return handleRpc(method, params ?? []);
});

await ctx.addInitScript(({ address, chainIdHex }) => {
  const provider = {
    isMetaMask: true,
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [address];
      if (method === "eth_chainId") return chainIdHex;
      if (method === "net_version") return String(parseInt(chainIdHex, 16));
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
      return window.__walletRpc({ method, params });
    },
    on() {},
    removeListener() {},
  };
  window.ethereum = provider;

  const info = {
    uuid: "22222222-3333-4444-5555-666666666666",
    name: "Test Wallet",
    rdns: "dev.aram.testwallet",
    icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
  };
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }),
    );
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}, { address: account.address, chainIdHex: CHAIN_ID_HEX });

const chain = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
const walletClient = createWalletClient({ account, chain, transport: http(RPC) });
const publicClient = createPublicClient({ chain, transport: http(RPC) });

async function handleRpc(method, params) {
  if (method === "eth_sendTransaction") {
    const [tx] = params;
    const hash = await walletClient.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value ? BigInt(tx.value) : undefined,
      gas: tx.gas ? BigInt(tx.gas) : undefined,
    });
    console.log("  -> sent tx", hash);
    return hash;
  }
  if (method === "eth_signTypedData_v4") {
    const [, json] = params;
    const typed = typeof json === "string" ? JSON.parse(json) : json;
    // viem wants the primary type's struct only, without EIP712Domain.
    const types = { ...typed.types };
    delete types.EIP712Domain;
    const sig = await walletClient.signTypedData({
      domain: typed.domain,
      types,
      primaryType: typed.primaryType,
      message: typed.message,
    });
    console.log("  -> signed permit");
    return sig;
  }
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

const page = await ctx.newPage();
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`[console] ${m.text()}`);
});
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));

console.log("account:", account.address);
console.log("balance before:", await publicClient.getBalance({ address: account.address }));

/**
 * AppKit's modal is a web component that swallows pointer events across the
 * whole viewport while open. If a stray connect attempt left it up, close
 * it before trying to click anything underneath.
 */
async function dismissModal() {
  const modal = page.locator("w3m-modal.open");
  if (await modal.count()) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }
}

// --- board ---
await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
await page.getByText("GASFREE").first().waitFor({ timeout: 30000 });
await dismissModal();
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/01-board.png` });
console.log("shot 01-board (real tokens rendered)");

// --- open a token ---
await dismissModal();
await page.getByText("Gas Is Free").first().click();
await page.getByRole("button", { name: /Buy GASFREE|Enter an amount/ }).waitFor({ timeout: 30000 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/02-coin.png` });
console.log("shot 02-coin");

// --- real buy ---
const before = await publicClient.getBalance({ address: account.address });
await page.getByPlaceholder("0.00").first().fill("0.5");
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/03-quote.png` });

await dismissModal();
console.log("clicking Buy…");
await page.getByRole("button", { name: /^Buy GASFREE$/ }).click();

// Toast only appears after the receipt lands.
await page.getByText(/^Bought/).waitFor({ timeout: 90000 });
await page.screenshot({ path: `${OUT}/04-bought.png` });
console.log("shot 04-bought");

const after = await publicClient.getBalance({ address: account.address });
console.log("balance after: ", after);
console.log("spent (wei):   ", (before - after).toString());

// --- portfolio reflects it ---
await page.goto(`${BASE}/portfolio`, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/05-portfolio.png` });
console.log("shot 05-portfolio");

await browser.close();

if (errors.length) {
  console.log("\n=== CONSOLE ERRORS ===");
  for (const e of [...new Set(errors)]) console.log(e);
} else {
  console.log("\nno console errors");
}
