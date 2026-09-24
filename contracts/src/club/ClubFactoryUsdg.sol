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
import {ClubVaultUsdg} from "./ClubVaultUsdg.sol";

/// @title ClubFactoryUsdg
/// @notice Launches the club coin a Club auction was won for: deploys the
/// token, creates its pool, makes the auction's winner the club's creator with
/// the creator's invite seats, and runs the winner's first buy.
///
/// @dev ClubFactory, with three differences.
///
/// - Only the launcher — ClubAuction — may call it, and it names the creator
///   rather than taking msg.sender. On Robinhood Chain a coin exists because
///   someone won the auction for it, so there is no path to a launch that
///   skips the auction, and the root of the tree is the winner, not the
///   auction contract that happened to make the call.
/// - The first buy is paid in USDG pulled from the launcher, and its tokens go
///   straight to the creator.
/// - The token is deployed with CREATE2 and a caller-chosen salt, because
///   ClubVaultUsdg requires the token to sort above USDG. The finalize bot
///   mines the salt off-chain; a bad one reverts in the vault and the bot
///   tries another.
contract ClubFactoryUsdg is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    ClubVaultUsdg public immutable vault;
    IPoolManager public immutable poolManager;
    IERC20 public immutable usdg;

    /// @dev Whoever deployed this contract, allowed to name the launcher once.
    /// The launcher and the factory each need the other's address, so one of
    /// them has to be set after deployment.
    address public immutable deployer;
    address public launcher;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant MAX_DEV_BUY_USDC = 300e6;

    /// @dev Identical to ClubFactory.TokenCreated, so one subgraph handler
    /// serves both.
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

    struct TokenInfo {
        string name;
        string symbol;
        string description;
        string metadataUri;
    }

    struct DevBuy {
        address token;
        address recipient;
        uint256 usdc;
        uint256 minTokensOut;
    }

    constructor(address vault_) {
        require(vault_ != address(0), "vault=0");
        vault = ClubVaultUsdg(vault_);
        poolManager = ClubVaultUsdg(vault_).poolManager();
        usdg = IERC20(Currency.unwrap(ClubVaultUsdg(vault_).USDC()));
        deployer = msg.sender;
    }

    function setLauncher(address launcher_) external {
        require(msg.sender == deployer, "not deployer");
        require(launcher == address(0), "launcher already set");
        require(launcher_ != address(0), "launcher=0");
        launcher = launcher_;
    }

    /// @notice Where createToken would deploy a token with this name, symbol
    /// and salt.
    ///
    /// @dev The salt has to be mined against this, not against a compiled
    /// artifact. The bytecode a build artifact reports for AromaToken is not
    /// guaranteed to be byte-for-byte what this contract embeds — compiler
    /// runs differ in metadata — and a salt mined off the wrong init code
    /// lands the token somewhere else entirely. Asking the deployed factory
    /// removes the question. USDG sits about 37% of the way through the
    /// address space, so a random salt works about two times in three and the
    /// bot rarely needs more than a couple of calls.
    function predictToken(string calldata name, string calldata symbol, bytes32 salt)
        external
        view
        returns (address)
    {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(AromaToken).creationCode,
                abi.encode(name, symbol, TOTAL_SUPPLY, address(vault))
            )
        );
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))
            )
        );
    }

    function createToken(
        TokenInfo calldata info,
        address creator,
        uint256 devBuyUsdc,
        uint256 minTokensOut,
        bytes32 salt
    ) external nonReentrant returns (address token, PoolId poolId) {
        require(msg.sender == launcher, "not launcher");
        require(creator != address(0), "creator=0");
        require(devBuyUsdc <= MAX_DEV_BUY_USDC, "dev buy exceeds cap");

        if (devBuyUsdc > 0) {
            usdg.safeTransferFrom(msg.sender, address(this), devBuyUsdc);
        }

        // Split into steps only to stay under the stack limit.
        (token, poolId) = _deployAndLaunch(info, creator, devBuyUsdc, salt);

        if (devBuyUsdc > 0) {
            poolManager.unlock(
                abi.encode(
                    DevBuy({
                        token: token,
                        recipient: creator,
                        usdc: devBuyUsdc,
                        minTokensOut: minTokensOut
                    })
                )
            );
        }
    }

    function _deployAndLaunch(
        TokenInfo calldata info,
        address creator,
        uint256 devBuyUsdc,
        bytes32 salt
    ) private returns (address token, PoolId poolId) {
        token = address(
            new AromaToken{salt: salt}(info.name, info.symbol, TOTAL_SUPPLY, address(vault))
        );
        poolId = vault.launch(token, creator);

        // Before the first buy, for the reason PoolFactory gives: an indexer
        // must hear about the token before it sees the token's first trade.
        emit TokenCreated(
            token,
            creator,
            poolId,
            info.name,
            info.symbol,
            info.description,
            info.metadataUri,
            devBuyUsdc
        );
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "not pool manager");
        DevBuy memory d = abi.decode(data, (DevBuy));

        PoolKey memory key = vault.poolKey(d.token);

        // The hook gates buys on membership, so it is told the buy is the
        // creator's. The factory is one of the two senders it takes that from.
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(d.usdc),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            abi.encode(d.recipient, address(0), uint256(0), uint256(0), bytes(""))
        );

        int128 owed0 = delta.amount0();
        require(owed0 <= 0, "unexpected USDG credit");
        uint256 owed = uint256(uint128(-owed0));
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
