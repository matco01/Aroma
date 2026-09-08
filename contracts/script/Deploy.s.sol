// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {CurveManager} from "../src/CurveManager.sol";
import {AromaFactory} from "../src/AromaFactory.sol";
import {LiquidityLocker} from "../src/LiquidityLocker.sol";

/// @notice Deploys the whole system and completes the one-time bootstrap.
///
/// Order matters and is not arbitrary. AromaFactory's constructor needs
/// CurveManager's address, and CurveManager can only learn its factory
/// afterwards — hence setFactory, callable exactly once.
///
/// CurveManager and LiquidityLocker each need the other's address and both
/// hold it immutably, which cannot be satisfied by deploying them in either
/// order. The knot is cut by predicting the locker's address from the
/// deployer's next nonce, handing that to the curve, and then deploying the
/// locker into exactly that slot. The script asserts the prediction held
/// before it wires anything else up; if it did not, the run reverts rather
/// than leaving a curve pointing at an address that will never hold a
/// contract.
///
/// The only difference between an Arc testnet and an Arc mainnet
/// deployment is POOL_MANAGER:
///
///   Arc testnet (5042002) — leave it unset. Uniswap v4 is not deployed
///     there (eth_getCode against the published singleton returns empty),
///     the locker deploys with no manager, and graduation parks funds in
///     it exactly as the product does today.
///
///   Arc mainnet (5042) — set it to the v4 PoolManager, published as
///     0x8366a39cc670b4001a1121b8f6a443a643e40951. Verify that address has
///     code on the network you are deploying to before relying on it; a
///     locker pointed at an empty address will accept graduations and then
///     fail to seed them.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        // The deployer owns the contract through the broadcast because
        // setFactory is onlyOwner, then hands it over. Handing over first
        // would leave the factory unwireable by anyone but the new owner.
        address owner = vm.envOr("PROTOCOL_OWNER", deployer);
        address poolManager = vm.envOr("POOL_MANAGER", address(0));

        console.log("deployer:        ", deployer);
        console.log("owner:           ", owner);
        console.log("poolManager:     ", poolManager);
        console.log("balance (wei):   ", deployer.balance);

        if (poolManager == address(0)) {
            console.log("");
            console.log("No POOL_MANAGER set: the locker will hold graduation");
            console.log("funds without seeding a pool. Correct for Arc testnet.");
        } else {
            require(poolManager.code.length > 0, "POOL_MANAGER has no code on this chain");
        }

        // The locker is the second contract this account creates in the
        // broadcast, so its address is the deployer's next-nonce CREATE
        // address. Computed before broadcasting so the curve can be handed
        // it as an immutable constructor argument.
        uint64 nonce = vm.getNonce(deployer);
        address predictedLocker = vm.computeCreateAddress(deployer, nonce + 1);

        vm.startBroadcast(pk);

        CurveManager curve = new CurveManager(deployer, predictedLocker);
        LiquidityLocker locker = new LiquidityLocker(poolManager, address(curve));
        require(address(locker) == predictedLocker, "locker address prediction failed");

        AromaFactory factory = new AromaFactory(address(curve));
        curve.setFactory(address(factory));

        // Ownable2Step: this only nominates. Ownership does not move until
        // the nominee calls acceptOwnership from that address, which is the
        // point — it makes it impossible to hand the fee key to an address
        // nobody can sign for, which would strand every fee permanently.
        if (owner != deployer) {
            curve.transferOwnership(owner);
        }

        vm.stopBroadcast();

        console.log("");
        console.log("CurveManager:    ", address(curve));
        console.log("LiquidityLocker: ", address(locker));
        console.log("AromaFactory:    ", address(factory));
        console.log("");
        console.log("Verify wiring:");
        console.log("  factory set:   ", curve.factory() == address(factory));
        console.log("  vault is locker:", curve.graduationVault() == address(locker));
        console.log("  locker -> curve:", address(locker.curve()) == address(curve));
        console.log("  pool manager:  ", address(locker.poolManager()));
        console.log("  owner now:     ", curve.owner());
        console.log("  owner pending: ", curve.pendingOwner());

        if (curve.pendingOwner() != address(0)) {
            console.log("");
            console.log("ACTION REQUIRED: ownership is nominated, not transferred.");
            console.log("From the wallet above, call acceptOwnership() on:");
            console.log("  ", address(curve));
            console.log("Until then the deployer still owns fee withdrawal.");
        }
    }
}
