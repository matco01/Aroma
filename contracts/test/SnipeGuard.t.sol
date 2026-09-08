// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CurveManager} from "../src/CurveManager.sol";
import {AromaFactory} from "../src/AromaFactory.sol";

/**
 * The launch-window tax.
 *
 * Two things are being tested here and only one of them is the feature. The
 * feature is that a buy in the first second costs almost everything and a
 * buy after the window costs nothing extra. The other, more important thing
 * is that a creator cannot turn this into a honeypot — the caps are what
 * make it safe to hand a stranger a dial labelled "tax my buyers", so the
 * caps get more tests than the decay does.
 */
contract SnipeGuardTest is Test {
    CurveManager internal curve;
    AromaFactory internal factory;

    address internal owner = address(0xA0);
    address internal creator = address(0xC0);
    address internal sniper = address(0x51);
    address internal human = address(0x11);
    address internal teamWallet = address(0x7EA);

    function setUp() public {
        curve = new CurveManager(owner, address(0xBEEF));
        factory = new AromaFactory(address(curve));
        vm.prank(owner);
        curve.setFactory(address(factory));

        vm.deal(creator, 10_000e18);
        vm.deal(sniper, 10_000e18);
        vm.deal(human, 10_000e18);
        vm.deal(teamWallet, 10_000e18);
    }

    function _launch(uint32 window, uint16 bps, address[] memory exempt)
        internal
        returns (address token)
    {
        vm.prank(creator);
        token = factory.createToken(
            "Guarded", "GRD", "", "", 0, 0,
            AromaFactory.LaunchGuard(window, bps, exempt)
        );
    }

    function _none() internal pure returns (address[] memory) {
        return new address[](0);
    }

    // -----------------------------------------------------------------
    // The feature
    // -----------------------------------------------------------------

    function test_taxIsHighestAtLaunchAndZeroAfterTheWindow() public {
        address token = _launch(3, 9_900, _none());

        assertEq(curve.snipeTaxBps(token, sniper), 9_900, "at t=0 the full rate applies");

        vm.warp(block.timestamp + 1);
        uint16 mid = curve.snipeTaxBps(token, sniper);
        assertLt(mid, 9_900, "must decay");
        assertGt(mid, 0, "still inside the window");

        vm.warp(block.timestamp + 2);
        assertEq(curve.snipeTaxBps(token, sniper), 0, "window is over");
    }

    function test_aSniperGetsFarFewerTokensThanTheHumanBehindThem() public {
        address token = _launch(3, 9_900, _none());

        vm.prank(sniper);
        uint256 snipedTokens = curve.buy{value: 100e18}(token, sniper, 0);

        // Same money, three seconds later, no tax.
        vm.warp(block.timestamp + 3);
        vm.prank(human);
        uint256 humanTokens = curve.buy{value: 100e18}(token, human, 0);

        assertLt(snipedTokens * 10, humanTokens, "sniping must be badly unprofitable");
    }

    function test_exemptWalletsPayNothing() public {
        address[] memory exempt = new address[](1);
        exempt[0] = teamWallet;
        address token = _launch(3, 9_900, exempt);

        assertEq(curve.snipeTaxBps(token, teamWallet), 0, "team wallet is exempt");
        assertEq(curve.snipeTaxBps(token, sniper), 9_900, "everyone else is not");

        vm.prank(teamWallet);
        uint256 teamTokens = curve.buy{value: 100e18}(token, teamWallet, 0);
        vm.prank(sniper);
        uint256 sniperTokens = curve.buy{value: 100e18}(token, sniper, 0);

        assertGt(teamTokens, sniperTokens * 10, "exemption must actually apply");
    }

    function test_guardIsOffUnlessAskedFor() public {
        address token = _launch(0, 0, _none());
        assertEq(curve.snipeTaxBps(token, sniper), 0, "no guard by default");
    }

    function test_taxGoesToTheCreatorAndProtocol_notNowhere() public {
        address token = _launch(3, 9_900, _none());

        uint256 feesBefore = curve.creatorFeesAccrued(token);
        uint256 protocolBefore = curve.accumulatedFees();

        vm.prank(sniper);
        curve.buy{value: 100e18}(token, sniper, 0);

        assertGt(curve.creatorFeesAccrued(token), feesBefore, "creator receives the tax");
        assertGt(curve.accumulatedFees(), protocolBefore, "protocol receives its share");
    }

    // -----------------------------------------------------------------
    // The caps — the reason this is safe to expose at all
    // -----------------------------------------------------------------

    function test_windowCannotOutlastTheCap() public {
        // Cached before expectRevert. Reading a public constant is itself an
        // external call, so inline it becomes the "next call" the cheatcode
        // watches — and it does not revert. Same trap as the prank-consuming
        // reads noted in CurveHandler.
        uint32 tooLong = curve.MAX_SNIPE_WINDOW() + 1;
        AromaFactory.LaunchGuard memory guard = AromaFactory.LaunchGuard(tooLong, 9_900, _none());

        vm.prank(creator);
        vm.expectRevert("snipe window too long");
        factory.createToken("Forever", "FVR", "", "", 0, 0, guard);
    }

    function test_rateCannotExceedTheCap() public {
        uint16 tooHigh = curve.MAX_SNIPE_BPS() + 1;
        AromaFactory.LaunchGuard memory guard = AromaFactory.LaunchGuard(3, tooHigh, _none());

        vm.prank(creator);
        vm.expectRevert("snipe rate too high");
        factory.createToken("AllOfIt", "ALL", "", "", 0, 0, guard);
    }

    /// The honeypot this design exists to make impossible: a tax that never
    /// ends. Whatever a creator sets, three seconds later every buyer pays
    /// the ordinary fee and nothing more.
    function test_everyPossibleGuardHasExpiredWithinThreeSeconds() public {
        address token = _launch(curve.MAX_SNIPE_WINDOW(), curve.MAX_SNIPE_BPS(), _none());
        vm.warp(block.timestamp + curve.MAX_SNIPE_WINDOW());
        assertEq(curve.snipeTaxBps(token, sniper), 0, "no guard may outlive the cap");
    }

    function test_exemptListIsBoundedSoRegistrationCannotBeGriefed() public {
        AromaFactory.LaunchGuard memory guard =
            AromaFactory.LaunchGuard(3, 9_900, new address[](11));

        vm.prank(creator);
        vm.expectRevert("too many exempt wallets");
        factory.createToken("Many", "MNY", "", "", 0, 0, guard);
    }

    /// The exemption list is fixed at creation. A creator who could add to
    /// it later would be choosing, after the fact, who had to pay.
    function test_thereIsNoWayToChangeTheGuardAfterLaunch() public {
        address token = _launch(3, 9_900, _none());
        bytes4[3] memory forbidden = [
            bytes4(keccak256("setSnipeGuard(address,uint32,uint16)")),
            bytes4(keccak256("addSnipeExempt(address,address)")),
            bytes4(keccak256("setSnipeExempt(address,address,bool)"))
        ];
        for (uint256 i = 0; i < forbidden.length; i++) {
            (bool ok,) = address(curve).call(abi.encodeWithSelector(forbidden[i], token, sniper, true));
            assertFalse(ok, "the guard must be immutable after launch");
        }
    }
}
