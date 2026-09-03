import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE || "http://localhost:3111";
const OUT = process.env.OUT || ".";
fs.mkdirSync(OUT, { recursive: true });

const errors = [];

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 950 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`[console] ${m.text()}`);
});
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));

async function shot(path, name, prep) {
  await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 60000 });
  if (prep) await prep();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot", name);
}

await shot("/", "01-board");

// List view exercises the dense-row layout.
await shot("/", "02-board-list", async () => {
  await page.getByLabel("List view").click();
  await page.waitForTimeout(250);
});

// Connect first so the trade panel shows its live state, not the CTA.
await shot("/coin/dollar-doge", "03-coin", async () => {
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByPlaceholder("0.00").first().fill("50");
  await page.waitForTimeout(250);
});

// Sell side of the same ticket — checks the buy/sell colour split.
await shot("/coin/dollar-doge", "03b-coin-sell", async () => {
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "sell", exact: true }).click();
  await page.getByPlaceholder("0.00").first().fill("25");
  await page.waitForTimeout(250);
});

// Successful buy — the toast should be floating top-right, mid-visible.
await shot("/coin/dollar-doge", "09-toast-buy", async () => {
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByPlaceholder("0.00").first().fill("505");
  await page.getByRole("button", { name: "Buy DOGEUSD" }).click();
  await page.waitForTimeout(180);
});

// Custom slippage input open.
await shot("/coin/dollar-doge", "10-custom-slippage", async () => {
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Custom", exact: true }).click();
  await page.getByLabel("Custom slippage percent").fill("2.4");
  await page.waitForTimeout(150);
});

// Portfolio with the seeded demo positions.
await shot("/portfolio", "07-portfolio", async () => {
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.waitForTimeout(300);
});

await shot("/create", "04-create", async () => {
  await page.getByPlaceholder("Dollar Doge").fill("Gas Is A Dollar");
  await page.getByPlaceholder("DOGEUSD").fill("GASBUCK");
  await page
    .getByPlaceholder("What is this coin about?")
    .fill("on arc the gas is usdc so the fee is a number you already understand");
  await page.waitForTimeout(250);
});

// Command menu overlay.
await shot("/", "05-search", async () => {
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(400);
  await page.keyboard.type("peg");
  await page.waitForTimeout(300);
});

// Mobile board.
const mob = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
});
const mp = await mob.newPage();
await mp.goto(BASE + "/", { waitUntil: "networkidle", timeout: 60000 });
await mp.waitForTimeout(500);
await mp.screenshot({ path: `${OUT}/06-mobile.png` });
console.log("shot", "06-mobile");

// Mobile portfolio — the row layout switches to stacked labels below sm.
await mp.goto(BASE + "/portfolio", { waitUntil: "networkidle", timeout: 60000 });
await mp.getByRole("button", { name: "Connect wallet" }).click();
await mp.waitForTimeout(300);
await mp.screenshot({ path: `${OUT}/08-mobile-portfolio.png` });
console.log("shot", "08-mobile-portfolio");

await browser.close();

if (errors.length) {
  console.log("\n=== CONSOLE ERRORS ===");
  for (const e of [...new Set(errors)]) console.log(e);
} else {
  console.log("\nno console errors");
}
