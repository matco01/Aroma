// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/libraries/FixedPoint96.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ICurveManagerLike {
    function graduationSeedUsdc(address token) external view returns (uint256);
    function depositGraduatedFees(address token) external payable;
}

/**
 * @title LiquidityLocker
 * @notice Where a graduated token's liquidity goes, and where it stays.
 *
 * @dev This is CurveManager's `graduationVault`. That address is immutable
 * and already receives both halves of a graduation — the native USDC by
 * plain call, the reserved tokens by ERC-20 transfer — so making the vault
 * a contract that can seed a pool needed no change to the curve's money
 * path at all. The curve still does exactly what it did.
 *
 * Graduating and seeding are deliberately two steps, not one. If pool
 * creation were inlined into `graduate()`, any revert inside Uniswap — a
 * pool that already exists, a price outside bounds, a change to the
 * singleton — would make graduation itself impossible, stranding a fully
 * raised token on a curve it has already outgrown. Here a failed seed is
 * retryable and the funds are never in limbo: they sit in this contract,
 * visible on-chain, until someone calls seedPool again.
 *
 * `poolManager` may be the zero address. On Arc testnet (5042002) Uniswap
 * v4 is not deployed — eth_getCode against the published PoolManager
 * returns empty there — so the locker deploys with no manager and behaves
 * as a plain vault, which is what the product does today. On Arc mainnet
 * (5042) it deploys pointing at the real singleton and this same code
 * seeds a real pool. No admin switch, no upgrade, no migration: the
 * difference between the two is one constructor argument.
 *
 * The LP is locked by construction rather than by promise. No function
 * here decreases liquidity or moves a position out. collectFees is the
 * only reach into the pool and it modifies liquidity by zero. Nobody,
 * including whoever deployed this, can pull the floor out from under a
 * graduated token.
 */
