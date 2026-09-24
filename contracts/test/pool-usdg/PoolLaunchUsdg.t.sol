// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {PoolVaultUsdg} from "../../src/pool-usdg/PoolVaultUsdg.sol";
import {PoolFactoryUsdg} from "../../src/pool-usdg/PoolFactoryUsdg.sol";
import {AromaToken} from "../../src/AromaToken.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";

/// @notice End-to-end tests for the USDG pool launch mechanism, against
/// Uniswap's real deployed PoolManager on a fork — same rationale as
/// `PoolLaunchTest` (`test/pool/PoolLaunch.t.sol`): a fork exercises the
/// bytecode that's actually running, not a build of source hoped to match
/// it. The fork target is Ethereum mainnet for the same reason that file
/// gives: nothing here depends on which chain the *code* runs on, only that
/// currency0 behaves like a real deployed ERC-20 — which, unlike native USDC,
/// USDG genuinely is even on this fork, since `MockUsdg` is deployed fresh
/// rather than assumed to already exist at some address.
contract PoolLaunchUsdgTest is Test {
    using StateLibrary for IPoolManager;

    address constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    string constant DEFAULT_RPC = "https://eth.drpc.org";
    uint256 constant FORK_BLOCK = 25_900_000;

    uint160 constant REQUIRED_FLAGS = uint160(
        (1 << 13) // beforeInitialize
            | (1 << 7) // beforeSwap
            | (1 << 6) // afterSwap
            | (1 << 3) // beforeSwapReturnDelta
            | (1 << 2) // afterSwapReturnDelta
    );
    address constant HOOK_ADDRESS = address((uint160(0x4444) << 144) | REQUIRED_FLAGS);

    PoolVaultUsdg vault;
    PoolFactoryUsdg factory;
    PoolSwapTest swapRouter;
    MockUsdg usdg;

    address owner = makeAddr("owner");
    address creator = makeAddr("creator");
    address trader = makeAddr("trader");

    function setUp() public {
        vm.createSelectFork(vm.envOr("ETH_RPC_URL", string(DEFAULT_RPC)), FORK_BLOCK);

        usdg = new MockUsdg();

        deployCodeTo(
            "PoolVaultUsdg.sol:PoolVaultUsdg",
            abi.encode(POOL_MANAGER, address(usdg), owner),
            HOOK_ADDRESS
        );
        vault = PoolVaultUsdg(payable(HOOK_ADDRESS));

        factory = new PoolFactoryUsdg(address(vault));
        vm.prank(owner);
        vault.setFactory(address(factory));

        swapRouter = new PoolSwapTest(IPoolManager(POOL_MANAGER));

        vm.etch(owner, "");
        vm.etch(creator, "");
        vm.etch(trader, "");

        usdg.mint(creator, 10_000_000e6);
        usdg.mint(trader, 10_000_000e6);
        vm.prank(creator);
        usdg.approve(address(factory), type(uint256).max);
        vm.prank(trader);
        usdg.approve(address(swapRouter), type(uint256).max);
    }

    /// @dev Mines a CREATE2 salt for `factory` deploying an AromaToken with
    /// the given constructor args, landing above `usdg`'s address — the same
    /// property `DeployPoolUsdg.s.sol`'s off-chain bot is expected to find,
    /// done directly here since tests don't need it to happen off-chain.
    function _mineTokenSalt(string memory name, string memory symbol)
        internal
        view
        returns (bytes32)
    {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(AromaToken).creationCode,
                abi.encode(name, symbol, factory.TOTAL_SUPPLY(), address(vault))
            )
        );
        for (uint256 i = 0; i < 1000; i++) {
            bytes32 salt = bytes32(i);
            address predicted = address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(bytes1(0xff), address(factory), salt, initCodeHash)
                        )
                    )
                )
            );
            if (predicted > address(usdg)) return salt;
        }
        revert("no salt found");
    }

    function _info(string memory name, string memory symbol, string memory description)
        internal
        pure
        returns (PoolFactoryUsdg.TokenInfo memory)
    {
        return PoolFactoryUsdg.TokenInfo({
            name: name,
            symbol: symbol,
            description: description,
            metadataUri: ""
        });
    }

    function _launch() internal returns (address token, PoolKey memory key) {
        bytes32 salt = _mineTokenSalt("Aroma Coin", "AROMA");
        vm.prank(creator);
        (token,) = factory.createToken(_info("Aroma Coin", "AROMA", "a test coin"), 0, 0, salt);
        key = vault.poolKey(token);
    }

    function _launchWithDevBuy(uint256 devBuyUsdc, uint256 minOut)
        internal
        returns (address token, PoolKey memory key)
    {
        bytes32 salt = _mineTokenSalt("Aroma Coin", "AROMA");
        vm.prank(creator);
        (token,) = factory.createToken(
            _info("Aroma Coin", "AROMA", "a test coin"), devBuyUsdc, minOut, salt
        );
        key = vault.poolKey(token);
    }

    function _buy(PoolKey memory key, uint256 usdgIn) internal returns (BalanceDelta) {
        vm.prank(trader);
        return swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(usdgIn),
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

    function test_launch_isEntirelySingleSided() public {
        uint256 baseline = usdg.balanceOf(POOL_MANAGER);
        (address token,) = _launch();
        assertEq(usdg.balanceOf(POOL_MANAGER), baseline, "launch cost the protocol USDG");
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

    function test_launch_requiresTokenAboveUsdg() public {
        // A salt that lands the token *below* USDG must be rejected rather
        // than silently mispricing the pool against inverted tick math.
        bytes32 badSalt;
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(AromaToken).creationCode,
                abi.encode("X", "X", factory.TOTAL_SUPPLY(), address(vault))
            )
        );
        for (uint256 i = 0; i < 1000; i++) {
            bytes32 candidate = bytes32(i);
            address predicted = address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(bytes1(0xff), address(factory), candidate, initCodeHash)
                        )
                    )
                )
            );
            if (predicted < address(usdg)) {
                badSalt = candidate;
                break;
            }
        }
        vm.prank(creator);
        vm.expectRevert("token must sort above USDG");
        factory.createToken(_info("X", "X", ""), 0, 0, badSalt);
    }

    function test_setFactory_isOneShot() public {
        vm.prank(owner);
        vm.expectRevert("factory already set");
        vault.setFactory(address(0xbeef));
    }

    function test_initialize_rejectsPoolsThisVaultDidNotCreate() public {
        PoolKey memory rogue = vault.poolKey(address(0xC0FFEE));
        uint160 sqrtPrice = TickMath.getSqrtPriceAtTick(vault.TICK_INIT());
        vm.expectRevert();
        IPoolManager(POOL_MANAGER).initialize(rogue, sqrtPrice);
    }

    // ---------------------------------------------------------------
    // Dev-buy
    // ---------------------------------------------------------------

    function test_devBuy_deliversTokensInTheLaunchTransaction() public {
        (address token,) = _launchWithDevBuy(250e6, 0);
        assertGt(IERC20(token).balanceOf(creator), 0, "creator got no tokens");
        assertEq(IERC20(token).balanceOf(address(factory)), 0, "factory held tokens");
    }

    function test_devBuy_movesThePriceLikeAnyOtherBuy() public {
        (, PoolKey memory key) = _launchWithDevBuy(250e6, 0);
        assertLt(_tick(key), vault.TICK_INIT(), "dev buy did not move the price");
    }

    function test_devBuy_paysTheSameFeeAsAnyoneElse() public {
        // At the cap exactly, so this also proves the cap itself is fillable.
        (address token,) = _launchWithDevBuy(300e6, 0);
        (,, uint256 creatorUsdg, uint256 protocolUsdg) = vault.launches(token);
        assertApproxEqRel(creatorUsdg + protocolUsdg, 3e6, 0.01e18, "not ~1%");
    }

    function test_devBuy_isCapped() public {
        bytes32 salt = _mineTokenSalt("Aroma Coin", "AROMA");
        vm.prank(creator);
        vm.expectRevert("dev buy exceeds cap");
        // One unit over the 300 USDG cap, not a round number far above it.
        factory.createToken(_info("Aroma Coin", "AROMA", "a test coin"), 300e6 + 1, 0, salt);
    }

    function test_devBuy_pullsExactlyTheDevBuyAmount() public {
        uint256 before = usdg.balanceOf(creator);
        _launchWithDevBuy(250e6, 0);
        // No overpayment/refund case in the USDG version: only what's spent
        // is ever pulled.
        assertEq(before - usdg.balanceOf(creator), 250e6, "pulled the wrong amount");
    }

    function test_devBuy_respectsSlippage() public {
        bytes32 salt = _mineTokenSalt("Aroma Coin", "AROMA");
        vm.prank(creator);
        vm.expectRevert("dev buy slippage");
        factory.createToken(_info("Aroma Coin", "AROMA", "c"), 250e6, type(uint256).max, salt);
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

        _buy(key, 100e6);

        assertGt(IERC20(token).balanceOf(trader), 0, "trader received no tokens");
        assertLt(_tick(key), before, "price did not move in the buyer's favour");
    }

    function test_graduation_raisesTheExpectedAmount() public {
        uint256 baseline = usdg.balanceOf(POOL_MANAGER);
        (, PoolKey memory key) = _launch();

        for (uint256 i = 0; i < 12; i++) {
            if (_tick(key) <= vault.TICK_GRADUATION()) break;
            _buy(key, 2_000e6);
        }

        assertLe(_tick(key), vault.TICK_GRADUATION(), "did not reach graduation");
        uint256 raised = usdg.balanceOf(POOL_MANAGER) - baseline;
        assertApproxEqRel(raised, 13_800.65e6, 0.03e18, "raise is off target");
        console.log("raised (6dp):", raised);
    }

    function test_pricePastGraduationIsStillTradeable() public {
        (, PoolKey memory key) = _launch();
        for (uint256 i = 0; i < 12; i++) {
            if (_tick(key) <= vault.TICK_GRADUATION()) break;
            _buy(key, 2_000e6);
        }
        uint256 held = usdg.balanceOf(POOL_MANAGER);

        _buy(key, 500e6);
        assertGt(usdg.balanceOf(POOL_MANAGER), held, "no liquidity above graduation");
    }

    // ---------------------------------------------------------------
    // Fees
    // ---------------------------------------------------------------

    function test_fees_onABuyAreTakenInUsdg() public {
        (address token, PoolKey memory key) = _launch();
        _buy(key, 10_000e6);

        (,, uint256 creatorUsdg, uint256 protocolUsdg) = vault.launches(token);
        uint256 total = creatorUsdg + protocolUsdg;

        assertApproxEqRel(total, 100e6, 0.01e18, "fee is not ~1% of volume");
        assertEq(usdg.balanceOf(address(vault)), total, "fee not actually held as USDG");
        assertEq(creatorUsdg, (total * 7000) / 10000, "creator share is not 70%");
    }

    function test_fees_onASellAreAlsoTakenInUsdg_noTokensSold() public {
        (address token, PoolKey memory key) = _launch();
        _buy(key, 10_000e6);

        (,, uint256 creatorBefore, uint256 protocolBefore) = vault.launches(token);
        uint256 feesBefore = creatorBefore + protocolBefore;
        uint256 vaultTokensBefore = IERC20(token).balanceOf(address(vault));

        _sell(key, token, IERC20(token).balanceOf(trader) / 2);

        (,, uint256 creatorAfter, uint256 protocolAfter) = vault.launches(token);
        uint256 feesAfter = creatorAfter + protocolAfter;

        assertGt(feesAfter, feesBefore, "a sell produced no USDG fee");
        assertEq(usdg.balanceOf(address(vault)), feesAfter, "sell fee not held as USDG");
        assertEq(
            IERC20(token).balanceOf(address(vault)),
            vaultTokensBefore,
            "vault accrued tokens - the v3 problem is back"
        );
    }

    function test_fees_creatorClaimsInUsdg() public {
        (address token, PoolKey memory key) = _launch();
        _buy(key, 10_000e6);

        vm.prank(trader);
        vm.expectRevert("not creator");
        vault.claimCreatorFees(token);

        uint256 before = usdg.balanceOf(creator);
        vm.prank(creator);
        uint256 paid = vault.claimCreatorFees(token);
        assertGt(paid, 0);
        assertEq(usdg.balanceOf(creator) - before, paid, "creator was not paid in USDG");
    }

    function test_fees_onlyOwnerWithdrawsProtocolShare() public {
        (address token, PoolKey memory key) = _launch();
        _buy(key, 10_000e6);

        vm.prank(creator);
        vm.expectRevert();
        vault.withdrawProtocolFees(token, creator);

        vm.prank(owner);
        uint256 paid = vault.withdrawProtocolFees(token, owner);
        assertGt(paid, 0);
        assertEq(usdg.balanceOf(owner), paid);
    }

    function test_fees_claimingTwiceYieldsNothingTheSecondTime() public {
        (address token, PoolKey memory key) = _launch();
        _buy(key, 10_000e6);

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
            SwapParams({zeroForOne: true, amountSpecified: -1e6, sqrtPriceLimitX96: 0}),
            ""
        );
    }
}
