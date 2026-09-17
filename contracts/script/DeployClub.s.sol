// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ClubVault} from "../src/club/ClubVault.sol";
import {ClubFactory} from "../src/club/ClubFactory.sol";
import {ClubRouter} from "../src/club/ClubRouter.sol";
import {Create2Factory} from "./DeployPool.s.sol";

/// @notice Deploys the club system beside the pool system.
///
/// Sibling of DeployPool.s.sol, and deliberately independent of it: nothing
/// here reads or writes the pool system's contracts, so running this cannot
/// disturb a single coin already trading. The two share only AromaToken and
/// the Uniswap PoolManager they both launch into.
///
/// The vault's address is mined for its hook permission bits exactly as
/// PoolVault's is — same flags, since ClubVault implements the same callbacks
/// — so see DeployPool.s.sol for why the address is searched for rather than
/// accepted.
contract DeployClub is Script {
    uint160 constant BEFORE_INITIALIZE_FLAG = 1 << 13;
    uint160 constant BEFORE_SWAP_FLAG = 1 << 7;
    uint160 constant AFTER_SWAP_FLAG = 1 << 6;
    uint160 constant BEFORE_SWAP_RETURNS_DELTA_FLAG = 1 << 3;
    uint160 constant AFTER_SWAP_RETURNS_DELTA_FLAG = 1 << 2;
    uint160 constant ALL_HOOK_MASK = (1 << 14) - 1;

    uint160 constant REQUIRED_FLAGS = BEFORE_INITIALIZE_FLAG | BEFORE_SWAP_FLAG | AFTER_SWAP_FLAG
        | BEFORE_SWAP_RETURNS_DELTA_FLAG | AFTER_SWAP_RETURNS_DELTA_FLAG;

    uint256 constant MAX_SALT_ATTEMPTS = 500_000;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address owner = vm.envOr("PROTOCOL_OWNER", deployer);
        address poolManager = vm.envAddress("POOL_MANAGER");

        console.log("deployer:        ", deployer);
        console.log("owner:           ", owner);
        console.log("pool manager:    ", poolManager);
        console.log("balance (wei):   ", deployer.balance);

        require(poolManager != address(0), "POOL_MANAGER not set");
        require(poolManager.code.length > 0, "POOL_MANAGER has no code on this chain");

        address predictedCreate2 = vm.computeCreateAddress(deployer, vm.getNonce(deployer));
        bytes memory vaultInitCode =
            abi.encodePacked(type(ClubVault).creationCode, abi.encode(poolManager, deployer));
        (bytes32 salt, address predictedVault) = _mineHookAddress(predictedCreate2, vaultInitCode);

        console.log("");
        console.log("create2 factory: ", predictedCreate2);
        console.log("mined vault:     ", predictedVault);
        console.log("hook flags:      ", uint256(uint160(predictedVault) & ALL_HOOK_MASK));
        console.log("required flags:  ", uint256(REQUIRED_FLAGS));

        vm.startBroadcast(pk);

        Create2Factory create2 = new Create2Factory();
        require(address(create2) == predictedCreate2, "create2 factory address prediction failed");

        ClubVault vault = ClubVault(payable(create2.deploy(salt, vaultInitCode)));
        require(address(vault) == predictedVault, "vault address prediction failed");
        require(
            uint160(address(vault)) & ALL_HOOK_MASK == REQUIRED_FLAGS,
            "vault address lacks the hook permission bits"
        );

        ClubFactory factory = new ClubFactory(address(vault));
        ClubRouter router = new ClubRouter(address(vault));

        // Unlike the pool system, the router is wired in, not merely deployed:
        // the vault takes this router's word about who is trading. Both are set
        // exactly once, before ownership is handed over, and can never change.
        vault.setFactory(address(factory));
        vault.setRouter(address(router));

        if (owner != deployer) {
            vault.transferOwnership(owner);
        }

        vm.stopBroadcast();

        console.log("");
        console.log("ClubVault:       ", address(vault));
        console.log("ClubFactory:     ", address(factory));
        console.log("ClubRouter:      ", address(router));
        console.log("");
        console.log("Verify wiring:");
        console.log("  factory set:   ", vault.factory() == address(factory));
        console.log("  router set:    ", vault.router() == address(router));
        console.log("  vault -> mgr:  ", address(vault.poolManager()) == poolManager);
        console.log("  router -> mgr: ", address(router.poolManager()) == poolManager);
        console.log("  owner now:     ", vault.owner());
        console.log("  owner pending: ", vault.pendingOwner());

        if (vault.pendingOwner() != address(0)) {
            console.log("");
            console.log("ACTION REQUIRED: ownership is nominated, not transferred.");
            console.log("From the owner wallet, call acceptOwnership() on:");
            console.log("  ", address(vault));
        }
    }

    function _mineHookAddress(address create2Factory, bytes memory initCode)
        internal
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
}
