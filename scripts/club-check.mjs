import { chromium } from "playwright";
import fs from "node:fs";
import { createPublicClient, createWalletClient, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";

/**
 * Club coins through the real UI, end to end, against a fork with both contract
 * systems deployed.
 *
 *   BASE=http://127.0.0.1:3021 RPC=http://127.0.0.1:8549 \
 *   CLUB_VAULT=0x.. OUT=./shots node scripts/club-check.mjs
 *
 * Three wallets in three separate browser contexts, the way three different
 * people would arrive:
 *
 *   1. a creator picks Club on the launch form, launches, and makes an invite
 *      link from the coin page — a real EIP-712 signature;
 *   2. someone opens that link, is told they are invited, and joins by buying;
 *   3. someone with no invite opens the same coin and cannot buy.
 *
 * Then the second wallet opens an ordinary coin, to check that normal coins
 * still trade exactly as before with clubs switched on.
 */

const BASE = process.env.BASE ?? "http://127.0.0.1:3021";
const RPC = process.env.RPC ?? "http://127.0.0.1:8549";
const OUT = process.env.OUT ?? ".";
const CLUB_VAULT = process.env.CLUB_VAULT;
const MNEMONIC = "test test test test test test test test test test test junk";
if (!CLUB_VAULT) throw new Error("CLUB_VAULT required");
fs.mkdirSync(OUT, { recursive: true });

const chain = {
  id: 5042,
  name: "Arc fork",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
const publicClient = createPublicClient({ chain, transport: http(RPC) });

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ args: ["--no-sandbox"] });

