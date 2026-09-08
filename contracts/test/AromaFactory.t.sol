// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CurveManager} from "../src/CurveManager.sol";
import {AromaFactory} from "../src/AromaFactory.sol";
import {AromaToken} from "../src/AromaToken.sol";

contract AramFactoryTest is Test {
    CurveManager curve;
    AromaFactory factory;

    address owner = makeAddr("owner");
    address vault = makeAddr("vault");
    address creator = makeAddr("creator");
    address stranger = makeAddr("stranger");

    function setUp() public {
        curve = new CurveManager(owner, vault);
        factory = new AromaFactory(address(curve));
        vm.prank(owner);
        curve.setFactory(address(factory));

        vm.deal(creator, 100_000e18);
        vm.deal(stranger, 100_000e18);
    }

    function test_createToken_isFreeApartFromGas() public {
        uint256 balBefore = creator.balance;

        vm.prank(creator);
        address token = factory.createToken("Free Coin", "FREE", "", "", 0, 0, AromaFactory.LaunchGuard(0, 0, new address[](0)));

        assertEq(creator.balance, balBefore, "no creation fee, matching pump.fun's own $0 schedule");
        assertTrue(token != address(0));
    }

    function test_createToken_mintsFullSupplyToCurve() public {
        vm.prank(creator);
        address token = factory.createToken("Supply Coin", "SUP", "", "", 0, 0, AromaFactory.LaunchGuard(0, 0, new address[](0)));

        assertEq(IERC20(token).totalSupply(), factory.TOTAL_SUPPLY(), "fixed 1B supply");
        assertEq(
            IERC20(token).balanceOf(address(curve)),
            factory.TOTAL_SUPPLY(),
            "entire supply starts in the curve, none held back for anyone"
        );
        assertEq(IERC20(token).balanceOf(creator), 0, "creator gets no free allocation");
    }

    function test_createToken_recordsCreatorAndMetadata() public {
        vm.prank(creator);
        address token = factory.createToken("Named Coin", "NAME", "", "", 0, 0, AromaFactory.LaunchGuard(0, 0, new address[](0)));

        (,, address recordedCreator, bool graduated) = curve.tokenState(token);
        assertEq(recordedCreator, creator, "creator recorded for fee routing");
        assertFalse(graduated);
        assertEq(AromaToken(token).name(), "Named Coin");
        assertEq(AromaToken(token).symbol(), "NAME");
    }

    /// @dev Regression test for a real bug caught during development: the
    /// factory pays for the dev-buy as the *calling contract*, so a
    /// buy() that delivered to msg.sender would have sent the creator's
    /// tokens to the factory address, stranding them permanently. Tokens
    /// must land on the creator.
    function test_devBuy_deliversTokensToCreatorNotFactory() public {
        uint256 devBuy = 500e18;

        vm.prank(creator);
        address token = factory.createToken{value: devBuy}("Dev Coin", "DEV", "", "", devBuy, 0, AromaFactory.LaunchGuard(0, 0, new address[](0)));

        assertGt(IERC20(token).balanceOf(creator), 0, "creator holds their dev-buy");
        assertEq(IERC20(token).balanceOf(address(factory)), 0, "factory must never retain tokens");
    }

    function test_devBuy_goesThroughTheSamePricingAsAnyoneElse() public {
        uint256 devBuy = 500e18;

        // What a normal buyer would receive for the same amount on a fresh
        // curve — the dev must get exactly this, no preferential pricing.
        vm.prank(creator);
        address refToken = factory.createToken("Ref Coin", "REF", "", "", 0, 0, AromaFactory.LaunchGuard(0, 0, new address[](0)));
        (uint256 publicQuote,) = curve.quoteBuy(refToken, devBuy);

        vm.prank(creator);
        address token = factory.createToken{value: devBuy}("Dev Coin", "DEV", "", "", devBuy, 0, AromaFactory.LaunchGuard(0, 0, new address[](0)));

        assertEq(IERC20(token).balanceOf(creator), publicQuote, "dev-buy priced identically to a public buy");
    }

    function test_devBuy_accruesCreatorFeeToThemselves() public {
        uint256 devBuy = 1_000e18;

        vm.prank(creator);
        address token = factory.createToken{value: devBuy}("Dev Coin", "DEV", "", "", devBuy, 0, AromaFactory.LaunchGuard(0, 0, new address[](0)));

        // The dev-buy pays the same 1% as any trade, and 70% of that
        // routes straight back to the creator — who is the buyer here.
        assertGt(curve.creatorFeesAccrued(token), 0, "dev-buy generates creator fees like any other trade");
    }

    function test_createToken_refundsExcessPayment() public {
        uint256 devBuy = 100e18;
        uint256 overpay = 250e18;
        uint256 balBefore = creator.balance;

        vm.prank(creator);
        factory.createToken{value: overpay}("Refund Coin", "RFND", "", "", devBuy, 0, AromaFactory.LaunchGuard(0, 0, new address[](0)));

        assertEq(creator.balance, balBefore - devBuy, "only the dev-buy is spent; the rest comes back");
    }

    function test_createToken_revertsWhenPaymentBelowDevBuy() public {
        vm.prank(creator);
        vm.expectRevert(bytes("insufficient payment"));
        factory.createToken{value: 10e18}("Short Coin", "SHRT", "", "", 500e18, 0, AromaFactory.LaunchGuard(0, 0, new address[](0)));
    }

    function test_devBuy_respectsSlippageBound() public {
        uint256 devBuy = 500e18;

        vm.prank(creator);
        address refToken = factory.createToken("Ref Coin", "REF", "", "", 0, 0, AromaFactory.LaunchGuard(0, 0, new address[](0)));
        (uint256 quote,) = curve.quoteBuy(refToken, devBuy);

        vm.prank(creator);
        vm.expectRevert(bytes("slippage"));
        factory.createToken{value: devBuy}("Dev Coin", "DEV", "", "", devBuy, quote + 1, AromaFactory.LaunchGuard(0, 0, new address[](0)));
    }

    /// @dev The cap existed as a constant but nothing checked it — a
    /// creator could have taken most of the curve at its cheapest prices
    /// before anyone else knew the token existed. Regression test.
    function test_devBuy_isCappedAndEnforced() public {
        uint256 overCap = curve.MAX_DEV_BUY_USDC() + 1;
        vm.deal(creator, overCap + 1e18);

        vm.prank(creator);
        vm.expectRevert(bytes("dev buy exceeds cap"));
        factory.createToken{value: overCap}("Sniper Coin", "SNIPE", "", "", overCap, 0, AromaFactory.LaunchGuard(0, 0, new address[](0)));
    }

    function test_devBuy_atExactlyTheCapIsAllowed() public {
        uint256 atCap = curve.MAX_DEV_BUY_USDC();
        vm.deal(creator, atCap + 1e18);

        vm.prank(creator);
        address token = factory.createToken{value: atCap}("Edge Coin", "EDGE", "", "", atCap, 0, AromaFactory.LaunchGuard(0, 0, new address[](0)));
        assertGt(IERC20(token).balanceOf(creator), 0, "a dev-buy exactly at the cap must still succeed");
    }

    function test_registerToken_onlyCallableByFactory() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("only factory"));
        curve.registerToken(makeAddr("fakeToken"), stranger, 0, 0, new address[](0));
    }

    function test_setFactory_isOneTimeOnly() public {
        vm.prank(owner);
        vm.expectRevert(bytes("factory already set"));
        curve.setFactory(makeAddr("anotherFactory"));
    }

    function test_launchedTokenHasNoMintFunction() public {
        vm.prank(creator);
        address token = factory.createToken("Fixed Coin", "FIXD", "", "", 0, 0, AromaFactory.LaunchGuard(0, 0, new address[](0)));

        uint256 supplyBefore = IERC20(token).totalSupply();

        // There is no mint selector on the deployed token at all — this
        // asserts the ABI surface, not just that a call happens to fail.
        (bool ok,) = token.call(abi.encodeWithSignature("mint(address,uint256)", creator, 1e18));
        assertFalse(ok, "no mint function may exist on a launched token");
        assertEq(IERC20(token).totalSupply(), supplyBefore, "supply is immutable after deployment");
    }

    /// @notice A token must be announced before it is traded.
    ///
    /// The dev-buy happens inside createToken and emits Bought from
    /// CurveManager. Indexers consume logs in index order, so if
    /// TokenCreated came last, every consumer would see a trade for a token
    /// it had never heard of — and any indexer keyed by token silently
    /// drops that trade. Aroma's own subgraph did exactly that: six seeded
    /// tokens produced five dev-buys and indexed one trade.
    ///
    /// This asserts the emission order directly, because the failure mode
    /// is invisible on-chain — balances and reserves are all correct, only
    /// the log ordering is wrong.
    function test_devBuy_isAnnouncedAfterTheTokenExists() public {
        vm.recordLogs();

        vm.prank(creator);
        factory.createToken{value: 100e18}("Ordered", "ORD", "", "", 100e18, 0, AromaFactory.LaunchGuard(0, 0, new address[](0)));

        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 tokenCreatedSig =
            keccak256("TokenCreated(address,address,string,string,string,string,uint256)");
        bytes32 boughtSig =
            keccak256("Bought(address,address,address,uint256,uint256,uint256,uint256)");

        int256 tokenCreatedAt = -1;
        int256 boughtAt = -1;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == tokenCreatedSig && tokenCreatedAt < 0) {
                tokenCreatedAt = int256(i);
            }
            if (logs[i].topics[0] == boughtSig && boughtAt < 0) {
                boughtAt = int256(i);
            }
        }

        assertGe(tokenCreatedAt, 0, "TokenCreated must be emitted");
        assertGe(boughtAt, 0, "dev-buy must emit Bought");
        assertLt(
            tokenCreatedAt,
            boughtAt,
            "TokenCreated must precede the dev-buy's Bought, or indexers drop the dev-buy"
        );
    }
}
