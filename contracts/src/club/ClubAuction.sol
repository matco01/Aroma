// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {PoolFactoryUsdg} from "../pool-usdg/PoolFactoryUsdg.sol";

/// @title ClubAuction
/// @notice Aroma no longer lets anyone launch a coin whenever they want.
/// Instead there is exactly one Club open at a time: a 24-hour English
/// auction (duration configurable at deploy, not after) for the exclusive
/// right to launch the next coin. The current top bidder can rewrite that
/// coin's draft identity — name, ticker, description, image/links — at will,
/// visible to everyone watching. When the countdown reaches zero, the
/// winner's draft launches automatically, the winning bid goes to the
/// protocol treasury, and a new Club opens immediately.
///
/// @dev Every payment here is USDG (a plain ERC-20 — Robinhood Chain's native
/// gas token is ETH, not a stablecoin), pulled via `transferFrom`, never
/// `payable`/`msg.value`.
///
/// Refunds to an outbid bidder use the pull-payment pattern
/// (`pendingReturns` + `withdraw`), not a push transfer at bid time. That's a
/// deliberate departure from how `PoolFactoryUsdg`/`PoolVaultUsdg` move funds
/// (a raw push, safe there because a caller only ever pays itself): here, a
/// *new* bidder's transaction would be paying a *different*, previous
/// bidder, and a malicious top-bidder contract that reverts on receiving
/// funds could otherwise wedge every future bid.
///
/// `PoolFactoryUsdg.createToken` has no "on behalf of" parameter — whoever
/// calls it becomes the token's recorded creator in `PoolVaultUsdg`, which
/// means this contract, not the human winner. Rather than change
/// `PoolFactoryUsdg`, `finalize` sweeps the dev-buy's tokens to the real
/// winner itself, and `claimCreatorFeesFor` exists to keep forwarding
/// ongoing creator fees to them for as long as the coin trades.
contract ClubAuction is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    PoolFactoryUsdg public immutable poolFactory;
    IERC20 public immutable usdg;
    address public immutable treasury;

    uint64 public immutable roundDuration;
    uint256 public immutable minOpeningBid;
    uint256 public immutable minBidIncrementBps;
    uint64 public immutable antiSnipeExtension;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @dev Grouped rather than four flat string parameters on `bid`/
    /// `updateDraft` — with `bidAmount`/`devBuyUsdc`/`minTokensOut` already
    /// there, four more named parameters pushed solc past its stack limit,
    /// the same class of error `PoolFactoryUsdg.TokenInfo` exists to fix.
    struct Draft {
        string name;
        string symbol;
        string description;
        string metadataUri;
    }

    /// @dev Grouped for the same stack-limit reason as `Draft` — `bid`
    /// already has four other parameters, and USDG's EIP-2612 permit is
    /// four more values on its own.
    struct Permit {
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct Club {
        uint256 id;
        uint64 endsAt;
        bool finalized;
        address topBidder;
        uint256 topBid; // -> treasury at finalize
        uint256 topDevBuy; // -> forwarded into PoolFactoryUsdg's dev-buy
        uint256 minTokensOut; // slippage floor for that dev-buy
        string name;
        string symbol;
        string description;
        string metadataUri;
    }

    Club private current;

    /// @dev Pull-payment refunds for outbid bidders — see this contract's
    /// NatSpec for why this isn't a push transfer.
    mapping(address account => uint256 amount) public pendingReturns;

    /// @dev token -> the human who actually won the auction that launched
    /// it, since `PoolVaultUsdg` itself only ever sees this contract as the
    /// creator. Set once, at launch, and never changed.
    mapping(address token => address winner) public winnerOf;

    event ClubOpened(uint256 indexed clubId, uint64 endsAt);
    event ClubBid(
        uint256 indexed clubId,
        address indexed bidder,
        uint256 bidAmount,
        uint256 devBuyUsdc,
        uint64 endsAt
    );
    event ClubDraftUpdated(
        uint256 indexed clubId,
        address indexed bidder,
        string name,
        string symbol,
        string description,
        string metadataUri
    );
    event ClubLaunched(
        uint256 indexed clubId,
        address indexed token,
        address indexed winner,
        uint256 winningBid,
        uint256 devBuyUsdc
    );
    event ClubVoided(uint256 indexed clubId);
    event Withdrawn(address indexed account, uint256 amount);
    event CreatorFeesForwarded(address indexed token, address indexed winner, uint256 usdg);

    constructor(
        address poolFactory_,
        address usdg_,
        address treasury_,
        address owner_,
        uint64 roundDuration_,
        uint256 minOpeningBid_,
        uint256 minBidIncrementBps_,
        uint64 antiSnipeExtension_
    ) Ownable(owner_) {
        require(poolFactory_ != address(0), "poolFactory=0");
        require(usdg_ != address(0), "usdg=0");
        require(treasury_ != address(0), "treasury=0");
        require(roundDuration_ > 0, "roundDuration=0");

        poolFactory = PoolFactoryUsdg(poolFactory_);
        usdg = IERC20(usdg_);
        treasury = treasury_;
        roundDuration = roundDuration_;
        minOpeningBid = minOpeningBid_;
        minBidIncrementBps = minBidIncrementBps_;
        antiSnipeExtension = antiSnipeExtension_;

        _openNewClub();
    }

    function _openNewClub() private {
        uint256 id = current.id + 1;
        uint64 endsAt = uint64(block.timestamp) + roundDuration;
        current = Club({
            id: id,
            endsAt: endsAt,
            finalized: false,
            topBidder: address(0),
            topBid: 0,
            topDevBuy: 0,
            minTokensOut: 0,
            name: "",
            symbol: "",
            description: "",
            metadataUri: ""
        });
        emit ClubOpened(id, endsAt);
    }

    // ---------------------------------------------------------------
    // Bidding
    // ---------------------------------------------------------------

    /// @notice Bids `bidAmount` USDG for the current Club, optionally
    /// reserving `devBuyUsdc` more for the coin's own first buy if this bid
    /// wins. Also sets the draft identity — `name`/`symbol` are required on
    /// every bid, not just the first, so `finalize` always has a launchable
    /// draft no matter who is on top when the countdown ends.
    /// @dev Pulls `bidAmount + devBuyUsdc` in one `transferFrom`, authorized
    /// by `permit` rather than a prior approval — the same one-signature
    /// shape `AromaRouterUsdg.buy` uses and for the same reason: without it,
    /// bidding would need a separate approve transaction that buying on the
    /// AMM does not, which is a real UX regression for no benefit. A permit
    /// already consumed by the time this runs (front-run, or simply reused
    /// from a prior approval) is not an error — only the allowance actually
    /// being there afterward matters, same as AromaRouterUsdg's reasoning.
    function bid(
        uint256 bidAmount,
        uint256 devBuyUsdc,
        uint256 minTokensOut,
        Draft calldata draft,
        Permit calldata permit
    ) external nonReentrant {
        Club storage c = current;
        require(!c.finalized, "round finalized");
        require(block.timestamp < c.endsAt, "auction ended");
        require(bytes(draft.name).length > 0, "name required");
        require(bytes(draft.symbol).length > 0, "symbol required");
        require(devBuyUsdc <= poolFactory.MAX_DEV_BUY_USDC(), "dev buy exceeds cap");

        uint256 minNext = c.topBid == 0
            ? minOpeningBid
            : c.topBid + (c.topBid * minBidIncrementBps) / BPS_DENOMINATOR;
        require(bidAmount >= minNext, "bid too low");

        uint256 total = bidAmount + devBuyUsdc;
        try IERC20Permit(address(usdg)).permit(
            msg.sender, address(this), total, permit.deadline, permit.v, permit.r, permit.s
        ) {} catch {}
        require(
            usdg.allowance(msg.sender, address(this)) >= total,
            "permit failed and no allowance"
        );

        // Pull the new bidder's full escrow before touching the old
        // bidder's refund, so a failing transferFrom reverts cleanly rather
        // than crediting a refund against a bid that never arrived.
        usdg.safeTransferFrom(msg.sender, address(this), total);

        if (c.topBidder != address(0)) {
            pendingReturns[c.topBidder] += c.topBid + c.topDevBuy;
        }

        c.topBidder = msg.sender;
        c.topBid = bidAmount;
        c.topDevBuy = devBuyUsdc;
        c.minTokensOut = minTokensOut;
        c.name = draft.name;
        c.symbol = draft.symbol;
        c.description = draft.description;
        c.metadataUri = draft.metadataUri;

        // Anti-snipe: a bid inside the extension window pushes the deadline
        // out by exactly that much, so the top spot can't be locked in by a
        // bid nobody has time to respond to.
        if (c.endsAt - uint64(block.timestamp) < antiSnipeExtension) {
            c.endsAt = uint64(block.timestamp) + antiSnipeExtension;
        }

        emit ClubBid(c.id, msg.sender, bidAmount, devBuyUsdc, c.endsAt);
        // ClubBid itself carries no draft fields, to keep its topic/data
        // shape stable regardless of description/metadataUri length. An
        // indexer (or anyone else watching) gets the draft a bid set from
        // this same event `updateDraft` uses, not a second copy of it here.
        emit ClubDraftUpdated(
            c.id, msg.sender, draft.name, draft.symbol, draft.description, draft.metadataUri
        );
    }

    /// @notice Rewrites the current Club's draft identity without changing
    /// the bid — the cheap "edit the preview" action, usable by the top
    /// bidder as many times as they like while they're still on top.
    function updateDraft(Draft calldata draft) external {
        Club storage c = current;
        require(msg.sender == c.topBidder, "not top bidder");
        require(!c.finalized, "round finalized");
        require(bytes(draft.name).length > 0, "name required");
        require(bytes(draft.symbol).length > 0, "symbol required");

        c.name = draft.name;
        c.symbol = draft.symbol;
        c.description = draft.description;
        c.metadataUri = draft.metadataUri;

        emit ClubDraftUpdated(
            c.id, msg.sender, draft.name, draft.symbol, draft.description, draft.metadataUri
        );
    }

    function withdraw() external nonReentrant {
        uint256 amount = pendingReturns[msg.sender];
        require(amount > 0, "nothing to withdraw");
        pendingReturns[msg.sender] = 0;
        usdg.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------
    // Finalize — called by the team's own bot once the countdown ends, not
    // a permissionless keeper. If the bot is down past the deadline, the
    // round simply doesn't finalize until it's back; there's no fallback,
    // by design.
    // ---------------------------------------------------------------

    /// @param salt CREATE2 salt for the launched token, mined off-chain by
    /// the caller before this call — see `PoolFactoryUsdg`'s NatSpec for why
    /// a salt is needed at all (USDG isn't address zero, so a launched
    /// token's address has to be steered above it, not merely hoped for).
    /// Ignored when the round has no bids to launch.
    function finalize(bytes32 salt) external onlyOwner nonReentrant {
        Club storage c = current;
        require(!c.finalized, "already finalized");
        require(block.timestamp >= c.endsAt, "not ended");
        c.finalized = true;

        if (c.topBidder == address(0)) {
            emit ClubVoided(c.id);
            _openNewClub();
            return;
        }

        address winner = c.topBidder;
        uint256 winningBid = c.topBid;
        uint256 devBuyUsdc = c.topDevBuy;

        if (devBuyUsdc > 0) {
            usdg.forceApprove(address(poolFactory), devBuyUsdc);
        }

        (address token,) = poolFactory.createToken(
            PoolFactoryUsdg.TokenInfo({
                name: c.name,
                symbol: c.symbol,
                description: c.description,
                metadataUri: c.metadataUri
            }),
            devBuyUsdc,
            c.minTokensOut,
            salt
        );

        winnerOf[token] = winner;

        // The dev-buy's tokens land on whoever called createToken — this
        // contract — not the real winner. Sweep them across immediately,
        // while their true owner is still known.
        uint256 tokensReceived = IERC20(token).balanceOf(address(this));
        if (tokensReceived > 0) {
            IERC20(token).safeTransfer(winner, tokensReceived);
        }

        usdg.safeTransfer(treasury, winningBid);

        emit ClubLaunched(c.id, token, winner, winningBid, devBuyUsdc);
        _openNewClub();
    }

    /// @notice Forwards a club-launched token's accrued creator fees to the
    /// human who actually won the auction that launched it. Callable by
    /// anyone — funds only ever move to `winnerOf[token]`, never the caller.
    function claimCreatorFeesFor(address token) external nonReentrant returns (uint256 usdgOut) {
        address winner = winnerOf[token];
        require(winner != address(0), "not a club-launched token");
        usdgOut = poolFactory.vault().claimCreatorFees(token);
        if (usdgOut > 0) {
            usdg.safeTransfer(winner, usdgOut);
        }
        emit CreatorFeesForwarded(token, winner, usdgOut);
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    function getCurrentClub() external view returns (Club memory) {
        return current;
    }
}
