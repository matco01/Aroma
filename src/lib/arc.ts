/**
 * Arc chain constants.
 *
 * Arc is Circle's L1 where USDC is the *native gas token*, which is the whole
 * reason this launchpad can price everything in dollars with no oracle.
 *
 * The decimals split is the sharp edge to remember:
 *   - native interface (gas, native value transfer) = 18 decimals
 *   - ERC-20 interface (app-level transfers)        = 6 decimals
 * Same balance, two views. Mixing them up is the classic Arc bug.
 *
 * Which chain a build actually talks to is network.ts's decision; this file
 * only describes Arc's side of it.
 */

// ---------------------------------------------------------------------------
// Arc mainnet and the pool system — what Aroma launches on.
// ---------------------------------------------------------------------------

/**
 * Arc mainnet, chain 5042.
 *
 * The explorer is deliberately empty. As of 2026-09-16, launch day, Circle
 * has published no public mainnet explorer: arcscan.app has no address
 * record, and explorer.arc.io sits behind Circle's own Cloudflare Access
 * login. explorerUrl() returns null while this is empty and every explorer
 * link hides itself, which is better than sending people somewhere that
 * asks them to sign in to Circle. Fill it in when one exists.
 */
export const ARC_MAINNET = {
  id: 5042,
  name: "Arc",
  /**
   * Circle's own mainnet endpoint, open since the public launch. Used only
   * as the default when NEXT_PUBLIC_ARC_RPC_URL is unset — production should
   * set two providers there, per chain.ts, so one having a bad minute does
   * not stop everyone trading.
   */
  rpc: "https://rpc.mainnet.arc.io",
  explorer: "" as string,
  currency: { name: "USDC", symbol: "USDC", decimals: 18 },
} as const;

/**
 * The pool system's contracts on Arc mainnet.
 *
 * Empty until DeployPool.s.sol runs — see LAUNCH.md §1. While they are empty
 * `poolsDeployed` is false and the app says launches are coming rather than
 * offering buttons that would send transactions to the zero address.
 *
 * Addresses are code rather than environment variables on purpose: a wrong
 * address is a loss of funds, and a value that can differ between a build
 * and a deploy is a value nobody reviewed.
 */
export const ARC_MAINNET_CONTRACTS = {
  poolFactory: "0x1503ccF70A0E63DAfb47C35076D9408089DF0829",
  poolVault: "0xbD86C2F1bD9EB780d7B59Fa1F4feE04f62d260Cc",
  aromaRouter: "0x1c2c40ab442C48bDd9f00Dc344fF44d5B90CbA9e",
  /** Uniswap v4's singleton, per Uniswap's sdk-core address table. */
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  /** Block PoolVault was deployed in. Log scans start here. */
  deployBlock: 21108966n,
} as const;

/**
 * A local fork, for exercising the whole app before mainnet exists.
 *
 * Enabled with NEXT_PUBLIC_AROMA_NETWORK=local and never in production. The
 * fork is Ethereum mainnet under anvil, because Uniswap v4 is not deployed on
 * Arc testnet at any version; the substitution is exact for everything the
 * pool system touches — native currency at 18 decimals is all it asks of
 * currency0, and on Ethereum that is ETH where on Arc it is USDC.
 *
 * Addresses come from the environment here and only here, because they come
 * from whatever the local deploy printed.
 */
export const LOCAL = process.env.NEXT_PUBLIC_AROMA_NETWORK === "local";

export const LOCAL_NETWORK = {
  /**
   * anvil keeps the forked chain's id, so a fork of Arc answers 5042, not
   * 31337. The default is anvil's own id for a bare `anvil`; set
   * NEXT_PUBLIC_LOCAL_CHAIN_ID=5042 when forking Arc. Getting this wrong is
   * no longer quiet — chain.ts checks the endpoint's id against this one
   * before reading anything.
   */
  id: Number(process.env.NEXT_PUBLIC_LOCAL_CHAIN_ID ?? "31337"),
  name: "Local fork",
  rpc: "http://127.0.0.1:8545",
  explorer: "" as string,
  currency: { name: "USDC", symbol: "USDC", decimals: 18 },
} as const;

/**
 * Club coins on Arc — invite-only launches. See CLUBS.md.
 *
 * A second contract system beside the pool one, not a mode of it: a v4 pool's
 * hook is fixed when the pool is created, so a club coin and a normal coin
 * live in different vaults for their whole lives. Everything club-shaped in
 * the app is gated on `clubsDeployed`, so until these addresses exist the site
 * behaves exactly as it does without clubs — nothing to hide, because nothing
 * renders.
 */
