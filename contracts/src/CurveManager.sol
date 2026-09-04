// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title CurveManager
/// @notice One shared contract holding every launched token's bonding-curve
/// state, rather than one curve contract deployed per token — cheaper at
/// launch volume and a single audit surface instead of N. Every token uses
/// an identical curve shape (same virtual reserves, same fee, same
/// graduation target) by design: uniform mechanics across every launch is
/// the fairness pitch this whole product category is built on.
///
/// Accounting is entirely in native USDC (18 decimals) — Arc's *native* gas
/// asset, not the 6-decimal ERC-20 view of the same balance. This contract
/// never touches the 6-decimal interface at all; that conversion is a
/// display-layer concern for the frontend/indexer, never curve math. See
/// the project's derive_curve.py for how VIRTUAL_USDC_RESERVE and
/// VIRTUAL_TOKEN_RESERVE below were derived and verified against the
/// product's target constants (13,800 raised / 800M sold / $69,000 mcap).
///
/// @dev Rounding direction is protocol-favoring on every trade: buy and
/// sell both round the *invariant-preserving* leg up (via Math.ceilDiv),
/// which rounds the amount owed to the trader down. This is deliberate,
/// not incidental — see _buyQuote/_sellQuote.
contract CurveManager is ReentrancyGuard, Ownable2Step, Pausable {
    // ---------------------------------------------------------------
    // Curve constants — derived by contracts/script/math/derive_curve.py.
    // Re-run that script if any of these targets ever change; do not hand-
    // edit the reserve constants without re-deriving them.
    // ---------------------------------------------------------------

    /// @dev Virtual USDC reserve, 18-decimal. Exactly 4,600 USDC.
    uint256 public constant VIRTUAL_USDC_RESERVE = 4_600_000_000_000_000_000_000;
    /// @dev Virtual token reserve, 18-decimal. ~1,066,666,666.666667 tokens.
    uint256 public constant VIRTUAL_TOKEN_RESERVE = 1_066_666_666_666_666_666_666_666_667;
    /// @dev Product invariant of the two virtual reserves above, held
    /// constant for every token's curve. Solidity constant-folds this at
    /// compile time — no runtime multiplication cost.
    uint256 public constant K = VIRTUAL_USDC_RESERVE * VIRTUAL_TOKEN_RESERVE;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant CURVE_SUPPLY = 800_000_000e18;
    uint256 public constant LP_RESERVE_SUPPLY = TOTAL_SUPPLY - CURVE_SUPPLY;
    /// @dev The raise is *not* a free parameter. Seeding the graduation pool
    /// with the raise and the unsold tokens opens it at raise/LP_RESERVE, so
    /// matching the price the curve closed at forces
    /// LP_RESERVE/TOTAL_SUPPLY == GRADUATION_RAISE/GRADUATION_MARKET_CAP.
    /// With a 20% reserve and a $69,000 graduation, that is $13,800 — not a
    /// number anyone picked. An earlier $24,000 opened the pool at a
    /// $119,950 market cap against a curve closing at $69,000, a 73.8% jump
    /// paid by whoever bought into the new pool. derive_curve.py now asserts
    /// this rather than trusting it.
    uint256 public constant GRADUATION_RAISE_USDC = 13_800e18;

    uint256 public constant TRADE_FEE_BPS = 100; // 1%, matches Pons' own rate
    uint256 public constant FEE_DENOMINATOR = 10_000;

    /// @dev Of the 1% trade fee, the share that goes to the token's creator
    /// rather than the protocol — 7,000 / FEE_DENOMINATOR = 70%, matching
    /// Pons' own real-world split (their protocol keeps the other 30%).
    /// This is the whole reason a creator's own token is worth launching
    /// beyond the dev-buy: every trade after that earns them something.
    uint256 public constant CREATOR_FEE_SHARE_BPS = 7_000;

    /// @dev Flat fee skimmed from the raised USDC at graduation, before the
    /// remainder is seeded into the graduation vault/pool. Pump.fun charges
    /// an equivalent flat fee at migration (0.015 SOL) separate from their
    /// (zero) creation fee — this is the same idea, not the same number:
    /// theirs is SOL-denominated and covers *their* real migration gas;
    /// ours is a placeholder in the same modest spirit ($10, well under
    /// 0.07% of the $13,800 raise) until real Uniswap v4 seeding costs on
    /// Arc are known. Revisit once graduate() actually seeds a pool.
    uint256 public constant GRADUATION_FEE_USDC = 10e18;

    /// @dev Ceiling on a creator's same-transaction dev-buy, denominated in
    /// USDC. Flagged in the project plan as needing a real product decision
    /// — $2,000 is a placeholder default, not a confirmed number. Change
    /// before this is ever deployed with real funds.
    uint256 public constant MAX_DEV_BUY_USDC = 2_000e18;

    // ---------------------------------------------------------------
    // Per-token state
    // ---------------------------------------------------------------

    struct TokenState {
        uint256 realUsdcReserve; // net USDC actually backing this token's curve (post-fee)
        uint256 tokensSold; // cumulative tokens sold via the curve
        address creator;
        bool graduated;
    }

    mapping(address token => TokenState) public tokenState;

    /// @notice Set once, by the owner, immediately after both this contract
    /// and AromaFactory are deployed — see their shared NatSpec note on the
    /// bootstrap ordering. Immutable in practice (guarded to set-once) even
    /// though it isn't declared `immutable`, because it can't be known at
    /// this contract's own construction time (Factory needs this contract's
    /// address first).
    address public factory;

    /// @notice Where graduation proceeds go. Immutable, deliberately: an
    /// owner-settable destination would let whoever holds the owner key
    /// redirect every graduating token's entire raise to themselves, which
    /// is precisely the rug this product tells users can't happen. Fixing
    /// it at construction means the destination is auditable from the
    /// deploy transaction and can never change underneath a holder.
    ///
    /// The consequence is that pointing graduations at a real Uniswap v4
    /// pool seeder later requires deploying a new CurveManager rather than
    /// flipping a setting. That is the correct trade — redeploying costs
    /// nothing before mainnet, and after mainnet this must not be movable.
    address public immutable graduationVault;

    /// @notice Protocol's 30% share of trade fees, collected but not yet
    /// withdrawn. Structurally separate from every token's realUsdcReserve
    /// — see withdrawFees for why that separation is the important safety
    /// property here, not just bookkeeping. Also collects the flat
    /// graduation fee (see GRADUATION_FEE_USDC) — both are protocol
    /// revenue, no reason to track them in two places.
    uint256 public accumulatedFees;

    /// @notice Each token's creator's 70% share of that token's trade fees,
    /// accrued here until claimed. Per-token rather than per-creator-wallet
    /// so a creator who launches several tokens claims each separately —
    /// keeps this ledger a direct mirror of what each token's own trading
    /// actually generated, with no cross-token pooling to reason about.
    mapping(address token => uint256) public creatorFeesAccrued;

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    event TokenRegistered(address indexed token, address indexed creator);
    /// @dev `payer` and `recipient` differ exactly once per token: the
    /// factory-mediated dev-buy, where payer is the AromaFactory contract
    /// and recipient is the actual creator. Indexers should key holder
    /// balances off `recipient`, not `payer`. `fee` is split creator/
    /// protocol per CREATOR_FEE_SHARE_BPS — `creatorFee` names this token's
    /// creator's cut explicitly rather than making indexers re-derive it.
    event Bought(
        address indexed token,
        address indexed recipient,
        address payer,
        uint256 usdcIn,
        uint256 fee,
        uint256 creatorFee,
        uint256 tokensOut
    );
    event Sold(
        address indexed token,
        address indexed seller,
        uint256 tokensIn,
        uint256 usdcOut,
        uint256 fee,
        uint256 creatorFee
    );
    event Graduated(address indexed token, uint256 usdcSeed, uint256 tokenSeed, uint256 graduationFee);
    /// @dev The post-graduation counterpart to Bought/Sold's fee split —
    /// see depositGraduatedFees. `depositor` will be this token's Uniswap
    /// v4 hook once that exists; until then this is open to any caller,
    /// which is safe (it can only ever credit real attached value, never
    /// fabricate it) but worth knowing when reading these events.
    event GraduatedFeesDeposited(address indexed token, address indexed depositor, uint256 amount, uint256 creatorFee);
    event CreatorFeesClaimed(address indexed token, address indexed creator, uint256 amount);
    event FactorySet(address indexed factory);

    constructor(address initialOwner, address initialGraduationVault) Ownable(initialOwner) {
        require(initialGraduationVault != address(0), "vault=0");
        graduationVault = initialGraduationVault;
    }

    modifier onlyFactory() {
        require(msg.sender == factory, "only factory");
        _;
    }

    // ---------------------------------------------------------------
    // Bootstrap / admin — deliberately the smallest possible surface.
    // Everything here is either one-time (factory) or narrowly scoped
    // (pause, fee withdrawal, vault redirect) with no path to touching an
    // individual token's active curve reserve.
    // ---------------------------------------------------------------

    /// @notice Wires this contract to its factory. Callable exactly once —
    /// after that this behaves like an immutable value. Two-step because
    /// AromaFactory's constructor needs this contract's address, so this
    /// contract can't know the factory's address at its own construction.
    function setFactory(address factory_) external onlyOwner {
        require(factory == address(0), "factory already set");
        require(factory_ != address(0), "factory=0");
        factory = factory_;
        emit FactorySet(factory_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Withdraws accumulated protocol fees. Can only ever move
    /// `accumulatedFees` — never a token's realUsdcReserve, and never funds
    /// already sent to the graduation vault. That structural separation
    /// (not an access-control check) is what makes this safe to be
    /// owner-gated at all: there's no value in this function's reach that
    /// backs an active curve or a completed graduation.
    function withdrawFees(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "to=0");
        require(amount <= accumulatedFees, "exceeds fees");
        accumulatedFees -= amount;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "transfer failed");
    }

    // ---------------------------------------------------------------
    // Registration — called once per token, by the factory, right after it
    // deploys a fresh AromaToken (which mints the full supply here).
    // ---------------------------------------------------------------

    function registerToken(address token, address creator) external onlyFactory {
        require(tokenState[token].creator == address(0), "already registered");
        require(IERC20(token).balanceOf(address(this)) == TOTAL_SUPPLY, "bad supply");
        tokenState[token] = TokenState({realUsdcReserve: 0, tokensSold: 0, creator: creator, graduated: false});
        emit TokenRegistered(token, creator);
    }

    // ---------------------------------------------------------------
    // Trading
    // ---------------------------------------------------------------

    /// @notice Buys `token` with native USDC (msg.value), delivered to
    /// `recipient`. Recipient is a separate parameter from msg.sender —
    /// not for msg.sender's own convenience, but because AromaFactory pays
    /// for a creator's same-transaction dev-buy *as the calling contract*,
    /// so msg.sender inside this function would otherwise resolve to the
    /// factory, not the creator. Everyone else just passes their own
    /// address. This is deliberately the exact same function everyone's
    /// buy runs through, dev-buy included — not a separate discounted path.
    function buy(address token, address recipient, uint256 minTokensOut)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 tokensOut)
    {
        require(recipient != address(0) && recipient != address(this), "bad recipient");
        TokenState storage st = tokenState[token];
        require(st.creator != address(0), "unknown token");
        require(!st.graduated, "graduated");
        require(msg.value > 0, "usdcIn=0");

        uint256 fee = (msg.value * TRADE_FEE_BPS) / FEE_DENOMINATOR;
        uint256 usdcInNet = msg.value - fee;
        uint256 creatorFee = (fee * CREATOR_FEE_SHARE_BPS) / FEE_DENOMINATOR;

        tokensOut = _buyQuote(st.realUsdcReserve, st.tokensSold, usdcInNet);
        // A trade too small to move the curve by one wei of token would
        // otherwise take the fee and hand back nothing.
        require(tokensOut > 0, "amount too small");
        require(tokensOut >= minTokensOut, "slippage");
        require(st.tokensSold + tokensOut <= CURVE_SUPPLY, "exceeds curve supply");
        // Intentionally a hard revert rather than a partial fill + refund
        // when a buy would overshoot the curve's remaining supply — see
        // this function's own test coverage for the reasoning: partial-fill
        // UX is a real future improvement, not a silent gap, but it adds
        // real surface area this first version deliberately avoids.

        // Effects before interactions.
        st.realUsdcReserve += usdcInNet;
        st.tokensSold += tokensOut;
        creatorFeesAccrued[token] += creatorFee;
        accumulatedFees += fee - creatorFee;

        emit Bought(token, recipient, msg.sender, msg.value, fee, creatorFee, tokensOut);

        // Interaction: our own token's transfer, not an arbitrary external
        // call — no reentrancy surface here (OZ ERC20 has no hooks), but
        // nonReentrant still applies as defense-in-depth.
        require(IERC20(token).transfer(recipient, tokensOut), "token transfer failed");
    }

    /// @notice Sells `tokenAmount` of `token` for native USDC. Uses
    /// EIP-2612 permit so the whole trade — approve + sell — is one signed
    /// transaction, matching the single-tx buy path (native USDC needs no
    /// approve at all; this is the closest sells can get to that).
    function sell(
        address token,
        uint256 tokenAmount,
        uint256 minUsdcOut,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant whenNotPaused returns (uint256 usdcOut) {
        TokenState storage st = tokenState[token];
        require(st.creator != address(0), "unknown token");
        require(!st.graduated, "graduated");
        require(tokenAmount > 0, "tokenAmount=0");

        IERC20Permit(token).permit(msg.sender, address(this), tokenAmount, permitDeadline, v, r, s);
        require(IERC20(token).transferFrom(msg.sender, address(this), tokenAmount), "token pull failed");

        uint256 usdcOutGross = _sellQuote(st.realUsdcReserve, st.tokensSold, tokenAmount);
        uint256 fee = (usdcOutGross * TRADE_FEE_BPS) / FEE_DENOMINATOR;
        uint256 creatorFee = (fee * CREATOR_FEE_SHARE_BPS) / FEE_DENOMINATOR;
        usdcOut = usdcOutGross - fee;
        require(usdcOut > 0, "amount too small");
        require(usdcOut >= minUsdcOut, "slippage");

        // Effects before the risky leg. This ordering is the whole point —
        // see the contract-level NatSpec: a native-USDC payout to an
        // arbitrary caller is the sharpest reentrancy surface in this
        // contract, so every balance this trade touches is final before
        // that external call happens.
        st.realUsdcReserve -= usdcOutGross;
        st.tokensSold -= tokenAmount;
        creatorFeesAccrued[token] += creatorFee;
        accumulatedFees += fee - creatorFee;

        emit Sold(token, msg.sender, tokenAmount, usdcOut, fee, creatorFee);

        // Interaction, deliberately last.
        (bool ok,) = msg.sender.call{value: usdcOut}("");
        require(ok, "usdc transfer failed");
    }

    /// @notice Moves a fully-raised token off the curve. Permissionless —
    /// anyone can call this once the threshold is hit, not just an
    /// Aroma-run keeper, so the product doesn't depend on Aroma operating a
    /// bot for graduation to actually happen.
    /// @dev What "graduating" means today is intentionally incomplete: it
    /// sends the seed USDC + reserved tokens to `graduationVault` rather
    /// than actually seeding a Uniswap v4 pool. That's not an oversight —
    /// Uniswap v4's exact reachability and integration shape on Arc testnet
    /// is unverified as of this contract being written (see the project
    /// plan's §3/§9 open items), and this contract would rather hold funds
    /// safely at a known address than guess at an unverified external
    /// protocol's interface. Replacing this with real pool-seeding is a
    /// named blocker before Phase 7 (mainnet), not a later nice-to-have.
    function graduate(address token) external nonReentrant whenNotPaused {
        TokenState storage st = tokenState[token];
        require(st.creator != address(0), "unknown token");
        require(!st.graduated, "already graduated");
        require(st.realUsdcReserve >= GRADUATION_RAISE_USDC, "not ready");

        st.graduated = true;
        uint256 graduationFee = GRADUATION_FEE_USDC;
        uint256 usdcSeed = st.realUsdcReserve - graduationFee;
        uint256 tokenSeed = TOTAL_SUPPLY - st.tokensSold; // == LP_RESERVE_SUPPLY in the exact-graduation case

        // Zero the reserve: this USDC is about to physically leave the
        // contract, so leaving the figure standing would claim backing
        // that isn't here any more. Nothing reads it after graduation
        // today, but the contract's solvency invariant — native balance
        // covers every reserve plus every unclaimed fee — has to hold at
        // all times, not just where a current code path happens to look.
        st.realUsdcReserve = 0;
        accumulatedFees += graduationFee;

        emit Graduated(token, usdcSeed, tokenSeed, graduationFee);

        (bool ok,) = graduationVault.call{value: usdcSeed}("");
        require(ok, "vault transfer failed");
        require(IERC20(token).transfer(graduationVault, tokenSeed), "token vault transfer failed");
    }

    /// @notice Deposits post-graduation swap fees for `token`, split the
    /// same 70/30 creator/protocol way as pre-graduation trade fees, into
    /// the exact same `creatorFeesAccrued` ledger buy()/sell() use —
    /// claimCreatorFees works identically whether a creator's balance came
    /// from curve trading or from this. Mirrors Pons V2's own architecture:
    /// their post-graduation Uniswap v4 fees are "realised through fee
    /// swept events" — this is that sweep's landing point on our side.
    /// @dev Not yet restricted to a specific caller because there is no
    /// real hook to restrict it to — see graduate()'s NatSpec on why
    /// pool-seeding itself is still stubbed. Callable by anyone today,
    /// which is safe (this can only credit value the caller actually
    /// attaches — it has no path to fabricate or redirect existing funds),
    /// but should be locked to this token's real v4 hook address once that
    /// hook exists, so the event log stays a trustworthy record of real
    /// swept fees rather than anyone-can-call noise.
    function depositGraduatedFees(address token) external payable nonReentrant {
        TokenState storage st = tokenState[token];
        require(st.graduated, "not graduated");
        require(msg.value > 0, "amount=0");

        uint256 creatorFee = (msg.value * CREATOR_FEE_SHARE_BPS) / FEE_DENOMINATOR;
        creatorFeesAccrued[token] += creatorFee;
        accumulatedFees += msg.value - creatorFee;

        emit GraduatedFeesDeposited(token, msg.sender, msg.value, creatorFee);
    }

    /// @notice Pays out a token's creator their full accrued fee balance —
    /// pre-graduation trade fees and post-graduation swept fees alike, no
    /// distinction on this side. Anyone can call this (not just the
    /// creator), but funds only ever go to the recorded creator address;
    /// the permissionless pattern here matches graduate() — the product
    /// doesn't depend on the creator remembering to claim, or on Aroma
    /// operating anything, for a payout to happen.
    function claimCreatorFees(address token) external nonReentrant whenNotPaused {
        TokenState storage st = tokenState[token];
        require(st.creator != address(0), "unknown token");
        uint256 amount = creatorFeesAccrued[token];
        require(amount > 0, "nothing to claim");

        // Effects before interaction — same reasoning as sell()'s payout.
        creatorFeesAccrued[token] = 0;

        emit CreatorFeesClaimed(token, st.creator, amount);

        (bool ok,) = st.creator.call{value: amount}("");
        require(ok, "transfer failed");
    }

    // ---------------------------------------------------------------
    // Quotes — read-only, same math as the real trade functions. Factored
    // out specifically so the UI's displayed price/impact/slippage can
    // never silently drift from what execution actually does; call these,
    // don't reimplement the formula client-side.
    // ---------------------------------------------------------------

    function quoteBuy(address token, uint256 usdcIn) external view returns (uint256 tokensOut, uint256 fee) {
        TokenState storage st = tokenState[token];
        require(st.creator != address(0), "unknown token");
        fee = (usdcIn * TRADE_FEE_BPS) / FEE_DENOMINATOR;
        tokensOut = _buyQuote(st.realUsdcReserve, st.tokensSold, usdcIn - fee);
    }

    function quoteSell(address token, uint256 tokenAmount) external view returns (uint256 usdcOut, uint256 fee) {
        TokenState storage st = tokenState[token];
        require(st.creator != address(0), "unknown token");
        uint256 gross = _sellQuote(st.realUsdcReserve, st.tokensSold, tokenAmount);
        fee = (gross * TRADE_FEE_BPS) / FEE_DENOMINATOR;
        usdcOut = gross - fee;
    }

    // ---------------------------------------------------------------
    // Internal curve math. Pure functions, fully covered by fuzz tests —
    // see test/CurveManager.t.sol — because this is the highest-stakes
    // arithmetic in the whole contract.
    // ---------------------------------------------------------------

    /// @dev Rounds the post-trade virtual+real token reserve *up*, which
    /// rounds `tokensOut` *down*. Protocol-favoring on every single trade,
    /// by however small a margin — the alternative (rounding down the
    /// reserve) would let a trader extract a systematic, repeatable edge.
    function _buyQuote(uint256 realUsdcReserve, uint256 tokensSold, uint256 usdcInNet)
        internal
        pure
        returns (uint256 tokensOut)
    {
        uint256 effUsdc = VIRTUAL_USDC_RESERVE + realUsdcReserve;
        uint256 effToken = VIRTUAL_TOKEN_RESERVE - tokensSold;
        uint256 newEffUsdc = effUsdc + usdcInNet;
        uint256 newEffToken = Math.ceilDiv(K, newEffUsdc);
        tokensOut = effToken - newEffToken;
    }

    /// @dev Mirror of _buyQuote: rounds the post-trade USDC reserve *up*,
    /// which rounds `usdcOutGross` *down*. Same protocol-favoring direction,
    /// applied to the other side of the same formula.
    function _sellQuote(uint256 realUsdcReserve, uint256 tokensSold, uint256 tokenAmount)
        internal
        pure
        returns (uint256 usdcOutGross)
    {
        uint256 effUsdc = VIRTUAL_USDC_RESERVE + realUsdcReserve;
        uint256 effToken = VIRTUAL_TOKEN_RESERVE - tokensSold;
        uint256 newEffToken = effToken + tokenAmount;
        uint256 newEffUsdc = Math.ceilDiv(K, newEffToken);
        usdcOutGross = effUsdc - newEffUsdc;
    }
}
