// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {ClubVaultUsdg} from "../../src/club/ClubVaultUsdg.sol";
import {ClubFactoryUsdg} from "../../src/club/ClubFactoryUsdg.sol";
import {ClubRouterUsdg} from "../../src/club/ClubRouterUsdg.sol";
import {ClubAuction} from "../../src/club/ClubAuction.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";

/// @notice Tests for the auction that gates every launch: bidding, refunds,
/// draft editing, and finalize — including that what finalize launches is a
/// club whose root is the human winner, not this contract: the winner holds
/// the first buy, the creator's invite seats, and the root's share of fees.
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

    ClubVaultUsdg vault;
    ClubFactoryUsdg factory;
    ClubRouterUsdg router;
    ClubAuction club;
    MockUsdg usdg;

    address poolOwner = makeAddr("poolOwner");
    address clubOwner = makeAddr("clubOwner");
    address treasury = makeAddr("treasury");
    address alice;
    uint256 alicePk;
    address bob = makeAddr("bob");

    function setUp() public {
        vm.createSelectFork(vm.envOr("ETH_RPC_URL", string(DEFAULT_RPC)), FORK_BLOCK);

        (alice, alicePk) = makeAddrAndKey("alice");
        usdg = new MockUsdg();

        deployCodeTo(
            "ClubVaultUsdg.sol:ClubVaultUsdg",
            abi.encode(POOL_MANAGER, address(usdg), poolOwner),
            HOOK_ADDRESS
        );
        vault = ClubVaultUsdg(HOOK_ADDRESS);
        factory = new ClubFactoryUsdg(address(vault));
        router = new ClubRouterUsdg(address(vault));
        vm.startPrank(poolOwner);
        vault.setFactory(address(factory));
        vault.setRouter(address(router));
        vm.stopPrank();

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
        factory.setLauncher(address(club));

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
        usdg.approve(address(router), type(uint256).max);
    }

    function _mineSaltFor(string memory name, string memory symbol)
        internal
        view
        returns (bytes32)
    {
        for (uint256 i = 0; i < 1_000; i++) {
            if (factory.predictToken(name, symbol, bytes32(i)) > address(usdg)) return bytes32(i);
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
        // Read before expectRevert: an external call in the argument list
        // would be the call the expectation applies to.
        uint256 cap = factory.MAX_DEV_BUY_USDC();
        assertEq(cap, 300e6, "first buy cap is 300 USDG");
        vm.prank(alice);
        vm.expectRevert("dev buy exceeds cap");
        club.bid(200e6, cap + 1, 0, ClubAuction.Draft({name: "Aroma Coin", symbol: "AROMA", description: "", metadataUri: ""}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));
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

    function test_finalize_makesTheWinnerTheClubsRoot() public {
        address token = _launchForAlice();
        assertEq(vault.creatorOf(token), alice, "creator is not the winner");
        assertTrue(vault.isMember(token, alice));
        assertFalse(vault.isMember(token, address(club)), "the auction joined the club");
        assertEq(vault.seatsLeft(token, alice), 10, "winner lacks the creator's seats");
    }

    function _launchForAlice() internal returns (address token) {
        vm.prank(alice);
        club.bid(200e6, 0, 0, ClubAuction.Draft({name: "Aroma Coin", symbol: "AROMA", description: "", metadataUri: ""}), ClubAuction.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}));
        _warpPastDeadline();
        bytes32 salt = _mineSaltFor("Aroma Coin", "AROMA");
        vm.prank(clubOwner);
        club.finalize(salt);
        token = _predictToken(salt, "Aroma Coin", "AROMA");
    }

    function _predictToken(bytes32 salt, string memory name, string memory symbol)
        internal
        view
        returns (address)
    {
        return factory.predictToken(name, symbol, salt);
    }

    // ---------------------------------------------------------------
    // The winner's club
    // ---------------------------------------------------------------

    /// @dev End to end: win the auction, invite someone, and earn from their
    /// trade. The invite is signed with the winner's own key.
    function test_winner_invitesAndEarnsFromTheirTrades() public {
        address token = _launchForAlice();

        uint256 nonce = vault.inviteNonce(token, alice);
        uint256 deadline = block.timestamp + 1 days;
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(alicePk, vault.inviteDigest(token, alice, nonce, deadline));

        vm.prank(bob, bob);
        router.buyWithInvite(
            token,
            1_000e6,
            0,
            ClubRouterUsdg.Invite({inviter: alice, nonce: nonce, deadline: deadline, signature: abi.encodePacked(r, s_, v)}),
            ClubRouterUsdg.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)})
        );
        assertEq(vault.inviterOf(token, bob), alice);

        uint256 earned = vault.claimable(alice);
        // Root cut plus the whole tree: alice is both bob's inviter and the root.
        assertEq(earned, (1_000e6 * 150) / 10_000 - (1_000e6 * 150 / 10_000 * 30) / 150, "winner's share");

        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        vault.claim();
        assertEq(usdg.balanceOf(alice) - before, earned);
    }
}
