// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PoolVault} from "../src/pool/PoolVault.sol";
import {PoolFactory} from "../src/pool/PoolFactory.sol";
import {AromaRouter} from "../src/pool/AromaRouter.sol";

/// @notice Deploys a contract to an address chosen in advance.
///
/// @dev A local one rather than the well-known deterministic proxy at
/// 0x4e59…1e0e, which is not as universal as it is assumed to be — it has no
/// code on Ethereum mainnet, checked against three independent RPCs, and
/// nothing says Arc will carry it either. Depending on a third-party
/// contract's presence for the one deployment whose *address* has to be
/// exact is a bad trade when the alternative is nine lines.
contract Create2Factory {
    function deploy(bytes32 salt, bytes memory initCode) external returns (address addr) {
        assembly ("memory-safe") {
            addr := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        require(addr != address(0), "CREATE2 deployment reverted");
    }
}

/// @notice Deploys the pool-based launch system and completes its bootstrap.
///
/// Sibling of Deploy.s.sol, which deploys the curve system. The two are
/// independent — they share only AromaToken, and neither reads the other's
/// state — so running this does not disturb an existing curve deployment.
///
/// The wrinkle is the vault's address. It is also the pool's hook, and v4
/// encodes a hook's permissions in the low 14 bits of its own address: the
/// manager reads them to decide which callbacks to make, and rejects a pool
/// whose hook address disagrees with the callbacks that hook implements. The
/// address is part of the interface, so it is searched for rather than
/// accepted.
///
/// That search needs a deployer address known before anything is deployed,
/// which is the same knot Deploy.s.sol cuts for the LiquidityLocker and it is
/// cut the same way: predict the address from the deployer's next nonce, mine
/// against the prediction, then deploy into exactly that slot and assert the
/// prediction held.
///
/// POOL_MANAGER is the variable that matters, and it is why this cannot run
/// on Arc testnet: Uniswap is not deployed there at any version. Every
/// canonical v3 and v4 address returns empty code on chain 5042002, checked
/// directly against the public RPC. Deploy against Arc mainnet (5042), whose
/// PoolManager is 0x8366a39cc670b4001a1121b8f6a443a643e40951, or exercise
/// against a fork.
contract DeployPool is Script {
    /// @dev Uniswap's hook permission bits, from v4-core's Hooks library.
    /// Repeated rather than imported so a change upstream surfaces as a
    /// failed deployment instead of a silently different address.
    uint160 constant BEFORE_INITIALIZE_FLAG = 1 << 13;
    uint160 constant BEFORE_SWAP_FLAG = 1 << 7;
    uint160 constant AFTER_SWAP_FLAG = 1 << 6;
    uint160 constant BEFORE_SWAP_RETURNS_DELTA_FLAG = 1 << 3;
    uint160 constant AFTER_SWAP_RETURNS_DELTA_FLAG = 1 << 2;
    uint160 constant ALL_HOOK_MASK = (1 << 14) - 1;

    /// @dev What PoolVault implements: it guards initialization, and charges
    /// the fee on whichever side of the swap is USDC — which needs both swap
    /// callbacks and both return-delta permissions.
    uint160 constant REQUIRED_FLAGS = BEFORE_INITIALIZE_FLAG | BEFORE_SWAP_FLAG | AFTER_SWAP_FLAG
        | BEFORE_SWAP_RETURNS_DELTA_FLAG | AFTER_SWAP_RETURNS_DELTA_FLAG;

    /// @dev One salt in 2^14 fits, so this is ~30x the expected search.
    uint256 constant MAX_SALT_ATTEMPTS = 500_000;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        // The deployer owns the vault through the broadcast because
        // setFactory is onlyOwner, then hands it over. Handing over first
        // would leave the vault unwireable by anyone but the new owner.
        address owner = vm.envOr("PROTOCOL_OWNER", deployer);
        address poolManager = vm.envAddress("POOL_MANAGER");

        console.log("deployer:        ", deployer);
        console.log("owner:           ", owner);
        console.log("pool manager:    ", poolManager);
        console.log("balance (wei):   ", deployer.balance);

        require(poolManager != address(0), "POOL_MANAGER not set");
        require(poolManager.code.length > 0, "POOL_MANAGER has no code on this chain");

        // The Create2Factory is the first contract this account creates in
        // the broadcast, so its address is the deployer's current-nonce
        // CREATE address. Computed before broadcasting so the salt can be
        // mined against it.
        address predictedCreate2 = vm.computeCreateAddress(deployer, vm.getNonce(deployer));
        bytes memory vaultInitCode = _vaultInitCode(poolManager, deployer);
        (bytes32 salt, address predictedVault) = _mineHookAddress(predictedCreate2, vaultInitCode);

        console.log("");
        console.log("create2 factory: ", predictedCreate2);
        console.log("mined vault:     ", predictedVault);
        console.log("hook flags:      ", uint256(uint160(predictedVault) & ALL_HOOK_MASK));
        console.log("required flags:  ", uint256(REQUIRED_FLAGS));

        vm.startBroadcast(pk);

        Create2Factory create2 = new Create2Factory();
        require(address(create2) == predictedCreate2, "create2 factory address prediction failed");

        PoolVault vault = PoolVault(payable(create2.deploy(salt, vaultInitCode)));
        require(address(vault) == predictedVault, "vault address prediction failed");
        require(
            uint160(address(vault)) & ALL_HOOK_MASK == REQUIRED_FLAGS,
            "vault address lacks the hook permission bits"
        );

        PoolFactory factory = new PoolFactory(address(vault));
        vault.setFactory(address(factory));

        // The router is not wired into anything — it holds no state, owns
        // nothing, and the vault does not know it exists. It is deployed here
        // only because the frontend needs an address to swap through, and
        // Uniswap has published no Universal Router for Arc. Replacing it
        // later is a frontend change, not a migration.
        AromaRouter router = new AromaRouter(address(vault));

        // Ownable2Step: this only nominates. Ownership does not move until
        // the nominee calls acceptOwnership from that address, which is the
        // point — it makes it impossible to hand the fee key to an address
        // nobody can sign for, which would strand every fee permanently.
        if (owner != deployer) {
            vault.transferOwnership(owner);
        }

        vm.stopBroadcast();

        console.log("");
        console.log("PoolVault:       ", address(vault));
        console.log("PoolFactory:     ", address(factory));
        console.log("AromaRouter:     ", address(router));
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
            console.log("Until then the deployer still owns fee withdrawal.");
        }
    }

    function _vaultInitCode(address poolManager, address vaultOwner)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(type(PoolVault).creationCode, abi.encode(poolManager, vaultOwner));
    }

    /// @notice Searches for a salt whose CREATE2 address carries exactly the
    /// permission bits PoolVault implements.
    ///
    /// @dev Exactly, not merely at least. v4 rejects a hook whose address
    /// claims a callback the contract does not implement, and will happily
    /// call one the address claims and the contract reverts on. Both
    /// directions matter, so the comparison is on the full 14-bit mask rather
    /// than a subset test.
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
