// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
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

/// @title ClubVault
/// @notice Invite-only coins. Same pool as a normal Aroma launch, a different
/// hook: only members can buy, members are admitted by invitation, and the
/// trading fee pays the chain of people who invited the trader.
///
/// The design, the reasoning behind each number and the simulations they came
/// from are in CLUBS.md at the repository root. This contract implements that
/// document; where the two disagree, the document is the thing to fix first.
///
/// @dev A separate contract from PoolVault rather than an extension of it, and
/// that is not a style choice. A v4 pool's hook is part of its PoolKey and is
/// fixed when the pool is initialized, and PoolVault's fee is a constant, so no
/// change to PoolVault could ever reach a pool that already exists. Clubs run
/// beside the normal system instead of replacing it: normal coins keep their
/// vault, factory and router untouched, and every coin already trading is
/// unaffected by anything here.
///
/// The pool geometry — ticks, liquidity, supply — is copied from PoolVault
/// exactly. A club coin prices identically to a normal one; only who may buy
/// it and where its fee goes are different.
contract ClubVault is IHooks, IUnlockCallback, ReentrancyGuard, Ownable2Step, EIP712 {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    // ---------------------------------------------------------------
    // Pool geometry — identical to PoolVault, derived by
    // script/math/derive_pool.py. See PoolVault for what each one means.
    // ---------------------------------------------------------------

    Currency public constant USDC = Currency.wrap(address(0));

    int24 public constant TICK_SPACING = 2;
    int24 public constant TICK_INIT = 123_546;
    int24 public constant TICK_GRADUATION = 95_818;
    int24 public constant TICK_RESERVE_FLOOR = 68_090;

    uint24 public constant POOL_LP_FEE = 0;
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    uint128 public constant SALE_LIQUIDITY = 2215084467296721841999892;
    uint128 public constant RESERVE_LIQUIDITY = 2215164928381102038775570;

    // ---------------------------------------------------------------
    // Fees
    //
    // 1.5% rather than a normal coin's 1%. The protocol keeps the same 30
    // bps it takes everywhere; the other 120 go to the club. There is no
    // creator fee in the normal sense — the creator earns by being the root
    // of the tree, plus a small cut of every trade at any depth, which is the
    // only share with no radius.
    // ---------------------------------------------------------------

    uint256 public constant SWAP_FEE_BPS = 150;
    uint256 public constant PROTOCOL_FEE_BPS = 30;
    uint256 public constant ROOT_FEE_BPS = 10;
    /// @dev Documented for readers; the tree is always taken as whatever
    /// remains after the other two, so integer division cannot strand a wei.
    uint256 public constant TREE_FEE_BPS = 110;
    uint256 public constant FEE_DENOMINATOR = 10_000;

    /// @dev How far up the tree a trade's fee travels. The club itself has no
    /// depth limit; this is only the payout radius. It exists for gas: each
    /// level is a storage write on every swap, and an unbounded walk would let
    /// someone build a chain deep enough to make the coin untradeable. Ten
    /// levels is about 88,000 people below a member who fills every seat.
    uint256 public constant MAX_DEPTH = 10;

    // ---------------------------------------------------------------
    // Membership
    // ---------------------------------------------------------------

    /// @dev Fixed for every club. With seats never replenishing, the creator's
    /// seed count is what keeps a club alive when members don't invite: in
    /// simulation, 3 seeds left 39% of clubs barely growing and 10 left 3%.
    uint8 public constant CREATOR_SEATS = 10;
    uint8 public constant MEMBER_SEATS = 3;

    /// @dev The smallest buy that may redeem an invite. A seat is consumed by
    /// buying, not by being invited, so that invites are not wasted on people
    /// who never participate. Without a floor a one-wei buy would count, and a
    /// publicly posted link could have its seats burned for nothing.
    uint256 public constant MIN_JOIN_USDC = 1e18;

    bytes32 public constant INVITE_TYPEHASH =
        keccak256("Invite(address token,address inviter,uint256 nonce,uint256 deadline)");

    // ---------------------------------------------------------------
    // State
    // ---------------------------------------------------------------

    IPoolManager public immutable poolManager;

    /// @dev Both set once, after deployment, by the owner. They are the only
    /// two contracts whose word the hook takes about who is trading: when a
    /// swap arrives from either, the trader is read from its hook data rather
    /// than from tx.origin. That is what lets smart-contract wallets use clubs
    /// at all. Setting them once rather than leaving them owner-mutable means
    /// the owner cannot later install a router that lies about identity.
    address public factory;
    address public router;

    struct Club {
        address creator;
        PoolId poolId;
    }

    mapping(address token => Club) public clubs;
    mapping(PoolId poolId => address token) public poolTokens;

    /// @dev The tree. Written once when a member joins and never changed,
    /// which is also what makes cycles impossible: nobody can be invited twice,
    /// so walking upward always ends at the creator.
    mapping(address token => mapping(address member => address inviter)) public inviterOf;
    mapping(address token => mapping(address account => bool)) public isMember;
    mapping(address token => mapping(address member => uint8)) public seatsUsed;
    /// @dev Bumped to invalidate every outstanding link a member has handed
    /// out. Seats already redeemed are never affected.
    mapping(address token => mapping(address member => uint256)) public inviteNonce;

    /// @dev What each account can withdraw, across every club it earns from.
    /// One balance rather than one per club, so collecting is one transaction
    /// however many clubs someone is in. Per-club figures are in the events.
    mapping(address account => uint256) public claimable;

    /// @dev Protocol revenue across all clubs, likewise withdrawn in one call.
    /// PoolVault keeps this per token and it costs a transaction per coin to
    /// collect; there is no reason to repeat that here.
    uint256 public protocolUsdc;

    bool private _launching;

    event Launched(address indexed token, address indexed creator, PoolId poolId);
    event Joined(address indexed token, address indexed member, address indexed inviter);
    event InvitesRevoked(address indexed token, address indexed member, uint256 nonce);
    event FeeTaken(address indexed token, address indexed trader, uint256 usdc);
    /// @dev level 0 is the creator's root cut; 1 is whoever invited the
    /// trader, 2 whoever invited them, and so on.
    event Credited(address indexed token, address indexed account, uint8 level, uint256 usdc);
    event Claimed(address indexed account, uint256 usdc);
    event ProtocolFeesWithdrawn(address indexed to, uint256 usdc);

    constructor(address poolManager_, address owner_) Ownable(owner_) EIP712("Aroma Clubs", "1") {
        require(poolManager_ != address(0), "poolManager=0");
        require(poolManager_.code.length > 0, "poolManager has no code");
        poolManager = IPoolManager(poolManager_);
    }

    receive() external payable {}

    function setFactory(address factory_) external onlyOwner {
        require(factory == address(0), "factory already set");
        require(factory_ != address(0), "factory=0");
        factory = factory_;
    }

    function setRouter(address router_) external onlyOwner {
        require(router == address(0), "router already set");
        require(router_ != address(0), "router=0");
        router = router_;
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

    /// @notice Creates the pool and deposits the supply exactly as PoolVault
    /// does, and makes the creator the club's first member.
    function launch(address token, address creator)
        external
        nonReentrant
        returns (PoolId poolId)
    {
        require(msg.sender == factory, "not factory");
        require(clubs[token].creator == address(0), "already launched");
        require(creator != address(0), "creator=0");
        require(token != address(0), "token=0");
        require(
            IERC20(token).balanceOf(address(this)) >= TOTAL_SUPPLY, "supply not received"
        );

        PoolKey memory key = poolKey(token);
        poolId = key.toId();

        clubs[token] = Club({creator: creator, poolId: poolId});
        poolTokens[poolId] = token;

        _launching = true;
        int24 openingTick = poolManager.initialize(key, TickMath.getSqrtPriceAtTick(TICK_INIT));
        require(openingTick == TICK_INIT, "pool opened at wrong tick");
        poolManager.unlock(abi.encode(token));
        _launching = false;

        emit Launched(token, creator, poolId);

        // The root of the tree. Admitted by launching rather than by invite,
        // so it has no inviter, which is what every upward walk stops at.
        isMember[token][creator] = true;
        emit Joined(token, creator, address(0));
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "not pool manager");
        address token = abi.decode(data, (address));
        PoolKey memory key = poolKey(token);

        BalanceDelta saleDelta = _addLiquidity(key, TICK_GRADUATION, TICK_INIT, SALE_LIQUIDITY);
        BalanceDelta reserveDelta =
            _addLiquidity(key, TICK_RESERVE_FLOOR, TICK_GRADUATION, RESERVE_LIQUIDITY);

        require(saleDelta.amount0() == 0 && reserveDelta.amount0() == 0, "unexpected USDC owed");

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
    // Invites
    //
    // An invite is an EIP-712 signature, not a transaction. Handing one out
    // costs nothing, which matters because most never get redeemed. It is a
    // bearer instrument: one signature can admit up to as many people as the
    // inviter has seats, because the scarce thing is the seat, not the
    // signature. Whoever buys first with it gets in.
    //
    // Redemption happens inside a buy, so a seat is only ever consumed by
    // someone who actually bought. That is the point of the design: invites
    // that burn on sending are wasted on everyone who never shows up.
    // ---------------------------------------------------------------

    function inviteDigest(address token, address inviter, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(INVITE_TYPEHASH, token, inviter, nonce, deadline)));
    }

    function seatsOf(address token, address member) public view returns (uint8) {
        if (!isMember[token][member]) return 0;
        return member == clubs[token].creator ? CREATOR_SEATS : MEMBER_SEATS;
    }

    function seatsLeft(address token, address member) external view returns (uint8) {
        uint8 total = seatsOf(token, member);
        uint8 used = seatsUsed[token][member];
        return used >= total ? 0 : total - used;
    }

    /// @notice Why an invite would not admit `invitee`, or an empty string if
    /// it would.
    ///
    /// @dev The same checks redemption applies, exposed as a view so a page
    /// can say "this invite is full" before someone connects a wallet and pays
    /// gas to find out. Redemption calls this too, so the two cannot drift.
    function inviteProblem(
        address token,
        address invitee,
        address inviter,
        uint256 nonce,
        uint256 deadline,
        bytes memory signature
    ) public view returns (string memory) {
        if (clubs[token].creator == address(0)) return "unknown club";
        if (isMember[token][invitee]) return "already a member";
        if (block.timestamp > deadline) return "invite expired";
        if (!isMember[token][inviter]) return "inviter not a member";
        if (nonce != inviteNonce[token][inviter]) return "invite revoked";
        if (seatsUsed[token][inviter] >= seatsOf(token, inviter)) return "no seats left";
        if (!_signedBy(inviter, inviteDigest(token, inviter, nonce, deadline), signature)) {
            return "bad invite signature";
        }
        return "";
    }

    /// @dev Whether `signer` signed `digest`, by their own key or, failing
    /// that, by their contract wallet's say-so.
    ///
    /// The order is the point, and it is the opposite of OpenZeppelin's
    /// SignatureChecker. That library decides by whether the signer has code:
    /// no code means ECDSA, any code means ERC-1271 *only*. That was correct
    /// until EIP-7702, which lets an ordinary key-controlled account carry a
    /// delegation — and a delegation is code. Such an account still signs with
    /// its own key, but SignatureChecker never checks the key; it asks the
    /// delegate, and a delegate that does not implement ERC-1271 says no.
    ///
    /// Found on a fork of Arc mainnet, not in the unit tests: anvil's first
    /// account carries a 7702 delegation there, and every invite it signed was
    /// refused as a bad signature while being, byte for byte, a valid one.
    /// Wallets are putting delegations on user accounts, so this is the case to
    /// get right rather than an edge.
    ///
    /// Accepting the key first is sound. An account's key is its ultimate
    /// authority under 7702 — it can re-delegate at will — and a pure contract
    /// wallet has no key that could ever recover to its address, so it can only
    /// reach the ERC-1271 branch.
    function _signedBy(address signer, bytes32 digest, bytes memory signature)
        private
        view
        returns (bool)
    {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) return true;
        return signer.code.length > 0
            && SignatureChecker.isValidERC1271SignatureNow(signer, digest, signature);
    }

    /// @notice Invalidates every invite link the caller has handed out for
    /// `token`. Anyone already admitted stays admitted.
    function revokeInvites(address token) external {
        require(isMember[token][msg.sender], "not a member");
        uint256 nonce = ++inviteNonce[token][msg.sender];
        emit InvitesRevoked(token, msg.sender, nonce);
    }

    // ---------------------------------------------------------------
    // Who is trading
    // ---------------------------------------------------------------

    /// @dev Hook data from a trusted sender is
    /// abi.encode(trader, inviter, nonce, deadline, signature), with a zero
    /// inviter when there is no invite. From any other sender it is ignored
    /// entirely and the trader is tx.origin.
    ///
    /// tx.origin is what lets a member buy through any terminal or bot, not
    /// just this site: membership is on-chain state, so once a wallet is in,
    /// every route works. Its known limit is smart-contract wallets, whose
    /// tx.origin is a relayer rather than the wallet — which is exactly why
    /// the router may state the trader instead.
    ///
    /// Hook data from an untrusted sender must be ignored, not merely
    /// distrusted: anyone can call the pool manager with hook data claiming to
    /// be any member, and honouring it would let a non-member buy.
    function _traderOf(address sender, bytes calldata hookData) private view returns (address) {
        if ((sender == router || sender == factory) && hookData.length >= 32) {
            return abi.decode(hookData[:32], (address));
        }
        return tx.origin;
    }

    function _admit(
        address token,
        address trader,
        address sender,
        SwapParams calldata params,
        bytes calldata hookData
    ) private {
        // Only the router can carry an invite. Redemption has to happen inside
        // a real buy, and the router is the one sender that both states who the
        // buyer is and only ever sends exact-input buys, so the amount checked
        // below is the amount actually spent.
        require(sender == router && hookData.length > 32, "invite only");
        (, address inviter, uint256 nonce, uint256 deadline, bytes memory signature) =
            abi.decode(hookData, (address, address, uint256, uint256, bytes));
        require(inviter != address(0), "invite only");
        require(
            params.amountSpecified < 0 && uint256(-params.amountSpecified) >= MIN_JOIN_USDC,
            "join buy too small"
        );

        string memory problem = inviteProblem(token, trader, inviter, nonce, deadline, signature);
        require(bytes(problem).length == 0, problem);

        seatsUsed[token][inviter] += 1;
        inviterOf[token][trader] = inviter;
        isMember[token][trader] = true;
        emit Joined(token, trader, inviter);
    }

    // ---------------------------------------------------------------
    // Hook
    //
    // Fee mechanics are PoolVault's exactly — whichever hook can reach the
    // USDC side charges, exact-output sells are refused — with two additions:
    // buys are gated on membership, and the fee is split up the tree rather
    // than 70/30.
    // ---------------------------------------------------------------

    function _specifiedIsUsdc(SwapParams calldata p) private pure returns (bool) {
        return p.zeroForOne == (p.amountSpecified < 0);
    }

    /// @dev The split, in one place.
    ///
    /// Protocol and root are fixed shares. The tree is walked upward from the
    /// trader's inviter: each level takes two thirds of what is left and passes
    /// a third on, which is the "each level pays a third of the one below"
    /// schedule — 73.3, 24.4, 8.1 bps and so on — expressed so that it needs
    /// no table and loses nothing to rounding.
    ///
    /// The deepest ancestor reached takes everything still left, whether the
    /// walk stopped at MAX_DEPTH or because the chain ran out. That is the
    /// roll-up rule. Without it, the unpaid depth of shallow trees would fall
    /// back to the protocol, which simulated at 37% of fees against an
    /// advertised 30%. Every member's chain ends at the creator, so in practice
    /// the roll-up lands there.
    ///
    /// A trader with no inviter at all — the creator trading their own coin, or
    /// a non-member selling tokens they were sent — has no tree to pay, and
    /// that share goes to the protocol.
    function _creditFee(address token, address trader, uint256 fee) private {
        emit FeeTaken(token, trader, fee);

        uint256 toProtocol = (fee * PROTOCOL_FEE_BPS) / SWAP_FEE_BPS;
        uint256 toRoot = (fee * ROOT_FEE_BPS) / SWAP_FEE_BPS;
        uint256 tree = fee - toProtocol - toRoot;

        if (toRoot > 0) {
            address creator = clubs[token].creator;
            claimable[creator] += toRoot;
            emit Credited(token, creator, 0, toRoot);
        }

        address member = inviterOf[token][trader];
        for (uint256 level = 1; level <= MAX_DEPTH && member != address(0); ++level) {
            address next = inviterOf[token][member];
            uint256 share = (level == MAX_DEPTH || next == address(0)) ? tree : (tree * 2) / 3;
            if (share > 0) {
                tree -= share;
                claimable[member] += share;
                emit Credited(token, member, uint8(level), share);
            }
            member = next;
        }

        protocolUsdc += toProtocol + tree;
    }

    function beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) external override returns (bytes4, BeforeSwapDelta, uint24) {
        require(msg.sender == address(poolManager), "not pool manager");
        address token = Currency.unwrap(key.currency1);
        require(clubs[token].creator != address(0), "unknown pool");

        address trader = _traderOf(sender, hookData);

        // Buying is gated. Selling never is: anyone holding the coin can always
        // leave, and gating the exit is what would make this a honeypot.
        if (params.zeroForOne && !isMember[token][trader]) {
            _admit(token, trader, sender, params, hookData);
        }

        if (!_specifiedIsUsdc(params)) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }
        require(params.amountSpecified < 0, "exact-output sells unsupported");

        uint256 fee = (uint256(-params.amountSpecified) * SWAP_FEE_BPS) / FEE_DENOMINATOR;
        if (fee == 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        poolManager.take(key.currency0, address(this), fee);
        _creditFee(token, trader, fee);

        return (
            IHooks.beforeSwap.selector,
            toBeforeSwapDelta(int128(int256(fee)), int128(0)),
            0
        );
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) external override returns (bytes4, int128) {
        require(msg.sender == address(poolManager), "not pool manager");
        if (_specifiedIsUsdc(params)) return (IHooks.afterSwap.selector, 0);

        address token = Currency.unwrap(key.currency1);
        require(clubs[token].creator != address(0), "unknown pool");

        int128 usdcDelta = delta.amount0();
        uint256 gross =
            usdcDelta >= 0 ? uint256(int256(usdcDelta)) : uint256(-int256(usdcDelta));
        uint256 fee = (gross * SWAP_FEE_BPS) / FEE_DENOMINATOR;
        if (fee == 0) return (IHooks.afterSwap.selector, 0);

        poolManager.take(key.currency0, address(this), fee);
        _creditFee(token, _traderOf(sender, hookData), fee);

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
    // Money out
    // ---------------------------------------------------------------

    /// @notice Withdraws everything the caller has earned, from every club.
    function claim() external nonReentrant returns (uint256 usdc) {
        usdc = claimable[msg.sender];
        claimable[msg.sender] = 0;
        if (usdc > 0) {
            (bool ok,) = msg.sender.call{value: usdc}("");
            require(ok, "USDC transfer failed");
        }
        emit Claimed(msg.sender, usdc);
    }

    function withdrawProtocolFees(address to) external onlyOwner nonReentrant returns (uint256 usdc) {
        require(to != address(0), "to=0");
        usdc = protocolUsdc;
        protocolUsdc = 0;
        if (usdc > 0) {
            (bool ok,) = to.call{value: usdc}("");
            require(ok, "USDC transfer failed");
        }
        emit ProtocolFeesWithdrawn(to, usdc);
    }

    function creatorOf(address token) external view returns (address) {
        return clubs[token].creator;
    }

    // ---------------------------------------------------------------
    // Unused hooks — see PoolVault.
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

    // As with PoolVault, there is deliberately no function that removes
    // liquidity and no rescue hatch. Only fees can leave.
}
