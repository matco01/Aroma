// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ClubVault} from "../../src/club/ClubVault.sol";
import {ClubFactory} from "../../src/club/ClubFactory.sol";
import {ClubRouter} from "../../src/club/ClubRouter.sol";
import {MockContractWallet} from "./MockContractWallet.sol";

/// @notice Club coins against Uniswap's real PoolManager on a fork, the same
/// setup PoolLaunchTest uses and for the same reasons.
///
/// Most of these tests are about the gate rather than the happy path, because
/// the gate is where this feature can go wrong in a way that costs someone
/// money: a non-member getting in, a seat consumed without a buy, a fee going
/// to the wrong person, or a member unable to leave.
contract ClubLaunchTest is Test {
    using StateLibrary for IPoolManager;

    address constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    string constant DEFAULT_RPC = "https://eth.drpc.org";
    uint256 constant FORK_BLOCK = 25_900_000;

    uint160 constant REQUIRED_FLAGS = uint160(
        (1 << 13) // beforeInitialize
            | (1 << 7) // beforeSwap
            | (1 << 6) // afterSwap
            | (1 << 3) // beforeSwapReturnDelta
            | (1 << 2) // afterSwapReturnDelta
    );
    /// @dev A different prefix from PoolLaunchTest's hook, so the two can never
    /// be confused in a trace.
    address constant HOOK_ADDRESS = address((uint160(0xC1B) << 144) | REQUIRED_FLAGS);

    ClubVault vault;
    ClubFactory factory;
    ClubRouter router;
    PoolSwapTest swapRouter;

    address owner;
    address creator;
    uint256 creatorPk;
    address outsider;

    function setUp() public {
        vm.createSelectFork(vm.envOr("ETH_RPC_URL", string(DEFAULT_RPC)), FORK_BLOCK);

        owner = _eoa("owner");
        (creator, creatorPk) = makeAddrAndKey("creator");
        vm.etch(creator, "");
        vm.deal(creator, 10_000 ether);
        outsider = _eoa("outsider");
        vm.deal(outsider, 10_000 ether);

        deployCodeTo("ClubVault.sol:ClubVault", abi.encode(POOL_MANAGER, owner), HOOK_ADDRESS);
        vault = ClubVault(payable(HOOK_ADDRESS));

        factory = new ClubFactory(address(vault));
        router = new ClubRouter(address(vault));
        vm.startPrank(owner);
        vault.setFactory(address(factory));
        vault.setRouter(address(router));
        vm.stopPrank();

        swapRouter = new PoolSwapTest(IPoolManager(POOL_MANAGER));
    }

    // -----------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------

    /// @dev makeAddr derives addresses deterministically and on a mainnet fork
    /// one can land on a real contract; clearing the code keeps them EOAs.
    function _eoa(string memory name) internal returns (address a) {
        a = makeAddr(name);
        vm.etch(a, "");
        vm.deal(a, 0);
    }

    function _signer(string memory name) internal returns (address a, uint256 pk) {
        (a, pk) = makeAddrAndKey(name);
        vm.etch(a, "");
        vm.deal(a, 10_000 ether);
    }

    function _launch() internal returns (address token) {
        vm.prank(creator, creator);
        (token,) = factory.createToken("Club Coin", "CLUB", "a club", "", 0, 0);
    }

    function _sig(uint256 pk, address token, address inviter, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, vault.inviteDigest(token, inviter, nonce, deadline));
        return abi.encodePacked(r, s, v);
    }

    /// @dev An open invite link from `inviter`, valid for a day.
    function _link(address token, address inviter, uint256 inviterPk)
        internal
        view
        returns (uint256 nonce, uint256 deadline, bytes memory sig)
    {
        nonce = vault.inviteNonce(token, inviter);
        deadline = block.timestamp + 1 days;
        sig = _sig(inviterPk, token, inviter, nonce, deadline);
    }

    function _join(address token, address invitee, address inviter, uint256 inviterPk, uint256 usdc)
        internal
    {
        (uint256 nonce, uint256 deadline, bytes memory sig) = _link(token, inviter, inviterPk);
        vm.deal(invitee, invitee.balance + usdc);
        vm.prank(invitee, invitee);
        router.buyWithInvite{value: usdc}(token, 0, inviter, nonce, deadline, sig);
    }

    function _routerBuy(address who, address token, uint256 usdc) internal {
        vm.deal(who, who.balance + usdc);
        vm.prank(who, who);
        router.buy{value: usdc}(token, 0);
    }

    /// @dev A buy through some other contract entirely — the way a terminal
    /// or bot reaches the pool — with tx.origin set to `who`.
    function _directBuy(address who, address token, uint256 usdc, bytes memory hookData)
        internal
        returns (BalanceDelta)
    {
        // Read before the prank. An external call in the argument list below
        // would run first and consume both the prank and any expectRevert the
        // caller set, so the swap would silently run as this test contract.
        PoolKey memory key = vault.poolKey(token);
        vm.deal(who, who.balance + usdc);
        vm.prank(who, who);
        return swapRouter.swap{value: usdc}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(usdc),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            hookData
        );
    }

    /// @dev The refused counterpart of _directBuy. It has to exist separately:
    /// a caller's own vm.expectRevert would be consumed by the poolKey read
    /// inside _directBuy, and the test would pass on a swap that succeeded.
    ///
    /// Matches the exact revert, not just "something reverted". A bare
    /// expectRevert would also pass on running out of funds, which would let
    /// the gate be broken while these tests stayed green. A hook's revert
    /// reaches the caller wrapped by the pool manager in this shape.
    function _expectDirectBuyRefused(address who, address token, uint256 usdc, bytes memory hookData)
        internal
    {
        PoolKey memory key = vault.poolKey(token);
        vm.deal(who, who.balance + usdc);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(vault),
                IHooks.beforeSwap.selector,
                abi.encodeWithSignature("Error(string)", "invite only"),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        vm.prank(who, who);
        swapRouter.swap{value: usdc}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(usdc),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            hookData
        );
    }

    function _directSell(address who, address token, uint256 tokens) internal returns (BalanceDelta) {
        PoolKey memory key = vault.poolKey(token); // before the prank — see _directBuy
        vm.prank(who, who);
        IERC20(token).approve(address(swapRouter), type(uint256).max);
        vm.prank(who, who);
        return swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: false,
                amountSpecified: -int256(tokens),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev The split _creditFee applies, recomputed independently.
    function _split(uint256 fee)
        internal
        pure
        returns (uint256 toProtocol, uint256 toRoot, uint256 tree)
    {
        toProtocol = (fee * 30) / 150;
        toRoot = (fee * 10) / 150;
        tree = fee - toProtocol - toRoot;
    }

    // -----------------------------------------------------------------
    // launch
    // -----------------------------------------------------------------

    function test_launch_makesTheCreatorTheRootWithTenSeats() public {
        address token = _launch();

        assertTrue(vault.isMember(token, creator));
        assertEq(vault.inviterOf(token, creator), address(0), "root has no inviter");
        assertEq(vault.seatsOf(token, creator), 10);
        assertEq(vault.seatsLeft(token, creator), 10);
    }

    function test_launch_opensExactlyWhereANormalCoinDoes() public {
        address token = _launch();
        (, int24 tick,,) = IPoolManager(POOL_MANAGER).getSlot0(vault.poolKey(token).toId());
        assertEq(tick, vault.TICK_INIT());
        assertGt(IERC20(token).balanceOf(POOL_MANAGER), 999_000_000e18, "supply not deposited");
    }

    function test_creatorDevBuy_goesThroughTheGate() public {
        vm.prank(creator, creator);
        (address token,) = factory.createToken{value: 50 ether}("Club Coin", "CLUB", "", "", 50 ether, 0);
        assertGt(IERC20(token).balanceOf(creator), 0);
    }

    // -----------------------------------------------------------------
    // the gate
    // -----------------------------------------------------------------

    function test_nonMember_cannotBuyThroughTheRouter() public {
        address token = _launch();
        vm.deal(outsider, 10 ether);
        vm.prank(outsider, outsider);
        vm.expectRevert(bytes("invite only"));
        router.buy{value: 10 ether}(token, 0);
    }

    function test_nonMember_cannotBuyThroughAnyOtherRoute() public {
        address token = _launch();
        _expectDirectBuyRefused(outsider, token, 10 ether, "");
        assertEq(IERC20(token).balanceOf(outsider), 0);
    }

    /// @dev The attack the trusted-sender rule exists for. Anyone can call the
    /// pool manager with hook data naming any member; honouring it would let a
    /// non-member in.
    function test_nonMember_cannotClaimToBeAMemberInHookData() public {
        address token = _launch();
        bytes memory lie = abi.encode(creator, address(0), uint256(0), uint256(0), bytes(""));
        _expectDirectBuyRefused(outsider, token, 10 ether, lie);
        assertEq(IERC20(token).balanceOf(outsider), 0);
    }

    /// @dev Proves the two tests above are refusing for the right reason. If
    /// the swap helper were broken, a refusal test would pass on any revert at
    /// all; this is the same swap, by a member, and it must go through.
    function test_theSameDirectBuyWorksForAMember() public {
        address token = _launch();
        (address alice,) = _signer("alice");
        _join(token, alice, creator, creatorPk, 10 ether);
        uint256 before = IERC20(token).balanceOf(alice);
        _directBuy(alice, token, 10 ether, "");
        assertGt(IERC20(token).balanceOf(alice), before);
    }

    function test_member_canBuyThroughAnyRoute() public {
        address token = _launch();
        (address alice,) = _signer("alice");
        _join(token, alice, creator, creatorPk, 10 ether);

        // Membership is on-chain state, so a terminal works once a wallet is in.
        BalanceDelta delta = _directBuy(alice, token, 10 ether, "");
        assertGt(delta.amount1(), 0);
    }

    function test_sell_isOpenToEveryone() public {
        address token = _launch();
        (address alice,) = _signer("alice");
        _join(token, alice, creator, creatorPk, 100 ether);

        // A non-member ends up holding the coin.
        uint256 half = IERC20(token).balanceOf(alice) / 2;
        vm.prank(alice);
        IERC20(token).transfer(outsider, half);

        BalanceDelta delta = _directSell(outsider, token, half);
        assertGt(delta.amount0(), 0, "outsider could not sell");
    }

    // -----------------------------------------------------------------
    // invites
    // -----------------------------------------------------------------

    function test_invite_admitsAndConsumesOneSeat() public {
        address token = _launch();
        (address alice,) = _signer("alice");

        _join(token, alice, creator, creatorPk, 10 ether);

        assertTrue(vault.isMember(token, alice));
        assertEq(vault.inviterOf(token, alice), creator);
        assertEq(vault.seatsLeft(token, creator), 9);
        assertEq(vault.seatsOf(token, alice), 3, "new member gets 3 seats");
        assertGt(IERC20(token).balanceOf(alice), 0, "seat consumed without a buy");
    }

    function test_invite_isABearerLinkUntilTheSeatsRunOut() public {
        address token = _launch();
        (address alice, uint256 alicePk) = _signer("alice");
        _join(token, alice, creator, creatorPk, 10 ether);

        // One link, handed to four people. Alice has three seats.
        (uint256 nonce, uint256 deadline, bytes memory sig) = _link(token, alice, alicePk);
        for (uint256 i = 0; i < 3; i++) {
            (address friend,) = _signer(string.concat("friend", vm.toString(i)));
            vm.prank(friend, friend);
            router.buyWithInvite{value: 5 ether}(token, 0, alice, nonce, deadline, sig);
            assertEq(vault.inviterOf(token, friend), alice);
        }

        (address late,) = _signer("late");
        vm.prank(late, late);
        vm.expectRevert(bytes("no seats left"));
        router.buyWithInvite{value: 5 ether}(token, 0, alice, nonce, deadline, sig);
    }

    function test_invite_revokedLinksStopWorking() public {
        address token = _launch();
        (uint256 nonce, uint256 deadline, bytes memory sig) = _link(token, creator, creatorPk);

        vm.prank(creator);
        vault.revokeInvites(token);

        (address alice,) = _signer("alice");
        vm.prank(alice, alice);
        vm.expectRevert(bytes("invite revoked"));
        router.buyWithInvite{value: 5 ether}(token, 0, creator, nonce, deadline, sig);
    }

    function test_invite_revokingDoesNotRemoveAnyone() public {
        address token = _launch();
        (address alice,) = _signer("alice");
        _join(token, alice, creator, creatorPk, 10 ether);

        vm.prank(creator);
        vault.revokeInvites(token);

        assertTrue(vault.isMember(token, alice));
        _routerBuy(alice, token, 5 ether);
    }

    function test_invite_expires() public {
        address token = _launch();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(creatorPk, token, creator, 0, deadline);

        vm.warp(deadline + 1);
        (address alice,) = _signer("alice");
        vm.prank(alice, alice);
        vm.expectRevert(bytes("invite expired"));
        router.buyWithInvite{value: 5 ether}(token, 0, creator, 0, deadline, sig);
    }

    function test_invite_forgedSignatureIsRefused() public {
        address token = _launch();
        (, uint256 impostorPk) = makeAddrAndKey("impostor");
        uint256 deadline = block.timestamp + 1 days;
        // Signed by the wrong key, claiming to be the creator's invite.
        bytes memory sig = _sig(impostorPk, token, creator, 0, deadline);

        (address alice,) = _signer("alice");
        vm.prank(alice, alice);
        vm.expectRevert(bytes("bad invite signature"));
        router.buyWithInvite{value: 5 ether}(token, 0, creator, 0, deadline, sig);
    }

    /// @dev The bug found on the Arc fork. An ordinary key-controlled account
    /// carrying an EIP-7702 delegation has code, and a library that picks its
    /// verification method by "has code" never checks the key — so a valid
    /// invite was refused. The delegate here implements nothing, which is the
    /// worst case and the one observed on Arc mainnet.
    function test_invite_fromAn7702DelegatedAccountIsAccepted() public {
        address token = _launch();
        (address alice, uint256 alicePk) = _signer("alice");
        _join(token, alice, creator, creatorPk, 10 ether);

        // Give alice a 7702 delegation designator, as Arc mainnet shows real
        // accounts carrying.
        vm.etch(alice, abi.encodePacked(hex"ef0100", address(0xDE1E6A7E)));
        assertGt(alice.code.length, 0);

        (address bob,) = _signer("bob");
        _join(token, bob, alice, alicePk, 10 ether);
        assertEq(vault.inviterOf(token, bob), alice);
    }

    /// @dev A Safe-like wallet has no key that recovers to its own address, so
    /// it can only be verified through ERC-1271. It must be able to found a
    /// club and hand out invites.
    function test_contractWallet_canFoundAClubAndInvite() public {
        (address walletOwner, uint256 walletOwnerPk) = _signer("walletOwner");
        MockContractWallet wallet = new MockContractWallet(walletOwner);

        vm.prank(walletOwner);
        bytes memory ret = wallet.execute(
            address(factory),
            0,
            abi.encodeCall(ClubFactory.createToken, ("Safe Club", "SAFE", "", "", 0, 0))
        );
        (address token,) = abi.decode(ret, (address, bytes32));
        assertTrue(vault.isMember(token, address(wallet)));

        // The owner's key signs; the invite names the wallet as inviter.
        (address bob,) = _signer("bob");
        _join(token, bob, address(wallet), walletOwnerPk, 10 ether);
        assertEq(vault.inviterOf(token, bob), address(wallet));
    }

    function test_contractWallet_thatRefusesTheSignatureCannotInvite() public {
        (address walletOwner, uint256 walletOwnerPk) = _signer("walletOwner");
        MockContractWallet wallet = new MockContractWallet(walletOwner);
        vm.prank(walletOwner);
        bytes memory ret = wallet.execute(
            address(factory),
            0,
            abi.encodeCall(ClubFactory.createToken, ("Safe Club", "SAFE", "", "", 0, 0))
        );
        (address token,) = abi.decode(ret, (address, bytes32));

        wallet.setRefuse(true);
        (uint256 nonce, uint256 deadline, bytes memory sig) = _link(token, address(wallet), walletOwnerPk);
        (address bob,) = _signer("bob");
        vm.prank(bob, bob);
        vm.expectRevert(bytes("bad invite signature"));
        router.buyWithInvite{value: 5 ether}(token, 0, address(wallet), nonce, deadline, sig);
    }

    function test_invite_fromANonMemberIsRefused() public {
        address token = _launch();
        (address stranger, uint256 strangerPk) = makeAddrAndKey("stranger");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _sig(strangerPk, token, stranger, 0, deadline);

        (address alice,) = _signer("alice");
        vm.prank(alice, alice);
        vm.expectRevert(bytes("inviter not a member"));
        router.buyWithInvite{value: 5 ether}(token, 0, stranger, 0, deadline, sig);
    }

    function test_invite_needsARealBuyNotDust() public {
        address token = _launch();
        (uint256 nonce, uint256 deadline, bytes memory sig) = _link(token, creator, creatorPk);

        (address alice,) = _signer("alice");
        vm.prank(alice, alice);
        vm.expectRevert(bytes("join buy too small"));
        router.buyWithInvite{value: 0.5 ether}(token, 0, creator, nonce, deadline, sig);

        assertEq(vault.seatsLeft(token, creator), 10, "seat consumed by a refused buy");
    }

    function test_invite_clickedTwiceIsJustABuy() public {
        address token = _launch();
        (address alice,) = _signer("alice");
        _join(token, alice, creator, creatorPk, 10 ether);
        uint8 seatsBefore = vault.seatsLeft(token, creator);

        // Same link again, by someone already in: must not fail, must not
        // spend another seat, must not move them in the tree.
        _join(token, alice, creator, creatorPk, 10 ether);

        assertEq(vault.seatsLeft(token, creator), seatsBefore);
        assertEq(vault.inviterOf(token, alice), creator);
    }

    function test_invite_cannotMoveSomeoneWhoIsAlreadyIn() public {
        address token = _launch();
        (address alice, uint256 alicePk) = _signer("alice");
        (address bob,) = _signer("bob");
        _join(token, alice, creator, creatorPk, 10 ether);
        _join(token, bob, creator, creatorPk, 10 ether);

        // Alice tries to pull bob under her.
        _join(token, bob, alice, alicePk, 10 ether);

        assertEq(vault.inviterOf(token, bob), creator, "position in the tree changed");
        assertEq(vault.seatsLeft(token, alice), 3, "alice spent a seat on someone already in");
    }

    // -----------------------------------------------------------------
    // fees
    // -----------------------------------------------------------------

    /// @dev creator -> a -> b -> c
    function _chainOfThree() internal returns (address token, address a, address b, address c) {
        token = _launch();
        uint256 aPk;
        uint256 bPk;
        (a, aPk) = _signer("a");
        (b, bPk) = _signer("b");
        (c,) = _signer("c");
        _join(token, a, creator, creatorPk, 10 ether);
        _join(token, b, a, aPk, 10 ether);
        _join(token, c, b, bPk, 10 ether);
    }

    function test_fee_walksUpTheTreeInThirds() public {
        (address token, address a, address b, address c) = _chainOfThree();
        uint256[4] memory before =
            [vault.claimable(creator), vault.claimable(a), vault.claimable(b), vault.protocolUsdc()];

        _routerBuy(c, token, 100 ether);

        uint256 fee = (100 ether * 150) / 10_000;
        (uint256 toProtocol, uint256 toRoot, uint256 tree) = _split(fee);
        uint256 toB = (tree * 2) / 3; //         level 1: whoever invited c
        uint256 toA = ((tree - toB) * 2) / 3; // level 2
        // level 3 is the creator, the end of the chain, which takes the rest

        assertEq(vault.claimable(b) - before[2], toB, "level 1");
        assertEq(vault.claimable(a) - before[1], toA, "level 2");
        assertEq(vault.claimable(creator) - before[0], toRoot + (tree - toB - toA), "root + roll-up");
        assertEq(vault.protocolUsdc() - before[3], toProtocol, "protocol");

        // The published schedule: 73.3 and 24.4 bps of a $100 buy.
        assertApproxEqAbs(toB, 0.7333333333 ether, 1e10);
        assertApproxEqAbs(toA, 0.2444444444 ether, 1e10);
    }

    function test_fee_stopsAtTenLevels() public {
        address token = _launch();

        // creator -> m0 -> m1 -> ... -> m11
        address[12] memory m;
        uint256[12] memory pk;
        for (uint256 i = 0; i < 12; i++) {
            (m[i], pk[i]) = _signer(string.concat("m", vm.toString(i)));
            if (i == 0) _join(token, m[0], creator, creatorPk, 2 ether);
            else _join(token, m[i], m[i - 1], pk[i - 1], 2 ether);
        }

        uint256[12] memory before;
        for (uint256 i = 0; i < 12; i++) before[i] = vault.claimable(m[i]);
        uint256 creatorBefore = vault.claimable(creator);

        _routerBuy(m[11], token, 100 ether);

        uint256 fee = (100 ether * 150) / 10_000;
        (, uint256 toRoot, uint256 tree) = _split(fee);

        // Levels 1..10 are m10 down to m1. m0 is level 11 and the creator level
        // 12, both past the radius.
        uint256 paid;
        for (uint256 i = 1; i <= 10; i++) paid += vault.claimable(m[i]) - before[i];

        assertEq(paid, tree, "the ten levels did not receive the whole tree");
        assertEq(vault.claimable(m[0]) - before[0], 0, "level 11 was paid");
        assertEq(vault.claimable(creator) - creatorBefore, toRoot, "creator got more than the root cut");
    }

    function test_fee_creatorTradingTheirOwnCoin_treeGoesToProtocol() public {
        address token = _launch();
        uint256 protocolBefore = vault.protocolUsdc();
        uint256 creatorBefore = vault.claimable(creator);

        _routerBuy(creator, token, 100 ether);

        uint256 fee = (100 ether * 150) / 10_000;
        (uint256 toProtocol, uint256 toRoot, uint256 tree) = _split(fee);
        assertEq(vault.claimable(creator) - creatorBefore, toRoot);
        assertEq(vault.protocolUsdc() - protocolBefore, toProtocol + tree);
    }

    function test_fee_nonMemberSellHasNoTree() public {
        address token = _launch();
        (address alice,) = _signer("alice");
        _join(token, alice, creator, creatorPk, 100 ether);
        uint256 tokens = IERC20(token).balanceOf(alice) / 2;
        vm.prank(alice);
        IERC20(token).transfer(outsider, tokens);

        uint256 vaultBefore = address(vault).balance;
        uint256 creatorBefore = vault.claimable(creator);
        uint256 protocolBefore = vault.protocolUsdc();

        _directSell(outsider, token, tokens);

        uint256 fee = address(vault).balance - vaultBefore;
        assertGt(fee, 0);
        (, uint256 toRoot,) = _split(fee);
        assertEq(vault.claimable(creator) - creatorBefore, toRoot);
        assertEq(vault.protocolUsdc() - protocolBefore, fee - toRoot);
    }

    /// @dev Every wei the hook takes is owed to someone, and nothing else ever
    /// arrives, so the vault's balance must equal what it owes exactly.
    function test_vaultOwesExactlyWhatItHolds() public {
        address token = _launch();
        (address a, uint256 aPk) = _signer("a");
        (address b, uint256 bPk) = _signer("b");
        (address c,) = _signer("c");
        _join(token, a, creator, creatorPk, 37 ether);
        _join(token, b, a, aPk, 11 ether);
        _join(token, c, b, bPk, 3 ether);
        _routerBuy(c, token, 123 ether);
        _directBuy(b, token, 7 ether, "");
        _routerBuy(creator, token, 19 ether);
        vm.prank(a);
        IERC20(token).transfer(outsider, 1_000_000e18);
        _directSell(outsider, token, 1_000_000e18);

        uint256 owed = vault.protocolUsdc() + vault.claimable(creator) + vault.claimable(a)
            + vault.claimable(b) + vault.claimable(c) + vault.claimable(outsider);
        assertEq(address(vault).balance, owed);
    }

    // -----------------------------------------------------------------
    // money out
    // -----------------------------------------------------------------

    function test_claim_paysEverythingOwedOnce() public {
        address token = _launch();
        (address a, uint256 aPk) = _signer("a");
        (address b,) = _signer("b");
        _join(token, a, creator, creatorPk, 10 ether);
        _join(token, b, a, aPk, 10 ether);
        _routerBuy(b, token, 100 ether);

        uint256 owed = vault.claimable(a);
        assertGt(owed, 0);
        uint256 balanceBefore = a.balance;

        vm.prank(a);
        vault.claim();
        assertEq(a.balance - balanceBefore, owed);
        assertEq(vault.claimable(a), 0);

        vm.prank(a);
        vault.claim();
        assertEq(a.balance - balanceBefore, owed, "paid twice");
    }

    function test_protocolFees_ownerOnly() public {
        address token = _launch();
        _routerBuy(creator, token, 100 ether);
        uint256 owed = vault.protocolUsdc();
        assertGt(owed, 0);

        vm.prank(outsider);
        vm.expectRevert();
        vault.withdrawProtocolFees(outsider);

        address treasury = _eoa("treasury");
        vm.prank(owner);
        vault.withdrawProtocolFees(treasury);
        assertEq(treasury.balance, owed);
        assertEq(vault.protocolUsdc(), 0);
    }

    // -----------------------------------------------------------------
    // wiring
    // -----------------------------------------------------------------

    function test_routerAndFactoryCanOnlyBeSetOnce() public {
        vm.startPrank(owner);
        vm.expectRevert(bytes("router already set"));
        vault.setRouter(outsider);
        vm.expectRevert(bytes("factory already set"));
        vault.setFactory(outsider);
        vm.stopPrank();
    }

    function test_aPoolNotCreatedByTheVaultIsRefused() public {
        address token = _launch();
        PoolKey memory rogue = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(uint160(token) + 1)),
            fee: 0,
            tickSpacing: 2,
            hooks: IHooks(address(vault))
        });
        vm.expectRevert();
        IPoolManager(POOL_MANAGER).initialize(rogue, TickMath.getSqrtPriceAtTick(123_546));
    }
}
