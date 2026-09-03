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
 */

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
 * aram's own deployed contracts, live on Arc testnet.
 *
 * Deployed and exercised end to end on 2026-09-03: launch, dev-buy, public
 * buy, permit sell, and creator-fee claim all confirmed on-chain. Mainnet
 * addresses go here once Arc mainnet is live and Uniswap v4 graduation is
 * wired up — see contracts/README.md.
 */
export const ARC_TESTNET_CONTRACTS = {
  curveManager: "0x4697289C9F954BFf3FD44BC2B27801045Ccc1a5D",
  aramFactory: "0x371F53a3047e9081b136CfCe29c97689cf531b44",
  /** Native USDC's ERC-20 interface. 6 decimals; the native view is 18. */
  usdc: "0x3600000000000000000000000000000000000000",
  /**
   * Block the factory was deployed in. Log scans start here rather than at
   * genesis — Arc is already past block 60,000,000 and the public RPC
   * rejects a range that wide outright. Update on any redeploy.
   */
  deployBlock: 60_305_400n,
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
  /** USDC that must flow into the curve before a token graduates. */
  graduationTargetUsd: 24_000,
  /** Market cap the curve reaches at graduation. */
  graduationMarketCapUsd: 69_000,
  /** Fixed supply minted at creation. Nothing is mintable afterwards. */
  totalSupply: 1_000_000_000,
  /** Of the fixed supply, the portion sold through the curve... */
  curveSupply: 800_000_000,
  /** ...and the portion held back to seed the pool at graduation. */
  lpReserveSupply: 200_000_000,
  /** Taken on each buy and sell, in basis points. */
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
  virtualUsdcReserve: "18461538461538461538462",
  virtualTokenReserve: "1415384615384615384615384615",
} as const;
