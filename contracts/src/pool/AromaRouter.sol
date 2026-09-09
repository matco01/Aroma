// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolVault} from "./PoolVault.sol";

/// @title AromaRouter
/// @notice Buys and sells Aroma's pool-launched coins, with the same call
/// shapes CurveManager exposes.
///
/// Exists rather than routing through Uniswap's Universal Router for two
/// reasons, and the second is the one that matters.
///
/// The practical one: Uniswap's published address tables give Arc a v3
/// router, a v4 Quoter and a v4 PositionManager, but no Universal Router. A
/// frontend cannot swap a v4 pool without *some* router, and depending on an
/// address nobody has published is not a plan.
///
/// The real one: the Universal Router takes ERC-20s through Permit2, which is
/// a second approval system with its own signature scheme and its own
/// allowance state. AromaToken already implements EIP-2612, and CurveManager
/// already uses it so that selling is one signed transaction rather than
/// approve-then-sell. Routing sells through Permit2 would throw that away and
/// make the pool version of the product measurably worse to use than the
/// curve version it replaces. `sell` below therefore takes the same permit
/// arguments `CurveManager.sell` does, and the frontend's sell flow is the
/// same flow it already has.
///
/// @dev Only serves Aroma pools: every key is built by asking PoolVault, so
/// there is no path to an arbitrary pool and no approval that outlives a
/// transaction. This contract never holds a balance between calls.
contract AromaRouter is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;
    PoolVault public immutable vault;

    enum Side {
        Buy,
        Sell
    }

    struct Order {
        Side side;
        address token;
        address trader;
        uint256 amountIn;
        uint256 minOut;
    }

    event Bought(address indexed token, address indexed buyer, uint256 usdcIn, uint256 tokensOut);
    event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 usdcOut);

    constructor(address vault_) {
        require(vault_ != address(0), "vault=0");
        vault = PoolVault(payable(vault_));
        poolManager = PoolVault(payable(vault_)).poolManager();
    }

    /// @notice Spends the native USDC sent with this call on `token`.
    /// @param minTokensOut Slippage floor. There is no equivalent parameter
    /// on the pool itself — unlike CurveManager.buy, the pool takes a price
    /// limit rather than an amount, so enforcing a minimum is the router's
    /// job and skipping it would leave every buy unprotected.
    function buy(address token, uint256 minTokensOut)
        external
        payable
        nonReentrant
        returns (uint256 tokensOut)
    {
        require(msg.value > 0, "no USDC sent");
        require(vault.creatorOf(token) != address(0), "unknown token");

        bytes memory result = poolManager.unlock(
            abi.encode(
                Order({
                    side: Side.Buy,
                    token: token,
                    trader: msg.sender,
                    amountIn: msg.value,
                    minOut: minTokensOut
                })
            )
        );
        tokensOut = abi.decode(result, (uint256));
        emit Bought(token, msg.sender, msg.value, tokensOut);
    }

    /// @notice Sells `tokenAmount` of `token` for native USDC. Uses EIP-2612
    /// permit so the whole trade — approve + sell — is one signed
    /// transaction, matching the single-tx buy path.
    ///
    /// @dev Deliberately the same signature as CurveManager.sell, so moving
    /// the frontend from one venue to the other is a change of address and
    /// ABI rather than a change of flow.
    function sell(
        address token,
        uint256 tokenAmount,
        uint256 minUsdcOut,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 usdcOut) {
        require(tokenAmount > 0, "tokenAmount=0");
        require(vault.creatorOf(token) != address(0), "unknown token");

        // A permit is front-runnable: anyone can submit the signature on the
        // owner's behalf, which consumes the nonce and makes this call revert
        // on a signature that was perfectly valid. Since the only thing that
        // matters is the allowance existing by the next line, a permit that
        // has already been used is not an error. CurveManager calls permit
        // unguarded; this does not, and that difference is intentional.
        try IERC20Permit(token).permit(
            msg.sender, address(this), tokenAmount, permitDeadline, v, r, s
        ) {} catch {}
        require(
            IERC20(token).allowance(msg.sender, address(this)) >= tokenAmount,
            "permit failed and no allowance"
        );

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokenAmount);

        bytes memory result = poolManager.unlock(
            abi.encode(
                Order({
                    side: Side.Sell,
                    token: token,
                    trader: msg.sender,
                    amountIn: tokenAmount,
                    minOut: minUsdcOut
                })
            )
        );
        usdcOut = abi.decode(result, (uint256));
        emit Sold(token, msg.sender, tokenAmount, usdcOut);
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "not pool manager");
        Order memory o = abi.decode(data, (Order));
        PoolKey memory key = vault.poolKey(o.token);

        bool zeroForOne = o.side == Side.Buy;
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                // Negative is exact-input. Exact-output is not offered: the
                // hook refuses exact-output sells, and offering a shape that
                // works in one direction only is worse than not offering it.
                amountSpecified: -int256(o.amountIn),
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        // The returned delta is already net of whatever the hook charged —
        // PoolManager applies afterSwap's adjustment before returning it — so
        // these are the amounts the trader actually owes and receives.
        uint256 out;
        if (zeroForOne) {
            int128 owed0 = delta.amount0();
            require(owed0 <= 0, "unexpected USDC credit");
            // Settling native currency needs no sync; the value carries it.
            poolManager.settle{value: uint256(uint128(-owed0))}();

            int128 got1 = delta.amount1();
            require(got1 > 0, "no tokens received");
            out = uint256(uint128(got1));
            require(out >= o.minOut, "slippage");
            // Straight to the trader. A router that briefly holds a trader's
            // tokens is a router that can be made to lose them.
            poolManager.take(key.currency1, o.trader, out);
        } else {
            int128 owed1 = delta.amount1();
            require(owed1 <= 0, "unexpected token credit");
            uint256 owed = uint256(uint128(-owed1));
            poolManager.sync(key.currency1);
            IERC20(o.token).safeTransfer(address(poolManager), owed);
            poolManager.settle();

            int128 got0 = delta.amount0();
            require(got0 > 0, "no USDC received");
            out = uint256(uint128(got0));
            require(out >= o.minOut, "slippage");
            poolManager.take(key.currency0, o.trader, out);
        }

        return abi.encode(out);
    }

    /// @dev Native USDC returned by the pool manager mid-settle.
    receive() external payable {}
}
