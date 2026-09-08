// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CurveManager} from "../src/CurveManager.sol";
import {AromaFactory} from "../src/AromaFactory.sol";
import {AromaToken} from "../src/AromaToken.sol";

/// @notice Drives CurveManager with random sequences of real user actions.
/// Foundry calls these functions in arbitrary order with arbitrary inputs;
/// the invariants in CurveManagerInvariants must survive whatever comes out
/// of that. This is the part of the test suite that can catch a bug nobody
/// thought to write a test for, which is the whole reason it exists.
contract CurveHandler is Test {
    CurveManager public curve;
    AromaFactory public factory;

    address[] public tokens;
    address[] public actors;
    uint256[] public actorKeys;

    uint256 public ghostGraduatedUsdcOut;
    uint256 public ghostCreatorFeesPaidOut;
    uint256 public ghostProtocolFeesPaidOut;

    constructor(CurveManager curve_, AromaFactory factory_) {
        curve = curve_;
        factory = factory_;

        for (uint256 i = 1; i <= 4; i++) {
            uint256 key = 0xA0000 + i;
            actorKeys.push(key);
            address a = vm.addr(key);
            actors.push(a);
            vm.deal(a, 1_000_000e18);
        }

        // Start with one token so buy/sell have something to act on even
        // if the fuzzer never picks createToken first.
        _createToken(0);
    }

    function _actor(uint256 seed) internal view returns (address a, uint256 key) {
        uint256 i = seed % actors.length;
        return (actors[i], actorKeys[i]);
    }

    function _createToken(uint256 seed) internal returns (address token) {
        (address a,) = _actor(seed);
        vm.prank(a);
        token = factory.createToken("Fuzz", "FUZZ", "", "", 0, 0, AromaFactory.LaunchGuard(0, 0, new address[](0)));
        tokens.push(token);
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    // ---- Actions the fuzzer can take ----

    function createToken(uint256 seed) external {
        if (tokens.length >= 5) return; // keep runs bounded
        _createToken(seed);
    }

    function buy(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        address token = tokens[tokenSeed % tokens.length];
        (,,, bool graduated) = curve.tokenState(token);
        if (graduated) return;

        (address a,) = _actor(actorSeed);
        amount = bound(amount, 1e12, 30_000e18);
        if (a.balance < amount) return;

        // Skip buys that would overshoot the curve's remaining supply —
        // the contract correctly reverts on those, and a revert here would
        // just halt the sequence rather than testing anything.
        (uint256 tokensOut,) = curve.quoteBuy(token, amount);
        (, uint256 sold,,) = curve.tokenState(token);
        if (sold + tokensOut > curve.CURVE_SUPPLY()) return;

        vm.prank(a);
        curve.buy{value: amount}(token, a, 0);
    }

    function sell(uint256 actorSeed, uint256 tokenSeed, uint256 pctBps) external {
        address token = tokens[tokenSeed % tokens.length];
        (,,, bool graduated) = curve.tokenState(token);
        if (graduated) return;

        (address a, uint256 key) = _actor(actorSeed);
        uint256 bal = IERC20(token).balanceOf(a);
        if (bal == 0) return;

        uint256 amount = (bal * bound(pctBps, 1, 10_000)) / 10_000;
        if (amount == 0) return;

        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(key, a, token, amount, deadline);

        vm.prank(a);
        curve.sell(token, amount, 0, deadline, v, r, s);
    }

    function graduate(uint256 tokenSeed) external {
        address token = tokens[tokenSeed % tokens.length];
        (uint256 raised,,, bool graduated) = curve.tokenState(token);
        if (graduated || raised < curve.GRADUATION_RAISE_USDC()) return;

        ghostGraduatedUsdcOut += raised - curve.GRADUATION_FEE_USDC();
        curve.graduate(token);
    }

    function claimCreatorFees(uint256 tokenSeed) external {
        address token = tokens[tokenSeed % tokens.length];
        uint256 owed = curve.creatorFeesAccrued(token);
        if (owed == 0) return;

        ghostCreatorFeesPaidOut += owed;
        curve.claimCreatorFees(token);
    }

    function depositGraduatedFees(uint256 tokenSeed, uint256 amount) external {
        address token = tokens[tokenSeed % tokens.length];
        (,,, bool graduated) = curve.tokenState(token);
        if (!graduated) return;

        amount = bound(amount, 1e12, 1_000e18);
        vm.deal(address(this), address(this).balance + amount);
        curve.depositGraduatedFees{value: amount}(token);
    }

    function withdrawFees(uint256 amount) external {
        uint256 pot = curve.accumulatedFees();
        if (pot == 0) return;
        amount = bound(amount, 1, pot);

        // Cache the owner before pranking: a `curve.owner()` call inside
        // the withdrawFees arguments would consume the prank itself, so
        // the withdrawal would come from this handler and revert on access
        // control — silently never exercising this path at all.
        address protocolOwner = curve.owner();

        ghostProtocolFeesPaidOut += amount;
        vm.prank(protocolOwner);
        curve.withdrawFees(protocolOwner, amount);
    }

    function _signPermit(uint256 pk, address signerAddr, address token, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        AromaToken t = AromaToken(token);
        bytes32 typehash = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 structHash =
            keccak256(abi.encode(typehash, signerAddr, address(curve), value, t.nonces(signerAddr), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", t.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(pk, digest);
    }

    receive() external payable {}
}

contract CurveManagerInvariants is Test {
    CurveManager curve;
    AromaFactory factory;
    CurveHandler handler;

    address owner = makeAddr("owner");
    address vault = makeAddr("vault");

    function setUp() public {
        curve = new CurveManager(owner, vault);
        factory = new AromaFactory(address(curve));
        vm.prank(owner);
        curve.setFactory(address(factory));

        handler = new CurveHandler(curve, factory);
        targetContract(address(handler));
    }

    /// @notice The one that matters most: the contract must always hold at
    /// least as much native USDC as it owes. Every curve reserve, every
    /// unclaimed creator fee, and the protocol's own pot are all claims on
    /// the same balance — if their sum ever exceeds what's actually here,
    /// someone's funds are unbacked and the last person out cannot be paid.
    function invariant_contractIsAlwaysSolvent() public view {
        uint256 owed = curve.accumulatedFees();
        uint256 n = handler.tokenCount();
        for (uint256 i = 0; i < n; i++) {
            address token = handler.tokens(i);
            (uint256 reserve,,,) = curve.tokenState(token);
            owed += reserve;
            owed += curve.creatorFeesAccrued(token);
        }
        assertGe(address(curve).balance, owed, "curve holds less USDC than it owes");
    }

    /// @notice Tokens sold can never exceed the portion of supply the curve
    /// is allowed to sell. If this breaks, the LP reserve gets eaten and
    /// graduation has nothing left to pair with the raise.
    function invariant_curveNeverOversells() public view {
        uint256 n = handler.tokenCount();
        for (uint256 i = 0; i < n; i++) {
            (, uint256 sold,,) = curve.tokenState(handler.tokens(i));
            assertLe(sold, curve.CURVE_SUPPLY(), "curve sold past its supply cap");
        }
    }

    /// @notice The contract must always still hold enough of each token to
    /// cover what it hasn't sold — otherwise a later buyer or the eventual
    /// graduation seed would come up short.
    function invariant_unsoldTokensAreStillHeld() public view {
        uint256 n = handler.tokenCount();
        for (uint256 i = 0; i < n; i++) {
            address token = handler.tokens(i);
            (, uint256 sold,, bool graduated) = curve.tokenState(token);
            if (graduated) continue; // supply has intentionally left for the vault
            assertGe(
                IERC20(token).balanceOf(address(curve)),
                curve.TOTAL_SUPPLY() - sold,
                "curve holds fewer tokens than it still owes buyers"
            );
        }
    }

    /// @notice A graduated token is terminal — it must never flip back to
    /// tradeable, which would let the curve sell supply it no longer holds.
    function invariant_graduationIsIrreversible() public view {
        uint256 n = handler.tokenCount();
        for (uint256 i = 0; i < n; i++) {
            address token = handler.tokens(i);
            (uint256 reserve,,, bool graduated) = curve.tokenState(token);
            if (graduated) {
                assertEq(reserve, 0, "graduated token must not still claim a reserve");
            }
        }
    }
}
