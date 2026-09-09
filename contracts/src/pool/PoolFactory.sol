// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

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
import {PoolVault} from "./PoolVault.sol";

/// @title PoolFactory
/// @notice One transaction: deploy a fixed-supply token, create its Uniswap
/// v4 pool, deposit the entire supply as locked single-sided liquidity, and
/// optionally run the creator's own first buy. The coin is tradeable, and
/// visible to everything watching the pool manager, in the block it is
/// created.
///
/// Mirrors AromaFactory's shape deliberately — same token, same zero creation
/// fee, same dev-buy mechanic, same absence of an admin surface — so the two
/// launch mechanisms stay legible side by side. A creator pays Arc network
/// gas and the trade fee on their own buy, and nothing else.
///
/// @dev Deployed after PoolVault, then PoolVault.setFactory(this) once, the
/// same bootstrap CurveManager and AromaFactory use.
///
/// The one thing AromaFactory has that this does not is the launch guard.
/// Snipe protection is a deferral, not an oversight: it is possible here —
/// unlike v3, a v4 hook could enforce a per-swap rule — but it is its own
/// piece of work. Until it exists, a launch is snipeable from the block it is
/// created, which is precisely why the dev-buy below has to be in the *same
/// transaction* rather than left to the creator to send afterwards.
contract PoolFactory is IUnlockCallback, ReentrancyGuard {
    PoolVault public immutable vault;
    IPoolManager public immutable poolManager;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    /// @dev Ceiling on the creator's same-transaction buy, matching
    /// CurveManager.MAX_DEV_BUY_USDC. The reasoning carries over unchanged:
    /// the creator is the only party who can buy before anyone else knows the
    /// token exists, and without a cap they could take the cheapest part of
    /// the range in full. Ordinary buyers are not capped, because they are not
    /// first by construction.
    uint256 public constant MAX_DEV_BUY_USDC = 2_000e18;

    /// @dev Same shape as AromaFactory.TokenCreated, plus the pool, so one
    /// subgraph schema serves both mechanisms — the handlers differ, the
    /// entities do not. `description` is carried for indexers and the UI
    /// only; it is never read on-chain and costs only log data.
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

    constructor(address vault_) {
        require(vault_ != address(0), "vault=0");
        vault = PoolVault(payable(vault_));
        poolManager = PoolVault(payable(vault_)).poolManager();
    }

    /// @param devBuyUsdc Native USDC to spend on an immediate buy. Zero skips
    /// it entirely — this is optional.
    /// @param minTokensOut Slippage floor for that buy. The creator's own
    /// trade gets no less protection than anyone else's.
    /// @param metadataUri Pointer to off-chain metadata — an `ipfs://` URI
    /// whose JSON carries the token's image. The image cannot live on-chain at
    /// any sane cost, but the pointer can, and that is what keeps the token
    /// self-describing if the launchpad that created it disappears. An empty
    /// string is allowed; the UI falls back to art derived from the address.
    ///
    /// @dev No CREATE2 address mining, unlike the v3 version of this contract.
    /// There, the pair's sort order decided which way every tick constant
    /// pointed and a plain CREATE left it to chance. Native USDC is address
    /// zero and sorts below every possible token, so ordering here is not a
    /// thing that can go wrong.
    function createToken(
        string calldata name,
        string calldata symbol,
        string calldata description,
        string calldata metadataUri,
        uint256 devBuyUsdc,
        uint256 minTokensOut
    ) external payable nonReentrant returns (address token, PoolId poolId) {
        require(devBuyUsdc <= MAX_DEV_BUY_USDC, "dev buy exceeds cap");
        require(msg.value >= devBuyUsdc, "insufficient payment");

        // Mints the whole supply straight to the vault, so it can deposit
        // without an approval or a second transfer.
        token = address(new AromaToken(name, symbol, TOTAL_SUPPLY, address(vault)));
        poolId = vault.launch(token, msg.sender);

        // Announce the token *before* the dev-buy, not after.
        //
        // The dev-buy emits Swap from the PoolManager, and an indexer
        // processes logs in index order. With TokenCreated emitted last, a
        // consumer sees the token's first trade before it has ever heard of
        // the token — and any indexer that keys trades by pool (ours does,
        // via PoolRef) silently drops that dev-buy. Since it is usually the
        // largest early trade and sets the opening price, losing it is not
        // cosmetic. AromaFactory pins this same ordering with a test.
        emit TokenCreated(
            token, msg.sender, poolId, name, symbol, description, metadataUri, devBuyUsdc
        );

        if (devBuyUsdc > 0) {
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

        uint256 refund = msg.value - devBuyUsdc;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            require(ok, "refund failed");
        }
    }

    /// @inheritdoc IUnlockCallback
    ///
    /// @dev The buy runs from *this* contract rather than from PoolVault, even
    /// though the vault already has the unlock machinery. The vault is the
    /// pool's hook, so a swap it initiated would settle the hook's fee against
    /// the same account that owes the swap input — one address playing both
    /// sides, and accounting that is far harder to be sure of than it is to
    /// avoid. Here the swapper and the hook are different addresses and the
    /// deltas stay separate.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "not pool manager");
        DevBuy memory d = abi.decode(data, (DevBuy));

        PoolKey memory key = vault.poolKey(d.token);

        // Exact input, no price limit beyond the range's own floor: the
        // creator is buying into an empty pool, so the only thing that stops
        // this is the liquidity itself.
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(d.usdc),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );

        // Negative is owed. currency0 covers both the swap input and the fee
        // the hook charged, so settling the whole debt pays both.
        int128 owed0 = delta.amount0();
        require(owed0 <= 0, "unexpected USDC credit");
        poolManager.settle{value: uint256(uint128(-owed0))}();

        int128 out1 = delta.amount1();
        require(out1 > 0, "dev buy received no tokens");
        uint256 tokensOut = uint256(uint128(out1));
        require(tokensOut >= d.minTokensOut, "dev buy slippage");

        // Straight to the creator, not to this contract. Same reasoning as
        // CurveManager.buy's recipient parameter: a factory that briefly holds
        // a creator's tokens is a factory that can be made to lose them.
        poolManager.take(key.currency1, d.recipient, tokensOut);

        return "";
    }

    /// @dev Native USDC refunded by the pool manager during settle would
    /// otherwise revert on arrival.
    receive() external payable {}
}
