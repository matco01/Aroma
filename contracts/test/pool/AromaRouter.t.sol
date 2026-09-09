// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolVault} from "../../src/pool/PoolVault.sol";
import {PoolFactory} from "../../src/pool/PoolFactory.sol";
import {AromaRouter} from "../../src/pool/AromaRouter.sol";

/// @notice Tests for the router, against Uniswap's real deployed PoolManager.
///
/// The point of this contract is that a sell stays *one* signed transaction.
/// Uniswap's own router would route ERC-20s through Permit2, a second
/// approval system, and turn every sell into approve-then-sell — worse than
/// the curve product it replaces. The permit tests below are the ones that
/// prove that did not happen.
contract AromaRouterTest is Test {
    using StateLibrary for IPoolManager;

    address constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    string constant DEFAULT_RPC = "https://eth.drpc.org";
    uint256 constant FORK_BLOCK = 25_900_000;

    uint160 constant REQUIRED_FLAGS =
        uint160((1 << 13) | (1 << 7) | (1 << 6) | (1 << 3) | (1 << 2));
    address constant HOOK_ADDRESS = address((uint160(0x4444) << 144) | REQUIRED_FLAGS);

    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    PoolVault vault;
    PoolFactory factory;
    AromaRouter router;

    address owner = makeAddr("owner");
    address creator = makeAddr("creator");

    uint256 traderPk = 0xA11CE;
    address trader;

    address token;
    PoolKey key;

    function setUp() public {
        vm.createSelectFork(vm.envOr("ETH_RPC_URL", string(DEFAULT_RPC)), FORK_BLOCK);
        trader = vm.addr(traderPk);

        deployCodeTo("PoolVault.sol:PoolVault", abi.encode(POOL_MANAGER, owner), HOOK_ADDRESS);
        vault = PoolVault(payable(HOOK_ADDRESS));
        factory = new PoolFactory(address(vault));
        vm.prank(owner);
        vault.setFactory(address(factory));
        router = new AromaRouter(address(vault));

        // makeAddr and vm.addr derive addresses that can already hold real
        // contracts on a mainnet fork. Clear them so they behave as EOAs.
        vm.etch(owner, "");
        vm.etch(creator, "");
        vm.etch(trader, "");
        vm.deal(trader, 1_000_000 ether);
        vm.deal(creator, 1 ether);
        vm.deal(owner, 0);

        vm.prank(creator);
        (token,) = factory.createToken("Aroma Coin", "AROMA", "a test coin", "", 0, 0);
        key = vault.poolKey(token);
    }

    function _signPermit(uint256 value, uint256 deadline)
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

    function _buy(uint256 usdc) internal returns (uint256 tokensOut) {
        vm.prank(trader);
        return router.buy{value: usdc}(token, 0);
    }

    // ---------------------------------------------------------------
    // Buying
    // ---------------------------------------------------------------

    function test_buy_deliversTokensToTheBuyer() public {
        uint256 out = _buy(100 ether);
        assertGt(out, 0, "no tokens returned");
        assertEq(IERC20(token).balanceOf(trader), out, "tokens did not reach the buyer");
    }

    function test_buy_needsNoApprovalAtAll() public {
        // Native USDC is the input, so there is nothing to approve. This is
        // the property the sell path below works to match.
        assertEq(IERC20(token).allowance(trader, address(router)), 0);
        _buy(100 ether);
        assertGt(IERC20(token).balanceOf(trader), 0);
    }

    function test_buy_movesThePrice() public {
        (, int24 before,,) = IPoolManager(POOL_MANAGER).getSlot0(key.toId());
        _buy(100 ether);
        (, int24 afterTick,,) = IPoolManager(POOL_MANAGER).getSlot0(key.toId());
        assertLt(afterTick, before, "price did not move in the buyer's favour");
    }

    function test_buy_enforcesSlippage() public {
        vm.prank(trader);
        vm.expectRevert("slippage");
        router.buy{value: 100 ether}(token, type(uint256).max);
    }

    function test_buy_rejectsUnknownTokens() public {
        vm.prank(trader);
        vm.expectRevert("unknown token");
        router.buy{value: 1 ether}(address(0xDEAD), 0);
    }

    function test_buy_paysTheHookFee() public {
        _buy(1_000 ether);
        (,, uint256 creatorUsdc, uint256 protocolUsdc) = vault.launches(token);
        assertApproxEqRel(creatorUsdc + protocolUsdc, 10 ether, 0.01e18, "fee is not ~1%");
    }

    // ---------------------------------------------------------------
    // Selling — one signature, no Permit2
    // ---------------------------------------------------------------

    function test_sell_isOneTransactionWithNoPriorApproval() public {
        uint256 balance = _buy(1_000 ether);
        uint256 amount = balance / 2;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(amount, deadline);

        // No approve() anywhere. This is the whole reason the router exists.
        assertEq(IERC20(token).allowance(trader, address(router)), 0, "pre-approved");

        uint256 before = trader.balance;
        vm.prank(trader);
        uint256 usdcOut = router.sell(token, amount, 0, deadline, v, r, s);

        assertGt(usdcOut, 0, "no USDC returned");
        assertEq(trader.balance - before, usdcOut, "seller was not paid");
        assertEq(IERC20(token).balanceOf(trader), balance - amount, "tokens not taken");
    }

    function test_sell_enforcesSlippage() public {
        uint256 balance = _buy(1_000 ether);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(balance, deadline);

        vm.prank(trader);
        vm.expectRevert("slippage");
        router.sell(token, balance, type(uint256).max, deadline, v, r, s);
    }

    /// @dev A permit is front-runnable: anyone may submit the signature, which
    /// consumes the nonce. The sell must still work — the allowance is what
    /// matters, not who created it.
    function test_sell_survivesAFrontRunPermit() public {
        uint256 balance = _buy(1_000 ether);
        uint256 amount = balance / 2;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(amount, deadline);

        // A griefer submits the permit first, burning the nonce.
        vm.prank(makeAddr("griefer"));
        IERC20Permit(token).permit(trader, address(router), amount, deadline, v, r, s);

        vm.prank(trader);
        uint256 usdcOut = router.sell(token, amount, 0, deadline, v, r, s);
        assertGt(usdcOut, 0, "a front-run permit bricked the sell");
    }

    function test_sell_rejectsAnInvalidSignatureWithNoAllowance() public {
        _buy(1_000 ether);
        vm.prank(trader);
        vm.expectRevert("permit failed and no allowance");
        router.sell(token, 1e18, 0, block.timestamp + 1 hours, 27, bytes32(0), bytes32(0));
    }

    function test_sell_paysTheHookFeeInUsdc() public {
        uint256 balance = _buy(1_000 ether);
        (,, uint256 creatorBefore, uint256 protocolBefore) = vault.launches(token);
        uint256 vaultTokensBefore = IERC20(token).balanceOf(address(vault));

        uint256 amount = balance / 2;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(amount, deadline);
        vm.prank(trader);
        router.sell(token, amount, 0, deadline, v, r, s);

        (,, uint256 creatorAfter, uint256 protocolAfter) = vault.launches(token);
        assertGt(creatorAfter + protocolAfter, creatorBefore + protocolBefore, "no fee taken");
        // The fee arrived as USDC, not as the token. If this ever fails, the
        // v4 pivot has been undone.
        assertEq(
            IERC20(token).balanceOf(address(vault)),
            vaultTokensBefore,
            "vault accrued tokens - fees are not USDC-only any more"
        );
    }

    // ---------------------------------------------------------------
    // The router holds nothing
    // ---------------------------------------------------------------

    function test_router_keepsNoBalanceBetweenTrades() public {
        uint256 balance = _buy(1_000 ether);
        uint256 amount = balance / 2;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(amount, deadline);
        vm.prank(trader);
        router.sell(token, amount, 0, deadline, v, r, s);

        assertEq(address(router).balance, 0, "router kept USDC");
        assertEq(IERC20(token).balanceOf(address(router)), 0, "router kept tokens");
    }

    function test_unlockCallback_rejectsCallsThatAreNotFromThePoolManager() public {
        vm.expectRevert("not pool manager");
        router.unlockCallback("");
    }
}
