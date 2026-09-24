// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ClubVaultUsdg} from "../../src/club/ClubVaultUsdg.sol";
import {ClubFactoryUsdg} from "../../src/club/ClubFactoryUsdg.sol";
import {ClubRouterUsdg} from "../../src/club/ClubRouterUsdg.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";
import {MockContractWallet} from "./MockContractWallet.sol";

/// @notice ClubLaunchTest, ported to Robinhood Chain's USDG club contracts.
/// Every gate, invite and fee-tree test there has its counterpart here, with
/// amounts in 6-decimal USDG. What only exists here: the factory taking
/// launches from the auction alone, the token-above-USDG rule, permits on
/// buys, and fees held as pool-manager claims.
///
/// The fork's pool manager has never held this test's USDG, which is exactly
/// the condition a hook that took its fee mid-swap would fail under — so every
/// direct buy below doubles as the regression test for that.
contract ClubLaunchUsdgTest is Test {
    using StateLibrary for IPoolManager;
    using CurrencyLibrary for Currency;

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
    address constant HOOK_ADDRESS = address((uint160(0xC1D) << 144) | REQUIRED_FLAGS);

    uint256 constant ONE = 1e6; // one USDG

    MockUsdg usdg;
    ClubVaultUsdg vault;
    ClubFactoryUsdg factory;
    ClubRouterUsdg router;
    PoolSwapTest swapRouter;

    address owner;
    address creator;
    uint256 creatorPk;
    address outsider;

    function setUp() public {
        vm.createSelectFork(vm.envOr("ETH_RPC_URL", string(DEFAULT_RPC)), FORK_BLOCK);

        owner = _eoa("owner");
        (creator, creatorPk) = _signer("creator");
        outsider = _eoa("outsider");

        usdg = new MockUsdg();
        deployCodeTo(
            "ClubVaultUsdg.sol:ClubVaultUsdg",
            abi.encode(POOL_MANAGER, address(usdg), owner),
            HOOK_ADDRESS
        );
        vault = ClubVaultUsdg(HOOK_ADDRESS);

        factory = new ClubFactoryUsdg(address(vault));
        router = new ClubRouterUsdg(address(vault));
        vm.startPrank(owner);
        vault.setFactory(address(factory));
        vault.setRouter(address(router));
        vm.stopPrank();

        // This test contract stands in for ClubAuction.
        factory.setLauncher(address(this));
        usdg.approve(address(factory), type(uint256).max);

        swapRouter = new PoolSwapTest(IPoolManager(POOL_MANAGER));
    }

    // -----------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------

    function _eoa(string memory name) internal returns (address a) {
        a = makeAddr(name);
        vm.etch(a, "");
    }

    function _signer(string memory name) internal returns (address a, uint256 pk) {
        (a, pk) = makeAddrAndKey(name);
        vm.etch(a, "");
    }

    /// @dev Gives `who` USDG and approves both routes to spend it, so tests
    /// read as the trade rather than the setup.
    function _fund(address who, uint256 amount) internal {
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(router), type(uint256).max);
        usdg.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    function _noPermit() internal pure returns (ClubRouterUsdg.Permit memory) {
        return ClubRouterUsdg.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)});
    }

    /// @dev Mined through the factory's own prediction — see
    /// ClubFactoryUsdg.predictToken for why not the build artifact.
    function _mineSalt(string memory name, string memory symbol) internal view returns (bytes32) {
        for (uint256 i = 0; i < 1_000; i++) {
            address predicted = factory.predictToken(name, symbol, bytes32(i));
            if (predicted > address(usdg) && predicted.code.length == 0) return bytes32(i);
        }
        revert("no salt found");
    }

    function _info(string memory name, string memory symbol)
        internal
        pure
        returns (ClubFactoryUsdg.TokenInfo memory)
    {
        return ClubFactoryUsdg.TokenInfo({name: name, symbol: symbol, description: "a club", metadataUri: ""});
    }

    function _launchFor(address root, uint256 devBuy) internal returns (address token) {
        if (devBuy > 0) usdg.mint(address(this), devBuy);
        (token,) = factory.createToken(_info("Club Coin", "CLUB"), root, devBuy, 0, _mineSalt("Club Coin", "CLUB"));
    }

    function _launch() internal returns (address token) {
        return _launchFor(creator, 0);
    }

    function _sig(uint256 pk, address token, address inviter, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, vault.inviteDigest(token, inviter, nonce, deadline));
        return abi.encodePacked(r, s, v);
    }

    function _link(address token, address inviter, uint256 inviterPk)
        internal
        view
        returns (ClubRouterUsdg.Invite memory invite)
    {
        uint256 nonce = vault.inviteNonce(token, inviter);
        uint256 deadline = block.timestamp + 1 days;
        invite = ClubRouterUsdg.Invite({
            inviter: inviter,
            nonce: nonce,
            deadline: deadline,
            signature: _sig(inviterPk, token, inviter, nonce, deadline)
        });
    }

    function _buyWithInvite(address who, address token, uint256 amount, ClubRouterUsdg.Invite memory invite)
        internal
    {
        _fund(who, amount);
        vm.prank(who, who);
        router.buyWithInvite(token, amount, 0, invite, _noPermit());
    }

    function _join(address token, address invitee, address inviter, uint256 inviterPk, uint256 amount)
        internal
    {
        _buyWithInvite(invitee, token, amount, _link(token, inviter, inviterPk));
    }

    function _routerBuy(address who, address token, uint256 amount) internal {
        _fund(who, amount);
        vm.prank(who, who);
        router.buy(token, amount, 0, _noPermit());
    }

    /// @dev A buy through some other contract entirely — the way a terminal
    /// or bot reaches the pool — with tx.origin set to `who`. PoolSwapTest
    /// pays in after the swap, as most routers do.
    function _directBuy(address who, address token, uint256 amount, bytes memory hookData)
        internal
        returns (BalanceDelta)
    {
        PoolKey memory key = vault.poolKey(token); // before the prank
        _fund(who, amount);
        vm.prank(who, who);
        return swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            hookData
        );
    }

    /// @dev See ClubLaunchTest._expectDirectBuyRefused for why this matches
    /// the exact wrapped revert.
    function _expectDirectBuyRefused(address who, address token, uint256 amount, bytes memory hookData)
        internal
    {
        PoolKey memory key = vault.poolKey(token);
        _fund(who, amount);
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
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            hookData
        );
    }

    function _directSell(address who, address token, uint256 tokens) internal returns (BalanceDelta) {
        PoolKey memory key = vault.poolKey(token);
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

    /// @dev The vault's fee holdings: pool-manager claims, not a token balance.
    function _vaultClaims() internal view returns (uint256) {
        return IPoolManager(POOL_MANAGER).balanceOf(address(vault), Currency.wrap(address(usdg)).toId());
    }

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

    function test_launch_makesTheWinnerTheRootWithTenSeats() public {
        address token = _launch();

        assertTrue(vault.isMember(token, creator));
        assertEq(vault.creatorOf(token), creator, "the launcher became the creator");
        assertFalse(vault.isMember(token, address(this)), "the launcher joined its own club");
        assertEq(vault.inviterOf(token, creator), address(0), "root has no inviter");
        assertEq(vault.seatsOf(token, creator), 10);
        assertEq(vault.seatsLeft(token, creator), 10);
    }

    function test_launch_opensAtTheUsdgGeometry() public {
        address token = _launch();
        (, int24 tick,,) = IPoolManager(POOL_MANAGER).getSlot0(vault.poolKey(token).toId());
        assertEq(tick, vault.TICK_INIT());
        assertGt(IERC20(token).balanceOf(POOL_MANAGER), 999_000_000e18, "supply not deposited");
    }

    function test_launch_onlyTheLauncher() public {
        bytes32 salt = _mineSalt("Club Coin", "CLUB");
        ClubFactoryUsdg.TokenInfo memory info = _info("Club Coin", "CLUB");
        vm.prank(outsider);
        vm.expectRevert(bytes("not launcher"));
        factory.createToken(info, outsider, 0, 0, salt);
    }

    function test_launcher_canOnlyBeSetOnce() public {
        vm.expectRevert(bytes("launcher already set"));
        factory.setLauncher(outsider);
    }

    function test_launcher_onlyByTheDeployer() public {
        ClubFactoryUsdg fresh = new ClubFactoryUsdg(address(vault));
        vm.prank(outsider);
        vm.expectRevert(bytes("not deployer"));
        fresh.setLauncher(outsider);
    }

    function test_launch_requiresTokenAboveUsdg() public {
        bytes32 salt;
        bool found;
        for (uint256 i = 0; i < 1_000; i++) {
            if (factory.predictToken("Club Coin", "CLUB", bytes32(i)) < address(usdg)) {
                (salt, found) = (bytes32(i), true);
                break;
            }
        }
        assertTrue(found, "no salt lands below USDG");
        ClubFactoryUsdg.TokenInfo memory info = _info("Club Coin", "CLUB");
        vm.expectRevert(bytes("token must sort above USDG"));
        factory.createToken(info, creator, 0, 0, salt);
    }

    function test_predictToken_isWhereTheTokenLands() public {
        bytes32 salt = _mineSalt("Club Coin", "CLUB");
        address predicted = factory.predictToken("Club Coin", "CLUB", salt);
        (address token,) = factory.createToken(_info("Club Coin", "CLUB"), creator, 0, 0, salt);
        assertEq(token, predicted);
    }

    function test_firstBuy_goesThroughTheGateToTheWinner() public {
        address token = _launchFor(creator, 50 * ONE);
        assertGt(IERC20(token).balanceOf(creator), 0, "winner got nothing");
        assertEq(IERC20(token).balanceOf(address(this)), 0, "tokens stuck with the launcher");
        assertEq(IERC20(token).balanceOf(address(factory)), 0, "tokens stuck in the factory");
    }

    function test_firstBuy_capIs300Usdg() public {
        usdg.mint(address(this), 300 * ONE + 1);
        bytes32 salt = _mineSalt("Club Coin", "CLUB");
        ClubFactoryUsdg.TokenInfo memory info = _info("Club Coin", "CLUB");
        vm.expectRevert(bytes("dev buy exceeds cap"));
        factory.createToken(info, creator, 300 * ONE + 1, 0, salt);
    }

    // -----------------------------------------------------------------
    // the gate
    // -----------------------------------------------------------------

    function test_nonMember_cannotBuyThroughTheRouter() public {
        address token = _launch();
        _fund(outsider, 10 * ONE);
        vm.prank(outsider, outsider);
        vm.expectRevert(bytes("invite only"));
        router.buy(token, 10 * ONE, 0, _noPermit());
    }

    function test_nonMember_cannotBuyThroughAnyOtherRoute() public {
        address token = _launch();
        _expectDirectBuyRefused(outsider, token, 10 * ONE, "");
        assertEq(IERC20(token).balanceOf(outsider), 0);
    }

    function test_nonMember_cannotClaimToBeAMemberInHookData() public {
        address token = _launch();
        bytes memory lie = abi.encode(creator, address(0), uint256(0), uint256(0), bytes(""));
        _expectDirectBuyRefused(outsider, token, 10 * ONE, lie);
        assertEq(IERC20(token).balanceOf(outsider), 0);
    }

    /// @dev Also the regression test for taking fees mid-swap: this pool
    /// manager holds none of this USDG when the hook charges, and PoolSwapTest
    /// only pays in afterwards.
    function test_theSameDirectBuyWorksForAMember() public {
        address token = _launch();
        (address alice,) = _signer("alice");
        _join(token, alice, creator, creatorPk, 10 * ONE);
        uint256 before = IERC20(token).balanceOf(alice);
        _directBuy(alice, token, 10 * ONE, "");
        assertGt(IERC20(token).balanceOf(alice), before);
    }

    function test_firstEverTradeOnAFreshPoolManager_isADirectBuy() public {
        address token = _launch();
        assertEq(usdg.balanceOf(POOL_MANAGER), 0, "precondition: no USDG in the pool manager");
        BalanceDelta delta = _directBuy(creator, token, 10 * ONE, "");
        assertGt(delta.amount1(), 0);
    }

    function test_member_canBuyThroughAnyRoute() public {
        address token = _launch();
        (address alice,) = _signer("alice");
        _join(token, alice, creator, creatorPk, 10 * ONE);
        BalanceDelta delta = _directBuy(alice, token, 10 * ONE, "");
        assertGt(delta.amount1(), 0);
    }

    function test_sell_isOpenToEveryone() public {
        address token = _launch();
        (address alice,) = _signer("alice");
        _join(token, alice, creator, creatorPk, 100 * ONE);

        uint256 half = IERC20(token).balanceOf(alice) / 2;
        vm.prank(alice);
        IERC20(token).transfer(outsider, half);

        BalanceDelta delta = _directSell(outsider, token, half);
        assertGt(delta.amount0(), 0, "outsider could not sell");
    }

    // -----------------------------------------------------------------
    // permits
    // -----------------------------------------------------------------

    function _permitSig(address asset, uint256 ownerPk, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (ClubRouterUsdg.Permit memory)
    {
        address holder = vm.addr(ownerPk);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                holder,
                spender,
                value,
                MockUsdg(asset).nonces(holder),
                deadline
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", MockUsdg(asset).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        return ClubRouterUsdg.Permit({deadline: deadline, v: v, r: r, s: s});
    }

    function test_buyWithInvite_isOneSignatureWithAPermit() public {
        address token = _launch();
        (address alice, uint256 alicePk) = _signer("alice");
        usdg.mint(alice, 10 * ONE); // no approval
        ClubRouterUsdg.Invite memory invite = _link(token, creator, creatorPk);
        ClubRouterUsdg.Permit memory permit =
            _permitSig(address(usdg), alicePk, address(router), 10 * ONE, block.timestamp + 1 hours);

        vm.prank(alice, alice);
        router.buyWithInvite(token, 10 * ONE, 0, invite, permit);
        assertTrue(vault.isMember(token, alice));
        assertEq(usdg.balanceOf(alice), 0);
    }

    function test_routerSell_withAPermitOnTheCoin() public {
        address token = _launch();
        (address alice, uint256 alicePk) = _signer("alice");
        _join(token, alice, creator, creatorPk, 100 * ONE);
        uint256 tokens = IERC20(token).balanceOf(alice);

        ClubRouterUsdg.Permit memory permit =
            _permitSig(token, alicePk, address(router), tokens, block.timestamp + 1 hours);
        vm.prank(alice, alice);
        uint256 out = router.sell(token, tokens, 0, permit);
        assertGt(out, 0);
        assertEq(usdg.balanceOf(alice), out);
        assertLt(out, 100 * ONE, "sold back for more than was paid");
    }

    function test_buy_withoutPermitOrAllowanceIsRefused() public {
        address token = _launch();
        usdg.mint(creator, 10 * ONE);
        vm.prank(creator, creator);
        vm.expectRevert(bytes("permit failed and no allowance"));
        router.buy(token, 10 * ONE, 0, _noPermit());
    }

    // -----------------------------------------------------------------
    // invites
    // -----------------------------------------------------------------

    function test_invite_admitsAndConsumesOneSeat() public {
        address token = _launch();
        (address alice,) = _signer("alice");

        _join(token, alice, creator, creatorPk, 10 * ONE);

        assertTrue(vault.isMember(token, alice));
        assertEq(vault.inviterOf(token, alice), creator);
        assertEq(vault.seatsLeft(token, creator), 9);
        assertEq(vault.seatsOf(token, alice), 3, "new member gets 3 seats");
        assertGt(IERC20(token).balanceOf(alice), 0, "seat consumed without a buy");
    }

    function test_invite_isABearerLinkUntilTheSeatsRunOut() public {
        address token = _launch();
        (address alice, uint256 alicePk) = _signer("alice");
        _join(token, alice, creator, creatorPk, 10 * ONE);

        ClubRouterUsdg.Invite memory invite = _link(token, alice, alicePk);
        for (uint256 i = 0; i < 3; i++) {
            (address friend,) = _signer(string.concat("friend", vm.toString(i)));
            _buyWithInvite(friend, token, 5 * ONE, invite);
            assertEq(vault.inviterOf(token, friend), alice);
        }

        (address late,) = _signer("late");
        _fund(late, 5 * ONE);
        vm.prank(late, late);
        vm.expectRevert(bytes("no seats left"));
        router.buyWithInvite(token, 5 * ONE, 0, invite, _noPermit());
    }

    function test_invite_revokedLinksStopWorking() public {
        address token = _launch();
        ClubRouterUsdg.Invite memory invite = _link(token, creator, creatorPk);

        vm.prank(creator);
        vault.revokeInvites(token);

        (address alice,) = _signer("alice");
        _fund(alice, 5 * ONE);
        vm.prank(alice, alice);
        vm.expectRevert(bytes("invite revoked"));
        router.buyWithInvite(token, 5 * ONE, 0, invite, _noPermit());
    }

    function test_invite_revokingDoesNotRemoveAnyone() public {
        address token = _launch();
        (address alice,) = _signer("alice");
        _join(token, alice, creator, creatorPk, 10 * ONE);

        vm.prank(creator);
        vault.revokeInvites(token);

        assertTrue(vault.isMember(token, alice));
        _routerBuy(alice, token, 5 * ONE);
    }

    function test_invite_expires() public {
        address token = _launch();
        uint256 deadline = block.timestamp + 1 hours;
        ClubRouterUsdg.Invite memory invite = ClubRouterUsdg.Invite({
            inviter: creator,
            nonce: 0,
            deadline: deadline,
            signature: _sig(creatorPk, token, creator, 0, deadline)
        });

        vm.warp(deadline + 1);
        (address alice,) = _signer("alice");
        _fund(alice, 5 * ONE);
        vm.prank(alice, alice);
        vm.expectRevert(bytes("invite expired"));
        router.buyWithInvite(token, 5 * ONE, 0, invite, _noPermit());
    }

    function test_invite_forgedSignatureIsRefused() public {
        address token = _launch();
        (, uint256 impostorPk) = makeAddrAndKey("impostor");
        uint256 deadline = block.timestamp + 1 days;
        ClubRouterUsdg.Invite memory invite = ClubRouterUsdg.Invite({
            inviter: creator,
            nonce: 0,
            deadline: deadline,
            signature: _sig(impostorPk, token, creator, 0, deadline)
        });

        (address alice,) = _signer("alice");
        _fund(alice, 5 * ONE);
        vm.prank(alice, alice);
        vm.expectRevert(bytes("bad invite signature"));
        router.buyWithInvite(token, 5 * ONE, 0, invite, _noPermit());
    }

    /// @dev See ClubLaunchTest: an EIP-7702-delegated account still signs with
    /// its own key.
    function test_invite_fromAn7702DelegatedAccountIsAccepted() public {
        address token = _launch();
        (address alice, uint256 alicePk) = _signer("alice");
        _join(token, alice, creator, creatorPk, 10 * ONE);

        vm.etch(alice, abi.encodePacked(hex"ef0100", address(0xDE1E6A7E)));
        assertGt(alice.code.length, 0);

        (address bob,) = _signer("bob");
        _join(token, bob, alice, alicePk, 10 * ONE);
        assertEq(vault.inviterOf(token, bob), alice);
    }

    /// @dev A Safe-like wallet can win the auction, so it must be able to be
    /// a club's root and hand out invites through ERC-1271.
    function test_contractWallet_canWinAClubAndInvite() public {
        (address walletOwner, uint256 walletOwnerPk) = _signer("walletOwner");
        MockContractWallet wallet = new MockContractWallet(walletOwner);

        address token = _launchFor(address(wallet), 0);
        assertTrue(vault.isMember(token, address(wallet)));

        (address bob,) = _signer("bob");
        _join(token, bob, address(wallet), walletOwnerPk, 10 * ONE);
        assertEq(vault.inviterOf(token, bob), address(wallet));
    }

    function test_contractWallet_thatRefusesTheSignatureCannotInvite() public {
        (address walletOwner, uint256 walletOwnerPk) = _signer("walletOwner");
        MockContractWallet wallet = new MockContractWallet(walletOwner);
        address token = _launchFor(address(wallet), 0);

        wallet.setRefuse(true);
        ClubRouterUsdg.Invite memory invite = _link(token, address(wallet), walletOwnerPk);
        (address bob,) = _signer("bob");
        _fund(bob, 5 * ONE);
        vm.prank(bob, bob);
        vm.expectRevert(bytes("bad invite signature"));
        router.buyWithInvite(token, 5 * ONE, 0, invite, _noPermit());
    }

    function test_invite_fromANonMemberIsRefused() public {
        address token = _launch();
        (address stranger, uint256 strangerPk) = makeAddrAndKey("stranger");
        uint256 deadline = block.timestamp + 1 days;
        ClubRouterUsdg.Invite memory invite = ClubRouterUsdg.Invite({
            inviter: stranger,
            nonce: 0,
            deadline: deadline,
            signature: _sig(strangerPk, token, stranger, 0, deadline)
        });

        (address alice,) = _signer("alice");
        _fund(alice, 5 * ONE);
        vm.prank(alice, alice);
        vm.expectRevert(bytes("inviter not a member"));
        router.buyWithInvite(token, 5 * ONE, 0, invite, _noPermit());
    }

    function test_invite_needsARealBuyNotDust() public {
        address token = _launch();
        ClubRouterUsdg.Invite memory invite = _link(token, creator, creatorPk);

        (address alice,) = _signer("alice");
        _fund(alice, ONE / 2);
        vm.prank(alice, alice);
        vm.expectRevert(bytes("join buy too small"));
        router.buyWithInvite(token, ONE / 2, 0, invite, _noPermit());

        assertEq(vault.seatsLeft(token, creator), 10, "seat consumed by a refused buy");
    }

    function test_invite_clickedTwiceIsJustABuy() public {
        address token = _launch();
        (address alice,) = _signer("alice");
        _join(token, alice, creator, creatorPk, 10 * ONE);
        uint8 seatsBefore = vault.seatsLeft(token, creator);

        _join(token, alice, creator, creatorPk, 10 * ONE);

        assertEq(vault.seatsLeft(token, creator), seatsBefore);
        assertEq(vault.inviterOf(token, alice), creator);
    }

    function test_invite_cannotMoveSomeoneWhoIsAlreadyIn() public {
        address token = _launch();
        (address alice, uint256 alicePk) = _signer("alice");
        (address bob,) = _signer("bob");
        _join(token, alice, creator, creatorPk, 10 * ONE);
        _join(token, bob, creator, creatorPk, 10 * ONE);

        _join(token, bob, alice, alicePk, 10 * ONE);

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
        _join(token, a, creator, creatorPk, 10 * ONE);
        _join(token, b, a, aPk, 10 * ONE);
        _join(token, c, b, bPk, 10 * ONE);
    }

    function test_fee_walksUpTheTreeInThirds() public {
        (address token, address a, address b, address c) = _chainOfThree();
        uint256[4] memory before =
            [vault.claimable(creator), vault.claimable(a), vault.claimable(b), vault.protocolUsdc()];

        _routerBuy(c, token, 100 * ONE);

        uint256 fee = (100 * ONE * 150) / 10_000;
        (uint256 toProtocol, uint256 toRoot, uint256 tree) = _split(fee);
        uint256 toB = (tree * 2) / 3;
        uint256 toA = ((tree - toB) * 2) / 3;

        assertEq(vault.claimable(b) - before[2], toB, "level 1");
        assertEq(vault.claimable(a) - before[1], toA, "level 2");
        assertEq(vault.claimable(creator) - before[0], toRoot + (tree - toB - toA), "root + roll-up");
        assertEq(vault.protocolUsdc() - before[3], toProtocol, "protocol");

        // The published schedule: 73.3 and 24.4 bps of a $100 buy, to the
        // precision six decimals allow.
        assertApproxEqAbs(toB, 733_333, 1);
        assertApproxEqAbs(toA, 244_444, 1);
    }

    function test_fee_stopsAtTenLevels() public {
        address token = _launch();

        address[12] memory m;
        uint256[12] memory pk;
        for (uint256 i = 0; i < 12; i++) {
            (m[i], pk[i]) = _signer(string.concat("m", vm.toString(i)));
            if (i == 0) _join(token, m[0], creator, creatorPk, 2 * ONE);
            else _join(token, m[i], m[i - 1], pk[i - 1], 2 * ONE);
        }

        uint256[12] memory before;
        for (uint256 i = 0; i < 12; i++) before[i] = vault.claimable(m[i]);
        uint256 creatorBefore = vault.claimable(creator);

        _routerBuy(m[11], token, 100 * ONE);

        uint256 fee = (100 * ONE * 150) / 10_000;
        (, uint256 toRoot, uint256 tree) = _split(fee);

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

        _routerBuy(creator, token, 100 * ONE);

        uint256 fee = (100 * ONE * 150) / 10_000;
        (uint256 toProtocol, uint256 toRoot, uint256 tree) = _split(fee);
        assertEq(vault.claimable(creator) - creatorBefore, toRoot);
        assertEq(vault.protocolUsdc() - protocolBefore, toProtocol + tree);
    }

    function test_fee_nonMemberSellHasNoTree() public {
        address token = _launch();
        (address alice,) = _signer("alice");
        _join(token, alice, creator, creatorPk, 100 * ONE);
        uint256 tokens = IERC20(token).balanceOf(alice) / 2;
        vm.prank(alice);
        IERC20(token).transfer(outsider, tokens);

        uint256 claimsBefore = _vaultClaims();
        uint256 creatorBefore = vault.claimable(creator);
        uint256 protocolBefore = vault.protocolUsdc();

        _directSell(outsider, token, tokens);

        uint256 fee = _vaultClaims() - claimsBefore;
        assertGt(fee, 0);
        (, uint256 toRoot,) = _split(fee);
        assertEq(vault.claimable(creator) - creatorBefore, toRoot);
        assertEq(vault.protocolUsdc() - protocolBefore, fee - toRoot);
    }

    /// @dev Every unit the hook charges is owed to someone, so the vault's
    /// claims on the pool manager must equal what it owes exactly — and it
    /// holds no USDG of its own at all.
    function test_vaultOwesExactlyWhatItHolds() public {
        address token = _launch();
        (address a, uint256 aPk) = _signer("a");
        (address b, uint256 bPk) = _signer("b");
        (address c,) = _signer("c");
        _join(token, a, creator, creatorPk, 37 * ONE);
        _join(token, b, a, aPk, 11 * ONE);
        _join(token, c, b, bPk, 3 * ONE);
        _routerBuy(c, token, 123 * ONE);
        _directBuy(b, token, 7 * ONE, "");
        _routerBuy(creator, token, 19 * ONE);
        vm.prank(a);
        IERC20(token).transfer(outsider, 1_000_000e18);
        _directSell(outsider, token, 1_000_000e18);

        uint256 owed = vault.protocolUsdc() + vault.claimable(creator) + vault.claimable(a)
            + vault.claimable(b) + vault.claimable(c) + vault.claimable(outsider);
        assertEq(_vaultClaims(), owed);
        assertEq(usdg.balanceOf(address(vault)), 0);
    }

    // -----------------------------------------------------------------
    // money out
    // -----------------------------------------------------------------

    function test_claim_paysEverythingOwedOnce() public {
        address token = _launch();
        (address a, uint256 aPk) = _signer("a");
        (address b,) = _signer("b");
        _join(token, a, creator, creatorPk, 10 * ONE);
        _join(token, b, a, aPk, 10 * ONE);
        _routerBuy(b, token, 100 * ONE);

        uint256 owed = vault.claimable(a);
        assertGt(owed, 0);
        uint256 balanceBefore = usdg.balanceOf(a);
        uint256 claimsBefore = _vaultClaims();

        vm.prank(a);
        vault.claim();
        assertEq(usdg.balanceOf(a) - balanceBefore, owed);
        assertEq(vault.claimable(a), 0);
        assertEq(claimsBefore - _vaultClaims(), owed, "claims not burned");

        vm.prank(a);
        vault.claim();
        assertEq(usdg.balanceOf(a) - balanceBefore, owed, "paid twice");
    }

    function test_protocolFees_ownerOnly() public {
        address token = _launch();
        _routerBuy(creator, token, 100 * ONE);
        uint256 owed = vault.protocolUsdc();
        assertGt(owed, 0);

        vm.prank(outsider);
        vm.expectRevert();
        vault.withdrawProtocolFees(outsider);

        address treasury = _eoa("treasury");
        vm.prank(owner);
        vault.withdrawProtocolFees(treasury);
        assertEq(usdg.balanceOf(treasury), owed);
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
            currency0: Currency.wrap(address(usdg)),
            currency1: Currency.wrap(address(uint160(token) + 1)),
            fee: 0,
            tickSpacing: 2,
            hooks: IHooks(address(vault))
        });
        vm.expectRevert();
        IPoolManager(POOL_MANAGER).initialize(rogue, TickMath.getSqrtPriceAtTick(399_870));
    }
}
