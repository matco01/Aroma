/**
 * Robinhood Chain constants — the Club auction and every coin it launches.
 *
 * A new file, not a rewrite of arc.ts: Arc's contracts, economics and UI
 * copy stay exactly as they are, dormant rather than deleted, in case the
 * old permissionless flow ever comes back. This is the live chain now.
 *
 * The sharp edge here is the opposite of Arc's: Arc's native gas token *is*
 * USDC, so price math needed no decimal correction. Robinhood Chain's native
 * gas token is ETH — confirmed against Robinhood's own docs — so Aroma
 * settles in USDG instead, a plain ERC-20 confirmed at 6 decimals against
 * Paxos's deployed contract on Etherscan. Every USDG amount in this app is
 * 6-decimal; the launched token itself stays 18-decimal, same as on Arc.
 */

export const ROBINHOOD_MAINNET = {
  id: 4663,
  name: "Robinhood Chain",
  // Robinhood's own docs recommend an Alchemy-backed URL for production;
  // this public endpoint is rate-limited and fine for development.
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",
  currency: { name: "Ether", symbol: "ETH", decimals: 18 },
} as const;

export const ROBINHOOD_TESTNET = {
  id: 46630,
  name: "Robinhood Chain Testnet",
  rpc: "https://rpc.testnet.chain.robinhood.com",
  explorer: "https://explorer.testnet.chain.robinhood.com",
  faucet: "https://faucet.testnet.chain.robinhood.com",
  currency: { name: "Ether", symbol: "ETH", decimals: 18 },
} as const;

/**
 * USDG, confirmed at this address from two independent Robinhood doc
 * fetches (docs.robinhood.com/chain/contracts/ and a corroborating search).
 * Same address on both networks isn't assumed here — set the testnet one
 * once it's confirmed; until then testnet contract calls that touch USDG
 * are the thing to verify first against a real testnet transaction.
 */
export const USDG_DECIMALS = 6;

/**
 * Aroma's own contracts. Every address below except `usdg` and
 * `poolManager` is a FIXME until the corresponding deploy script
 * (DeployPoolUsdg.s.sol, DeployClub.s.sol) has actually run — placeholder
 * zero addresses would silently pass type-checking and fail every call.
 *
 * `poolManager` carries its own caveat: it surfaced repeatedly during
 * research as the address below, which is either a real canonical
 * cross-chain Uniswap v4 deployment or a research-tool echo that could not
 * be independently confirmed against a block explorer. Confirm it before
 * relying on it for anything real — see LAUNCH.md's successor for Robinhood
 * Chain, CLUB.md, for the same discipline Arc's own runbook already applies
 * to its PoolManager address.
 */
export const ROBINHOOD_MAINNET_CONTRACTS = {
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951", // UNVERIFIED
  poolVaultUsdg: "0x0000000000000000000000000000000000000000", // FIXME
  poolFactoryUsdg: "0x0000000000000000000000000000000000000000", // FIXME
  aromaRouterUsdg: "0x0000000000000000000000000000000000000000", // FIXME
  clubAuction: "0x0000000000000000000000000000000000000000", // FIXME
  deployBlock: 0n, // FIXME: the block PoolVaultUsdg was deployed in
} as const;

/**
 * Testnet mirror. `usdg`/`poolManager` are carried over from the mainnet
 * values above rather than independently confirmed on testnet — that has
 * not been checked, and is the first thing to verify (e.g. `usdg.symbol()`
 * against a real testnet RPC) before trusting a testnet balance the app
 * shows.
 */
export const ROBINHOOD_TESTNET_CONTRACTS = {
  usdg: ROBINHOOD_MAINNET_CONTRACTS.usdg, // UNVERIFIED on testnet
  poolManager: ROBINHOOD_MAINNET_CONTRACTS.poolManager, // UNVERIFIED
  poolVaultUsdg: "0x0000000000000000000000000000000000000000", // FIXME
  poolFactoryUsdg: "0x0000000000000000000000000000000000000000", // FIXME
  aromaRouterUsdg: "0x0000000000000000000000000000000000000000", // FIXME
  clubAuction: "0x0000000000000000000000000000000000000000", // FIXME
  deployBlock: 0n, // FIXME
} as const;

/**
 * True once ClubAuction has a real testnet address. Until DeployClub.s.sol
 * runs it's the zero address, and the UI says the Club is coming rather
 * than pointing anything at it.
 */
export const clubDeployed = !/^0x0{40}$/i.test(ROBINHOOD_TESTNET_CONTRACTS.clubAuction);

export function contractsForChain(
  chainId: number,
): typeof ROBINHOOD_MAINNET_CONTRACTS {
  return chainId === ROBINHOOD_MAINNET.id
    ? ROBINHOOD_MAINNET_CONTRACTS
    : ROBINHOOD_TESTNET_CONTRACTS;
}

/**
 * Protocol economics for the Club auction.
 *
 * These are display/validation hints, not the source of truth — the
 * contract's own immutables (set once at deploy, never owner-tunable) are
 * that, matching the project's existing philosophy for CurveManager's snipe
 * tax and AromaFactory's LaunchGuard. Keep these in sync with whatever
 * DeployClub.s.sol was actually run with; there is deliberately no way to
 * read them from the chain without a call per page load, so a drift here is
 * a UI showing the wrong minimum, not a contract accepting the wrong bid —
 * the contract's own `require`s are the real enforcement either way.
 */
/**
 * PoolVaultUsdg's swap fee, in basis points, and the creator's share of it.
 * Numerically identical to the dormant Arc pool's `PoolVault` constants —
 * copied on purpose, not derived from `arc.ts`'s `CURVE`, since that object
 * describes a different, dormant system and importing from it here would
 * make a coincidence of matching numbers look like a real dependency.
 */
export const POOL_USDG = {
  tradeFeeBps: 100,
  creatorFeeShareBps: 7_000,
} as const;

export const CLUB = {
  roundDurationSeconds: 24 * 60 * 60,
  minOpeningBidUsdg: 100,
  minBidIncrementBps: 500,
  antiSnipeExtensionSeconds: 5 * 60,
  /** PoolFactoryUsdg.MAX_DEV_BUY_USDC, in whole USDG. */
  maxDevBuyUsdg: 300,
} as const;

/** Minimum valid bid given the current top bid, mirroring ClubAuction.bid's own check. */
export function minNextBidUsdg(topBidUsdg: number): number {
  if (topBidUsdg <= 0) return CLUB.minOpeningBidUsdg;
  return topBidUsdg + (topBidUsdg * CLUB.minBidIncrementBps) / 10_000;
}
