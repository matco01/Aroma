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
import {ClubVaultUsdg} from "./ClubVaultUsdg.sol";

/// @title ClubRouterUsdg
/// @notice Buys and sells club coins on Robinhood Chain, and is the only way to
/// redeem an invite.
///
/// @dev ClubRouter, paid in USDG instead of native value. A buy pulls USDG
/// with an EIP-2612 permit, so it is still one signature and one transaction
/// rather than approve-then-buy; a permit that fails (already used, or
/// front-run) is tolerated as long as an allowance covers the buy, for the
/// reason AromaRouter gives about sells.
///
/// Arguments are grouped into structs so buyWithInvite stays under the stack
/// limit without via-IR.
contract ClubRouterUsdg is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;
    ClubVaultUsdg public immutable vault;
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
        bytes hookData;
    }

    struct Permit {
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct Invite {
        address inviter;
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    event Bought(address indexed token, address indexed buyer, uint256 usdcIn, uint256 tokensOut);
    event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 usdcOut);

    constructor(address vault_) {
        require(vault_ != address(0), "vault=0");
        vault = ClubVaultUsdg(vault_);
        poolManager = ClubVaultUsdg(vault_).poolManager();
        usdg = IERC20(Currency.unwrap(ClubVaultUsdg(vault_).USDC()));
    }

    /// @notice Buy as an existing member.
    function buy(address token, uint256 usdgIn, uint256 minTokensOut, Permit calldata permit)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        require(usdgIn > 0, "no USDG sent");
        require(vault.creatorOf(token) != address(0), "unknown token");
        require(vault.isMember(token, msg.sender), "invite only");

        _pull(address(usdg), usdgIn, permit);
        tokensOut = _swap(Side.Buy, token, usdgIn, minTokensOut, _noInvite());
        emit Bought(token, msg.sender, usdgIn, tokensOut);
    }

    /// @notice Buy with an invite. For someone not yet a member this is how
    /// they join, and the seat is consumed only if the buy goes through. For
    /// someone already a member the invite is ignored and this is an ordinary
    /// buy, so a link that is clicked twice does not fail.
    function buyWithInvite(
        address token,
        uint256 usdgIn,
        uint256 minTokensOut,
        Invite calldata invite,
        Permit calldata permit
    ) external nonReentrant returns (uint256 tokensOut) {
        require(usdgIn > 0, "no USDG sent");
        require(vault.creatorOf(token) != address(0), "unknown token");

        if (!vault.isMember(token, msg.sender)) {
            require(usdgIn >= vault.MIN_JOIN_USDC(), "join buy too small");
            string memory problem = vault.inviteProblem(
                token, msg.sender, invite.inviter, invite.nonce, invite.deadline, invite.signature
            );
            require(bytes(problem).length == 0, problem);
        }

        _pull(address(usdg), usdgIn, permit);
        tokensOut = _swap(
            Side.Buy,
            token,
            usdgIn,
            minTokensOut,
            abi.encode(msg.sender, invite.inviter, invite.nonce, invite.deadline, invite.signature)
        );
        emit Bought(token, msg.sender, usdgIn, tokensOut);
    }

    /// @notice Sells for USDG with a permit on the coin. Open to anyone
    /// holding it, member or not.
    function sell(address token, uint256 tokenAmount, uint256 minUsdgOut, Permit calldata permit)
        external
        nonReentrant
        returns (uint256 usdgOut)
    {
        require(tokenAmount > 0, "tokenAmount=0");
        require(vault.creatorOf(token) != address(0), "unknown token");

        _pull(token, tokenAmount, permit);
        usdgOut = _swap(Side.Sell, token, tokenAmount, minUsdgOut, _noInvite());
        emit Sold(token, msg.sender, tokenAmount, usdgOut);
    }

    function _pull(address asset, uint256 amount, Permit calldata permit) private {
        try IERC20Permit(asset).permit(
            msg.sender, address(this), amount, permit.deadline, permit.v, permit.r, permit.s
        ) {} catch {}
        require(
            IERC20(asset).allowance(msg.sender, address(this)) >= amount,
            "permit failed and no allowance"
        );
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
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
            require(owed0 <= 0, "unexpected USDG credit");
            uint256 owed = uint256(uint128(-owed0));
            require(owed == o.amountIn, "insufficient liquidity");
            _settle(key.currency0, owed);

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
            _settle(key.currency1, owed);

            int128 got0 = delta.amount0();
            require(got0 > 0, "no USDG received");
            out = uint256(uint128(got0));
            require(out >= o.minOut, "slippage");
            poolManager.take(key.currency0, o.trader, out);
        }

        return abi.encode(out);
    }

    function _settle(Currency currency, uint256 amount) private {
        poolManager.sync(currency);
        IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), amount);
        poolManager.settle();
    }
}
