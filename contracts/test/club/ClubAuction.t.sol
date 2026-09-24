// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {PoolVaultUsdg} from "../../src/pool-usdg/PoolVaultUsdg.sol";
import {PoolFactoryUsdg} from "../../src/pool-usdg/PoolFactoryUsdg.sol";
import {AromaToken} from "../../src/AromaToken.sol";
import {ClubAuction} from "../../src/club/ClubAuction.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";

/// @notice Tests for the auction that gates every launch: bidding, refunds,
/// draft editing, and finalize — including the two things `ClubAuction`'s
/// NatSpec calls out as easy to get wrong: dev-buy tokens and creator fees
/// both have to reach the real human winner, not this contract, even though
/// `PoolFactoryUsdg`/`PoolVaultUsdg` only ever see `ClubAuction` itself as
/// the caller.
contract ClubAuctionTest is Test {
    address constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    string constant DEFAULT_RPC = "https://eth.drpc.org";
    uint256 constant FORK_BLOCK = 25_900_000;

    uint160 constant REQUIRED_FLAGS =
        uint160((1 << 13) | (1 << 7) | (1 << 6) | (1 << 3) | (1 << 2));
    address constant HOOK_ADDRESS = address((uint160(0x4444) << 144) | REQUIRED_FLAGS);

    uint64 constant ROUND_DURATION = 24 hours;
    uint256 constant MIN_OPENING_BID = 100e6;
    uint256 constant MIN_BID_INCREMENT_BPS = 500;
    uint64 constant ANTI_SNIPE_EXTENSION = 5 minutes;

    PoolVaultUsdg vault;
    PoolFactoryUsdg factory;
    ClubAuction club;
    PoolSwapTest swapRouter;
    MockUsdg usdg;

    address poolOwner = makeAddr("poolOwner");
    address clubOwner = makeAddr("clubOwner");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.createSelectFork(vm.envOr("ETH_RPC_URL", string(DEFAULT_RPC)), FORK_BLOCK);

        usdg = new MockUsdg();

        deployCodeTo(
            "PoolVaultUsdg.sol:PoolVaultUsdg",
            abi.encode(POOL_MANAGER, address(usdg), poolOwner),
            HOOK_ADDRESS
        );
        vault = PoolVaultUsdg(payable(HOOK_ADDRESS));
        factory = new PoolFactoryUsdg(address(vault));
        vm.prank(poolOwner);
        vault.setFactory(address(factory));

        swapRouter = new PoolSwapTest(IPoolManager(POOL_MANAGER));

        club = new ClubAuction(
            address(factory),
            address(usdg),
            treasury,
            clubOwner,
            ROUND_DURATION,
            MIN_OPENING_BID,
            MIN_BID_INCREMENT_BPS,
            ANTI_SNIPE_EXTENSION
        );

        vm.etch(poolOwner, "");
        vm.etch(clubOwner, "");
        vm.etch(treasury, "");
        vm.etch(alice, "");
        vm.etch(bob, "");

        usdg.mint(alice, 1_000_000e6);
        usdg.mint(bob, 1_000_000e6);
        vm.prank(alice);
        usdg.approve(address(club), type(uint256).max);
        vm.prank(bob);
        usdg.approve(address(club), type(uint256).max);
        vm.prank(bob);
        usdg.approve(address(swapRouter), type(uint256).max);
    }

    function _mineSaltFor(string memory name, string memory symbol)
        internal
        view
        returns (bytes32)
    {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(AromaToken).creationCode,
                abi.encode(name, symbol, factory.TOTAL_SUPPLY(), address(vault))
            )
        );
        for (uint256 i = 0; i < 1000; i++) {
            bytes32 salt = bytes32(i);
            address predicted = address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(bytes1(0xff), address(factory), salt, initCodeHash)
                        )
                    )
                )
            );
            if (predicted > address(usdg)) return salt;
        }
        revert("no salt found");
    }

    function _warpPastDeadline() internal {
        ClubAuction.Club memory c = club.getCurrentClub();
        vm.warp(uint256(c.endsAt) + 1);
    }

    // ---------------------------------------------------------------
    // Bidding
    // ---------------------------------------------------------------

    function test_bid_becomesTopBidder() public {
        vm.prank(alice);
        club.bid(200e6, 0, 0, ClubAuction.Draft({name: "Aroma Coin", symbol: "AROMA", description: "desc", metadataUri: ""}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));

        ClubAuction.Club memory c = club.getCurrentClub();
        assertEq(c.topBidder, alice);
        assertEq(c.topBid, 200e6);
        assertEq(c.name, "Aroma Coin");
    }

    function test_bid_belowMinimumOpeningBidReverts() public {
        vm.prank(alice);
        vm.expectRevert("bid too low");
        club.bid(MIN_OPENING_BID - 1, 0, 0, ClubAuction.Draft({name: "Aroma Coin", symbol: "AROMA", description: "", metadataUri: ""}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));
    }

    function test_bid_requiresNameAndSymbol() public {
        vm.prank(alice);
        vm.expectRevert("name required");
        club.bid(MIN_OPENING_BID, 0, 0, ClubAuction.Draft({name: "", symbol: "AROMA", description: "", metadataUri: ""}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));

        vm.prank(alice);
        vm.expectRevert("symbol required");
        club.bid(MIN_OPENING_BID, 0, 0, ClubAuction.Draft({name: "Aroma Coin", symbol: "", description: "", metadataUri: ""}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));
    }

    function test_bid_belowIncrementReverts() public {
        vm.prank(alice);
        club.bid(200e6, 0, 0, ClubAuction.Draft({name: "Aroma Coin", symbol: "AROMA", description: "", metadataUri: ""}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));

        vm.prank(bob);
        vm.expectRevert("bid too low");
        club.bid(201e6, 0, 0, ClubAuction.Draft({name: "Bob Coin", symbol: "BOB", description: "", metadataUri: ""}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));
    }

    function test_bid_outbidRefundsThePreviousBidderViaWithdraw() public {
        vm.prank(alice);
        club.bid(200e6, 0, 0, ClubAuction.Draft({name: "Aroma Coin", symbol: "AROMA", description: "", metadataUri: ""}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));
        uint256 aliceBefore = usdg.balanceOf(alice);

        vm.prank(bob);
        club.bid(300e6, 0, 0, ClubAuction.Draft({name: "Bob Coin", symbol: "BOB", description: "", metadataUri: ""}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));

        assertEq(club.pendingReturns(alice), 200e6, "no refund credited");
        assertEq(usdg.balanceOf(alice), aliceBefore, "paid before withdraw was called");

        vm.prank(alice);
        club.withdraw();
        assertEq(usdg.balanceOf(alice) - aliceBefore, 200e6, "withdraw paid the wrong amount");
        assertEq(club.pendingReturns(alice), 0);
    }

    function test_bid_pullsBidPlusDevBuyTogether() public {
        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        club.bid(200e6, 50e6, 0, ClubAuction.Draft({name: "Aroma Coin", symbol: "AROMA", description: "", metadataUri: ""}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));
        assertEq(before - usdg.balanceOf(alice), 250e6, "did not pull bid + dev-buy");
    }

    function test_bid_devBuyAboveCapReverts() public {
        vm.prank(alice);
        vm.expectRevert("dev buy exceeds cap");
        club.bid(200e6, factory.MAX_DEV_BUY_USDC() + 1, 0, ClubAuction.Draft({name: "Aroma Coin", symbol: "AROMA", description: "", metadataUri: ""}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));
    }

    function test_bid_nearDeadlineExtendsCountdown() public {
        ClubAuction.Club memory before = club.getCurrentClub();
        vm.warp(uint256(before.endsAt) - 1 minutes);

        vm.prank(alice);
        club.bid(200e6, 0, 0, ClubAuction.Draft({name: "Aroma Coin", symbol: "AROMA", description: "", metadataUri: ""}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));

        ClubAuction.Club memory afterBid = club.getCurrentClub();
        assertEq(
            afterBid.endsAt,
            uint64(block.timestamp) + ANTI_SNIPE_EXTENSION,
            "deadline did not extend"
        );
    }

    function test_bid_wellBeforeDeadlineDoesNotExtendCountdown() public {
        ClubAuction.Club memory before = club.getCurrentClub();
        vm.prank(alice);
        club.bid(200e6, 0, 0, ClubAuction.Draft({name: "Aroma Coin", symbol: "AROMA", description: "", metadataUri: ""}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));
        ClubAuction.Club memory afterBid = club.getCurrentClub();
        assertEq(afterBid.endsAt, before.endsAt, "deadline moved with no snipe risk");
    }

    function test_bid_afterDeadlineReverts() public {
        _warpPastDeadline();
        vm.prank(alice);
        vm.expectRevert("auction ended");
        club.bid(200e6, 0, 0, ClubAuction.Draft({name: "Aroma Coin", symbol: "AROMA", description: "", metadataUri: ""}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));
    }

    // ---------------------------------------------------------------
    // Draft editing
    // ---------------------------------------------------------------

    function test_updateDraft_onlyTopBidderCanEdit() public {
        vm.prank(alice);
        club.bid(200e6, 0, 0, ClubAuction.Draft({name: "Aroma Coin", symbol: "AROMA", description: "d1", metadataUri: ""}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));

        vm.prank(bob);
        vm.expectRevert("not top bidder");
        club.updateDraft(ClubAuction.Draft({name: "Hijacked", symbol: "HACK", description: "", metadataUri: ""}));

        vm.prank(alice);
        club.updateDraft(ClubAuction.Draft({name: "Aroma Coin V2", symbol: "AROMA2", description: "d2", metadataUri: "ipfs://x"}));
        ClubAuction.Club memory c = club.getCurrentClub();
        assertEq(c.name, "Aroma Coin V2");
        assertEq(c.symbol, "AROMA2");
        assertEq(c.description, "d2");
        assertEq(c.metadataUri, "ipfs://x");
    }

    function test_updateDraft_doesNotChangeTheBid() public {
        vm.prank(alice);
        club.bid(200e6, 0, 0, ClubAuction.Draft({name: "Aroma Coin", symbol: "AROMA", description: "", metadataUri: ""}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));
        vm.prank(alice);
        club.updateDraft(ClubAuction.Draft({name: "New Name", symbol: "NEW", description: "", metadataUri: ""}));
        assertEq(club.getCurrentClub().topBid, 200e6, "bid changed on a pure draft edit");
    }

    // ---------------------------------------------------------------
    // Finalize
    // ---------------------------------------------------------------

    function test_finalize_revertsBeforeDeadline() public {
        vm.prank(alice);
        club.bid(200e6, 0, 0, ClubAuction.Draft({name: "Aroma Coin", symbol: "AROMA", description: "", metadataUri: ""}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));
        vm.prank(clubOwner);
        vm.expectRevert("not ended");
        club.finalize(bytes32(0));
    }

    function test_finalize_onlyOwnerMayCall() public {
        _warpPastDeadline();
        vm.expectRevert();
        club.finalize(bytes32(0));
    }

    function test_finalize_noBidsVoidsAndOpensNextRound() public {
        uint256 firstId = club.getCurrentClub().id;
        _warpPastDeadline();

        vm.prank(clubOwner);
        club.finalize(bytes32(0));

        ClubAuction.Club memory next = club.getCurrentClub();
        assertEq(next.id, firstId + 1, "next round was not opened");
        assertFalse(next.finalized);
    }

    function test_finalize_launchesTheWinningDraftAndPaysTreasury() public {
        vm.prank(alice);
        club.bid(200e6, 0, 0, ClubAuction.Draft({name: "Aroma Coin", symbol: "AROMA", description: "a real coin", metadataUri: "ipfs://meta"}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));
        _warpPastDeadline();

        bytes32 salt = _mineSaltFor("Aroma Coin", "AROMA");
        uint256 treasuryBefore = usdg.balanceOf(treasury);

        vm.prank(clubOwner);
        club.finalize(salt);

        assertEq(
            usdg.balanceOf(treasury) - treasuryBefore, 200e6, "treasury was not paid the winning bid"
        );

        ClubAuction.Club memory next = club.getCurrentClub();
        assertEq(next.id, 2, "next round was not opened");
    }

    function test_finalize_devBuyTokensReachTheWinnerNotTheContract() public {
        vm.prank(alice);
        club.bid(200e6, 50e6, 0, ClubAuction.Draft({name: "Aroma Coin", symbol: "AROMA", description: "", metadataUri: ""}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));
        _warpPastDeadline();

        bytes32 salt = _mineSaltFor("Aroma Coin", "AROMA");
        vm.prank(clubOwner);
        club.finalize(salt);

        address token = _predictToken(salt, "Aroma Coin", "AROMA");
        assertGt(IERC20(token).balanceOf(alice), 0, "winner got no dev-buy tokens");
        assertEq(IERC20(token).balanceOf(address(club)), 0, "ClubAuction kept the dev-buy tokens");
    }

    function test_finalize_recordsTheWinnerForFeeForwarding() public {
        vm.prank(alice);
        club.bid(200e6, 0, 0, ClubAuction.Draft({name: "Aroma Coin", symbol: "AROMA", description: "", metadataUri: ""}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));
        _warpPastDeadline();
        bytes32 salt = _mineSaltFor("Aroma Coin", "AROMA");
        vm.prank(clubOwner);
        club.finalize(salt);

        address token = _predictToken(salt, "Aroma Coin", "AROMA");
        assertEq(club.winnerOf(token), alice);
    }

    function _predictToken(bytes32 salt, string memory name, string memory symbol)
        internal
        view
        returns (address)
    {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(AromaToken).creationCode,
                abi.encode(name, symbol, factory.TOTAL_SUPPLY(), address(vault))
            )
        );
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(factory), salt, initCodeHash))
                )
            )
        );
    }

    // ---------------------------------------------------------------
    // Creator fees
    // ---------------------------------------------------------------

    function test_claimCreatorFeesFor_paysTheWinnerNotTheCaller() public {
        vm.prank(alice);
        club.bid(200e6, 0, 0, ClubAuction.Draft({name: "Aroma Coin", symbol: "AROMA", description: "", metadataUri: ""}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));
        _warpPastDeadline();
        bytes32 salt = _mineSaltFor("Aroma Coin", "AROMA");
        vm.prank(clubOwner);
        club.finalize(salt);
        address token = _predictToken(salt, "Aroma Coin", "AROMA");

        // Generate real fees with a direct pool-manager swap, the same
        // primitive PoolLaunchUsdgTest's own `_buy` helper uses.
        PoolKey memory key = vault.poolKey(token);
        vm.prank(bob);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(uint256(10_000e6)),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        uint256 winnerBefore = usdg.balanceOf(alice);
        uint256 callerBefore = usdg.balanceOf(bob);

        vm.prank(bob);
        uint256 paid = club.claimCreatorFeesFor(token);

        assertGt(paid, 0, "no fees to claim");
        assertEq(usdg.balanceOf(alice) - winnerBefore, paid, "winner was not paid");
        assertEq(usdg.balanceOf(bob), callerBefore, "caller was paid instead of the winner");
    }

    function test_claimCreatorFeesFor_revertsForANonClubToken() public {
        vm.expectRevert("not a club-launched token");
        club.claimCreatorFeesFor(address(0xDEAD));
    }
}
