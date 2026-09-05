// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CurveManager} from "../src/CurveManager.sol";
import {AromaFactory} from "../src/AromaFactory.sol";
import {AromaToken} from "../src/AromaToken.sol";

/// @notice Covers the highest-stakes paths named in the project plan: the
/// curve math against derive_curve.py's verified targets, protocol-favoring
/// rounding, slippage enforcement actually reverting on-chain (not just
/// being displayed), and the creator/protocol fee split. The fuzz tests
/// specifically target the rounding-direction invariant — that's the one
/// silent-drift bug class hand-written cases alone won't reliably catch.
contract CurveManagerTest is Test {
    CurveManager curve;
    AromaFactory factory;

    address owner = makeAddr("owner");
    address vault = makeAddr("vault");

    // Actors that need to sign EIP-2612 permits must be key-derived, not
    // makeAddr-derived — makeAddr gives no usable private key.
    uint256 constant CREATOR_KEY = 0xC12EA702;
    uint256 constant TRADER_KEY = 0x77AD34;
    uint256 constant WRONG_KEY = 0xBAD5169;
    address creator = vm.addr(CREATOR_KEY);
    address trader = vm.addr(TRADER_KEY);
    address buyer = makeAddr("buyer");
    address whale = makeAddr("whale");

    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function setUp() public {
        curve = new CurveManager(owner, vault);
        factory = new AromaFactory(address(curve));
        vm.prank(owner);
        curve.setFactory(address(factory));

        vm.deal(creator, 100_000e18);
        vm.deal(trader, 100_000e18);
        vm.deal(buyer, 100_000e18);
        vm.deal(whale, 100_000e18);
    }

    function _launch() internal returns (address token) {
        vm.prank(creator);
        token = factory.createToken("Test Coin", "TEST", "", "", 0, 0, AromaFactory.LaunchGuard(0, 0, new address[](0)));
    }

    function _signPermit(uint256 pk, address signerAddr, address token, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        AromaToken t = AromaToken(token);
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, signerAddr, address(curve), value, t.nonces(signerAddr), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", t.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(pk, digest);
    }

    /// @dev Smallest msg.value whose post-fee remainder is at least `net`.
    /// The curve's graduation trigger reads the *net* reserve, but callers
    /// send gross, and a 1% fee is integer division — so hitting the
    /// graduation boundary exactly takes solving for it rather than
    /// guessing. For the $13,800 target this lands exactly, no overshoot,
    /// which matters: buy() hard-reverts if a trade would push tokensSold
    /// even one wei past CURVE_SUPPLY.
    function _grossForNet(uint256 net) internal view returns (uint256 gross) {
        uint256 feeBps = curve.TRADE_FEE_BPS();
        uint256 denom = curve.FEE_DENOMINATOR();
        gross = net * denom / (denom - feeBps);
        while (gross - (gross * feeBps / denom) < net) {
            gross++;
        }
    }

    /// @dev One buy, sized to land the curve exactly on its graduation
    /// threshold. Deliberately a single trade rather than a loop: constant
    /// product is path-independent for a given total input, so one buy
    /// reaches the identical end state as many, and it exercises the exact
    /// boundary case without iteration-convergence fragility.
    function _buyToGraduation(address token) internal {
        uint256 grossIn = _grossForNet(curve.GRADUATION_RAISE_USDC());
        vm.deal(whale, grossIn + 1e18);
        vm.prank(whale);
        curve.buy{value: grossIn}(token, whale, 0);
    }

    // -----------------------------------------------------------------
    // Curve math — must reproduce derive_curve.py's verified targets. If
    // this fails, the Solidity constants and the Python derivation have
    // drifted; re-run the script rather than hand-editing either side
    // back into agreement.
    // -----------------------------------------------------------------

    function test_graduationLandsExactlyOnDerivedTargets() public {
        address token = _launch();
        _buyToGraduation(token);

        (uint256 raised, uint256 tokensSold,,) = curve.tokenState(token);

        assertEq(raised, curve.GRADUATION_RAISE_USDC(), "net raised must land exactly on the $13,800 target");

        // Not bit-exact against the 800M target, and shouldn't be: the
        // Python derivation uses exact rationals, integer Solidity rounds.
        // What matters is the *direction* — ceilDiv must round tokens out
        // down, never up, so the dust always stays with the protocol
        // rather than being extractable by a trader repeating the trade.
        assertLe(tokensSold, curve.CURVE_SUPPLY(), "rounding must never sell past the curve supply");
        assertApproxEqAbs(
            tokensSold, curve.CURVE_SUPPLY(), 1e12, "tokens sold must reach 800M within integer-rounding dust"
        );

        // Spot price x total supply = fully diluted market cap. The
        // frontend computes mcap the same way (price * TOTAL_SUPPLY), so
        // this is the number the UI will actually show at graduation.
        uint256 price =
            (curve.VIRTUAL_USDC_RESERVE() + raised) * 1e18 / (curve.VIRTUAL_TOKEN_RESERVE() - tokensSold);
        uint256 marketCap = price * curve.TOTAL_SUPPLY() / 1e18;
        assertApproxEqAbs(marketCap, 69_000e18, 1e9, "market cap must land on $69,000");
    }

    function test_buy_cannotExceedCurveSupply() public {
        address token = _launch();
        _buyToGraduation(token);

        // Curve is now exactly sold out — any further buy overshoots.
        vm.prank(buyer);
        vm.expectRevert(bytes("exceeds curve supply"));
        curve.buy{value: 1e18}(token, buyer, 0);
    }

    /// @notice The graduation pool must open at the price the curve closed
    /// at. This is the test that did not exist when the curve was first
    /// derived, and its absence shipped a 73.8% price gap: with a $24,000
    /// raise and a 200M LP reserve the pool opened at a $119,950 market cap
    /// while the curve closed at $69,000 — a windfall for anyone holding
    /// through migration, paid for by whoever bought into the fresh pool.
    ///
    /// The reserve and the raise are one decision, not two:
    ///     LP_RESERVE / TOTAL_SUPPLY == GRADUATION_RAISE / GRADUATION_MCAP
    /// so this fails the moment either is edited without the other.
    function test_graduationPoolOpensAtTheCurvesClosingPrice() public {
        address token = _launch();
        _buyToGraduation(token);

        (uint256 raised, uint256 tokensSold,,) = curve.tokenState(token);
        uint256 closingPrice =
            (curve.VIRTUAL_USDC_RESERVE() + raised) * 1e18 / (curve.VIRTUAL_TOKEN_RESERVE() - tokensSold);

        curve.graduate(token);

        // What the vault actually received is what a pool would be seeded
        // with — read it back rather than recomputing the intent.
        uint256 usdcSeed = vault.balance;
        uint256 tokenSeed = IERC20(token).balanceOf(vault);
        uint256 openingPrice = usdcSeed * 1e18 / tokenSeed;

        // The only permitted gap is the flat graduation fee leaving the
        // raise: $10 of $13,800 is 0.072%. Allow 0.5% and no more.
        uint256 tolerance = closingPrice * 50 / 10_000;
        assertApproxEqAbs(
            openingPrice,
            closingPrice,
            tolerance,
            "graduation pool must open where the curve closed"
        );

        // And the gap must be *downward* — the fee leaves, so the pool can
        // only open marginally cheaper. Opening dearer would mean handing
        // holders free upside at the new buyer's expense.
        assertLe(openingPrice, closingPrice, "pool must never open above the curve's closing price");
    }

    function test_graduate_seedsVaultAndSkimsFlatFee() public {
        address token = _launch();
        _buyToGraduation(token);

        uint256 vaultUsdcBefore = vault.balance;
        uint256 protocolFeesBefore = curve.accumulatedFees();

        curve.graduate(token);

        (, uint256 tokensSold,, bool graduated) = curve.tokenState(token);
        assertTrue(graduated, "must be marked graduated");
        assertEq(
            vault.balance - vaultUsdcBefore,
            curve.GRADUATION_RAISE_USDC() - curve.GRADUATION_FEE_USDC(),
            "vault receives the raise minus the flat graduation fee"
        );
        assertEq(
            IERC20(token).balanceOf(vault),
            curve.TOTAL_SUPPLY() - tokensSold,
            "vault receives every unsold token to pair with the raise"
        );
        // Slightly *more* than the nominal LP reserve, never less — the
        // dust left behind by protocol-favouring rounding on every buy
        // ends up here, seeding the pool rather than going missing.
        assertGe(
            IERC20(token).balanceOf(vault),
            curve.LP_RESERVE_SUPPLY(),
            "LP reserve must never be short-changed by rounding"
        );
        assertApproxEqAbs(
            IERC20(token).balanceOf(vault),
            curve.LP_RESERVE_SUPPLY(),
            1e12,
            "unsold remainder is the LP reserve plus rounding dust"
        );
        assertEq(
            curve.accumulatedFees() - protocolFeesBefore,
            curve.GRADUATION_FEE_USDC(),
            "graduation fee lands in the protocol pot"
        );
    }

    /// @dev Graduation moves the whole raise out of the contract, so the
    /// reserve figure has to go with it. Leaving it standing would claim
    /// backing that is no longer here and break the solvency invariant.
    function test_graduate_zeroesTheReserveItPaysOut() public {
        address token = _launch();
        _buyToGraduation(token);
        curve.graduate(token);

        (uint256 reserve,,,) = curve.tokenState(token);
        assertEq(reserve, 0, "a graduated token must not still claim a curve reserve");
    }

    function test_buy_rejectsCurveItselfAsRecipient() public {
        address token = _launch();
        vm.prank(buyer);
        vm.expectRevert(bytes("bad recipient"));
        curve.buy{value: 100e18}(token, address(curve), 0);
    }

    function test_withdrawFees_rejectsZeroDestination() public {
        address token = _launch();
        vm.prank(buyer);
        curve.buy{value: 1_000e18}(token, buyer, 0);

        vm.prank(owner);
        vm.expectRevert(bytes("to=0"));
        curve.withdrawFees(address(0), 1);
    }

    /// @notice The owner cannot reach a single wei of user money.
    ///
    /// This replaces the old pause test. There is deliberately no emergency
    /// stop any more — an owner who can halt every token's trading is
    /// exactly the trust a launchpad claims not to require — so what
    /// matters now is proving the remaining admin surface is narrow.
    ///
    /// `withdrawFees` is capped at the protocol's own accumulated cut.
    /// Curve reserves and creator fees are not reachable from any
    /// owner-only path, and this asserts it rather than asserting it in a
    /// comment.
    function test_ownerCannotTouchUserFunds() public {
        address token = _launch();
        vm.prank(buyer);
        curve.buy{value: 1_000e18}(token, buyer, 0);

        (uint256 reserveBefore,,,) = curve.tokenState(token);
        uint256 creatorOwed = curve.creatorFeesAccrued(token);
        uint256 protocolPot = curve.accumulatedFees();

        assertGt(reserveBefore, 0, "precondition: the curve holds a reserve");
        assertGt(creatorOwed, 0, "precondition: the creator is owed fees");

        // Taking one wei more than the protocol's own pot must revert, even
        // though the contract's balance is far larger — that surplus is the
        // curve reserve and the creator's fees, and it is not the owner's.
        vm.prank(owner);
        vm.expectRevert(bytes("exceeds fees"));
        curve.withdrawFees(owner, protocolPot + 1);

        // Draining the entire legitimate pot must leave everything else
        // exactly where it was.
        vm.prank(owner);
        curve.withdrawFees(owner, protocolPot);

        (uint256 reserveAfter,,,) = curve.tokenState(token);
        assertEq(reserveAfter, reserveBefore, "curve reserve must be untouchable by the owner");
        assertEq(
            curve.creatorFeesAccrued(token), creatorOwed, "creator fees must be untouchable by the owner"
        );
        assertGe(
            address(curve).balance,
            reserveAfter + creatorOwed,
            "contract must still cover every obligation after the owner withdraws"
        );
    }

    /// @notice Trading cannot be halted by anyone, including the owner.
    ///
    /// The owner's entire surface is setFactory (one-shot, and already
    /// spent at deployment) and withdrawFees (capped at the protocol's own
    /// cut). Neither touches the trading path, so buying and selling stay
    /// open unconditionally. If a pause is ever reintroduced, this fails.
    function test_tradingCannotBeHalted() public {
        address token = _launch();

        // The owner draining the protocol pot must not affect trading.
        vm.prank(buyer);
        curve.buy{value: 1_000e18}(token, buyer, 0);
        // Read the pot BEFORE pranking. A `curve.accumulatedFees()` call
        // inside the argument list consumes the prank itself, so the
        // withdrawal would come from this test contract and revert on
        // access control — the same trap noted in CurveHandler.
        uint256 pot = curve.accumulatedFees();
        vm.prank(owner);
        curve.withdrawFees(owner, pot);

        vm.prank(whale);
        curve.buy{value: 1e18}(token, whale, 0);

        (, uint256 sold,,) = curve.tokenState(token);
        assertGt(sold, 0, "trading must remain open regardless of owner actions");
    }

    function test_graduationVaultIsImmutable() public view {
        // No setter exists at all — the ABI itself is the guarantee that
        // graduated liquidity can't be redirected after the fact.
        assertEq(curve.graduationVault(), vault);
    }

    function test_graduate_revertsBeforeThreshold() public {
        address token = _launch();
        vm.prank(buyer);
        curve.buy{value: 1_000e18}(token, buyer, 0);

        vm.expectRevert(bytes("not ready"));
        curve.graduate(token);
    }

    function test_graduate_isPermissionless() public {
        address token = _launch();
        _buyToGraduation(token);

        // Called by an arbitrary address with no special role — the
        // product must not depend on Aroma running a keeper for tokens to
        // graduate.
        vm.prank(makeAddr("randomPasserby"));
        curve.graduate(token);

        (,,, bool graduated) = curve.tokenState(token);
        assertTrue(graduated);
    }

    function test_trading_haltsAfterGraduation() public {
        address token = _launch();
        _buyToGraduation(token);
        curve.graduate(token);

        vm.prank(buyer);
        vm.expectRevert(bytes("graduated"));
        curve.buy{value: 100e18}(token, buyer, 0);
    }

    // -----------------------------------------------------------------
    // Fees — the creator/protocol split, pre- and post-graduation.
    // -----------------------------------------------------------------

    function test_buy_splitsFeeSeventyThirty() public {
        address token = _launch();
        uint256 usdcIn = 1_000e18;

        vm.prank(buyer);
        curve.buy{value: usdcIn}(token, buyer, 0);

        uint256 totalFee = usdcIn * curve.TRADE_FEE_BPS() / curve.FEE_DENOMINATOR();
        uint256 expectedCreatorCut = totalFee * curve.CREATOR_FEE_SHARE_BPS() / curve.FEE_DENOMINATOR();

        assertEq(totalFee, 10e18, "1% of $1,000 is $10");
        assertEq(curve.creatorFeesAccrued(token), expectedCreatorCut, "creator accrues 70% of the fee");
        assertEq(curve.accumulatedFees(), totalFee - expectedCreatorCut, "protocol keeps the other 30%");
    }

    function test_sell_alsoSplitsFee() public {
        address token = _launch();
        vm.prank(trader);
        curve.buy{value: 1_000e18}(token, trader, 0);

        uint256 creatorAccruedAfterBuy = curve.creatorFeesAccrued(token);
        uint256 bal = IERC20(token).balanceOf(trader);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(TRADER_KEY, trader, token, bal, deadline);

        vm.prank(trader);
        curve.sell(token, bal, 0, deadline, v, r, s);

        assertGt(
            curve.creatorFeesAccrued(token),
            creatorAccruedAfterBuy,
            "selling accrues creator fees too, not just buying"
        );
    }

    function test_claimCreatorFees_paysRecordedCreatorRegardlessOfCaller() public {
        address token = _launch();
        vm.prank(buyer);
        curve.buy{value: 1_000e18}(token, buyer, 0);

        uint256 owed = curve.creatorFeesAccrued(token);
        assertGt(owed, 0);

        uint256 creatorBalBefore = creator.balance;
        // A stranger triggers the claim; funds still land on the recorded
        // creator, never the caller. That's the point of the test.
        vm.prank(makeAddr("stranger"));
        curve.claimCreatorFees(token);

        assertEq(creator.balance - creatorBalBefore, owed, "creator receives the full accrued balance");
        assertEq(curve.creatorFeesAccrued(token), 0, "ledger zeroed after claim");
    }

    function test_claimCreatorFees_revertsWhenNothingAccrued() public {
        address token = _launch();
        vm.expectRevert(bytes("nothing to claim"));
        curve.claimCreatorFees(token);
    }

    function test_depositGraduatedFees_feedsSameLedgerAndClaimPath() public {
        address token = _launch();
        _buyToGraduation(token);
        curve.graduate(token);

        uint256 sweepAmount = 50e18;
        uint256 accruedBefore = curve.creatorFeesAccrued(token);
        uint256 expectedCut = sweepAmount * curve.CREATOR_FEE_SHARE_BPS() / curve.FEE_DENOMINATOR();

        curve.depositGraduatedFees{value: sweepAmount}(token);

        assertEq(
            curve.creatorFeesAccrued(token) - accruedBefore,
            expectedCut,
            "post-graduation sweep accrues on the same 70/30 split"
        );

        // The whole point of routing sweeps into the same ledger: one
        // claim function, regardless of which phase the fees came from.
        uint256 totalOwed = curve.creatorFeesAccrued(token);
        uint256 creatorBalBefore = creator.balance;
        curve.claimCreatorFees(token);

        assertEq(
            creator.balance - creatorBalBefore, totalOwed, "one claim pays out curve fees and swept fees together"
        );
    }

    function test_depositGraduatedFees_revertsBeforeGraduation() public {
        address token = _launch();
        vm.expectRevert(bytes("not graduated"));
        curve.depositGraduatedFees{value: 10e18}(token);
    }

    function test_withdrawFees_cannotTouchCurveReserves() public {
        address token = _launch();
        vm.prank(buyer);
        curve.buy{value: 1_000e18}(token, buyer, 0);

        uint256 protocolPot = curve.accumulatedFees();

        // Trying to withdraw even one wei beyond the protocol's own pot
        // must fail, no matter how much native USDC the contract holds in
        // curve reserves.
        vm.prank(owner);
        vm.expectRevert(bytes("exceeds fees"));
        curve.withdrawFees(owner, protocolPot + 1);
    }

    function test_withdrawFees_onlyOwner() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        curve.withdrawFees(makeAddr("attacker"), 0);
    }

    // -----------------------------------------------------------------
    // Slippage — must revert on-chain, not merely be displayed by the UI.
    // -----------------------------------------------------------------

    function test_buy_revertsOnSlippageViolation() public {
        address token = _launch();
        (uint256 quoted,) = curve.quoteBuy(token, 1_000e18);

        vm.prank(buyer);
        vm.expectRevert(bytes("slippage"));
        curve.buy{value: 1_000e18}(token, buyer, quoted + 1);
    }

    function test_sell_revertsOnSlippageViolation() public {
        address token = _launch();
        vm.prank(trader);
        curve.buy{value: 1_000e18}(token, trader, 0);

        uint256 bal = IERC20(token).balanceOf(trader);
        (uint256 quoted,) = curve.quoteSell(token, bal);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(TRADER_KEY, trader, token, bal, deadline);

        vm.prank(trader);
        vm.expectRevert(bytes("slippage"));
        curve.sell(token, bal, quoted + 1, deadline, v, r, s);
    }

    function test_sell_rejectsSignatureFromWrongKey() public {
        address token = _launch();
        vm.prank(trader);
        curve.buy{value: 1_000e18}(token, trader, 0);

        uint256 bal = IERC20(token).balanceOf(trader);
        uint256 deadline = block.timestamp + 1 hours;
        // Valid key, wrong signer — the permit must be rejected before any
        // trade logic runs.
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(WRONG_KEY, trader, token, bal, deadline);

        vm.prank(trader);
        vm.expectRevert();
        curve.sell(token, bal, 0, deadline, v, r, s);
    }

    function test_sell_roundTripReturnsUsdc() public {
        address token = _launch();
        vm.prank(trader);
        curve.buy{value: 1_000e18}(token, trader, 0);

        uint256 bal = IERC20(token).balanceOf(trader);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(TRADER_KEY, trader, token, bal, deadline);

        uint256 usdcBefore = trader.balance;
        vm.prank(trader);
        uint256 usdcOut = curve.sell(token, bal, 0, deadline, v, r, s);

        assertGt(usdcOut, 0, "selling must return something");
        assertEq(trader.balance - usdcBefore, usdcOut, "reported output must match what actually arrived");
        assertEq(IERC20(token).balanceOf(trader), 0, "all sold tokens leave the seller");
    }

    // -----------------------------------------------------------------
    // Fuzz — the rounding-direction invariant the plan flagged as the
    // highest-risk arithmetic in this contract.
    // -----------------------------------------------------------------

    /// @dev Buying then immediately selling the whole position must never
    /// return more USDC than went in. If this fails, rounding somewhere in
    /// _buyQuote/_sellQuote favours the trader, which is repeatable and
    /// therefore drainable.
    function testFuzz_buyThenSellIsNeverProfitable(uint256 usdcIn) public {
        usdcIn = bound(usdcIn, 1e15, 5_000e18);
        address token = _launch();

        vm.deal(trader, usdcIn + 1e18);
        uint256 balBefore = trader.balance;

        vm.prank(trader);
        curve.buy{value: usdcIn}(token, trader, 0);

        uint256 tokens = IERC20(token).balanceOf(trader);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(TRADER_KEY, trader, token, tokens, deadline);

        vm.prank(trader);
        curve.sell(token, tokens, 0, deadline, v, r, s);

        assertLe(trader.balance, balBefore, "a buy/sell round trip must never be profitable");
    }

    /// @dev The UI reads quoteBuy to show price impact and set slippage
    /// bounds. If the quote and the executed trade can diverge, users get
    /// silently wrong numbers — so they must be bit-identical, not close.
    function testFuzz_quoteMatchesExecution(uint256 usdcIn) public {
        usdcIn = bound(usdcIn, 1e12, 10_000e18);
        address token = _launch();

        (uint256 quoted,) = curve.quoteBuy(token, usdcIn);

        vm.deal(buyer, usdcIn + 1e18);
        vm.prank(buyer);
        uint256 actual = curve.buy{value: usdcIn}(token, buyer, 0);

        assertEq(quoted, actual, "quote must match execution exactly");
    }

    /// @dev Price must rise monotonically as the curve fills — a curve
    /// that ever gets cheaper as it sells would be arbitrageable in a loop.
    function testFuzz_priceRisesMonotonically(uint256 firstBuy, uint256 secondBuy) public {
        firstBuy = bound(firstBuy, 1e16, 2_000e18);
        secondBuy = bound(secondBuy, 1e16, 2_000e18);
        address token = _launch();

        (uint256 tokensFromFirst,) = curve.quoteBuy(token, firstBuy);

        vm.deal(buyer, firstBuy + secondBuy + 1e18);
        vm.prank(buyer);
        curve.buy{value: firstBuy}(token, buyer, 0);

        (uint256 tokensFromSecond,) = curve.quoteBuy(token, firstBuy);

        assertLe(
            tokensFromSecond, tokensFromFirst, "the same USDC must buy no more tokens after the curve has moved up"
        );
    }
}
