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

/// @title PoolVault
/// @notice Aroma's bonding curve, expressed as Uniswap v4 liquidity.
///
/// The equivalence to CurveManager is arithmetic, not analogy. A v4 position
/// over [Pa, Pb] satisfies
///
///     (x + L/sqrt(Pb)) * (y + L*sqrt(Pa)) = L^2
///
/// which is constant-product with virtual reserves — the form CurveManager
/// implements directly. Both price a launch identically. They differ in who
/// holds the reserves, and therefore in whether anyone outside Aroma can see
/// the trades: a coin inside CurveManager is invisible to every screener on
/// the market, because CurveManager is not an AMM anyone has an adapter for.
/// A coin in a real v4 pool is indexed from its first block.
///
/// This contract is also the pool's hook, and that is the whole reason the
/// system is on v4 rather than v3. In v3 the pool takes its fee from each
/// swap's *input*, so a creator earns USDC on buys and their own token on
/// sells, and the only ways to pay them pure USDC are to sell those tokens
/// into their own pool or to charge the fee in a router anyone can route
/// around. A hook can take the fee from whichever side is USDC — the input
/// on a buy, the output on a sell — so every fee is USDC, no token is ever
/// sold, and the charge cannot be avoided because it lives in the pool.
///
/// @dev One shared contract for every launch, matching CurveManager's
/// reasoning: cheaper per launch, one audit surface rather than N. It owns
/// every position it creates, which is what locks the liquidity — v4
/// positions are keyed by owner, this contract is the owner, and it has no
/// function that removes liquidity. Only fees can leave.
///
/// The pool's own LP fee is zero. All revenue arrives through the hook, in
/// USDC, so no fee ever accrues to the position in mixed currencies.
contract PoolVault is IHooks, IUnlockCallback, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    // ---------------------------------------------------------------
    // Curve geometry — derived by script/math/derive_pool.py.
    //
    // Re-run that script if any of this changes; the constants are
    // consequences of the tick choices, not independent knobs.
    //
    // v4 lets a pool choose its own tick spacing, which is worth more here
    // than it looks. On v3 the 1% tier forces spacing 200, and the nearest
    // usable ticks moved the opening cap to $4,256.86 and graduation to
    // $69,992.74. At spacing 2 the same curve lands on:
    //
    //   tick 123,546 -> $4,312.55 opening cap   (target $4,312.50)
    //   tick  95,818 -> $69,005.73 closing cap  (target $69,000)
    //   800M across that span raises $13,800.65 (target $13,800)
    //
    // Every figure within 0.01% of the number the product already promises.
    //
    // The other v4 difference is decimals. USDC is the *native* currency
    // here, address zero, at Arc's 18-decimal native view — not the
    // 6-decimal ERC-20 interface v3 would have forced. The 10^12 gap that
    // dominated the v3 ticks is simply gone, which is why these ticks are
    // ~276,310 away from that version's.
    // ---------------------------------------------------------------

    /// @dev Native USDC. On Arc the gas token *is* USDC, and v4 addresses
    /// native currency as zero, so the pair needs no wrapper and no
    /// 6-vs-18-decimal conversion anywhere in this contract.
    Currency public constant USDC = Currency.wrap(address(0));

    int24 public constant TICK_SPACING = 2;
    int24 public constant TICK_INIT = 123_546;
    int24 public constant TICK_GRADUATION = 95_818;
    /// @dev Bottom of the reserve position: a further 16x above the
    /// graduation price, mirroring the 16x the sale spans. Tops out near a
    /// $1.10M market cap.
    int24 public constant TICK_RESERVE_FLOOR = 68_090;

    /// @dev The pool charges nothing itself; the hook charges everything.
    /// A non-zero LP fee here would reintroduce exactly the mixed-currency
    /// accrual this design exists to avoid.
    uint24 public constant POOL_LP_FEE = 0;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    /// @dev Liquidity for the 800M sale position across
    /// [TICK_GRADUATION, TICK_INIT] and the 200M reserve across
    /// [TICK_RESERVE_FLOOR, TICK_GRADUATION]. Both rounded down, and the
    /// reserve shaded by a further 1e9, because the pool rounds the amount
    /// it asks for *up* and the two positions together must not exceed a
    /// fixed supply. The margin costs ~9e-8 of one token.
    uint128 public constant SALE_LIQUIDITY = 2215084467296721841999892;
    uint128 public constant RESERVE_LIQUIDITY = 2215164928381102038775570;

    /// @dev 1%, matching CurveManager's rate, charged by the hook.
    uint256 public constant SWAP_FEE_BPS = 100;
    /// @dev The creator's share of it — the same 70/30 CurveManager applies,
    /// so a creator's economics do not change with the venue.
    uint256 public constant CREATOR_FEE_SHARE_BPS = 7_000;
    uint256 public constant FEE_DENOMINATOR = 10_000;

    // ---------------------------------------------------------------
    // State
    // ---------------------------------------------------------------

    IPoolManager public immutable poolManager;

    /// @dev Set once after deployment. PoolFactory needs this contract's
    /// address in its constructor, so the two cannot both learn each
    /// other's at construction — the same bootstrap CurveManager uses.
    address public factory;

    struct Launch {
        address creator;
        PoolId poolId;
        /// Settled at the moment each fee is taken, so a later change to the
        /// split cannot repartition fees already earned. Both in USDC —
        /// that is the point of the hook.
        uint256 creatorUsdc;
        uint256 protocolUsdc;
    }

    mapping(address token => Launch) public launches;
    mapping(PoolId poolId => address token) public poolTokens;

    /// @dev Open only for the duration of our own launch call. Without it
    /// anyone could initialize a pool naming this contract as its hook, and
    /// its swaps would run fee logic against a launch that does not exist.
    bool private _launching;

    event Launched(address indexed token, address indexed creator, PoolId poolId);
    event FeeTaken(address indexed token, uint256 usdc);
    event CreatorFeesClaimed(address indexed token, address indexed creator, uint256 usdc);
    event ProtocolFeesWithdrawn(address indexed token, address indexed to, uint256 usdc);

    constructor(address poolManager_, address owner_) Ownable(owner_) {
        require(poolManager_ != address(0), "poolManager=0");
        require(poolManager_.code.length > 0, "poolManager has no code");
        poolManager = IPoolManager(poolManager_);
    }

    /// @dev Native USDC arrives here whenever the hook takes a fee.
    receive() external payable {}

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
            currency0: USDC,
            currency1: Currency.wrap(token),
            fee: POOL_LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(this))
        });
    }

    /// @notice Creates the pool, opens it at the launch price, and deposits
    /// the whole supply as two single-sided positions.
    ///
    /// @dev Single-sided is what makes this cost the protocol nothing. A
    /// position whose range sits entirely above the current price consists
    /// of only the token, so it can be funded in tokens alone with no USDC.
    /// Buyers walk the price into it and USDC accumulates as they do; since
    /// this contract cannot remove liquidity, that USDC stays.
    ///
    /// Currency ordering needs no address mining, unlike the v3 version:
    /// native USDC is address zero and therefore always sorts first, so the
    /// token is always currency1 and the tick constants can only mean one
    /// thing.
    function launch(address token, address creator)
        external
        nonReentrant
        returns (PoolId poolId)
    {
        require(msg.sender == factory, "not factory");
        require(launches[token].creator == address(0), "already launched");
        require(creator != address(0), "creator=0");
        require(token != address(0), "token=0");
        require(
            IERC20(token).balanceOf(address(this)) >= TOTAL_SUPPLY, "supply not received"
        );

        PoolKey memory key = poolKey(token);
        poolId = key.toId();

        launches[token] = Launch({creator: creator, poolId: poolId, creatorUsdc: 0, protocolUsdc: 0});
        poolTokens[poolId] = token;

        _launching = true;
        // TickMath rather than a hardcoded sqrt price. The v3 version of
        // this contract carried the value as a constant and opened its
        // pools one tick low, because Uniswap's own getSqrtPriceAtTick
        // drifts ~1e-9 above the exact ratio at large ticks. Asking the
        // library removes the whole class of error.
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

        // The sale: 800M across the 16x from opening to graduation price.
        BalanceDelta saleDelta = _addLiquidity(key, TICK_GRADUATION, TICK_INIT, SALE_LIQUIDITY);
        // The reserve: 200M continuing above graduation. In the curve system
        // this 20% was held back to be the token side of a pool seeded at
        // graduation; there is no seeding step here, so instead of deleting
        // it, it extends the curve — depth past graduation, earning fees,
        // never migrating.
        BalanceDelta reserveDelta =
            _addLiquidity(key, TICK_RESERVE_FLOOR, TICK_GRADUATION, RESERVE_LIQUIDITY);

        // Both ranges sit above the opening price, so they are funded in the
        // token alone. A non-zero USDC debt would mean a tick constant is
        // wrong, and paying it is strictly worse than reverting.
        require(saleDelta.amount0() == 0 && reserveDelta.amount0() == 0, "unexpected USDC owed");

        // Settle exactly what is owed, not the whole balance. Overpaying is
        // not generous here, it is a non-zero credit, and the manager treats
        // any unsettled delta — either sign — as a failure. The remainder
        // stays here as dust, which is what the liquidity margins leave room
        // for.
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
    // Hook — fees, always in USDC
    // ---------------------------------------------------------------
    //
    // v4 gives a hook two places to alter a swap's accounting: beforeSwap
    // can move the *specified* currency, afterSwap the *unspecified* one.
    // With two currencies, exactly one of those is USDC on any given swap,
    // so the rule is simply "whichever hook can reach USDC, charges".
    //
    //   buy,  exact input  -> specified is USDC -> beforeSwap
    //   buy,  exact output -> unspecified is USDC -> afterSwap
    //   sell, exact input  -> unspecified is USDC -> afterSwap
    //   sell, exact output -> specified is USDC -> beforeSwap
    //
    // The first three are implemented. The fourth — "give me exactly N USDC
    // for however many tokens that takes" — is refused rather than
    // approximated: charging on an exact-output *specified* amount means
    // handing the swapper less than the exact amount they asked for, which
    // is not what exact-output means. It is a rare shape for a launchpad
    // trade, and a wrong implementation would be worse than an honest
    // refusal. Every ordinary buy and sell is covered.

    function _specifiedIsUsdc(SwapParams calldata p) private pure returns (bool) {
        // exact input spends the input currency; exact output names the
        // output. Buying spends USDC, selling receives it — so the
        // specified currency is USDC exactly when those agree.
        return p.zeroForOne == (p.amountSpecified < 0);
    }

    function _creditFee(address token, uint256 fee) private {
        Launch storage l = launches[token];
        uint256 creatorShare = (fee * CREATOR_FEE_SHARE_BPS) / FEE_DENOMINATOR;
        l.creatorUsdc += creatorShare;
        // Remainder, not a second percentage, so integer division cannot
        // strand a wei nobody can claim.
        l.protocolUsdc += fee - creatorShare;
        emit FeeTaken(token, fee);
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        require(msg.sender == address(poolManager), "not pool manager");
        if (!_specifiedIsUsdc(params)) {
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

        // Take the USDC out of the swap, then tell the manager the hook
        // consumed that much of the specified currency. The swap proceeds on
        // what is left, so the buyer's fee comes off the top exactly as it
        // does in CurveManager.
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
        if (_specifiedIsUsdc(params)) return (IHooks.afterSwap.selector, 0);

        address token = Currency.unwrap(key.currency1);
        require(launches[token].creator != address(0), "unknown pool");

        // currency0 is USDC and is the unspecified side here. Positive means
        // the swapper is owed it (a sell); negative means they owe it (an
        // exact-output buy). Either way the fee is a slice of that amount.
        int128 usdcDelta = delta.amount0();
        uint256 gross =
            usdcDelta >= 0 ? uint256(int256(usdcDelta)) : uint256(-int256(usdcDelta));
        uint256 fee = (gross * SWAP_FEE_BPS) / FEE_DENOMINATOR;
        if (fee == 0) return (IHooks.afterSwap.selector, 0);

        poolManager.take(key.currency0, address(this), fee);
        _creditFee(token, fee);

        // Positive: the hook took this much of the unspecified currency. On
        // a sell it comes out of the seller's proceeds; on an exact-output
        // buy it is added to what the buyer pays. No token is ever sold.
        return (IHooks.afterSwap.selector, int128(int256(fee)));
    }

    /// @dev Refuses a pool that names this contract as its hook but was not
    /// created by `launch`. Such a pool would run the fee logic above
    /// against a launch that does not exist.
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
    // Fees out
    // ---------------------------------------------------------------

    function claimCreatorFees(address token) external nonReentrant returns (uint256 usdc) {
        Launch storage l = launches[token];
        address creator = l.creator;
        require(msg.sender == creator, "not creator");

        usdc = l.creatorUsdc;
        l.creatorUsdc = 0;
        if (usdc > 0) {
            (bool ok,) = creator.call{value: usdc}("");
            require(ok, "USDC transfer failed");
        }
        emit CreatorFeesClaimed(token, creator, usdc);
    }

    function withdrawProtocolFees(address token, address to)
        external
        onlyOwner
        nonReentrant
        returns (uint256 usdc)
    {
        require(to != address(0), "to=0");
        Launch storage l = launches[token];

        usdc = l.protocolUsdc;
        l.protocolUsdc = 0;
        if (usdc > 0) {
            (bool ok,) = to.call{value: usdc}("");
            require(ok, "USDC transfer failed");
        }
        emit ProtocolFeesWithdrawn(token, to, usdc);
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    function creatorOf(address token) external view returns (address) {
        return launches[token].creator;
    }

    // ---------------------------------------------------------------
    // Unused hooks
    //
    // The permission bits encoded in this contract's address say which of
    // these the manager may call, and it calls no others — but IHooks
    // requires the full surface, so the rest revert rather than silently
    // succeeding if the address is ever mined wrong.
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

    // There is deliberately no function that removes liquidity, and no
    // rescue hatch for stray tokens. The absence is the product: it is what
    // lets a launch claim its liquidity is locked without asking anyone to
    // trust an owner key.
}
