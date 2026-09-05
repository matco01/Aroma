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
 * Aroma's own deployed contracts, live on Arc testnet.
 *
 * Deployed and exercised end to end on 2026-09-03: launch, dev-buy, public
 * buy, permit sell, and creator-fee claim all confirmed on-chain. Mainnet
 * addresses go here once Arc mainnet is live and Uniswap v4 graduation is
 * wired up — see contracts/README.md.
 */
export const ARC_TESTNET_CONTRACTS = {
  curveManager: "0x98D436Bb667300Fc60fCeF23DFd6d797Ab287f09",
  aromaFactory: "0x8cE3Dd48f5981238Db315AaF0721790d667153B0",
  /** Holds graduated liquidity. Seeds a v4 pool where v4 exists; on
   *  testnet it has no PoolManager and simply holds the funds. */
  liquidityLocker: "0x965b96dF259Ad337596CEb5BE0768ed42971B761",
  /** Native USDC's ERC-20 interface. 6 decimals; the native view is 18. */
  usdc: "0x3600000000000000000000000000000000000000",
  /**
   * Block the factory was deployed in. Log scans start here rather than at
   * genesis — Arc is already past block 60,000,000 and the public RPC
   * rejects a range that wide outright. Update on any redeploy.
   */
  deployBlock: 60_601_584n,
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