export const ARC_MAINNET_CLUB_CONTRACTS = {
  clubFactory: "",
  clubVault: "",
  clubRouter: "",
  /** Block ClubVault was deployed in. Log scans start here. */
  deployBlock: 0n,
} as const;

/**
 * Mirrors the constants in ClubVault.sol, which ClubVaultUsdg shares exactly
 * — the club economics are the same on both chains.
 */
export const CLUB = {
  /** 1.5%. Pool geometry is identical to a normal coin; only this differs. */
  tradeFeeBps: 150,
  protocolFeeBps: 30,
  /** The creator's cut of every trade, at any depth. */
  rootFeeBps: 10,
  treeFeeBps: 110,
  /** How far up the tree one trade's fee travels. */
  maxDepth: 10,
  creatorSeats: 10,
  memberSeats: 3,
  /** Smallest buy that can redeem an invite. */
  minJoinUsd: 1,
  /**
   * How long an invite link stays valid. Long enough to survive being posted
   * and read a day later; short enough that an old link dug out of a chat
   * does not quietly work forever. Revoking is the tool for "right now".
   */
  inviteTtlSeconds: 7 * 24 * 60 * 60,
} as const;

/**
 * Pool-system economics, mirroring PoolVault.sol and PoolFactory.sol.
 *
 * Every number here is a consequence of the tick choices, not an independent
 * knob — contracts/script/math/derive_pool.py derives them and fails if the
 * contract has drifted. The market caps are what that script prints, which
 * is why they are not round: tick spacing 2 lands within 0.01% of the curve
 * system's $4,312.50 / $69,000 / $13,800, and the difference is stated rather
 * than rounded away.
 */
export const POOL = {
  totalSupply: 1_000_000_000,
  /** Sold across the 16x from the opening price to graduation. */
  saleSupply: 800_000_000,
  /** A second position continuing above graduation, never migrated. */
  reserveSupply: 200_000_000,

  openingMarketCapUsd: 4_312.55,
  graduationMarketCapUsd: 69_005.73,
  /** USDC the sale position holds once its range is fully bought. */
  graduationRaiseUsd: 13_800.65,
  /** Where the reserve position runs out, and with it all liquidity. */
  topMarketCapUsd: 1_104_172,
  /** USDC it takes to buy the whole supply from launch — no buy can fill past this. */
  totalRaiseUsd: 69_007,

  /** 1%, charged by the hook, always in USDC. */
  tradeFeeBps: 100,
  /** The creator's share of that fee. */
  creatorFeeShareBps: 7_000,
  /** PoolFactory.MAX_DEV_BUY_USDC. */
  maxDevBuyUsd: 2_000,

  tickSpacing: 2,
  tickInit: 123_546,
  tickGraduation: 95_818,
  tickReserveFloor: 68_090,
  saleLiquidity: "2215084467296721841999892",
  reserveLiquidity: "2215164928381102038775570",
} as const;

// ---------------------------------------------------------------------------
// Arc testnet and the bonding curve — parked.
//
// The curve system is not launching on mainnet. Its contracts stay deployed
// on testnet and everything below stays accurate for them, but nothing the
// app ships reads it any more.
// ---------------------------------------------------------------------------

export const ARC_TESTNET = {
  id: 5042002,
  name: "Arc Testnet",
  rpc: "https://rpc.testnet.arc.io",
  ws: "wss://rpc.testnet.arc.io",
  explorer: "https://testnet.arcscan.app",
  faucet: "https://faucet.circle.com",
  currency: { name: "USDC", symbol: "USDC", decimals: 18 },
} as const;

/**
 * Aroma's own deployed contracts, live on Arc testnet.
 *
 * Deployed and exercised end to end on 2026-09-03: launch, dev-buy, public
 * buy, permit sell, and creator-fee claim all confirmed on-chain. Mainnet
 * addresses go here once Arc mainnet is live and Uniswap v4 graduation is
 * wired up — see contracts/README.md.
 */
export const ARC_TESTNET_CONTRACTS = {
  curveManager: "0xEF036a1167e307b413a7F79AFC7d6A774Df8AC07",
  aromaFactory: "0xc11f086E1e45b3589b1F2B95FA8069Bc2a58D772",
  /** Holds graduated liquidity. Seeds a v4 pool where v4 exists; on
   *  testnet it has no PoolManager and simply holds the funds. */
  liquidityLocker: "0xeb80Abd167739E93393935863f035C94f8B667fF",
  /** Native USDC's ERC-20 interface. 6 decimals; the native view is 18. */
  usdc: "0x3600000000000000000000000000000000000000",
  /**
   * Block the factory was deployed in. Log scans start here rather than at
   * genesis — Arc is already past block 60,000,000 and the public RPC
   * rejects a range that wide outright. Update on any redeploy.
   */
  deployBlock: 60_641_627n,
} as const;

