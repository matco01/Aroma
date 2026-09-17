// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {ClubVault} from "./ClubVault.sol";

/// @title ClubRouter
/// @notice Buys and sells club coins, and is the only way to redeem an invite.
///
/// @dev AromaRouter's shape, for the same reasons AromaRouter gives, plus one
/// responsibility it does not have: it tells the hook who is trading. The hook
/// trusts this contract's statement of the trader because this contract only
/// ever states msg.sender, which is what lets smart-contract wallets use clubs.
/// For the same reason the vault accepts this address once and can never be
/// pointed at another.
///
/// Every require here duplicates a check the hook already makes. They exist
/// for the error message: a revert inside a hook reaches the caller wrapped by
/// the pool manager, and "invite only" is a far better thing to show someone
/// than an opaque wrapped error.
contract ClubRouter is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;
    ClubVault public immutable vault;

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
        bytes hookData;
    }

    event Bought(address indexed token, address indexed buyer, uint256 usdcIn, uint256 tokensOut);
    event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 usdcOut);

    constructor(address vault_) {
        require(vault_ != address(0), "vault=0");
        vault = ClubVault(payable(vault_));
        poolManager = ClubVault(payable(vault_)).poolManager();
    }

    /// @notice Buy as an existing member.
    function buy(address token, uint256 minTokensOut)
        external
        payable
        nonReentrant
        returns (uint256 tokensOut)
    {
        require(msg.value > 0, "no USDC sent");
        require(vault.creatorOf(token) != address(0), "unknown token");
        require(vault.isMember(token, msg.sender), "invite only");

        tokensOut = _swap(Side.Buy, token, msg.value, minTokensOut, _noInvite());
        emit Bought(token, msg.sender, msg.value, tokensOut);
    }

    /// @notice Buy with an invite. For someone not yet a member this is how
    /// they join, and the seat is consumed only if the buy goes through. For
    /// someone already a member the invite is ignored and this is an ordinary
    /// buy, so a link that is clicked twice does not fail.
    function buyWithInvite(
        address token,
        uint256 minTokensOut,
        address inviter,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external payable nonReentrant returns (uint256 tokensOut) {
        require(msg.value > 0, "no USDC sent");
        require(vault.creatorOf(token) != address(0), "unknown token");

        if (!vault.isMember(token, msg.sender)) {
            require(msg.value >= vault.MIN_JOIN_USDC(), "join buy too small");
            string memory problem =
                vault.inviteProblem(token, msg.sender, inviter, nonce, deadline, signature);
            require(bytes(problem).length == 0, problem);
        }

        tokensOut = _swap(
            Side.Buy,
            token,
            msg.value,
            minTokensOut,
            abi.encode(msg.sender, inviter, nonce, deadline, signature)
        );
        emit Bought(token, msg.sender, msg.value, tokensOut);
    }

    /// @notice Sells for native USDC with an EIP-2612 permit, as AromaRouter
    /// does. Open to anyone holding the coin, member or not.
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

        // Tolerates a front-run permit, for the reason AromaRouter gives.
        try IERC20Permit(token).permit(
            msg.sender, address(this), tokenAmount, permitDeadline, v, r, s
        ) {} catch {}
        require(
            IERC20(token).allowance(msg.sender, address(this)) >= tokenAmount,
            "permit failed and no allowance"
        );

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokenAmount);

        usdcOut = _swap(Side.Sell, token, tokenAmount, minUsdcOut, _noInvite());
        emit Sold(token, msg.sender, tokenAmount, usdcOut);
    }

    function _noInvite() private view returns (bytes memory) {
        return abi.encode(msg.sender, address(0), uint256(0), uint256(0), bytes(""));
    }

    function _swap(Side side, address token, uint256 amountIn, uint256 minOut, bytes memory hookData)
        private
        returns (uint256)
    {
        bytes memory result = poolManager.unlock(
            abi.encode(
                Order({
                    side: side,
                    token: token,
                    trader: msg.sender,
                    amountIn: amountIn,
                    minOut: minOut,
                    hookData: hookData
                })
            )
        );
        return abi.decode(result, (uint256));
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
            o.hookData
        );

        // All or nothing, exactly as AromaRouter — see its comments for the
        // stranded-funds bug this prevents.
        uint256 out;
        if (zeroForOne) {
            int128 owed0 = delta.amount0();
            require(owed0 <= 0, "unexpected USDC credit");
            require(uint256(uint128(-owed0)) == o.amountIn, "insufficient liquidity");
            poolManager.settle{value: uint256(uint128(-owed0))}();

            int128 got1 = delta.amount1();
            require(got1 > 0, "no tokens received");
            out = uint256(uint128(got1));
            require(out >= o.minOut, "slippage");
            poolManager.take(key.currency1, o.trader, out);
        } else {
            int128 owed1 = delta.amount1();
            require(owed1 <= 0, "unexpected token credit");
            uint256 owed = uint256(uint128(-owed1));
            require(owed == o.amountIn, "insufficient liquidity");
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

    receive() external payable {}
}
