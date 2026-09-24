// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    toBeforeSwapDelta
} from "v4-core/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

/// @title PoolVaultUsdg
/// @notice `PoolVault`, unchanged in every mechanic that doesn't depend on the
/// quote currency being native, retargeted at Robinhood Chain: quote currency
/// is USDG, a plain ERC-20, because Robinhood Chain's native gas token is ETH,
/// not a stablecoin. `PoolVault.sol` (Arc, native USDC) is left exactly as it
/// is — this is a new, parallel contract, not an edit of that one.
///
/// The curve geometry (`TICK_INIT`, `TICK_GRADUATION`, `TICK_RESERVE_FLOOR`,
/// the two liquidity constants) is **not** copied from `PoolVault` — those
/// numbers assume both currencies carry 18 decimals, which is only true of
/// native USDC. USDG is a plain ERC-20 confirmed at 6 decimals against
/// Paxos's own deployed contract (Etherscan
/// 0xe343167631d89b6ffc58b88d6b7fb0228795491d), the same convention as
/// ordinary USDC, so the 10^12 decimal gap `PoolVault`'s own NatSpec says the
/// native-currency version made disappear is back. Every tick below is
/// re-derived for that in `script/math/derive_pool_usdg.py` — see that
/// script for the math and for why it must be re-run, not hand-edited, if
/// any of this changes.
///
/// Ordering still needs `USDG` to land as `currency0` and the launched token
/// as `currency1` — the same shape native USDC gave for free by being
/// address zero, the lowest possible address. USDG is not address zero, so
/// that ordering is no longer automatic: see `launch`'s `require` below and
/// `PoolFactoryUsdg`'s NatSpec for how it's restored.
///
/// Everything about *why* a hook, why fees are single-currency, and why
/// liquidity can never be withdrawn is unchanged from `PoolVault` — see that
/// contract's NatSpec.
contract PoolVaultUsdg is IHooks, IUnlockCallback, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    // ---------------------------------------------------------------
    // Curve geometry — derived by script/math/derive_pool_usdg.py, *not* a
    // copy of PoolVault.sol's constants (see this contract's NatSpec for
    // why the 6-decimal quote currency changes every one of these numbers).
    // Re-run that script if any of this changes.
    // ---------------------------------------------------------------

    int24 public constant TICK_SPACING = 2;
    int24 public constant TICK_INIT = 399_870;
    int24 public constant TICK_GRADUATION = 372_142;
    int24 public constant TICK_RESERVE_FLOOR = 344_414;

    uint24 public constant POOL_LP_FEE = 0;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    uint128 public constant SALE_LIQUIDITY = 2215087395449222952;
    uint128 public constant RESERVE_LIQUIDITY = 2215167855639966831;

    uint256 public constant SWAP_FEE_BPS = 100;
    uint256 public constant CREATOR_FEE_SHARE_BPS = 7_000;
    uint256 public constant FEE_DENOMINATOR = 10_000;

    // ---------------------------------------------------------------
    // State
    // ---------------------------------------------------------------

    IPoolManager public immutable poolManager;

    /// @dev USDG, wrapped as a v4 Currency. Immutable rather than the
    /// original's `constant Currency.wrap(address(0))`, because which USDG
    /// address is correct depends on which Robinhood Chain network this is
    /// deployed to (mainnet vs. testnet) — it's a real ERC-20 with a real
    /// address, not a fixed sentinel.
    Currency public immutable USDG;

    /// @dev Set once after deployment, same bootstrap PoolVault uses.
    address public factory;

    struct Launch {
        address creator;
        PoolId poolId;
        uint256 creatorUsdg;
        uint256 protocolUsdg;
    }

    mapping(address token => Launch) public launches;
    mapping(PoolId poolId => address token) public poolTokens;

    bool private _launching;

    event Launched(address indexed token, address indexed creator, PoolId poolId);
    event FeeTaken(address indexed token, uint256 usdg);
    event CreatorFeesClaimed(address indexed token, address indexed creator, uint256 usdg);
    event ProtocolFeesWithdrawn(address indexed token, address indexed to, uint256 usdg);

    constructor(address poolManager_, address usdg_, address owner_) Ownable(owner_) {
        require(poolManager_ != address(0), "poolManager=0");
        require(poolManager_.code.length > 0, "poolManager has no code");
        require(usdg_ != address(0), "usdg=0");
        poolManager = IPoolManager(poolManager_);
        USDG = Currency.wrap(usdg_);
    }

    function setFactory(address factory_) external onlyOwner {
        require(factory == address(0), "factory already set");
        require(factory_ != address(0), "factory=0");
        factory = factory_;
    }

    // ---------------------------------------------------------------
    // Launch
    // ---------------------------------------------------------------

    function poolKey(address token) public view returns (PoolKey memory) {
        return PoolKey({
            currency0: USDG,
            currency1: Currency.wrap(token),
            fee: POOL_LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(this))
        });
    }

    /// @notice Creates the pool, opens it at the launch price, and deposits
    /// the whole supply as two single-sided positions. Mechanically identical
    /// to `PoolVault.launch` — see that NatSpec for why single-sided liquidity
    /// is what locks it for free.
    ///
    /// @dev The one real difference from `PoolVault`: currency ordering is no
    /// longer free. `token` must sort above `USDG` for the tick constants
    /// above to mean what they say (USDG as currency0, token as currency1) —
    /// `PoolFactoryUsdg` guarantees this by deploying the token via a salt
    /// mined off-chain for exactly this property, and this `require` is the
    /// on-chain check that the mining actually worked, not a step that's
    /// expected to fail in normal operation.
    function launch(address token, address creator)
        external
        nonReentrant
        returns (PoolId poolId)
    {
        require(msg.sender == factory, "not factory");
        require(launches[token].creator == address(0), "already launched");
        require(creator != address(0), "creator=0");
        require(token != address(0), "token=0");
        require(token > Currency.unwrap(USDG), "token must sort above USDG");
        require(
            IERC20(token).balanceOf(address(this)) >= TOTAL_SUPPLY, "supply not received"
        );

        PoolKey memory key = poolKey(token);
        poolId = key.toId();

        launches[token] = Launch({creator: creator, poolId: poolId, creatorUsdg: 0, protocolUsdg: 0});
        poolTokens[poolId] = token;

        _launching = true;
        int24 openingTick = poolManager.initialize(key, TickMath.getSqrtPriceAtTick(TICK_INIT));
        require(openingTick == TICK_INIT, "pool opened at wrong tick");

        poolManager.unlock(abi.encode(token));
        _launching = false;

        emit Launched(token, creator, poolId);
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "not pool manager");
        address token = abi.decode(data, (address));
        PoolKey memory key = poolKey(token);

        BalanceDelta saleDelta = _addLiquidity(key, TICK_GRADUATION, TICK_INIT, SALE_LIQUIDITY);
        BalanceDelta reserveDelta =
            _addLiquidity(key, TICK_RESERVE_FLOOR, TICK_GRADUATION, RESERVE_LIQUIDITY);

        require(saleDelta.amount0() == 0 && reserveDelta.amount0() == 0, "unexpected USDG owed");

        int128 owed = saleDelta.amount1() + reserveDelta.amount1();
        require(owed < 0, "expected a token debt");
        _settleToken(token, uint256(uint128(-owed)));
        return "";
    }

    function _addLiquidity(PoolKey memory key, int24 lower, int24 upper, uint128 liquidity)
        private
        returns (BalanceDelta callerDelta)
    {
        (callerDelta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: lower,
                tickUpper: upper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );
    }

    function _settleToken(address token, uint256 owed) private {
        poolManager.sync(Currency.wrap(token));
        IERC20(token).safeTransfer(address(poolManager), owed);
        poolManager.settle();
    }

    // ---------------------------------------------------------------
    // Hook — fees, always in USDG. Unchanged from PoolVault: v4's Currency
    // abstraction means `poolManager.take`/`sync`/`settle` behave the same
    // whether the currency is native or an ERC-20, so none of this logic
    // needed to change — only how fees leave the contract, below.
    // ---------------------------------------------------------------

    function _specifiedIsUsdg(SwapParams calldata p) private pure returns (bool) {
        return p.zeroForOne == (p.amountSpecified < 0);
    }

    function _creditFee(address token, uint256 fee) private {
        Launch storage l = launches[token];
        uint256 creatorShare = (fee * CREATOR_FEE_SHARE_BPS) / FEE_DENOMINATOR;
        l.creatorUsdg += creatorShare;
        l.protocolUsdg += fee - creatorShare;
        emit FeeTaken(token, fee);
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        require(msg.sender == address(poolManager), "not pool manager");
        if (!_specifiedIsUsdg(params)) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }
        require(params.amountSpecified < 0, "exact-output sells unsupported");

        address token = Currency.unwrap(key.currency1);
        require(launches[token].creator != address(0), "unknown pool");

        uint256 amountIn = uint256(-params.amountSpecified);
        uint256 fee = (amountIn * SWAP_FEE_BPS) / FEE_DENOMINATOR;
        if (fee == 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        poolManager.take(key.currency0, address(this), fee);
        _creditFee(token, fee);

        return (
            IHooks.beforeSwap.selector,
            toBeforeSwapDelta(int128(int256(fee)), int128(0)),
            0
        );
    }

    function afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external override returns (bytes4, int128) {
        require(msg.sender == address(poolManager), "not pool manager");
        if (_specifiedIsUsdg(params)) return (IHooks.afterSwap.selector, 0);

        address token = Currency.unwrap(key.currency1);
        require(launches[token].creator != address(0), "unknown pool");

        int128 usdgDelta = delta.amount0();
        uint256 gross =
            usdgDelta >= 0 ? uint256(int256(usdgDelta)) : uint256(-int256(usdgDelta));
        uint256 fee = (gross * SWAP_FEE_BPS) / FEE_DENOMINATOR;
        if (fee == 0) return (IHooks.afterSwap.selector, 0);

        poolManager.take(key.currency0, address(this), fee);
        _creditFee(token, fee);

        return (IHooks.afterSwap.selector, int128(int256(fee)));
    }

    function beforeInitialize(address, PoolKey calldata, uint160)
        external
        view
        override
        returns (bytes4)
    {
        require(msg.sender == address(poolManager), "not pool manager");
        require(_launching, "pool not created by this vault");
        return IHooks.beforeInitialize.selector;
    }

    // ---------------------------------------------------------------
    // Fees out — the one real change from PoolVault. USDG is an ERC-20, so
    // fees leave via `safeTransfer` rather than a raw `.call{value: ...}`.
    // ---------------------------------------------------------------

    function claimCreatorFees(address token) external nonReentrant returns (uint256 usdg) {
        Launch storage l = launches[token];
        address creator = l.creator;
        require(msg.sender == creator, "not creator");

        usdg = l.creatorUsdg;
        l.creatorUsdg = 0;
        if (usdg > 0) {
            IERC20(Currency.unwrap(USDG)).safeTransfer(creator, usdg);
        }
        emit CreatorFeesClaimed(token, creator, usdg);
    }

    function withdrawProtocolFees(address token, address to)
        external
        onlyOwner
        nonReentrant
        returns (uint256 usdg)
    {
        require(to != address(0), "to=0");
        Launch storage l = launches[token];

        usdg = l.protocolUsdg;
        l.protocolUsdg = 0;
        if (usdg > 0) {
            IERC20(Currency.unwrap(USDG)).safeTransfer(to, usdg);
        }
        emit ProtocolFeesWithdrawn(token, to, usdg);
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    function creatorOf(address token) external view returns (address) {
        return launches[token].creator;
    }

    // ---------------------------------------------------------------
    // Unused hooks — see PoolVault.sol for why these revert rather than
    // silently succeeding.
    // ---------------------------------------------------------------

    function afterInitialize(address, PoolKey calldata, uint160, int24)
        external
        pure
        override
        returns (bytes4)
    {
        revert("hook not enabled");
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert("hook not enabled");
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert("hook not enabled");
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert("hook not enabled");
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert("hook not enabled");
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert("hook not enabled");
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert("hook not enabled");
    }

    // No function removes liquidity, and there is no rescue hatch for stray
    // tokens — same absence, same reason, as PoolVault.
}
