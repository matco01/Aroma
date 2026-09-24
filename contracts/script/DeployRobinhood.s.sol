// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ClubVaultUsdg} from "../src/club/ClubVaultUsdg.sol";
import {ClubFactoryUsdg} from "../src/club/ClubFactoryUsdg.sol";
import {ClubRouterUsdg} from "../src/club/ClubRouterUsdg.sol";
import {ClubAuction} from "../src/club/ClubAuction.sol";
import {MockUsdg} from "../test/mocks/MockUsdg.sol";
import {Create2Factory} from "./DeployPool.s.sol";

/// @notice Deploys everything Aroma runs on Robinhood Chain, wired together:
/// the USDG club vault (hook), its factory and router, and the Club auction
/// that is the factory's only launcher. Opens the first 24-hour Club.
///
/// The vault's address is mined for its hook permission bits exactly as
/// DeployClub.s.sol mines ClubVault's — see DeployPool.s.sol for why the
/// address is searched for rather than accepted.
///
/// Robinhood Chain testnet has no USDG. Set DEPLOY_MOCK_USDG=true there to
/// deploy a mintable stand-in; the script refuses to do that on mainnet.
contract DeployRobinhood is Script {
    uint160 constant BEFORE_INITIALIZE_FLAG = 1 << 13;
    uint160 constant BEFORE_SWAP_FLAG = 1 << 7;
    uint160 constant AFTER_SWAP_FLAG = 1 << 6;
    uint160 constant BEFORE_SWAP_RETURNS_DELTA_FLAG = 1 << 3;
    uint160 constant AFTER_SWAP_RETURNS_DELTA_FLAG = 1 << 2;
    uint160 constant ALL_HOOK_MASK = (1 << 14) - 1;

    uint160 constant REQUIRED_FLAGS = BEFORE_INITIALIZE_FLAG | BEFORE_SWAP_FLAG | AFTER_SWAP_FLAG
        | BEFORE_SWAP_RETURNS_DELTA_FLAG | AFTER_SWAP_RETURNS_DELTA_FLAG;

    uint256 constant MAX_SALT_ATTEMPTS = 500_000;
    uint256 constant ROBINHOOD_MAINNET = 4663;

    struct Config {
        address owner;
        address poolManager;
        address usdg;
        address treasury;
        uint64 roundDuration;
        uint256 minOpeningBid;
        uint256 minBidIncrementBps;
        uint64 antiSnipeExtension;
    }

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        Config memory cfg = _config(deployer);

        console.log("chain id:        ", block.chainid);
        console.log("deployer:        ", deployer);
        console.log("owner:           ", cfg.owner);
        console.log("pool manager:    ", cfg.poolManager);
        console.log("treasury:        ", cfg.treasury);
        console.log("balance (wei):   ", deployer.balance);

        require(cfg.poolManager.code.length > 0, "POOL_MANAGER has no code on this chain");
        require(cfg.treasury != address(0), "CLUB_TREASURY not set");

        vm.startBroadcast(pk);

        if (cfg.usdg == address(0)) {
            require(vm.envOr("DEPLOY_MOCK_USDG", false), "USDG_ADDRESS not set");
            require(block.chainid != ROBINHOOD_MAINNET, "refusing to deploy mock USDG on mainnet");
            cfg.usdg = address(new MockUsdg());
            console.log("mock USDG:       ", cfg.usdg);
        }
        require(cfg.usdg.code.length > 0, "USDG_ADDRESS has no code on this chain");

        ClubVaultUsdg vault = _deployVault(deployer, cfg);
        ClubFactoryUsdg factory = new ClubFactoryUsdg(address(vault));
        ClubRouterUsdg router = new ClubRouterUsdg(address(vault));

        // Both set once and never again — see ClubVault on why the router's
        // word about who is trading must not be replaceable.
        vault.setFactory(address(factory));
        vault.setRouter(address(router));

        // The auction owner is whoever runs finalize. It starts as the
        // deployer and is nominated below, same two-step as the vault.
        ClubAuction club = new ClubAuction(
            address(factory),
            cfg.usdg,
            cfg.treasury,
            deployer,
            cfg.roundDuration,
            cfg.minOpeningBid,
            cfg.minBidIncrementBps,
            cfg.antiSnipeExtension
        );
        factory.setLauncher(address(club));

        if (cfg.owner != deployer) {
            vault.transferOwnership(cfg.owner);
            club.transferOwnership(cfg.owner);
        }

        vm.stopBroadcast();

        _report(vault, factory, router, club, cfg);
    }

    function _config(address deployer) private view returns (Config memory cfg) {
        cfg.owner = vm.envOr("PROTOCOL_OWNER", deployer);
        cfg.poolManager = vm.envAddress("POOL_MANAGER");
        cfg.usdg = vm.envOr("USDG_ADDRESS", address(0));
        cfg.treasury = vm.envAddress("CLUB_TREASURY");
        // Defaults match the product spec (24h rounds, 5-minute anti-snipe
        // extension); the bid sizes are placeholders to tune before mainnet.
        cfg.roundDuration = uint64(vm.envOr("CLUB_ROUND_DURATION_SECONDS", uint256(24 hours)));
        cfg.minOpeningBid = vm.envOr("CLUB_MIN_OPENING_BID", uint256(100e6)); // 100 USDG
        cfg.minBidIncrementBps = vm.envOr("CLUB_MIN_BID_INCREMENT_BPS", uint256(500)); // 5%
        cfg.antiSnipeExtension =
            uint64(vm.envOr("CLUB_ANTI_SNIPE_EXTENSION_SECONDS", uint256(5 minutes)));
    }

    function _deployVault(address deployer, Config memory cfg) private returns (ClubVaultUsdg vault) {
        address predictedCreate2 = vm.computeCreateAddress(deployer, vm.getNonce(deployer));
        bytes memory initCode = abi.encodePacked(
            type(ClubVaultUsdg).creationCode, abi.encode(cfg.poolManager, cfg.usdg, deployer)
        );
        (bytes32 salt, address predictedVault) = _mineHookAddress(predictedCreate2, initCode);

        Create2Factory create2 = new Create2Factory();
        require(address(create2) == predictedCreate2, "create2 factory address prediction failed");

        vault = ClubVaultUsdg(create2.deploy(salt, initCode));
        require(address(vault) == predictedVault, "vault address prediction failed");
        require(
            uint160(address(vault)) & ALL_HOOK_MASK == REQUIRED_FLAGS,
            "vault address lacks the hook permission bits"
        );
    }

    function _mineHookAddress(address create2Factory, bytes memory initCode)
        private
        pure
        returns (bytes32 salt, address predicted)
    {
        bytes32 initCodeHash = keccak256(initCode);
        for (uint256 i = 0; i < MAX_SALT_ATTEMPTS; i++) {
            bytes32 candidate = bytes32(i);
            address addr = address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(bytes1(0xff), create2Factory, candidate, initCodeHash)
                        )
                    )
                )
            );
            if (uint160(addr) & ALL_HOOK_MASK == REQUIRED_FLAGS) {
                return (candidate, addr);
            }
        }
        revert("no salt produces the required hook flags");
    }

    function _report(
        ClubVaultUsdg vault,
        ClubFactoryUsdg factory,
        ClubRouterUsdg router,
        ClubAuction club,
        Config memory cfg
    ) private view {
        console.log("");
        console.log("USDG:            ", cfg.usdg);
        console.log("ClubVaultUsdg:   ", address(vault));
        console.log("ClubFactoryUsdg: ", address(factory));
        console.log("ClubRouterUsdg:  ", address(router));
        console.log("ClubAuction:     ", address(club));
        console.log("");
        console.log("Verify wiring:");
        console.log("  factory set:      ", vault.factory() == address(factory));
        console.log("  router set:       ", vault.router() == address(router));
        console.log("  launcher set:     ", factory.launcher() == address(club));
        console.log("  first club ends:  ", club.getCurrentClub().endsAt);
        console.log("  vault owner:      ", vault.owner());
        console.log("  auction owner:    ", club.owner());

        if (vault.pendingOwner() != address(0)) {
            console.log("");
            console.log("ACTION REQUIRED: ownership is nominated, not transferred.");
            console.log("From the owner wallet, call acceptOwnership() on both:");
            console.log("  ", address(vault));
            console.log("  ", address(club));
            console.log("Until then the deployer's key is the one finalize() must be called from.");
        }
    }
}
