import { chromium } from "playwright";
import fs from "node:fs";

/**
 * Verifies the wallet integration end to end without a browser extension.
 *
 * Headless Chromium has no MetaMask, so this injects a minimal EIP-1193
 * provider that answers account/chain queries locally and forwards
 * everything else to the real Arc testnet RPC. That means the balance the
 * page renders is genuinely read from chain — this isn't a mock all the
 * way down, only the wallet's key-holding half is stubbed.
 */

const BASE = process.env.BASE || "http://localhost:3111";
const OUT = process.env.OUT || ".";
const RPC = process.env.ARC_RPC || "https://rpc.testnet.arc.io";
const ACCOUNT = (process.env.ACCOUNT || "0x776d63784aF98DA3CE9cFf020D2ea6bf67a12EcB").toLowerCase();
const CHAIN_ID_HEX = "0x4cef52"; // 5042002

fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 2 });

// Injected before any page script runs, so wagmi's connector discovery
// sees it exactly as it would a real extension.
await ctx.addInitScript(
  ({ account, chainIdHex, rpc }) => {
    const listeners = {};
    const provider = {
      isMetaMask: true,
      _isInjectedTestProvider: true,
      async request({ method, params }) {
        switch (method) {
          case "eth_requestAccounts":
          case "eth_accounts":
            return [account];
          case "eth_chainId":
            return chainIdHex;
          case "net_version":
            return String(parseInt(chainIdHex, 16));
          case "wallet_switchEthereumChain":
          case "wallet_addEthereumChain":
            return null;
          default: {
            // Everything else goes to the real chain.
            const res = await fetch(rpc, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params ?? [] }),
            });
            const json = await res.json();
            if (json.error) throw new Error(json.error.message);
            return json.result;
          }
        }
      },
      on(event, handler) {
        (listeners[event] ||= []).push(handler);
      },
      removeListener(event, handler) {
        listeners[event] = (listeners[event] || []).filter((h) => h !== handler);
      },
    };

    window.ethereum = provider;

    // EIP-6963: how modern wagmi actually discovers wallets.
    const info = {
      uuid: "11111111-2222-3333-4444-555555555555",
      name: "Test Wallet",
      rdns: "dev.aroma.testwallet",
      icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
    };
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }),
      );
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  },
  { account: ACCOUNT, chainIdHex: CHAIN_ID_HEX, rpc: RPC },
);

const page = await ctx.newPage();
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`[console] ${m.text()}`);
});
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));

await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
await page.screenshot({ path: `${OUT}/01-disconnected.png` });
console.log("shot 01-disconnected");

// An injected provider that answers eth_accounts without prompting gets
// picked up by wagmi's autoConnect, so the header may already show a
// balance before anything is clicked. Only click Connect if it's actually
// offered.
const connectButton = page.getByRole("button", { name: "Connect", exact: true });
if (await connectButton.isVisible().catch(() => false)) {
  console.log("clicking Connect");
  await connectButton.click();
} else {
  console.log("already auto-connected (wagmi reconnect)");
}

// Wait for the header to show a balance rather than the Connect label —
// that only happens once wagmi has the account *and* the balance query has
// come back from the real chain.
await page
  .locator("header")
  .getByText(/\$\d/)
  .first()
  .waitFor({ timeout: 30000 });

await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/02-connected.png` });
console.log("shot 02-connected");

const headerText = await page.locator("header").innerText();
console.log("\nheader after connect:");
console.log("  " + headerText.replace(/\n+/g, " | "));

// Portfolio uses the same wallet state.
await page.goto(`${BASE}/portfolio`, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/03-portfolio.png` });
console.log("shot 03-portfolio");

await browser.close();

if (errors.length) {
  console.log("\n=== CONSOLE ERRORS ===");
  for (const e of [...new Set(errors)]) console.log(e);
  process.exitCode = 1;
} else {
  console.log("\nno console errors");
}
