// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PoolVaultUsdg} from "../src/pool-usdg/PoolVaultUsdg.sol";
import {PoolFactoryUsdg} from "../src/pool-usdg/PoolFactoryUsdg.sol";
import {AromaRouterUsdg} from "../src/pool-usdg/AromaRouterUsdg.sol";
import {Create2Factory} from "./DeployPool.s.sol";

/// @notice Deploys the USDG pool-based launch system on Robinhood Chain and
/// completes its bootstrap. Sibling of `DeployPool.s.sol` (Arc, native USDC),
/// which this does not touch or depend on beyond reusing its `Create2Factory`
/// helper — see that file for why a local factory exists at all.
///
/// The hook-address mining is identical in shape to `DeployPool.s.sol`: a
/// v4 hook's permissions live in its own address's low 14 bits, so the
/// address is searched for, not merely accepted. `PoolVaultUsdg` implements
/// exactly the same callbacks as `PoolVault`, so `REQUIRED_FLAGS` is the same
/// mask.
///
/// @dev POOL_MANAGER for Robinhood Chain (chain id 4663) surfaced repeatedly
/// during research as 0x8366a39cc670b4001a1121b8f6a443a643e40951 — the exact
/// same address this repo already used for Arc's PoolManager — which is
/// either a real canonical cross-chain Uniswap v4 deployment, or a research
/// artifact that couldn't be independently confirmed against a block
/// explorer. **This has not been verified.** The `require` below (mirroring
/// `DeployPool.s.sol`'s own check for Arc) will at least refuse to deploy
/// against an address with no code — it cannot confirm the code *is*
/// PoolManager. Confirm that independently before broadcasting to mainnet.
contract DeployPoolUsdg is Script {
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
        address usdg = vm.envAddress("USDG_ADDRESS");

        console.log("deployer:        ", deployer);
        console.log("owner:           ", owner);
        console.log("pool manager:    ", poolManager, " <-- UNVERIFIED, confirm before mainnet use");
        console.log("usdg:            ", usdg);
        console.log("balance (wei):   ", deployer.balance);

        require(poolManager != address(0), "POOL_MANAGER not set");
        require(poolManager.code.length > 0, "POOL_MANAGER has no code on this chain");
        require(usdg != address(0), "USDG_ADDRESS not set");
        require(usdg.code.length > 0, "USDG_ADDRESS has no code on this chain");

        address predictedCreate2 = vm.computeCreateAddress(deployer, vm.getNonce(deployer));
        bytes memory vaultInitCode = _vaultInitCode(poolManager, usdg, deployer);
        (bytes32 salt, address predictedVault) = _mineHookAddress(predictedCreate2, vaultInitCode);

        console.log("");
        console.log("create2 factory: ", predictedCreate2);
        console.log("mined vault:     ", predictedVault);
        console.log("hook flags:      ", uint256(uint160(predictedVault) & ALL_HOOK_MASK));
        console.log("required flags:  ", uint256(REQUIRED_FLAGS));

        vm.startBroadcast(pk);

        Create2Factory create2 = new Create2Factory();
        require(address(create2) == predictedCreate2, "create2 factory address prediction failed");

        PoolVaultUsdg vault = PoolVaultUsdg(payable(create2.deploy(salt, vaultInitCode)));
        require(address(vault) == predictedVault, "vault address prediction failed");
        require(
            uint160(address(vault)) & ALL_HOOK_MASK == REQUIRED_FLAGS,
            "vault address lacks the hook permission bits"
        );

        PoolFactoryUsdg factory = new PoolFactoryUsdg(address(vault));
        vault.setFactory(address(factory));

        AromaRouterUsdg router = new AromaRouterUsdg(address(vault));

        if (owner != deployer) {
            vault.transferOwnership(owner);
        }

        vm.stopBroadcast();

        console.log("");
        console.log("PoolVaultUsdg:   ", address(vault));
        console.log("PoolFactoryUsdg: ", address(factory));
        console.log("AromaRouterUsdg: ", address(router));
        console.log("");
        console.log("Verify wiring:");
        console.log("  factory set:   ", vault.factory() == address(factory));
        console.log("  vault -> mgr:  ", address(vault.poolManager()) == poolManager);
        console.log("  router -> mgr: ", address(router.poolManager()) == poolManager);
        console.log("  owner now:     ", vault.owner());
        console.log("  owner pending: ", vault.pendingOwner());

        if (vault.pendingOwner() != address(0)) {
            console.log("");
            console.log("ACTION REQUIRED: ownership is nominated, not transferred.");
            console.log("From the wallet above, call acceptOwnership() on:");
            console.log("  ", address(vault));
        }
    }

    function _vaultInitCode(address poolManager, address usdg, address vaultOwner)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            type(PoolVaultUsdg).creationCode, abi.encode(poolManager, usdg, vaultOwner)
        );
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
