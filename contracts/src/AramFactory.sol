// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AramToken} from "./AramToken.sol";
import {CurveManager} from "./CurveManager.sol";

/// @title AramFactory
/// @notice One transaction: deploy a fixed-supply token (mints straight to
/// CurveManager), register it, and optionally run the creator's own
/// dev-buy through the exact same `buy()` path everyone else uses — this
/// is a real, named Pons v2 mechanic ("developer buy"), not invented for
/// aram. No admin surface at all: this contract holds no funds of its own
/// beyond the instant it takes to forward them, and has no owner.
/// @dev Deployed *after* CurveManager, then CurveManager.setFactory(this)
/// is called once to complete the bootstrap — see CurveManager's NatSpec
/// on why that two-step ordering exists.
///
/// No creation fee: pump.fun's own fee schedule charges $0 to create a
/// coin (revenue is entirely the bonding-curve trade fee), and that's a
/// deliberate incentive choice worth keeping, not an oversight — a
/// creation fee taxes exactly the behavior (many tokens launched) that
/// drives the trading volume this product actually monetizes from. A
/// creator pays only Arc's network gas, same as every other action here.
contract AramFactory is ReentrancyGuard {
    CurveManager public immutable curveManager;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    /// @dev Carries `description` purely so indexers and the UI have it —
    /// it is never read on-chain and costs only log data (8 gas/byte). The
    /// alternative, off-chain metadata behind a URI, means running storage
    /// and a resolver before a single token can render a sentence about
    /// itself. Images still can't live here and fall back to art derived
    /// from the token address.
    event TokenCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        string description,
        uint256 devBuyUsdc
    );

    constructor(address curveManager_) {
        require(curveManager_ != address(0), "curveManager=0");
        curveManager = CurveManager(curveManager_);
    }

    /// @param devBuyUsdc Native USDC to spend on an immediate dev-buy. Zero
    /// skips it entirely — this is optional.
    /// @param minDevTokensOut Slippage floor for the dev-buy — the
    /// creator's own trade gets no less protection than anyone else's.
    function createToken(
        string calldata name,
        string calldata symbol,
        string calldata description,
        uint256 devBuyUsdc,
        uint256 minDevTokensOut
    ) external payable nonReentrant returns (address token) {
        // The cap is enforced here, at the only place a dev-buy can
        // happen. It deliberately does *not* live in CurveManager.buy():
        // that function serves every ordinary trade too, and ordinary
        // buyers aren't capped — only the creator's privileged
        // first-in-line purchase is. Without this, a creator could take
        // most of the curve at its cheapest prices before anyone else
        // sees the token exists.
        require(devBuyUsdc <= curveManager.MAX_DEV_BUY_USDC(), "dev buy exceeds cap");
        require(msg.value >= devBuyUsdc, "insufficient payment");

        token = address(new AramToken(name, symbol, TOTAL_SUPPLY, address(curveManager)));
        curveManager.registerToken(token, msg.sender);

        // Announce the token *before* the dev-buy, not after.
        //
        // The dev-buy emits Bought from CurveManager, and an indexer
        // processes logs in index order. With TokenCreated emitted last, a
        // consumer sees the token's first trade before it has ever heard of
        // the token — and any indexer that keys trades by token (ours does,
        // and so would a third party's) silently drops that dev-buy. Since
        // the dev-buy is usually the largest early trade and sets the
        // opening price, losing it is not cosmetic.
        //
        // Ordering is the whole point of this line's position; test
        // test_devBuy_isAnnouncedAfterTheTokenExists pins it.
        emit TokenCreated(token, msg.sender, name, symbol, description, devBuyUsdc);

        if (devBuyUsdc > 0) {
            // recipient is msg.sender (the creator), not this factory —
            // see CurveManager.buy's NatSpec for exactly why that
            // parameter exists.
            curveManager.buy{value: devBuyUsdc}(token, msg.sender, minDevTokensOut);
        }

        uint256 refund = msg.value - devBuyUsdc;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            require(ok, "refund failed");
        }
    }
}
