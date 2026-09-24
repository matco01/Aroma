/**
 * Robinhood Chain constants — where Aroma runs: invite-only club coins, each
 * launched by winning a 24-hour Club auction, settled in USDG.
 *
 * network.ts decides which chain a build talks to; this file only describes
 * Robinhood's side of it, as arc.ts describes Arc's.
 *
 * The sharp edge here is the opposite of Arc's: Arc's native gas token *is*
 * USDC, so value moves as native currency with 18 decimals. Robinhood Chain's
 * gas token is ETH, so Aroma settles in USDG instead — a plain ERC-20 with 6
 * decimals, moved by permit. Every USDG amount is 6-decimal; the launched
 * token itself stays 18-decimal, same as on Arc.
 */

export const ROBINHOOD_MAINNET = {
  id: 4663,
  name: "Robinhood Chain",
  // Robinhood's own docs recommend an Alchemy-backed URL for production;
  // this public endpoint is rate-limited. Set NEXT_PUBLIC_ROBINHOOD_RPC_URL.
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",
  explorerName: "Blockscout",
  faucet: "",
  currency: { name: "Ether", symbol: "ETH", decimals: 18 },
} as const;

export const ROBINHOOD_TESTNET = {
  id: 46630,
  name: "Robinhood Chain Testnet",
  rpc: "https://rpc.testnet.chain.robinhood.com",
  explorer: "https://explorer.testnet.chain.robinhood.com",
  explorerName: "Blockscout",
  faucet: "https://faucet.testnet.chain.robinhood.com",
  currency: { name: "Ether", symbol: "ETH", decimals: 18 },
} as const;

export const USDG_DECIMALS = 6;

/** ClubVaultUsdg.TICK_GRADUATION. Arc's pools end their sale at 95,818. */
export const USDG_TICK_GRADUATION = 372_142;

/**
 * Aroma's contracts on each network. Everything but `usdg` and `poolManager`
 * is empty until DeployRobinhood.s.sol runs, and while it is empty the app
 * says clubs are coming rather than offering buttons that would send
 * transactions to nowhere.
 *
 * Addresses are code rather than environment variables for the reason
 * arc.ts gives: a wrong address is a loss of funds, and a value that can
 * differ between a build and a deploy is a value nobody reviewed.
 *
 * Testnet has no USDG. DeployRobinhood.s.sol deploys a mintable stand-in
 * there (DEPLOY_MOCK_USDG=true), and its address goes in `usdg` below.
 */
export type RobinhoodContracts = {
  usdg: string;
  /** Uniswap v4's PoolManager, confirmed to have code on both networks. */
  poolManager: string;
  clubVault: string;
  clubFactory: string;
  clubRouter: string;
  clubAuction: string;
  /** Block ClubVaultUsdg was deployed in. Log scans start here. */
  deployBlock: bigint;
};

export const ROBINHOOD_MAINNET_CONTRACTS: RobinhoodContracts = {
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  clubVault: "",
  clubFactory: "",
  clubRouter: "",
  clubAuction: "",
  deployBlock: 0n,
};

export const ROBINHOOD_TESTNET_CONTRACTS: RobinhoodContracts = {
  usdg: "", // the mock DeployRobinhood.s.sol deploys
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  clubVault: "",
  clubFactory: "",
  clubRouter: "",
  clubAuction: "",
  deployBlock: 0n,
};

/**
 * The Club auction's parameters, mirroring what DeployRobinhood.s.sol was run
 * with. Display and validation hints only — the contract's immutables are the
 * real enforcement, so a drift here is a UI showing the wrong minimum, not a
 * contract accepting the wrong bid.
 */
export const AUCTION = {
  roundDurationSeconds: 24 * 60 * 60,
  minOpeningBidUsdg: 100,
  minBidIncrementBps: 500,
  antiSnipeExtensionSeconds: 5 * 60,
  /** ClubFactoryUsdg.MAX_DEV_BUY_USDC, in whole USDG. */
  maxFirstBuyUsdg: 300,
} as const;

/** Minimum valid bid given the current top bid, mirroring ClubAuction.bid's own check. */
export function minNextBidUsdg(topBidUsdg: number): number {
  if (topBidUsdg <= 0) return AUCTION.minOpeningBidUsdg;
  return topBidUsdg + (topBidUsdg * AUCTION.minBidIncrementBps) / 10_000;
}
