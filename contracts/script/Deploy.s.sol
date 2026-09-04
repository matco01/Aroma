// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {CurveManager} from "../src/CurveManager.sol";
import {AromaFactory} from "../src/AromaFactory.sol";

/// @notice Deploys the three-contract system and completes the one-time
/// bootstrap wiring.
///
/// Order matters and isn't arbitrary: AromaFactory's constructor needs
/// CurveManager's address, and CurveManager can only learn its factory
/// afterwards — hence setFactory, which is callable exactly once.
///
/// `graduationVault` is immutable on CurveManager, so it must be right at
/// deploy time. On testnet the deployer is a fine placeholder; on mainnet
/// this must be the real Uniswap v4 pool seeder, and getting it wrong means
/// redeploying rather than flipping a setting. That's deliberate — see the
/// field's NatSpec.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        // Defaults to the deployer so a testnet run needs no extra config.
        address graduationVault = vm.envOr("GRADUATION_VAULT", deployer);
        address owner = vm.envOr("PROTOCOL_OWNER", deployer);

        console.log("deployer:        ", deployer);
        console.log("owner:           ", owner);
        console.log("graduationVault: ", graduationVault);
        console.log("balance (wei):   ", deployer.balance);

        vm.startBroadcast(pk);

        CurveManager curve = new CurveManager(owner, graduationVault);
        AromaFactory factory = new AromaFactory(address(curve));
        curve.setFactory(address(factory));

        vm.stopBroadcast();

        console.log("");
        console.log("CurveManager:    ", address(curve));
        console.log("AromaFactory:     ", address(factory));
        console.log("");
        console.log("Verify wiring:");
        console.log("  factory set:   ", curve.factory() == address(factory));
        console.log("  vault set:     ", curve.graduationVault() == graduationVault);
    }
}
