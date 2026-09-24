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
import {PoolVaultUsdg} from "./PoolVaultUsdg.sol";

/// @title AromaRouterUsdg
/// @notice `AromaRouter` retargeted at USDG. See that contract's NatSpec for
/// why a dedicated router exists at all (no Universal Router on Arc/Robinhood
/// Chain, and Permit2 would throw away the one-signature trade this product
/// depends on) — none of that reasoning changes here.
///
/// @dev The one real difference: USDC on Arc is native, so a buy needs no
/// approval at all — the payment travels as `msg.value`. USDG is a plain
/// ERC-20, so a naive port would make `buy` a two-step approve-then-call,
/// which is a real regression from today's one-signature buy. Rather than
/// accept that, this router checked whether USDG supports EIP-2612 first
/// (confirmed against Paxos's own `usdg-contract` README) — it does — so
/// `buy` takes a permit the same way `sell` already does, and both directions
/// stay one signed transaction.
contract AromaRouterUsdg is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;
    PoolVaultUsdg public immutable vault;
    IERC20 public immutable usdg;

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

    event Bought(address indexed token, address indexed buyer, uint256 usdgIn, uint256 tokensOut);
    event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 usdgOut);

    constructor(address vault_) {
        require(vault_ != address(0), "vault=0");
        vault = PoolVaultUsdg(vault_);
        poolManager = PoolVaultUsdg(vault_).poolManager();
        usdg = IERC20(Currency.unwrap(PoolVaultUsdg(vault_).USDG()));
    }

    /// @notice Spends `usdgIn` USDG on `token`, authorized by a permit rather
    /// than a prior approval — see this contract's NatSpec.
    /// @param minTokensOut Slippage floor — the pool takes a price limit
    /// rather than an amount, so enforcing a minimum is the router's job, the
    /// same reasoning `AromaRouter.buy` documents.
    function buy(
        address token,
        uint256 usdgIn,
        uint256 minTokensOut,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 tokensOut) {
        require(usdgIn > 0, "no USDG sent");
        require(vault.creatorOf(token) != address(0), "unknown token");

        // A permit is front-runnable in the same way sell's is: anyone can
        // submit it on the owner's behalf, consuming the nonce, so a permit
        // that was already used by the time this runs is not an error — only
        // the allowance actually being there afterward matters.
        try IERC20Permit(address(usdg)).permit(
            msg.sender, address(this), usdgIn, permitDeadline, v, r, s
        ) {} catch {}
        require(
            usdg.allowance(msg.sender, address(this)) >= usdgIn,
            "permit failed and no allowance"
        );
        usdg.safeTransferFrom(msg.sender, address(this), usdgIn);

        bytes memory result = poolManager.unlock(
            abi.encode(
                Order({side: Side.Buy, token: token, trader: msg.sender, amountIn: usdgIn, minOut: minTokensOut})
            )
        );
        tokensOut = abi.decode(result, (uint256));
        emit Bought(token, msg.sender, usdgIn, tokensOut);
    }

    /// @notice Sells `tokenAmount` of `token` for USDG, authorized by a
    /// permit on the launched token itself — unchanged from `AromaRouter.sell`,
    /// since that permit was never about which currency the pool quotes in.
    function sell(
        address token,
        uint256 tokenAmount,
        uint256 minUsdgOut,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 usdgOut) {
        require(tokenAmount > 0, "tokenAmount=0");
        require(vault.creatorOf(token) != address(0), "unknown token");

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
                Order({side: Side.Sell, token: token, trader: msg.sender, amountIn: tokenAmount, minOut: minUsdgOut})
            )
        );
        usdgOut = abi.decode(result, (uint256));
        emit Sold(token, msg.sender, tokenAmount, usdgOut);
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
                amountSpecified: -int256(o.amountIn),
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        uint256 out;
        if (zeroForOne) {
            int128 owed0 = delta.amount0();
            require(owed0 <= 0, "unexpected USDG credit");
            // USDG is ERC-20: sync + push + settle, the same shape the sell
            // side already used for the launched token, rather than the
            // native `settle{value: ...}` the Arc router uses.
            uint256 owed = uint256(uint128(-owed0));
            poolManager.sync(key.currency0);
            usdg.safeTransfer(address(poolManager), owed);
            poolManager.settle();

            int128 got1 = delta.amount1();
            require(got1 > 0, "no tokens received");
            out = uint256(uint128(got1));
            require(out >= o.minOut, "slippage");
            poolManager.take(key.currency1, o.trader, out);
        } else {
            int128 owed1 = delta.amount1();
            require(owed1 <= 0, "unexpected token credit");
            uint256 owed = uint256(uint128(-owed1));
            poolManager.sync(key.currency1);
            IERC20(o.token).safeTransfer(address(poolManager), owed);
            poolManager.settle();

            int128 got0 = delta.amount0();
            require(got0 > 0, "no USDG received");
            out = uint256(uint128(got0));
            require(out >= o.minOut, "slippage");
            // take() moves the real ERC-20 to the trader directly; this
            // router never holds USDG between calls.
            poolManager.take(key.currency0, o.trader, out);
        }

        return abi.encode(out);
    }
}
