// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {AromaToken} from "../AromaToken.sol";
import {ClubVault} from "./ClubVault.sol";

/// @title ClubFactory
/// @notice Launches a club coin: one transaction deploys the token, creates its
/// pool, deposits the supply as locked liquidity, makes the caller the club's
/// creator with 10 invite seats, and optionally runs their first buy.
///
/// @dev PoolFactory line for line, apart from the vault it launches into and
/// the hook data on the dev buy. The two factories stay separate contracts for
/// the same reason the two vaults do: a pool's hook is fixed at creation, so a
/// launch has to know which system it is joining before the pool exists.
contract ClubFactory is IUnlockCallback, ReentrancyGuard {
    ClubVault public immutable vault;
    IPoolManager public immutable poolManager;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant MAX_DEV_BUY_USDC = 2_000e18;

    /// @dev Identical to PoolFactory.TokenCreated, so the subgraph can serve
    /// both systems with one handler and tell them apart by which contract
    /// emitted the event.
    event TokenCreated(
        address indexed token,
        address indexed creator,
        PoolId indexed poolId,
        string name,
        string symbol,
        string description,
        string metadataUri,
        uint256 devBuyUsdc
    );

    struct DevBuy {
        address token;
        address recipient;
        uint256 usdc;
        uint256 minTokensOut;
    }

    constructor(address vault_) {
        require(vault_ != address(0), "vault=0");
        vault = ClubVault(payable(vault_));
        poolManager = ClubVault(payable(vault_)).poolManager();
    }

    function createToken(
        string calldata name,
        string calldata symbol,
        string calldata description,
        string calldata metadataUri,
        uint256 devBuyUsdc,
        uint256 minTokensOut
    ) external payable nonReentrant returns (address token, PoolId poolId) {
        require(devBuyUsdc <= MAX_DEV_BUY_USDC, "dev buy exceeds cap");
        require(msg.value >= devBuyUsdc, "insufficient payment");

        token = address(new AromaToken(name, symbol, TOTAL_SUPPLY, address(vault)));
        poolId = vault.launch(token, msg.sender);

        // Before the dev buy, for the reason PoolFactory gives: an indexer must
        // hear about the token before it sees the token's first trade.
        emit TokenCreated(
            token, msg.sender, poolId, name, symbol, description, metadataUri, devBuyUsdc
        );

        if (devBuyUsdc > 0) {
            poolManager.unlock(
                abi.encode(
                    DevBuy({
                        token: token,
                        recipient: msg.sender,
                        usdc: devBuyUsdc,
                        minTokensOut: minTokensOut
                    })
                )
            );
        }

        uint256 refund = msg.value - devBuyUsdc;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            require(ok, "refund failed");
        }
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "not pool manager");
        DevBuy memory d = abi.decode(data, (DevBuy));

        PoolKey memory key = vault.poolKey(d.token);

        // The hook gates buys on membership, so it has to be told who this buy
        // is for. It is the creator, who became the club's first member inside
        // vault.launch a moment ago. Without this the hook would fall back to
        // tx.origin, which is only the creator if the creator is not a
        // smart-contract wallet.
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(d.usdc),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            abi.encode(d.recipient, address(0), uint256(0), uint256(0), bytes(""))
        );

        int128 owed0 = delta.amount0();
        require(owed0 <= 0, "unexpected USDC credit");
        require(uint256(uint128(-owed0)) == d.usdc, "dev buy did not fill");
        poolManager.settle{value: uint256(uint128(-owed0))}();

        int128 out1 = delta.amount1();
        require(out1 > 0, "dev buy received no tokens");
        uint256 tokensOut = uint256(uint128(out1));
        require(tokensOut >= d.minTokensOut, "dev buy slippage");

        poolManager.take(key.currency1, d.recipient, tokensOut);
        return "";
    }

    receive() external payable {}
}
