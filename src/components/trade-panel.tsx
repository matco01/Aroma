"use client";

import { useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { formatUnits, type Address } from "viem";
import type { Coin } from "@/lib/mock";
import { CURVE } from "@/lib/arc";
import { compact, usd, usdExact } from "@/lib/format";
import { aromaTokenAbi } from "@/lib/abis";
import { useTrade } from "@/lib/use-trade";
import { useWallet } from "./wallet";
import { TradeToast, type TradeToastData } from "./trade-toast";

type Side = "buy" | "sell";

const PRESETS = [1, 2, 5, 10];
const SLIPPAGE_PRESETS = [0.5, 1, 3];

/**
 * The trade ticket — broadcasting real transactions.
 *
 * The Arc-specific win is the cost summary: trade fee *and* network fee are
 * both USDC, so the panel shows one honest total. On any other chain that
 * line needs a gas-token price feed and a disclaimer.
 *
 * Amounts are quoted against the live curve immediately before submission
 * and the resulting minimum is enforced on-chain, so a trade that moves
 * against the user between quote and inclusion reverts rather than filling
 * worse than shown.
 */
export function TradePanel({ coin }: { coin: Coin }) {
  const { connected, usdcBalance, connect } = useWallet();
  const { address } = useAccount();
  const [side, setSide] = useState<Side>("buy");
  /**
   * `amount` is always USDC — it is what the contract takes and what every
   * quote is denominated in. The token field is a view onto it, converted
   * at the current spot price.
   *
   * Kept as separate strings rather than one number so a half-typed "0."
   * survives, and so the field being typed into is never reformatted under
   * the cursor.
   */
  const [amount, setAmount] = useState("");
  const [tokenAmountText, setTokenAmountText] = useState("");
  const [slippage, setSlippage] = useState(1);
  const [customSlippage, setCustomSlippage] = useState("");
  const [editingSlippage, setEditingSlippage] = useState(false);
  const [toast, setToast] = useState<TradeToastData | null>(null);

  const { buy, sell, phase, error, reset } = useTrade(coin.contract);

  const isBuy = side === "buy";
  const isCustomSlippage = !SLIPPAGE_PRESETS.includes(slippage);
  const busy = phase === "quoting" || phase === "signing" || phase === "pending";

  // Real token balance for this coin, straight from its own contract.
  const { data: rawBalance, refetch: refetchBalance } = useReadContract({
    address: coin.contract as Address,
    abi: aromaTokenAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });

  const heldRaw = (rawBalance as bigint | undefined) ?? 0n;
  const held = Number(formatUnits(heldRaw, 18));
  const heldValue = held * coin.priceUsd;

  /**
   * What Max can safely spend.
   *
   * Naively `balance - a bit` overshoots every time, because the amount
   * typed is not the amount that leaves: total = value + value*fee + gas.
   * Solving it properly:
   *
   *     value * (1 + feeRate) + buyGas + sellReserve <= balance
   *
   * The sell reserve is the part people get bitten by. Spending to the last
   * cent leaves a position that cannot be sold, because selling costs gas
   * too — and on a chain where gas is the same asset you just spent, that
   * traps the position. Holding back a few cents is the difference between
   * a balance and a balance you can act on.
   */
  const SELL_RESERVE = 0.02;
  const maxSpendable = Math.max(
    0,
    (usdcBalance - 0.0017 - SELL_RESERVE) / (1 + CURVE.tradeFeeBps / 10_000),
  );

  const value = Number(amount) || 0;

  /** Typing USDC: the token side follows. */
  function setPayAmount(v: string) {
    if (!/^\d*\.?\d*$/.test(v)) return;
    setAmount(v);
    const n = Number(v) || 0;
    setTokenAmountText(
      n > 0 && coin.priceUsd > 0 ? String(Math.round(n / coin.priceUsd)) : "",
    );
    if (phase === "error") reset();
  }

  /**
   * Typing tokens: the USDC side follows.
   *
   * Converted at spot, which is deliberately an estimate — the curve moves
   * as the trade fills, so the true cost is only known at execution. The
   * quote that actually binds is taken on submit and enforced on-chain,
   * so this is a preview, not a promise.
   */
  function setTokenAmountText_(v: string) {
    if (!/^\d*\.?\d*$/.test(v)) return;
    setTokenAmountText(v);
    const n = Number(v) || 0;
    setAmount(n > 0 && coin.priceUsd > 0 ? (n * coin.priceUsd).toFixed(6) : "");
    if (phase === "error") reset();
  }
  const tradeFee = value * (CURVE.tradeFeeBps / 10_000);
  // Measured on Arc testnet: a buy costs ~70k gas and a sell ~110k (permit
  // verification is the difference), at roughly 24 gwei effective.
  const networkFee = isBuy ? 0.0017 : 0.0027;
  const total = isBuy ? value + tradeFee + networkFee : value - tradeFee - networkFee;
  const tokens = coin.priceUsd > 0 ? value / coin.priceUsd : 0;

  const remaining = Math.max(1, CURVE.graduationTargetUsd - coin.raisedUsd);
  const impact = coin.graduated
    ? (value / (coin.marketCapUsd * 0.12)) * 100
    : (value / remaining) * 12;

  const insufficientUsdc = isBuy && connected && total > usdcBalance;
  const insufficientTokens = !isBuy && connected && tokens > held;
  const blocked = insufficientUsdc || insufficientTokens;
  const canSubmit = connected && value > 0 && !blocked && !busy && !coin.graduated;


  function commitCustomSlippage() {
    const n = parseFloat(customSlippage);
    if (Number.isFinite(n) && n > 0) setSlippage(Math.min(50, n));
    setEditingSlippage(false);
  }

  async function submit() {
    if (!connected) return connect();
    if (!canSubmit) return;

    // Capture what the confirmation should say before state resets.
    const confirmedTokens = compact(Math.round(tokens));
    const confirmedUsd = usd(Math.max(0, total));

    let ok = false;
    if (isBuy) {
      ok = await buy(amount, slippage);
    } else {
      // Sell by token amount, derived from the USDC figure typed in.
      const portion = heldValue > 0 ? Math.min(1, value / heldValue) : 0;
      const tokenAmount =
        portion >= 0.999 ? heldRaw : (heldRaw * BigInt(Math.round(portion * 1e6))) / 1_000_000n;
      if (tokenAmount > 0n) ok = await sell(tokenAmount, slippage);
    }

    // Confirm only once the transaction actually mined — the hook resolves
    // true after waitForTransactionReceipt, not on submission.
    if (ok) {
      setToast({
        id: Date.now(),
        side,
        ticker: coin.ticker,
        tokens: confirmedTokens,
        usd: confirmedUsd,
        seed: coin.seed,
        hue: coin.hue,
      });
      setAmount("");
      setTokenAmountText("");
      refetchBalance();
      reset();
    }
  }

  function buttonLabel() {
    if (!connected) return "Connect wallet to trade";
    if (coin.graduated) return "Graduated — trades on the DEX";
    if (phase === "quoting") return "Quoting…";
    if (phase === "signing") return "Confirm in wallet…";
    if (phase === "pending") return "Submitting…";
    if (insufficientUsdc) return "Insufficient USDC";
    if (insufficientTokens) return `Not enough ${coin.ticker}`;
    if (value === 0) return "Enter an amount";
    return `${isBuy ? "Buy" : "Sell"} ${coin.ticker}`;
  }

  return (
    <>
      <div className="rounded-md border border-line bg-surface">
        <div className="grid grid-cols-2 border-b border-line p-1.5">
          {(["buy", "sell"] as Side[]).map((s) => {
            const active = side === s;
            const tone = s === "buy" ? "bg-up/12 text-up" : "bg-down/12 text-down";
            return (
              <button
                key={s}
                onClick={() => {
                  setSide(s);
                  setAmount("");
                  setTokenAmountText("");
                  reset();
                }}
                className={`rounded-sm py-2 text-[12.5px] font-medium capitalize transition-colors ${
                  active ? tone : "text-ink-2 hover:text-ink"
                }`}
              >
                {s}
              </button>
            );
          })}
        </div>

        <div className="p-3.5">
          {/* Two boxes, either one editable.
              
              A bonding curve is a swap, so it should behave like one:
              somebody deciding "I want 100k of this" should not have to
              work out the USDC themselves. Typing in either box fills the
              other. */}
          <AmountBox
            label={isBuy ? "You pay" : "You sell"}
            symbol={isBuy ? "USDC" : coin.ticker}
            value={isBuy ? amount : tokenAmountText}
            onChange={(v) => (isBuy ? setPayAmount(v) : setTokenAmountText_(v))}
            secondary={
              isBuy
                ? `Balance ${usdExact(usdcBalance)}`
                : `Holding ${compact(Math.round(held))}`
            }
            disabled={busy}
            invalid={blocked}
          />

          <div className="relative my-1.5 flex justify-center">
            <button
              onClick={() => {
                setSide(isBuy ? "sell" : "buy");
                setAmount("");
                setTokenAmountText("");
                reset();
              }}
              aria-label="Switch between buying and selling"
              className="flex h-7 w-7 items-center justify-center rounded-full border border-line bg-surface-2 text-ink-3 transition-colors hover:border-line-strong hover:text-ink"
            >
              <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden>
                <path
                  d="M3 1.5v8M3 9.5 1.2 7.7M8 9.5v-8M8 1.5l1.8 1.8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          <AmountBox
            label={isBuy ? "You receive" : "You get"}
            symbol={isBuy ? coin.ticker : "USDC"}
            value={isBuy ? tokenAmountText : amount}
            onChange={(v) => (isBuy ? setTokenAmountText_(v) : setPayAmount(v))}
            secondary={isBuy ? `≈ ${usd(value)}` : `≈ ${usd(value)}`}
            disabled={busy}
          />

          <div className="mt-2.5 flex gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => setPayAmount(String(p))}
                disabled={busy}
                className="num flex-1 rounded-sm border border-line py-2 text-[12px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
              >
                ${p}
              </button>
            ))}
            <button
              onClick={() =>
                setPayAmount(
                  isBuy
                    ? // Floor rather than round, so rounding can never push
                      // the total back over the balance.
                      (Math.floor(maxSpendable * 10_000) / 10_000).toFixed(4)
                    : heldValue.toFixed(4),
                )
              }
              disabled={busy}
              className="num flex-1 rounded-sm border border-line py-2 text-[12px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
            >
              Max
            </button>
          </div>

          {/* One line instead of four rows.
              
              Network fee and total cost were their own rows for a fee of
              $0.0017 — four-hundredths of a cent. Stating it that loudly
              made a rounding error look like a decision the reader had to
              make. Price impact stays because on a curve it is real, and
              it moves into the same line rather than above it. */}
          <p className="mt-3 text-[11px] text-ink-3">
            Routed through the bonding curve
            {value > 0 && (
              <>
                {" · "}
                <span className={impact > 5 ? "text-warn" : ""}>
                  {impact.toFixed(2)}% impact
                </span>
                {" · "}
                {CURVE.tradeFeeBps / 100}% fee
              </>
            )}
          </p>

          <div className="mt-3.5 flex items-center gap-2">
            <span className="label shrink-0">Max slippage</span>
            <div className="flex flex-1 gap-1">
              {SLIPPAGE_PRESETS.map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setSlippage(s);
                    setEditingSlippage(false);
                  }}
                  className={`num flex-1 rounded-sm border py-1 text-[11px] transition-colors ${
                    !editingSlippage && slippage === s
                      ? "border-line-strong bg-surface-3 text-ink"
                      : "border-line text-ink-3 hover:text-ink-2"
                  }`}
                >
                  {s}%
                </button>
              ))}

              {editingSlippage ? (
                <div className="flex flex-1 items-center rounded-sm border border-accent bg-bg px-1.5">
                  <input
                    autoFocus
                    value={customSlippage}
                    onChange={(e) => {
                      if (/^\d*\.?\d*$/.test(e.target.value)) setCustomSlippage(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitCustomSlippage();
                      if (e.key === "Escape") setEditingSlippage(false);
                    }}
                    onBlur={commitCustomSlippage}
                    inputMode="decimal"
                    placeholder="0.0"
                    aria-label="Custom slippage percent"
                    className="num w-full min-w-0 bg-transparent py-1 text-[11px] text-ink outline-none placeholder:text-ink-3"
                  />
                  <span className="num text-[10px] text-ink-3">%</span>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setCustomSlippage(isCustomSlippage ? String(slippage) : "");
                    setEditingSlippage(true);
                  }}
                  className={`num flex-1 rounded-sm border py-1 text-[11px] transition-colors ${
                    isCustomSlippage
                      ? "border-line-strong bg-surface-3 text-ink"
                      : "border-line text-ink-3 hover:text-ink-2"
                  }`}
                >
                  {isCustomSlippage ? `${slippage}%` : "Custom"}
                </button>
              )}
            </div>
          </div>

          <button
            onClick={submit}
            disabled={connected && !canSubmit}
            className={`mt-3.5 h-11 w-full rounded-sm text-[13.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-ink-3 ${
              !connected
                ? "bg-accent text-white hover:bg-accent-hi"
                : isBuy
                  ? "bg-up text-bg hover:brightness-110"
                  : "bg-down text-bg hover:brightness-110"
            }`}
          >
            {buttonLabel()}
          </button>

          {error && (
            <p className="slide-in mt-2.5 rounded-sm border border-down/25 bg-down/8 px-2.5 py-2 text-[11px] text-down">
              {error}
            </p>
          )}

          <p className="mt-3 text-[10.5px] leading-relaxed text-ink-3">
            Your wallet signs and submits this trade. Aroma never holds your funds.
          </p>
        </div>
      </div>

      {toast && <TradeToast key={toast.id} data={toast} onDone={() => setToast(null)} />}
    </>
  );
}

/**
 * One side of the swap: a large amount, its unit, and a quiet second line.
 *
 * The number is 28px because it is the thing being decided. It sat at the
 * size of a table cell before, which is the wrong weight for a figure
 * someone is about to commit money to.
 */
function AmountBox({
  label,
  symbol,
  value,
  onChange,
  secondary,
  disabled,
  invalid,
}: {
  label: string;
  symbol: string;
  value: string;
  onChange: (v: string) => void;
  secondary: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <div
      className={`rounded-sm border bg-bg px-3 py-2.5 transition-colors ${
        invalid ? "border-down/50" : "border-line focus-within:border-line-strong"
      }`}
    >
      <div className="flex items-baseline justify-between">
        <span className="label">{label}</span>
        <span className="num text-[11px] text-ink-3">{secondary}</span>
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
          placeholder="0"
          disabled={disabled}
          aria-label={`${label} in ${symbol}`}
          className="num min-w-0 flex-1 bg-transparent text-[28px] leading-tight text-ink outline-none placeholder:text-ink-3 disabled:opacity-50"
        />
        <span className="num shrink-0 text-[13px] text-ink-2">{symbol}</span>
      </div>
    </div>
  );
}

