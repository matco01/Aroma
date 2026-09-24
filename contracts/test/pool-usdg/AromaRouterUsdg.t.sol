// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolVaultUsdg} from "../../src/pool-usdg/PoolVaultUsdg.sol";
import {PoolFactoryUsdg} from "../../src/pool-usdg/PoolFactoryUsdg.sol";
import {AromaRouterUsdg} from "../../src/pool-usdg/AromaRouterUsdg.sol";
import {AromaToken} from "../../src/AromaToken.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";

/// @notice Tests for the USDG router, against Uniswap's real deployed
/// PoolManager. See `AromaRouter.t.sol` for why one-signature trades matter;
/// the difference here is that *both* directions need a permit rather than
/// just sell, since USDG (unlike native USDC) needs an approval to move at
/// all — see `AromaRouterUsdg`'s NatSpec for why that permit exists instead
/// of a plain approve-then-buy.
contract AromaRouterUsdgTest is Test {
    using StateLibrary for IPoolManager;

    address constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    string constant DEFAULT_RPC = "https://eth.drpc.org";
    uint256 constant FORK_BLOCK = 25_900_000;

    uint160 constant REQUIRED_FLAGS =
        uint160((1 << 13) | (1 << 7) | (1 << 6) | (1 << 3) | (1 << 2));
    address constant HOOK_ADDRESS = address((uint160(0x4444) << 144) | REQUIRED_FLAGS);

    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    PoolVaultUsdg vault;
    PoolFactoryUsdg factory;
    AromaRouterUsdg router;
    MockUsdg usdg;

    address owner = makeAddr("owner");
    address creator = makeAddr("creator");

    uint256 traderPk = 0xA11CE;
    address trader;

    address token;
    PoolKey key;

    function setUp() public {
        vm.createSelectFork(vm.envOr("ETH_RPC_URL", string(DEFAULT_RPC)), FORK_BLOCK);
        trader = vm.addr(traderPk);

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
        router = new AromaRouterUsdg(address(vault));

        vm.etch(owner, "");
        vm.etch(creator, "");
        vm.etch(trader, "");

        usdg.mint(trader, 10_000_000e6);
        usdg.mint(creator, 1e6);
        vm.prank(creator);
        usdg.approve(address(factory), type(uint256).max);

        bytes32 salt = _mineTokenSalt("Aroma Coin", "AROMA");
        vm.prank(creator);
        (token,) = factory.createToken(
            PoolFactoryUsdg.TokenInfo({
                name: "Aroma Coin",
                symbol: "AROMA",
                description: "a test coin",
                metadataUri: ""
            }),
            0,
            0,
            salt
        );
        key = vault.poolKey(token);
    }

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

    function _signUsdgPermit(uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        uint256 nonce = IERC20Permit(address(usdg)).nonces(trader);
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, trader, address(router), value, nonce, deadline));
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", IERC20Permit(address(usdg)).DOMAIN_SEPARATOR(), structHash)
        );
        (v, r, s) = vm.sign(traderPk, digest);
    }

    function _signTokenPermit(uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        uint256 nonce = IERC20Permit(token).nonces(trader);
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, trader, address(router), value, nonce, deadline));
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", IERC20Permit(token).DOMAIN_SEPARATOR(), structHash)
        );
        (v, r, s) = vm.sign(traderPk, digest);
    }

    function _buy(uint256 usdgIn) internal returns (uint256 tokensOut) {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signUsdgPermit(usdgIn, deadline);
        vm.prank(trader);
        return router.buy(token, usdgIn, 0, deadline, v, r, s);
    }

    // ---------------------------------------------------------------
    // Buying — one signature, via USDG's own EIP-2612 permit
    // ---------------------------------------------------------------

    function test_buy_deliversTokensToTheBuyer() public {
        uint256 out = _buy(100e6);
        assertGt(out, 0, "no tokens returned");
        assertEq(IERC20(token).balanceOf(trader), out, "tokens did not reach the buyer");
    }

    function test_buy_isOneTransactionWithNoPriorApproval() public {
        assertEq(usdg.allowance(trader, address(router)), 0, "pre-approved");
        _buy(100e6);
        assertGt(IERC20(token).balanceOf(trader), 0);
    }

    function test_buy_movesThePrice() public {
        (, int24 before,,) = IPoolManager(POOL_MANAGER).getSlot0(key.toId());
        _buy(100e6);
        (, int24 afterTick,,) = IPoolManager(POOL_MANAGER).getSlot0(key.toId());
        assertLt(afterTick, before, "price did not move in the buyer's favour");
    }

    function test_buy_enforcesSlippage() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signUsdgPermit(100e6, deadline);
        vm.prank(trader);
        vm.expectRevert("slippage");
        router.buy(token, 100e6, type(uint256).max, deadline, v, r, s);
    }

    function test_buy_rejectsUnknownTokens() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signUsdgPermit(1e6, deadline);
        vm.prank(trader);
        vm.expectRevert("unknown token");
        router.buy(address(0xDEAD), 1e6, 0, deadline, v, r, s);
    }

    function test_buy_survivesAFrontRunPermit() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signUsdgPermit(100e6, deadline);

        vm.prank(makeAddr("griefer"));
        IERC20Permit(address(usdg)).permit(trader, address(router), 100e6, deadline, v, r, s);

        vm.prank(trader);
        uint256 tokensOut = router.buy(token, 100e6, 0, deadline, v, r, s);
        assertGt(tokensOut, 0, "a front-run permit bricked the buy");
    }

    function test_buy_rejectsAnInvalidSignatureWithNoAllowance() public {
        vm.prank(trader);
        vm.expectRevert("permit failed and no allowance");
        router.buy(token, 1e6, 0, block.timestamp + 1 hours, 27, bytes32(0), bytes32(0));
    }

    function test_buy_paysTheHookFee() public {
        _buy(1_000e6);
        (,, uint256 creatorUsdg, uint256 protocolUsdg) = vault.launches(token);
        assertApproxEqRel(creatorUsdg + protocolUsdg, 10e6, 0.01e18, "fee is not ~1%");
    }

    // ---------------------------------------------------------------
    // Selling — unchanged from AromaRouter: still the token's own permit
    // ---------------------------------------------------------------

    function test_sell_isOneTransactionWithNoPriorApproval() public {
        uint256 balance = _buy(1_000e6);
        uint256 amount = balance / 2;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signTokenPermit(amount, deadline);

        assertEq(IERC20(token).allowance(trader, address(router)), 0, "pre-approved");

        uint256 before = usdg.balanceOf(trader);
        vm.prank(trader);
        uint256 usdgOut = router.sell(token, amount, 0, deadline, v, r, s);

        assertGt(usdgOut, 0, "no USDG returned");
        assertEq(usdg.balanceOf(trader) - before, usdgOut, "seller was not paid");
        assertEq(IERC20(token).balanceOf(trader), balance - amount, "tokens not taken");
    }

    function test_sell_enforcesSlippage() public {
        uint256 balance = _buy(1_000e6);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signTokenPermit(balance, deadline);

        vm.prank(trader);
        vm.expectRevert("slippage");
        router.sell(token, balance, type(uint256).max, deadline, v, r, s);
    }

    function test_sell_paysTheHookFeeInUsdg() public {
        uint256 balance = _buy(1_000e6);
        (,, uint256 creatorBefore, uint256 protocolBefore) = vault.launches(token);
        uint256 vaultTokensBefore = IERC20(token).balanceOf(address(vault));

        uint256 amount = balance / 2;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signTokenPermit(amount, deadline);
        vm.prank(trader);
        router.sell(token, amount, 0, deadline, v, r, s);

        (,, uint256 creatorAfter, uint256 protocolAfter) = vault.launches(token);
        assertGt(creatorAfter + protocolAfter, creatorBefore + protocolBefore, "no fee taken");
        assertEq(
            IERC20(token).balanceOf(address(vault)),
            vaultTokensBefore,
            "vault accrued tokens - fees are not USDG-only any more"
        );
    }

    // ---------------------------------------------------------------
    // The router holds nothing
    // ---------------------------------------------------------------

    function test_router_keepsNoBalanceBetweenTrades() public {
        uint256 balance = _buy(1_000e6);
        uint256 amount = balance / 2;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signTokenPermit(amount, deadline);
        vm.prank(trader);
        router.sell(token, amount, 0, deadline, v, r, s);

        assertEq(usdg.balanceOf(address(router)), 0, "router kept USDG");
        assertEq(IERC20(token).balanceOf(address(router)), 0, "router kept tokens");
    }

    // ---------------------------------------------------------------
    // Partial fills — mirrors AromaRouter.t.sol. Without the all-or-nothing
    // check, a buy that drained the pool settled part of usdgIn and left the
    // rest in the router for good.
    // ---------------------------------------------------------------

    function test_buy_thatWouldDrainThePoolRevertsInsteadOfStrandingUsdg() public {
        uint256 before = usdg.balanceOf(trader);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signUsdgPermit(500_000e6, deadline);

        vm.prank(trader);
        vm.expectRevert("insufficient liquidity");
        router.buy(token, 500_000e6, 0, deadline, v, r, s);

        assertEq(usdg.balanceOf(trader), before, "a refused buy cost the trader USDG");
        assertEq(usdg.balanceOf(address(router)), 0, "router kept USDG");
    }

    function test_buy_largeButFillableStillSucceeds() public {
        // Well above any ordinary trade and below the ~$69k the pool can take
        // from launch, so the check refuses only what cannot fill.
        uint256 out = _buy(60_000e6);
        assertGt(out, 0, "a fillable buy was refused");
        assertEq(usdg.balanceOf(address(router)), 0, "router kept USDG");
    }

    function test_sell_thatWouldDrainThePoolRevertsInsteadOfStrandingTokens() public {
        _buy(1_000e6);
        // More tokens than ever left the pool, so selling them needs more USDG
        // than the pool holds.
        uint256 amount = 500_000_000e18;
        deal(token, trader, amount);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signTokenPermit(amount, deadline);

        vm.prank(trader);
        vm.expectRevert("insufficient liquidity");
        router.sell(token, amount, 0, deadline, v, r, s);

        assertEq(IERC20(token).balanceOf(address(router)), 0, "router kept tokens");
    }

    function test_unlockCallback_rejectsCallsThatAreNotFromThePoolManager() public {
        vm.expectRevert("not pool manager");
        router.unlockCallback("");
    }
}