/** ERC-20 view of native USDC. Use for anything a user types or reads. */
export const USDC_ERC20_DECIMALS = 6;
/** Native view. Use for gas math and native value transfers. */
export const USDC_NATIVE_DECIMALS = 18;

/** Mempool floor documented by Arc. Surfaced in the UI so fees are never a surprise. */
export const MIN_MAX_FEE_PER_GAS_GWEI = 20;

/**
 * Protocol economics for the bonding curve.
 *
 * These are the source of truth the Solidity contracts must reproduce
 * exactly — see contracts/script/math/derive_curve.py, which derives the
 * curve's virtual reserves from these numbers, and CurveManager.sol, which
 * hardcodes the result. Changing anything here means re-running that script
 * and updating the contract constants; they are not independent.
 *
 * There is deliberately no creation fee: pump.fun's own published schedule
 * charges $0 to create a coin, and taxing creation works against the thing
 * that actually generates revenue here (trading volume across many tokens).
 * A creator pays Arc network gas and nothing else.
 */
export const CURVE = {
  /**
   * USDC that must flow into the curve before a token graduates.
   *
   * Not a free choice. The graduation pool is seeded with the raise and the
   * unsold tokens, so it opens at raise/lpReserveSupply; matching the price
   * the curve closed at forces
   *   lpReserveSupply / totalSupply === graduationTargetUsd / graduationMarketCapUsd
   * A 20% reserve against a $69,000 graduation therefore *is* $13,800.
   */
  graduationTargetUsd: 13_800,
  /** Market cap the curve reaches at graduation. */
  graduationMarketCapUsd: 69_000,
  /**
   * Market cap a token shows before anyone has bought anything — price is
   * quoted against the full supply, so a fresh coin is never $0. Derived,
   * not chosen: virtualUsdcReserve / virtualTokenReserve * totalSupply.
   * Worth stating plainly because it sets the upside on offer: $4,312.50 to
   * $69,000 is 16x.
   */
  startingMarketCapUsd: 4_312.5,
  /** Fixed supply minted at creation. Nothing is mintable afterwards. */
  totalSupply: 1_000_000_000,
  /** Of the fixed supply, the portion sold through the curve... */
  curveSupply: 800_000_000,
  /** ...and the portion held back to seed the pool at graduation. */
  lpReserveSupply: 200_000_000,
  /** Taken on each buy and sell, in basis points. */
  /**
   * Launch-window tax, when a creator switches it on. Both are the
   * contract's own maximums — CurveManager rejects anything higher — so
   * there is nothing to tune and nothing a creator can set that outlives
   * three seconds.
   */
  snipeWindowSeconds: 3,
  snipeStartBps: 9_900,

  tradeFeeBps: 100,
  /**
   * Share of each trade fee routed to the token's creator rather than the
   * protocol, in basis points of the fee. 70/30 matches Pons' own split.
   */
  creatorFeeShareBps: 7_000,
  /** Flat fee skimmed from the raise at graduation, in USDC. */
  graduationFeeUsd: 10,
  /**
   * The curve's virtual reserves, as 18-decimal strings.
   *
   * These must match CurveManager's own constants exactly — they're what
   * makes a price quoted in the UI agree with what the contract will
   * actually execute. Both sides come from
   * contracts/script/math/derive_curve.py; don't hand-edit either.
   */
  virtualUsdcReserve: "4600000000000000000000",
  virtualTokenReserve: "1066666666666666666666666667",
} as const;

/**
 * Market cap a token sits at after `raisedUsd` net USDC has entered its
 * curve. The same constant-product formula CurveManager uses:
 *
 *   price = (virtualUsdc + raised) / (virtualToken - sold)
 *
 * with `sold` derived from the invariant rather than tracked separately,
 * so a caller only needs to know how much went in.
 *
 * Used to preview what a creator's own dev-buy does to the opening market
 * cap — which is the number they will be judged on, and worth showing
 * before they commit rather than after.
 */
export function marketCapAfterRaise(raisedUsd: number): number {
  const vUsdc = Number(CURVE.virtualUsdcReserve) / 1e18;
  const vToken = Number(CURVE.virtualTokenReserve) / 1e18;
  const k = vUsdc * vToken;

  const netIn = raisedUsd * (1 - CURVE.tradeFeeBps / 10_000);
  const effUsdc = vUsdc + netIn;
  const effToken = k / effUsdc;
  if (effToken <= 0) return CURVE.graduationMarketCapUsd;

  return (effUsdc / effToken) * CURVE.totalSupply;
}