/** A browser context with its own wallet, announced the way extensions do. */
async function person(index, label) {
  const account = mnemonicToAccount(MNEMONIC, { addressIndex: index });
  await publicClient.request({ method: "anvil_setBalance", params: [account.address, "0x21E19E0C9BAB2400000"] });
  const wallet = createWalletClient({ account, chain, transport: http(RPC) });

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  await ctx.exposeBinding("__walletRpc", async (_s, { method, params }) => {
    params = params ?? [];
    if (method === "eth_sendTransaction") {
      const [tx] = params;
      return wallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value ? BigInt(tx.value) : undefined,
        gas: tx.gas ? BigInt(tx.gas) : undefined,
      });
    }
    if (method === "eth_signTypedData_v4") {
      const typed = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
      const types = { ...typed.types };
      delete types.EIP712Domain;
      return wallet.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message });
    }
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
  });
  await ctx.addInitScript(({ address }) => {
    const provider = {
      isMetaMask: true,
      async request({ method, params }) {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [address];
        if (method === "eth_chainId") return "0x13b2";
        if (method === "net_version") return "5042";
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        return window.__walletRpc({ method, params });
      },
      on() {},
      removeListener() {},
    };
    window.ethereum = provider;
    const info = {
      uuid: "33333333-4444-5555-6666-777777777777",
      name: "Test Wallet",
      rdns: "dev.aroma.testwallet",
      icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
    };
    const announce = () =>
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  }, { address: account.address });

  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [${label} pageerror] ${e.message.slice(0, 160)}`));
  return { account, page, ctx, label };
}

async function connect(p) {
  const button = p.page.getByRole("button", { name: "Connect", exact: true });
  if (await button.isVisible().catch(() => false)) await button.click();
  await p.page.locator("header").getByText(/\$\d/).first().waitFor({ timeout: 30000 });
}

const isMember = (token, who) =>
  publicClient.readContract({
    address: CLUB_VAULT,
    abi: [{ type: "function", name: "isMember", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "bool" }] }],
    functionName: "isMember",
    args: [token, who],
  });

// ---------------------------------------------------------------- 1. creator
const creator = await person(60, "creator");
await creator.page.goto(`${BASE}/create`, { waitUntil: "networkidle" });
await connect(creator);

const clubOption = creator.page.getByRole("radio", { name: /Club/ });
check("the launch form offers Club", await clubOption.isVisible());
await clubOption.click();
check("choosing Club selects it", (await clubOption.getAttribute("aria-checked")) === "true");

await creator.page.getByPlaceholder("Dollar Doge").fill("Browser Club");
await creator.page.getByPlaceholder("DOGEUSD").fill("BCLUB");
await creator.page.getByPlaceholder("0.00").fill("10");
const launchButton = creator.page.getByRole("button", { name: "Launch club" });
check("the button says Launch club", await launchButton.isVisible());
await creator.page.screenshot({ path: `${OUT}/c1-create-club.png` });
await launchButton.click();
await creator.page.getByText(/is live/).waitFor({ timeout: 90000 });
check("the success screen talks about invites", await creator.page.getByText(/invite-only club/).isVisible());
await creator.page.getByRole("link", { name: "View token" }).click();
await creator.page.waitForURL(/\/coin\/0x/, { timeout: 30000 });
const token = creator.page.url().match(/\/coin\/(0x[0-9a-fA-F]{40})/)[1];
console.log(`  token ${token}`);

await creator.page.getByRole("button", { name: "Create invite link" }).waitFor({ timeout: 60000 });
check("creator is a member on-chain", await isMember(token, creator.account.address));
check("the creator sees 10 invites", await creator.page.getByText("10 of 10 left").isVisible());
await creator.page.getByRole("button", { name: "Create invite link" }).click();
const linkBox = creator.page.getByRole("textbox", { name: "Invite link" });
await linkBox.waitFor({ timeout: 30000 });
const link = await linkBox.inputValue();
// Addresses compared case-insensitively: the page URL carries the checksummed
// form and the link the lowercase one, and both route to the same coin.
check(
  "an invite link was made",
  link.toLowerCase().includes(`/coin/${token.toLowerCase()}?invite=`),
  `${link.length} chars`,
);
await creator.page.screenshot({ path: `${OUT}/c2-invite-link.png`, fullPage: true });

// ---------------------------------------------------------------- 2. invitee
const invitee = await person(61, "invitee");
await invitee.page.goto(link, { waitUntil: "networkidle" });
await invitee.page.getByText(/been invited|You're invited/).first().waitFor({ timeout: 60000 });
check("the invitee is told they're invited before connecting", true);
await connect(invitee);
await invitee.page.getByText(/You're invited by/).waitFor({ timeout: 60000 });
check("once connected, the notice explains joining", true);
await invitee.page.getByRole("textbox", { name: /You pay/ }).fill("5");
const joinButton = invitee.page.getByRole("button", { name: "Join & buy BCLUB" });
await joinButton.waitFor({ timeout: 30000 });
check("the buy button says Join & buy", true);
await invitee.page.screenshot({ path: `${OUT}/c3-invitee-join.png`, fullPage: true });
await joinButton.click();
await invitee.page.getByText(/^Bought/).waitFor({ timeout: 90000 });
check("the join buy went through", await isMember(token, invitee.account.address));
await invitee.page.getByText("3 of 3 left").waitFor({ timeout: 60000 });
check("the new member immediately sees their own 3 invites", true);
await invitee.page.screenshot({ path: `${OUT}/c4-new-member.png`, fullPage: true });

// ---------------------------------------------------------------- 3. stranger
const stranger = await person(62, "stranger");
await stranger.page.goto(`${BASE}/coin/${token}`, { waitUntil: "networkidle" });
await connect(stranger);
const inviteOnly = stranger.page.getByRole("button", { name: "Invite only" });
await inviteOnly.waitFor({ timeout: 60000 });
check("a stranger's buy button says Invite only", true);
check("and it is disabled", await inviteOnly.isDisabled());
check("and the notice explains why", await stranger.page.getByText(/need an invite link from a member/).isVisible());
check("the stranger is not a member on-chain", !(await isMember(token, stranger.account.address)));
await stranger.page.screenshot({ path: `${OUT}/c5-stranger.png`, fullPage: true });

// ---------------------------------------------------------------- 4. normal coins unchanged
const board = await (await fetch(`${BASE}/api/board`)).json();
const normal = board.tokens.find((c) => !c.club);
check("the board still lists a normal coin", Boolean(normal), normal?.ticker);
if (normal) {
  await stranger.page.goto(`${BASE}/coin/${normal.contract}`, { waitUntil: "networkidle" });
  await stranger.page.getByRole("textbox", { name: /You pay/ }).fill("2");
  const buyNormal = stranger.page.getByRole("button", { name: `Buy ${normal.ticker}` });
  await buyNormal.waitFor({ timeout: 60000 });
  check("a stranger can still buy a normal coin", await buyNormal.isEnabled());
  check("with no club notice on it", !(await stranger.page.getByText(/invite-only/i).isVisible()));
  check("and the normal 1% fee", await stranger.page.getByText(/1% fee/).isVisible());
  await buyNormal.click();
  await stranger.page.getByText(/^Bought/).waitFor({ timeout: 90000 });
  check("the normal-coin buy went through", true);
  await stranger.page.screenshot({ path: `${OUT}/c6-normal-coin.png`, fullPage: true });
}

await browser.close();
console.log(failures === 0 ? "\n  all passed" : `\n  ${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
