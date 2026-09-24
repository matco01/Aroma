import {
  ARC_MAINNET,
  ARC_MAINNET_CLUB_CONTRACTS,
  ARC_MAINNET_CONTRACTS,
  LOCAL,
  LOCAL_NETWORK,
  POOL,
} from "./arc";
import {
  ROBINHOOD_MAINNET,
  ROBINHOOD_MAINNET_CONTRACTS,
  ROBINHOOD_TESTNET,
  ROBINHOOD_TESTNET_CONTRACTS,
  USDG_DECIMALS,
  USDG_TICK_GRADUATION,
} from "./robinhood";

/**
 * Which chain this build talks to, and everything that follows from it.
 *
 * One choice, made once, at build time: NEXT_PUBLIC_AROMA_NETWORK.
 *
 *   robinhood-testnet  (default) Robinhood Chain testnet, USDG clubs + auction
 *   robinhood          Robinhood Chain mainnet
 *   arc                Arc mainnet — the pool system and native-USDC clubs
 *   local              an anvil fork, addresses from the environment (arc.ts)
 *
 * Aroma runs on Robinhood. Arc stays selectable because its contracts are
 * live and may come back, not because a build ever serves both: every hook,
 * server read and wallet switch follows `activeChain` (chain.ts), which is
 * built from NETWORK below, so a build is wholly one chain or the other.
 */

export type NetworkKey = "robinhood-testnet" | "robinhood" | "arc" | "local";

const KEYS: NetworkKey[] = ["robinhood-testnet", "robinhood", "arc", "local"];
const requested = process.env.NEXT_PUBLIC_AROMA_NETWORK as NetworkKey | undefined;
export const NETWORK_KEY: NetworkKey =
  requested && KEYS.includes(requested) ? requested : "robinhood-testnet";

export const ON_ROBINHOOD = NETWORK_KEY === "robinhood" || NETWORK_KEY === "robinhood-testnet";

const ROBINHOOD = NETWORK_KEY === "robinhood" ? ROBINHOOD_MAINNET : ROBINHOOD_TESTNET;
const ROBINHOOD_CONTRACTS =
  NETWORK_KEY === "robinhood" ? ROBINHOOD_MAINNET_CONTRACTS : ROBINHOOD_TESTNET_CONTRACTS;

type Network = {
  id: number;
  name: string;
  rpc: string;
  explorer: string;
  explorerName: string;
  faucet: string;
  currency: { name: string; symbol: string; decimals: number };
  testnet: boolean;
};

export const NETWORK: Network = LOCAL
  ? { ...LOCAL_NETWORK, explorerName: "", faucet: "", testnet: true }
  : ON_ROBINHOOD
    ? { ...ROBINHOOD, testnet: NETWORK_KEY === "robinhood-testnet" }
    : { ...ARC_MAINNET, explorerName: "Arcscan", faucet: "", testnet: false };

/**
 * The currency every price, trade and fee is in.
 *
 * On Arc it is the chain's own gas token, sent as native value, 18 decimals.
 * On Robinhood it is USDG, an ERC-20 with 6 decimals, pulled with a permit.
 * Anything that parses, formats or sends an amount of it reads this rather
 * than assuming either.
 */
export const SETTLEMENT = ON_ROBINHOOD
  ? {
      symbol: "USDG",
      decimals: USDG_DECIMALS,
      native: false,
      token: ROBINHOOD_CONTRACTS.usdg,
    }
  : { symbol: "USDC", decimals: 18, native: true, token: "" };

/**
 * The tick where a coin's sale range ends. The dollar price is the same on
 * both chains; the tick is not, because USDG's 6 decimals move every tick
 * constant (contracts/script/math/derive_pool_usdg.py).
 */
export const TICK_GRADUATION = ON_ROBINHOOD ? USDG_TICK_GRADUATION : POOL.tickGraduation;

/**
 * The normal (non-club) pool system. Arc only: every Robinhood coin is a club
 * coin, so there the pool contracts are empty and everything gated on
 * `poolsDeployed` stays switched off.
 */
export const POOL_CONTRACTS = LOCAL
  ? {
      poolFactory: process.env.NEXT_PUBLIC_LOCAL_POOL_FACTORY ?? "",
      poolVault: process.env.NEXT_PUBLIC_LOCAL_POOL_VAULT ?? "",
      aromaRouter: process.env.NEXT_PUBLIC_LOCAL_AROMA_ROUTER ?? "",
      poolManager:
        process.env.NEXT_PUBLIC_LOCAL_POOL_MANAGER ?? ARC_MAINNET_CONTRACTS.poolManager,
      deployBlock: BigInt(process.env.NEXT_PUBLIC_LOCAL_DEPLOY_BLOCK ?? "0"),
    }
  : ON_ROBINHOOD
    ? {
        poolFactory: "",
        poolVault: "",
        aromaRouter: "",
        poolManager: ROBINHOOD_CONTRACTS.poolManager,
        deployBlock: ROBINHOOD_CONTRACTS.deployBlock,
      }
    : ARC_MAINNET_CONTRACTS;

export const poolsDeployed = Boolean(
  POOL_CONTRACTS.poolFactory && POOL_CONTRACTS.poolVault && POOL_CONTRACTS.aromaRouter,
);

/** Club coins' contracts — see CLUBS.md. On Robinhood, the USDG versions. */
export const CLUB_CONTRACTS = LOCAL
  ? {
      clubFactory: process.env.NEXT_PUBLIC_LOCAL_CLUB_FACTORY ?? "",
      clubVault: process.env.NEXT_PUBLIC_LOCAL_CLUB_VAULT ?? "",
      clubRouter: process.env.NEXT_PUBLIC_LOCAL_CLUB_ROUTER ?? "",
      deployBlock: BigInt(process.env.NEXT_PUBLIC_LOCAL_CLUB_DEPLOY_BLOCK ?? "0"),
    }
  : ON_ROBINHOOD
    ? {
        clubFactory: ROBINHOOD_CONTRACTS.clubFactory,
        clubVault: ROBINHOOD_CONTRACTS.clubVault,
        clubRouter: ROBINHOOD_CONTRACTS.clubRouter,
        deployBlock: ROBINHOOD_CONTRACTS.deployBlock,
      }
    : ARC_MAINNET_CLUB_CONTRACTS;

export const clubsDeployed = Boolean(
  CLUB_CONTRACTS.clubFactory && CLUB_CONTRACTS.clubVault && CLUB_CONTRACTS.clubRouter,
);

/**
 * The Club auction — Robinhood only. Launching there is winning it; on Arc,
 * launching is the create form.
 */
export const AUCTION_CONTRACT = ON_ROBINHOOD ? ROBINHOOD_CONTRACTS.clubAuction : "";
export const auctionDeployed = Boolean(AUCTION_CONTRACT && SETTLEMENT.token);

/** A link into the explorer, or null while there is no explorer to link to. */
export function explorerUrl(path: string): string | null {
  return NETWORK.explorer ? `${NETWORK.explorer}${path}` : null;
}
