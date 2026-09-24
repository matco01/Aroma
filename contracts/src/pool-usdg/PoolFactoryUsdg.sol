// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {AromaToken} from "../AromaToken.sol";
import {PoolVaultUsdg} from "./PoolVaultUsdg.sol";

/// @title PoolFactoryUsdg
/// @notice `PoolFactory` retargeted at USDG. Same one-transaction shape —
/// deploy the token, create its pool, deposit the whole supply, optionally
/// run the creator's own first buy — see `PoolFactory.sol`'s NatSpec for why
/// that shape and why no admin surface. `PoolFactory.sol` itself (Arc, native
/// USDC) is untouched; this is a new, parallel contract.
///
/// @dev The one structural addition over `PoolFactory` is `salt`. Native USDC
/// is address zero, so any token address sorts above it automatically —
/// `PoolFactory` deploys with a plain `new`, needing no address mining at all.
/// USDG has a real, nonzero address, so `PoolVaultUsdg.launch` requires the
/// token to sort above it, and `salt` is how the caller supplies a deployment
/// address that satisfies that — mined off-chain, exactly like `PoolVault`'s
/// own hook address is mined in `DeployPool.s.sol`, just for a single
/// less-than/greater-than bit rather than a specific permission-bit pattern,
/// so it costs a handful of attempts rather than thousands. `ClubAuction`'s
/// finalize bot does this mining right before calling `createToken`, since it
/// already knows the final name/symbol by then.
contract PoolFactoryUsdg is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    PoolVaultUsdg public immutable vault;
    IPoolManager public immutable poolManager;
    IERC20 public immutable usdg;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    /// @dev 300 USDG — the ceiling on the Club winner's first buy, which
    /// runs inside the launch transaction at the opening price, ahead of
    /// everyone. Deliberately lower than the Arc system's 2,000: the winner
    /// already gets the launch itself, and a small cap keeps the first buy a
    /// stake in the coin rather than a head start on the whole early range.
    ///
    /// USDG is 6 decimals (confirmed against Paxos's deployed contract),
    /// unlike native USDC's 18-decimal view on Arc — this is `300e6`, not
    /// `300e18`, and every USDG amount elsewhere in this contract and in
    /// `ClubAuction` follows the same 6-decimal convention.
    uint256 public constant MAX_DEV_BUY_USDC = 300e6;

    event TokenCreated(
        address indexed token,
        address indexed creator,
        PoolId indexed poolId,
        string name,
        string symbol,
        string description,
        string metadataUri,
        uint256 devBuyUsdc
    );

    struct DevBuy {
        address token;
        address recipient;
        uint256 usdc;
        uint256 minTokensOut;
    }

    /// @dev Grouped for the same reason AromaFactory.LaunchGuard is: this
    /// function has one more parameter than the native PoolFactory
    /// (`salt`), and that's enough on top of `token`/`poolId` to push
    /// createToken's emit past solc's stack limit. Grouping the identity
    /// fields buys back the slots without turning on via-ir, which
    /// AromaFactory's own NatSpec explains the cost of.
    struct TokenInfo {
        string name;
        string symbol;
        string description;
        string metadataUri;
    }

    constructor(address vault_) {
        require(vault_ != address(0), "vault=0");
        vault = PoolVaultUsdg(vault_);
        poolManager = PoolVaultUsdg(vault_).poolManager();
        usdg = IERC20(Currency.unwrap(PoolVaultUsdg(vault_).USDG()));
    }

    /// @param salt CREATE2 salt for the launched token. Must land `token`'s
    /// address above `usdg`'s — see this contract's NatSpec. Reverts in
    /// `PoolVaultUsdg.launch` (not here) if it doesn't, since that's where the
    /// ordering actually matters.
    /// @dev Pulls exactly `devBuyUsdc` via `transferFrom` — the caller must
    /// have approved this contract for at least that much first. Unlike the
    /// native-value original there is no overpayment/refund case: a caller
    /// simply isn't asked for more than the amount that gets spent.
    function createToken(
        TokenInfo calldata info,
        uint256 devBuyUsdc,
        uint256 minTokensOut,
        bytes32 salt
    ) external nonReentrant returns (address token, PoolId poolId) {
        require(devBuyUsdc <= MAX_DEV_BUY_USDC, "dev buy exceeds cap");

        if (devBuyUsdc > 0) {
            usdg.safeTransferFrom(msg.sender, address(this), devBuyUsdc);
        }

        // Split into two calls, not one long body: `info`, `minTokensOut`
        // and `salt` being simultaneously live at the TokenCreated emit
        // pushed this past solc's stack limit even after grouping `info`
        // into TokenInfo. Each private call below only holds the locals it
        // actually needs at once.
        (token, poolId) = _deployAndLaunch(info, devBuyUsdc, salt);

        if (devBuyUsdc > 0) {
            _runDevBuy(token, devBuyUsdc, minTokensOut);
        }
    }

    function _deployAndLaunch(TokenInfo calldata info, uint256 devBuyUsdc, bytes32 salt)
        private
        returns (address token, PoolId poolId)
    {
        token =
            address(new AromaToken{salt: salt}(info.name, info.symbol, TOTAL_SUPPLY, address(vault)));
        poolId = vault.launch(token, msg.sender);

        // Same ordering reasoning as PoolFactory: announce the token before
        // the dev-buy, so an indexer keying trades by token doesn't drop the
        // dev-buy for arriving before the token it belongs to.
        emit TokenCreated(
            token,
            msg.sender,
            poolId,
            info.name,
            info.symbol,
            info.description,
            info.metadataUri,
            devBuyUsdc
        );
    }

    function _runDevBuy(address token, uint256 devBuyUsdc, uint256 minTokensOut) private {
        poolManager.unlock(
            abi.encode(
                DevBuy({
                    token: token,
                    recipient: msg.sender,
                    usdc: devBuyUsdc,
                    minTokensOut: minTokensOut
                })
            )
        );
    }

    /// @inheritdoc IUnlockCallback
    /// @dev Same reasoning as PoolFactory's unlockCallback for why the buy
    /// runs from this contract rather than the vault. The settle step is the
    /// one real difference: USDG is ERC-20, so it's synced and transferred to
    /// the pool manager rather than paid with `settle{value: ...}`.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "not pool manager");
        DevBuy memory d = abi.decode(data, (DevBuy));

        PoolKey memory key = vault.poolKey(d.token);

        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(d.usdc),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );

        int128 owed0 = delta.amount0();
        require(owed0 <= 0, "unexpected USDG credit");
        uint256 owed = uint256(uint128(-owed0));
        // createToken pulled exactly d.usdc into this contract, which is only
        // right if the dev-buy spends all of it. MAX_DEV_BUY_USDC keeps it far
        // below the pool's liquidity so it always does — this makes that a
        // check rather than an argument, same as PoolFactory's.
        require(owed == d.usdc, "dev buy did not fill");
        poolManager.sync(key.currency0);
        usdg.safeTransfer(address(poolManager), owed);
        poolManager.settle();

        int128 out1 = delta.amount1();
        require(out1 > 0, "dev buy received no tokens");
        uint256 tokensOut = uint256(uint128(out1));
        require(tokensOut >= d.minTokensOut, "dev buy slippage");

        poolManager.take(key.currency1, d.recipient, tokensOut);

        return "";
    }
}
