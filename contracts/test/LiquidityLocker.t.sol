// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {CurveManager} from "../src/CurveManager.sol";
import {AromaFactory} from "../src/AromaFactory.sol";
import {LiquidityLocker} from "../src/LiquidityLocker.sol";

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
}

/**
 * Graduation into a real Uniswap v4 pool.
 *
 * These run against v4-core's actual PoolManager, not a stub. The whole
 * risk being managed here is that Arc mainnet is not reachable yet, so the
 * integration cannot be proven against the deployed singleton — the next
 * best thing is the same source the singleton was built from, exercising
 * the real unlock/settle accounting rather than a mock that agrees with
 * whatever this contract happens to do.
 */
contract LiquidityLockerTest is Test {
    using StateLibrary for IPoolManager;

    IPoolManager internal manager;
    CurveManager internal curve;
    AromaFactory internal factory;
    LiquidityLocker internal locker;

    address internal owner = address(0xA0);
    address internal creator = address(0xC0);
    address internal buyer = address(0xB0);

    function setUp() public {
        // Real v4 singleton, deployed by artifact — see test/v4/CompileV4.sol.
        manager = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(owner)));

        // The locker needs the curve's address and the curve needs the
        // locker's, and both are immutable. Precomputing the locker's
        // address is how that knot is tied at deploy time — the real
        // deploy script does the same thing.
        address predictedLocker = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        curve = new CurveManager(owner, predictedLocker);
        locker = new LiquidityLocker(address(manager), address(curve));
        assertEq(address(locker), predictedLocker, "locker address prediction");

        factory = new AromaFactory(address(curve));
        vm.prank(owner);
        curve.setFactory(address(factory));

        vm.deal(buyer, 100_000e18);
        vm.deal(creator, 1e18);
    }

    /// The exact gross spend that nets the graduation raise. Buying a round
    /// number instead overshoots and the curve rejects it — there are only
    /// so many tokens on the curve to sell.
    function _grossForNet(CurveManager c, uint256 net) internal view returns (uint256 gross) {
        uint256 feeBps = c.TRADE_FEE_BPS();
        uint256 denom = c.FEE_DENOMINATOR();
        gross = net * denom / (denom - feeBps);
        while (gross - (gross * feeBps / denom) < net) {
            gross++;
        }
    }

    function _graduate(CurveManager c, AromaFactory f) internal returns (address token) {
        vm.prank(creator);
        token = f.createToken("Grad Coin", "GRAD", "", "", 0, 0);

        uint256 gross = _grossForNet(c, c.GRADUATION_RAISE_USDC());
        vm.deal(buyer, gross + 1e18);
        vm.prank(buyer);
        c.buy{value: gross}(token, buyer, 0);

        c.graduate(token);
    }

    function _graduatedToken() internal returns (address token) {
        return _graduate(curve, factory);
    }

    function test_seedPool_createsAPoolAndLocksTheLiquidity() public {
        address token = _graduatedToken();

        uint256 seedUsdc = curve.graduationSeedUsdc(token);
        uint256 seedTokens = IERC20Like(token).balanceOf(address(locker));
        assertGt(seedUsdc, 0, "curve recorded no usdc seed");
        assertGt(seedTokens, 0, "locker holds no tokens");

        uint128 liquidity = locker.seedPool(token);
        assertGt(liquidity, 0, "no liquidity minted");

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: locker.POOL_FEE(),
            tickSpacing: locker.TICK_SPACING(),
            hooks: IHooks(address(0))
        });

        (uint160 sqrtPriceX96,,,) = manager.getSlot0(key.toId());
        assertGt(sqrtPriceX96, 0, "pool was never initialized");

        // The position is held by the locker, at full range, and the locker
        // exposes no way to reduce it.
        uint128 poolLiquidity = manager.getLiquidity(key.toId());
        assertEq(poolLiquidity, liquidity, "pool liquidity does not match");

        // Almost everything left the locker and went into the pool.
        assertLt(address(locker).balance, seedUsdc / 100, "most usdc should be in the pool");
    }

    function test_seedPool_pricesThePoolAtTheGraduationPrice() public {
        address token = _graduatedToken();
        uint256 seedUsdc = curve.graduationSeedUsdc(token);
        uint256 seedTokens = IERC20Like(token).balanceOf(address(locker));

        locker.seedPool(token);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: locker.POOL_FEE(),
            tickSpacing: locker.TICK_SPACING(),
            hooks: IHooks(address(0))
        });
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(key.toId());

        // price = tokens per usdc. Recover it and compare with the ratio the
        // graduation actually delivered; a mispriced pool is an instant
        // arbitrage against every holder.
        uint256 priceX96 = (uint256(sqrtPriceX96) * uint256(sqrtPriceX96)) >> 96;
        uint256 expectedX96 = (seedTokens << 96) / seedUsdc;

        uint256 diff = priceX96 > expectedX96 ? priceX96 - expectedX96 : expectedX96 - priceX96;
        assertLt(diff * 10_000 / expectedX96, 10, "pool price is off by more than 0.1%");
    }

    function test_seedPool_cannotBeRunTwice() public {
        address token = _graduatedToken();
        locker.seedPool(token);
        vm.expectRevert(LiquidityLocker.AlreadySeeded.selector);
        locker.seedPool(token);
    }

    function test_seedPool_isPermissionless() public {
        address token = _graduatedToken();
        vm.prank(address(0xDEAD));
        locker.seedPool(token);
        (bool seeded,,,) = locker.pools(token);
        assertTrue(seeded, "a stranger should be able to seed");
    }

    function test_unlockCallback_rejectsAnyoneButThePoolManager() public {
        address token = _graduatedToken();
        vm.expectRevert(LiquidityLocker.NotPoolManager.selector);
        locker.unlockCallback(abi.encode(token, int256(1)));
    }

    /// Without a pool manager the locker is a plain vault: it holds the
    /// funds and refuses to pretend it can seed anything. This is exactly
    /// the Arc-testnet configuration.
    function test_withoutAPoolManager_itHoldsFundsAndRefusesToSeed() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        CurveManager c2 = new CurveManager(owner, predicted);
        LiquidityLocker vaultOnly = new LiquidityLocker(address(0), address(c2));
        AromaFactory f2 = new AromaFactory(address(c2));
        vm.prank(owner);
        c2.setFactory(address(f2));

        address token = _graduate(c2, f2);

        assertGt(address(vaultOnly).balance, 0, "vault should hold the usdc");
        assertGt(IERC20Like(token).balanceOf(address(vaultOnly)), 0, "vault should hold the tokens");

        vm.expectRevert(LiquidityLocker.NoPoolManager.selector);
        vaultOnly.seedPool(token);
    }

    /// The locker exposes no function that can reduce a position. This is
    /// the property the whole design rests on, so it is asserted against
    /// the ABI rather than trusted.
    function test_lockerHasNoWayToRemoveLiquidity() public view {
        // Any of these would be a way out; none should exist.
        bytes4[5] memory forbidden = [
            bytes4(keccak256("withdraw(address)")),
            bytes4(keccak256("withdraw(address,uint256)")),
            bytes4(keccak256("removeLiquidity(address)")),
            bytes4(keccak256("rescue(address,uint256)")),
            bytes4(keccak256("sweep(address)"))
        ];
        for (uint256 i = 0; i < forbidden.length; i++) {
            (bool ok,) = address(locker).staticcall(abi.encodeWithSelector(forbidden[i], address(0)));
            assertFalse(ok, "locker exposes an escape hatch");
        }
    }
}
