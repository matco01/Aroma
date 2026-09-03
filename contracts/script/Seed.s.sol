// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {CurveManager} from "../src/CurveManager.sol";
import {AramFactory} from "../src/AramFactory.sol";

/// @notice Launches a handful of tokens with varied dev-buys so the board
/// has something real to render at different points on the curve, rather
/// than a single row. Testnet only — this is scaffolding for looking at the
/// UI with genuine on-chain data, not part of the protocol.
contract Seed is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        AramFactory factory = AramFactory(vm.envAddress("ARAM_FACTORY"));
        CurveManager curve = CurveManager(vm.envAddress("CURVE_MANAGER"));

        string[6] memory names = [
            "Gas Is Free",
            "Peg Enjoyer",
            "Six Decimals",
            "Sub Second",
            "Bank Run",
            "Exit Liquidity"
        ];
        string[6] memory symbols = ["GASFREE", "PEG", "SIX", "SUBSEC", "BANKRUN", "EXITLQ"];
        string[6] memory descriptions = [
            "on arc your gas is a dollar. on arc your dollar is gas. think about it",
            "i enjoy the peg. the peg enjoys me. nothing else matters",
            "for everyone who lost a run to eighteen. never again",
            "finality faster than you can regret the buy",
            "the only chart that goes up when everyone leaves",
            "at least this one is honest about it"
        ];
        // Spread across the curve so the board shows a range of progress
        // bars rather than six identical rows.
        uint256[6] memory devBuys = [uint256(0.4e18), 0.15e18, 0.9e18, 0, 0.25e18, 0.6e18];

        vm.startBroadcast(pk);
        for (uint256 i = 0; i < names.length; i++) {
            address token = factory.createToken{value: devBuys[i]}(
                names[i], symbols[i], descriptions[i], devBuys[i], 0
            );
            console.log(symbols[i], token);
        }
        vm.stopBroadcast();

        console.log("");
        console.log("protocol fee pot:", curve.accumulatedFees());
    }
}
