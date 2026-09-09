// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {PoolVault} from "../../src/pool/PoolVault.sol";
import {PoolFactory} from "../../src/pool/PoolFactory.sol";

/// @notice End-to-end tests for the v4 pool launch mechanism, against
/// Uniswap's real deployed PoolManager on a fork.
///
/// A fork rather than a local deployment because it exercises the bytecode
/// that is actually running, not a build of source we hope matches it. That
/// is `test/v4/CompileV4.sol`'s argument about mocks carried one step
/// further, and the lesson of the `v4-core` pin the README documents, where
/// what the code had been tested against could not be identified afterwards.
///
/// @dev Ethereum mainnet is the fork target only because v4 is deployed
/// there and no public Arc mainnet RPC exists yet. Nothing here is
/// Ethereum-specific — and the substitution is exact rather than
/// approximate, because the only thing that matters about currency0 is that
/// it is the chain's native asset at 18 decimals. On Ethereum that is ETH;
/// on Arc it is USDC. Point ETH_RPC_URL at Arc once you have an endpoint.
contract PoolLaunchTest is Test {
    using StateLibrary for IPoolManager;

    address constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    /// @dev Needs archive state, since the fork block below is pinned.
    /// Most free endpoints serve only recent state and fail with
    /// "state at block N is pruned".
    string constant DEFAULT_RPC = "https://eth.drpc.org";
    /// @dev Pinned rather than following head. A public node will drop a
    /// block out from under a fork mid-run, and an unpinned fork also
    /// re-fetches state on every invocation instead of using the cache.
    uint256 constant FORK_BLOCK = 25_900_000;

    /// @dev The permission bits PoolVault implements. v4 reads these off the
    /// hook's own address, so the vault cannot live just anywhere — in
    /// production DeployPool.s.sol mines a CREATE2 salt for them; here the
    /// address is chosen directly and the code etched into it.
    uint160 constant REQUIRED_FLAGS = uint160(
        (1 << 13) // beforeInitialize
            | (1 << 7) // beforeSwap
            | (1 << 6) // afterSwap
            | (1 << 3) // beforeSwapReturnDelta
            | (1 << 2) // afterSwapReturnDelta
    );
    address constant HOOK_ADDRESS = address((uint160(0x4444) << 144) | REQUIRED_FLAGS);

    PoolVault vault;
    PoolFactory factory;
    PoolSwapTest swapRouter;

    address owner = makeAddr("owner");
    address creator = makeAddr("creator");
    address trader = makeAddr("trader");

    function setUp() public {
        vm.createSelectFork(vm.envOr("ETH_RPC_URL", string(DEFAULT_RPC)), FORK_BLOCK);

        deployCodeTo("PoolVault.sol:PoolVault", abi.encode(POOL_MANAGER, owner), HOOK_ADDRESS);
        vault = PoolVault(payable(HOOK_ADDRESS));

        factory = new PoolFactory(address(vault));
        vm.prank(owner);
        vault.setFactory(address(factory));

        swapRouter = new PoolSwapTest(IPoolManager(POOL_MANAGER));

        // makeAddr derives addresses deterministically, and on a mainnet
        // fork one of them can already hold a real contract - `owner`
        // landed on one that forwards every ether it receives. Clear them
        // so they behave as the plain EOAs these tests assume.
        vm.etch(owner, "");
        vm.etch(creator, "");
        vm.etch(trader, "");

        vm.deal(trader, 10_000_000 ether);
        vm.deal(creator, 10_000 ether);
        vm.deal(owner, 0);
    }

    function _launch() internal returns (address token, PoolKey memory key) {
        vm.prank(creator);
        (token,) = factory.createToken("Aroma Coin", "AROMA", "a test coin", "", 0, 0);
        key = vault.poolKey(token);
    }

    function _launchWithDevBuy(uint256 usdc, uint256 minOut)
        internal
        returns (address token, PoolKey memory key)
    {
        vm.prank(creator);
        (token,) = factory.createToken{value: usdc}(
            "Aroma Coin", "AROMA", "a test coin", "", usdc, minOut
        );
        key = vault.poolKey(token);
    }

    function _buy(PoolKey memory key, uint256 usdcIn) internal returns (BalanceDelta) {
        vm.prank(trader);
        return swapRouter.swap{value: usdcIn}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(usdcIn),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _sell(PoolKey memory key, address token, uint256 tokensIn)
        internal
        returns (BalanceDelta)
    {
        vm.prank(trader);
        IERC20(token).approve(address(swapRouter), type(uint256).max);
        vm.prank(trader);
        return swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: false,
                amountSpecified: -int256(tokensIn),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _tick(PoolKey memory key) internal view returns (int24 tick) {
        (, tick,,) = IPoolManager(POOL_MANAGER).getSlot0(key.toId());
    }

    // ---------------------------------------------------------------
    // Launch
    // ---------------------------------------------------------------

    function test_launch_opensAtTheIntendedTick() public {
        (, PoolKey memory key) = _launch();
        assertEq(_tick(key), vault.TICK_INIT(), "pool opened at the wrong tick");
    }

    /// @dev The claim the whole design rests on: launching costs the protocol
    /// no USDC at all.
    function test_launch_isEntirelySingleSided() public {
        // The forked manager already custodies every real v4 pool's balance,
        // so the claim is that launching adds nothing to it, not that it is
        // empty.
        uint256 baseline = POOL_MANAGER.balance;
        (address token,) = _launch();
        assertEq(POOL_MANAGER.balance, baseline, "launch cost the protocol USDC");
        assertGt(IERC20(token).balanceOf(POOL_MANAGER), 999_000_000e18, "supply not deposited");
    }

    function test_launch_leavesEssentiallyNoDust() public {
        (address token,) = _launch();
        assertLt(IERC20(token).balanceOf(address(vault)), 1e18, "more than one token undeposited");
    }

    function test_launch_recordsCreator() public {
        (address token,) = _launch();
        assertEq(vault.creatorOf(token), creator);
    }

    function test_launch_onlyFactoryMayCall() public {
        vm.expectRevert("not factory");
        vault.launch(address(0xdead), creator);
    }

    function test_setFactory_isOneShot() public {
        vm.prank(owner);
        vm.expectRevert("factory already set");
        vault.setFactory(address(0xbeef));
    }

    /// @dev Anyone can name this contract as their pool's hook. If that pool
    /// were allowed to exist, its swaps would run the fee logic against a
    /// launch that does not exist.
    function test_initialize_rejectsPoolsThisVaultDidNotCreate() public {
        PoolKey memory rogue = vault.poolKey(address(0xC0FFEE));
        // Resolved before arming expectRevert: reading TICK_INIT is itself an
        // external call, and it would otherwise be the "next call" that is
        // expected to revert.
        uint160 sqrtPrice = TickMath.getSqrtPriceAtTick(vault.TICK_INIT());
        vm.expectRevert();
        IPoolManager(POOL_MANAGER).initialize(rogue, sqrtPrice);
    }

    // ---------------------------------------------------------------
    // Dev-buy
    //
    // The creator's first buy has to be in the same transaction as the
    // launch. A separate transaction, even in the same block, is front-
    // runnable by anyone watching the mempool — and with no snipe guard yet
    // there is nothing else standing between a creator and a sniper.
    // ---------------------------------------------------------------

    function test_devBuy_deliversTokensInTheLaunchTransaction() public {
        (address token,) = _launchWithDevBuy(500 ether, 0);
        assertGt(IERC20(token).balanceOf(creator), 0, "creator got no tokens");
        // Straight to the creator, never parked in the factory.
        assertEq(IERC20(token).balanceOf(address(factory)), 0, "factory held tokens");
    }

    function test_devBuy_movesThePriceLikeAnyOtherBuy() public {
        (, PoolKey memory key) = _launchWithDevBuy(500 ether, 0);
        assertLt(_tick(key), vault.TICK_INIT(), "dev buy did not move the price");
    }

    function test_devBuy_paysTheSameFeeAsAnyoneElse() public {
        (address token,) = _launchWithDevBuy(1_000 ether, 0);
        (,, uint256 creatorUsdc, uint256 protocolUsdc) = vault.launches(token);
        // 1% of 1,000, split 70/30 — the creator is not exempt from the fee
        // on their own coin, they just receive most of it back.
        assertApproxEqRel(creatorUsdc + protocolUsdc, 10 ether, 0.01e18, "not ~1%");
    }

    function test_devBuy_isCapped() public {
        vm.prank(creator);
        vm.expectRevert("dev buy exceeds cap");
        factory.createToken{value: 3_000 ether}(
            "Aroma Coin", "AROMA", "a test coin", "", 3_000 ether, 0
        );
    }

    function test_devBuy_refundsTheUnspentRemainder() public {
        uint256 before = creator.balance;
        vm.prank(creator);
        factory.createToken{value: 900 ether}("Aroma Coin", "AROMA", "c", "", 500 ether, 0);
        // Sent 900, spent 500 — the other 400 comes back rather than being
        // stranded in a contract with no withdraw function.
        assertEq(before - creator.balance, 500 ether, "refund is wrong");
    }

    function test_devBuy_respectsSlippage() public {
        vm.prank(creator);
        vm.expectRevert("dev buy slippage");
        factory.createToken{value: 500 ether}(
            "Aroma Coin", "AROMA", "c", "", 500 ether, type(uint256).max
        );
    }

    function test_devBuy_zeroSkipsIt() public {
        (address token,) = _launch();
        assertEq(IERC20(token).balanceOf(creator), 0, "bought without asking");
    }

    // ---------------------------------------------------------------
    // Trading
    // ---------------------------------------------------------------

    function test_buy_movesPriceUpAndDeliversTokens() public {
        (address token, PoolKey memory key) = _launch();
        int24 before = _tick(key);

        _buy(key, 100 ether);

        assertGt(IERC20(token).balanceOf(trader), 0, "trader received no tokens");
        // The token appreciating moves the tick down: the pair quotes
        // tokens-per-USDC, because native USDC sorts first as currency0.
        // This is the assertion that would catch an inverted pair.
        assertLt(_tick(key), before, "price did not move in the buyer's favour");
    }

    function test_graduation_raisesTheExpectedAmount() public {
        uint256 baseline = POOL_MANAGER.balance;
        (, PoolKey memory key) = _launch();

        // Walk the price all the way to the graduation tick.
        for (uint256 i = 0; i < 12; i++) {
            if (_tick(key) <= vault.TICK_GRADUATION()) break;
            _buy(key, 2_000 ether);
        }

        assertLe(_tick(key), vault.TICK_GRADUATION(), "did not reach graduation");
        uint256 raised = POOL_MANAGER.balance - baseline;
        // $13,800.65 by derivation, before the 1% the hook takes off the top.
        assertApproxEqRel(raised, 13_800.65 ether, 0.03e18, "raise is off target");
        console.log("raised (18dp):", raised);
    }

    function test_pricePastGraduationIsStillTradeable() public {
        (, PoolKey memory key) = _launch();
        for (uint256 i = 0; i < 12; i++) {
            if (_tick(key) <= vault.TICK_GRADUATION()) break;
            _buy(key, 2_000 ether);
        }
        uint256 held = POOL_MANAGER.balance;  // delta comparison below

        // Only the reserve position makes this possible. Without it the pool
        // would be empty above graduation.
        _buy(key, 500 ether);
        assertGt(POOL_MANAGER.balance, held, "no liquidity above graduation");
    }

    // ---------------------------------------------------------------
    // Fees — the reason this is on v4
    // ---------------------------------------------------------------

    function test_fees_onABuyAreTakenInUsdc() public {
        (address token, PoolKey memory key) = _launch();
        _buy(key, 10_000 ether);

        (,, uint256 creatorUsdc, uint256 protocolUsdc) = vault.launches(token);
        uint256 total = creatorUsdc + protocolUsdc;

        assertApproxEqRel(total, 100 ether, 0.01e18, "fee is not ~1% of volume");
        assertEq(address(vault).balance, total, "fee not actually held as native USDC");
        assertEq(creatorUsdc, (total * 7000) / 10000, "creator share is not 70%");
    }

    /// @dev The whole point of the v4 pivot. On v3 this fee would arrive as
    /// the creator's own token, and paying it out in USDC would have meant
    /// selling those tokens into this very pool.
    function test_fees_onASellAreAlsoTakenInUsdc_noTokensSold() public {
        (address token, PoolKey memory key) = _launch();
        _buy(key, 10_000 ether);

        (,, uint256 creatorBefore, uint256 protocolBefore) = vault.launches(token);
        uint256 feesBefore = creatorBefore + protocolBefore;
        uint256 vaultTokensBefore = IERC20(token).balanceOf(address(vault));

        _sell(key, token, IERC20(token).balanceOf(trader) / 2);

        (,, uint256 creatorAfter, uint256 protocolAfter) = vault.launches(token);
        uint256 feesAfter = creatorAfter + protocolAfter;

        assertGt(feesAfter, feesBefore, "a sell produced no USDC fee");
        assertEq(address(vault).balance, feesAfter, "sell fee not held as native USDC");
        // The vault's token balance must not grow: no fee arrived in tokens,
        // so nothing ever has to be sold to pay a creator.
        assertEq(
            IERC20(token).balanceOf(address(vault)),
            vaultTokensBefore,
            "vault accrued tokens - the v3 problem is back"
        );
    }

    function test_fees_creatorClaimsInUsdc() public {
        (address token, PoolKey memory key) = _launch();
        _buy(key, 10_000 ether);

        vm.prank(trader);
        vm.expectRevert("not creator");
        vault.claimCreatorFees(token);

        uint256 before = creator.balance;
        vm.prank(creator);
        uint256 paid = vault.claimCreatorFees(token);
        assertGt(paid, 0);
        assertEq(creator.balance - before, paid, "creator was not paid in USDC");
    }

    function test_fees_onlyOwnerWithdrawsProtocolShare() public {
        (address token, PoolKey memory key) = _launch();
        _buy(key, 10_000 ether);

        vm.prank(creator);
        vm.expectRevert();
        vault.withdrawProtocolFees(token, creator);

        vm.prank(owner);
        uint256 paid = vault.withdrawProtocolFees(token, owner);
        assertGt(paid, 0);
        assertEq(owner.balance, paid);
    }

    function test_fees_claimingTwiceYieldsNothingTheSecondTime() public {
        (address token, PoolKey memory key) = _launch();
        _buy(key, 10_000 ether);

        vm.prank(creator);
        vault.claimCreatorFees(token);
        vm.prank(creator);
        assertEq(vault.claimCreatorFees(token), 0);
    }

    function test_hook_rejectsCallsThatAreNotFromThePoolManager() public {
        (, PoolKey memory key) = _launch();
        vm.expectRevert("not pool manager");
        vault.beforeSwap(
            address(this),
            key,
            SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: 0}),
            ""
        );
    }
}
