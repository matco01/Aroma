// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CurveManager} from "../src/CurveManager.sol";
import {AromaFactory} from "../src/AromaFactory.sol";
import {AromaToken} from "../src/AromaToken.sol";

/// @notice Exercises the full user journey against a real network:
/// launch -> dev-buy -> public buy -> permit sell -> claim creator fees.
///
/// Graduation is deliberately absent: it needs $13,800 into the curve and
/// the faucet gives 20 USDC every two hours, so it isn't reachable here.
/// That path stays covered by the local suite.
contract Lifecycle is Script {
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address me = vm.addr(pk);
        CurveManager curve = CurveManager(vm.envAddress("CURVE_MANAGER"));
        AromaFactory factory = AromaFactory(vm.envAddress("AROMA_FACTORY"));

        console.log("=== start ===");
        console.log("account:              ", me);
        console.log("native balance (wei): ", me.balance);

        vm.startBroadcast(pk);

        // 1. Launch with a small dev-buy in the same transaction.
        uint256 devBuy = 1e18; // 1 USDC
        address token = factory.createToken{value: devBuy}("Arc Test Coin", "ARCTEST", "", "", devBuy, 0, AromaFactory.LaunchGuard(0, 0, new address[](0)));
        console.log("");
        console.log("=== launched ===");
        console.log("token:                ", token);
        console.log("dev-buy tokens:       ", IERC20(token).balanceOf(me));
        console.log("creator fees accrued: ", curve.creatorFeesAccrued(token));

        // 2. A second, ordinary buy.
        uint256 buyAmount = 2e18; // 2 USDC
        uint256 got = curve.buy{value: buyAmount}(token, me, 0);
        console.log("");
        console.log("=== bought 2 USDC ===");
        console.log("tokens received:      ", got);
        console.log("total token balance:  ", IERC20(token).balanceOf(me));

        (uint256 reserve, uint256 sold,,) = curve.tokenState(token);
        console.log("curve reserve (wei):  ", reserve);
        console.log("curve tokens sold:    ", sold);

        // 3. Sell half the position using a real EIP-2612 permit — one
        //    transaction, no separate approve.
        uint256 sellAmount = IERC20(token).balanceOf(me) / 2;
        uint256 usdcOut = _sellWithPermit(curve, token, pk, me, sellAmount);
        console.log("");
        console.log("=== sold half via permit ===");
        console.log("tokens sold:          ", sellAmount);
        console.log("usdc out (wei):       ", usdcOut);
        console.log("token balance left:   ", IERC20(token).balanceOf(me));

        // 4. Claim the creator's share of the fees those trades generated.
        uint256 owed = curve.creatorFeesAccrued(token);
        console.log("");
        console.log("=== creator fees ===");
        console.log("accrued (wei):        ", owed);
        if (owed > 0) {
            curve.claimCreatorFees(token);
            console.log("claimed:              ", true);
        }

        vm.stopBroadcast();

        console.log("");
        console.log("=== end ===");
        console.log("native balance (wei): ", me.balance);
        console.log("protocol fee pot:     ", curve.accumulatedFees());
    }

    /// @dev Kept in its own frame purely to stay under the stack limit —
    /// the signing locals plus run()'s own don't fit in one function.
    function _sellWithPermit(CurveManager curve, address token, uint256 pk, address me, uint256 amount)
        internal
        returns (uint256 usdcOut)
    {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                AromaToken(token).DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        PERMIT_TYPEHASH, me, address(curve), amount, AromaToken(token).nonces(me), deadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        usdcOut = curve.sell(token, amount, 0, deadline, v, r, s);
    }
}