contract LiquidityLocker is IUnlockCallback, ReentrancyGuard {
    using BalanceDeltaLibrary for BalanceDelta;

    /// @notice The v4 singleton, or address(0) where v4 does not exist yet.
    IPoolManager public immutable poolManager;

    /// @notice The curve that graduates tokens into this contract.
    ICurveManagerLike public immutable curve;

    /// @dev 1% pool fee, matching the curve's own trade fee so the cost of
    /// trading does not jump the moment a token graduates. v4 states fees
    /// in hundredths of a bip: 10_000 == 1%.
    uint24 public constant POOL_FEE = 10_000;

    /// @dev Uniswap's conventional spacing for the 1% tier.
    int24 public constant TICK_SPACING = 200;

    /// @dev Full range, snapped inward to a multiple of TICK_SPACING.
    /// Full range because this liquidity is never managed: there is nobody
    /// to rebalance a narrow band, and a position that drifts out of range
    /// is a token that cannot be traded.
    int24 public constant TICK_LOWER = -887_200;
    int24 public constant TICK_UPPER = 887_200;

    struct SeededPool {
        bool seeded;
        uint128 liquidity;
        uint256 usdcSeeded;
        uint256 tokensSeeded;
    }

    mapping(address token => SeededPool) public pools;

    event PoolSeeded(
        address indexed token, uint256 usdc, uint256 tokens, uint128 liquidity, uint160 sqrtPriceX96
    );
    event FeesCollected(address indexed token, uint256 usdc, uint256 tokens);

    error NoPoolManager();
    error AlreadySeeded();
    error NothingToSeed();
    error NotPoolManager();

    constructor(address poolManager_, address curve_) {
        // poolManager_ is allowed to be zero; curve_ is not, because a
        // locker with no curve can never be funded or report fees.
        require(curve_ != address(0), "curve=0");
        poolManager = IPoolManager(poolManager_);
        curve = ICurveManagerLike(curve_);
    }

    /// @notice Accepts the native USDC half of a graduation.
    receive() external payable {}

    /// @notice Creates this token's pool and puts the graduation seed into
    /// it, permanently. Permissionless, like graduate() itself — the
    /// product does not depend on Aroma running a bot for a graduated
    /// token to become tradeable.
    function seedPool(address token) external nonReentrant returns (uint128 liquidity) {
        if (address(poolManager) == address(0)) revert NoPoolManager();
        if (pools[token].seeded) revert AlreadySeeded();

        // The token side is unambiguous — this contract holds exactly the
        // tokens graduated for it. The USDC side is not: native balance is
        // pooled across every token awaiting a seed, so the amount comes
        // from the curve's own record of what it sent.
        uint256 usdcSeed = curve.graduationSeedUsdc(token);
        uint256 tokenSeed = IERC20Minimal(token).balanceOf(address(this));
        if (usdcSeed == 0 || tokenSeed == 0) revert NothingToSeed();
        if (usdcSeed > address(this).balance) usdcSeed = address(this).balance;

        PoolKey memory key = _keyFor(token);

        // price = currency1 per currency0 = tokens per USDC. Native is
        // always currency0 because address(0) sorts below every token.
        uint160 sqrtPriceX96 = uint160(Math.sqrt(FullMath.mulDiv(tokenSeed, 1 << 192, usdcSeed)));

        poolManager.initialize(key, sqrtPriceX96);

        liquidity = _liquidityFor(sqrtPriceX96, usdcSeed, tokenSeed);
        require(liquidity > 0, "liquidity=0");

        pools[token] = SeededPool({
            seeded: true,
            liquidity: liquidity,
            usdcSeeded: usdcSeed,
            tokensSeeded: tokenSeed
        });

        poolManager.unlock(abi.encode(token, int256(uint256(liquidity))));

        emit PoolSeeded(token, usdcSeed, tokenSeed, liquidity, sqrtPriceX96);
    }

    /// @notice Harvests this pool's accrued swap fees and routes them
    /// through the curve, where they meet the same 70/30 creator split and
    /// the same ledger as pre-graduation trade fees. A creator's claim
    /// button does not care which side of graduation the money came from.
    function collectFees(address token) external nonReentrant {
        if (address(poolManager) == address(0)) revert NoPoolManager();
        require(pools[token].seeded, "not seeded");

        uint256 usdcBefore = address(this).balance;

        // Zero liquidity delta. This is the only reach this contract has
        // into the pool, and it cannot move the position.
        poolManager.unlock(abi.encode(token, int256(0)));

        uint256 usdcFees = address(this).balance - usdcBefore;
        uint256 tokenFees = IERC20Minimal(token).balanceOf(address(this));

        if (usdcFees > 0) curve.depositGraduatedFees{value: usdcFees}(token);
        emit FeesCollected(token, usdcFees, tokenFees);
    }

    /// @dev v4 hands control back here with the manager unlocked. Every
    /// balance the pool owes or is owed must net to zero before this
    /// returns, or the whole call reverts.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();

        (address token, int256 liquidityDelta) = abi.decode(data, (address, int256));
        PoolKey memory key = _keyFor(token);

        (BalanceDelta callerDelta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: TICK_LOWER,
                tickUpper: TICK_UPPER,
                liquidityDelta: liquidityDelta,
                salt: bytes32(0)
            }),
            ""
        );

        int128 amount0 = callerDelta.amount0();
        int128 amount1 = callerDelta.amount1();

        // Native first, while nothing is synced — v4 reads msg.value as the
        // payment when the synced-currency slot is empty. The ERC-20 leg
        // must sync, transfer, then settle, and settle reverts if value is
        // attached, so the order here is not interchangeable.
        if (amount0 < 0) {
            poolManager.settle{value: uint256(uint128(-amount0))}();
        } else if (amount0 > 0) {
            poolManager.take(key.currency0, address(this), uint256(uint128(amount0)));
        }

        if (amount1 < 0) {
            uint256 owed = uint256(uint128(-amount1));
            poolManager.sync(key.currency1);
            IERC20Minimal(token).transfer(address(poolManager), owed);
            poolManager.settle();
        } else if (amount1 > 0) {
            poolManager.take(key.currency1, address(this), uint256(uint128(amount1)));
        }

        return "";
    }

    function _keyFor(address token) internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
    }

    /// @dev Largest liquidity both sides can fund. Taking the minimum means
    /// the position never asks for more of either currency than the
    /// graduation actually delivered; any dust stays here.
    function _liquidityFor(uint160 sqrtPriceX96, uint256 amount0, uint256 amount1)
        internal
        pure
        returns (uint128)
    {
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(TICK_LOWER);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(TICK_UPPER);

        uint256 l0 = FullMath.mulDiv(
            amount0, FullMath.mulDiv(sqrtPriceX96, sqrtB, FixedPoint96.Q96), sqrtB - sqrtPriceX96
        );
        uint256 l1 = FullMath.mulDiv(amount1, FixedPoint96.Q96, sqrtPriceX96 - sqrtA);

        uint256 liquidity = l0 < l1 ? l0 : l1;
        require(liquidity <= type(uint128).max, "liquidity overflow");
        return uint128(liquidity);
    }
}
