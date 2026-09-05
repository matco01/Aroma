"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useCreateToken } from "@/lib/use-trade";
import { IMAGE_RULES, checkImageFile, checkImageDimensions } from "@/lib/image-rules";
import { CURVE, marketCapAfterRaise } from "@/lib/arc";
import { compact, usd } from "@/lib/format";
import { CoinArt } from "./coin-art";
import { GraduationBar } from "./primitives";
import { useWallet } from "./wallet";

export function CreateForm() {
  const { connected, usdcBalance, connect } = useWallet();
  const { create, phase, error, tokenAddress, reset } = useCreateToken();
  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [description, setDescription] = useState("");
  const [devBuy, setDevBuy] = useState("");
  const [website, setWebsite] = useState("");
  const [x, setX] = useState("");
  const [telegram, setTelegram] = useState("");

  // Image upload. The preview is a local object URL so it appears the
  // instant a file is chosen, rather than after a round trip to IPFS —
  // pinning takes a second or two and staring at an empty box in the
  // meantime makes the whole form feel broken.
  const [imagePreview, setImagePreview] = useState<string>("");
  const [metadataUri, setMetadataUri] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const devBuyValue = Number(devBuy) || 0;
  // Measured on Arc testnet: deploying a token through the factory costs
  // ~1.22M gas at roughly 24 gwei effective. The earlier estimate here
  // was 0.0021 and was wrong by more than 10x, which is exactly the kind
  // of thing only a real network tells you.
  const networkFee = 0.0296;
  // No creation fee — launching costs gas and, optionally, whatever the
  // creator chooses to put into their own first buy.
  const total = devBuyValue + networkFee;

  // Hue is derived from the ticker so the preview art is stable as you type.
  const hue = useMemo(() => {
    let h = 0;
    for (const ch of ticker || "Aroma") h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }, [ticker]);
  const seed = useMemo(() => {
    let s = 7;
    for (const ch of (name + ticker) || "Aroma") s = (s * 33 + ch.charCodeAt(0)) >>> 0;
    return s;
  }, [name, ticker]);

  const nameError = name.length > 32 ? "Max 32 characters" : null;
  const tickerError =
    ticker.length > 10 ? "Max 10 characters" : null;
  const valid =
    name.trim().length > 0 &&
    ticker.trim().length > 0 &&
    !nameError &&
    !tickerError;
  const insufficient = connected && total > usdcBalance;

  async function submit() {
    if (!connected) return connect();
    if (!valid || insufficient) return;
    await create(name.trim(), ticker.trim(), description.trim(), devBuy || "0", metadataUri);
  }

  const busy = phase === "signing" || phase === "pending" || uploading;

  /**
   * Reads dimensions in the browser without decoding the whole image, so a
   * file that is never going to be accepted is rejected instantly instead
   * of after uploading megabytes. The server checks again regardless —
   * this is a courtesy, not the gate.
   */
  function measure(objectUrl: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve({ width: 0, height: 0 });
      img.src = objectUrl;
    });
  }

  async function onPickImage(file: File | undefined) {
    if (!file) return;
    setUploadError(null);
    setMetadataUri("");

    const fileProblem = checkImageFile(file.type, file.size);
    if (fileProblem) {
      setUploadError(fileProblem);
      setImagePreview("");
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const { width, height } = await measure(objectUrl);
    const dimensionProblem = checkImageDimensions(width, height);
    if (dimensionProblem) {
      setUploadError(dimensionProblem);
      setImagePreview("");
      URL.revokeObjectURL(objectUrl);
      return;
    }

    setImagePreview(objectUrl);
    setUploading(true);
    try {
      const body = new FormData();
      body.append("image", file);
      body.append("name", name.trim());
      body.append("symbol", ticker.trim());
      body.append("description", description.trim());

      const res = await fetch("/api/upload", { method: "POST", body });
      const json = (await res.json()) as { metadataUri?: string; error?: string };
      if (!res.ok || !json.metadataUri) {
        throw new Error(json.error ?? "Upload failed");
      }
      setMetadataUri(json.metadataUri);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Upload failed");
      // Keep the preview: the picture they chose is still the picture they
      // want, and clearing it would look like the file was rejected.
    } finally {
      setUploading(false);
    }
  }

  if (phase === "success") {
    return (
      <div className="mx-auto max-w-md rounded-md border border-line bg-surface p-5 text-center">
        <div className="mx-auto w-fit">
          <CoinArt seed={seed} hue={hue} size={56} radius={6} imageUrl={imagePreview} alt={name} />
        </div>
        <h2 className="mt-3 text-[15px] font-semibold text-ink">
          {name} is live
        </h2>
        <p className="num mt-1 text-[12px] text-ink-2">${ticker}</p>
        <dl className="mt-4 space-y-1.5 border-t border-line pt-4 text-left">
          <Summary label="Supply" value={`${compact(CURVE.totalSupply)} fixed`} />
          <Summary label="Paid" value={usd(total)} />
          <Summary label="Your allocation" value={devBuyValue > 0 ? usd(devBuyValue) : "None"} />
          <Summary label="Graduates at" value={`${usd(CURVE.graduationMarketCapUsd)} mcap`} />
        </dl>
        <p className="mt-4 text-[11.5px] leading-relaxed text-ink-3">
          The curve is open and anyone can buy.
        </p>
        <div className="mt-4 flex gap-2">
          <button
            onClick={reset}
            className="h-8 flex-1 rounded-sm border border-line text-[12.5px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
          >
            Launch another
          </button>
          <Link
            href={tokenAddress ? `/coin/${tokenAddress}` : "/"}
            className="flex h-8 flex-1 items-center justify-center rounded-sm bg-accent text-[12.5px] font-medium text-white transition-colors hover:bg-accent-hi"
          >
            {tokenAddress ? "View token" : "Back to board"}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
      {/* One panel, not three.
          
          Identity / Links / First buy were three bordered boxes stacked
          down the page, which is a lot of chrome for eight fields, and the
          helper prose under half of them explained things to someone who
          had already decided to launch. Name and ticker sit side by side
          because they are one thought, and so do the two socials. */}
      <div className="min-w-0">
        <div className="rounded-md border border-line bg-surface p-5">
          <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">
            Launch a coin
          </h1>

          <div className="mt-5 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" error={nameError} hint={`${name.length}/32`}>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Dollar Doge"
                  className={inputClass}
                />
              </Field>

              <Field label="Ticker" error={tickerError} hint={`${ticker.length}/10`}>
                <div className="flex items-center rounded-sm border border-line bg-bg px-2.5 focus-within:border-line-strong">
                  <span className="num text-[14px] text-ink-3">$</span>
                  <input
                    value={ticker}
                    onChange={(e) =>
                      setTicker(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
                    }
                    placeholder="DOGEUSD"
                    className="num h-11 flex-1 bg-transparent pl-1 text-[14px] text-ink outline-none placeholder:text-ink-3"
                  />
                </div>
              </Field>
            </div>

            <Field label="Description" hint={`${description.length}/200`}>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value.slice(0, 200))}
                rows={3}
                placeholder="What is this coin about?"
                className={`${inputClass} resize-none py-2`}
              />
            </Field>

            <Field label="Image" hint="optional">
              <label
                className={`flex cursor-pointer items-center gap-3 rounded-sm border border-dashed bg-bg px-3.5 py-3 transition-colors ${
                  uploadError ? "border-down/50" : "border-line hover:border-line-strong"
                }`}
              >
                <CoinArt
                  seed={seed}
                  hue={hue}
                  size={38}
                  radius={5}
                  imageUrl={imagePreview}
                  alt=""
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-ink-2">
                    {uploading
                      ? "Pinning to IPFS…"
                      : metadataUri
                        ? "Pinned to IPFS"
                        : "Choose image"}
                  </span>
                  <span className="block truncate text-[11px] text-ink-3">
                    {uploadError
                      ? uploadError
                      : `PNG, JPG, GIF or WebP · ${IMAGE_RULES.minDimension}–${IMAGE_RULES.maxDimension}px`}
                  </span>
                </span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  disabled={uploading}
                  onChange={(e) => onPickImage(e.target.files?.[0])}
                  className="hidden"
                />
              </label>
            </Field>

            {/* Shown, not hidden behind a toggle. Links are what a coin
                gets judged on — a launch with no X account reads as a rug,
                and a disclosure this load-bearing should not need
                discovering. */}
            <div className="space-y-4">
                <Field label="Website">
                  <input
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="https://"
                    className={inputClass}
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="X">
                    <input
                      value={x}
                      onChange={(e) => setX(e.target.value)}
                      placeholder="@handle"
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Telegram">
                    <input
                      value={telegram}
                      onChange={(e) => setTelegram(e.target.value)}
                      placeholder="t.me/"
                      className={inputClass}
                    />
                  </Field>
                </div>
            </div>

            <Field
              label="First buy"
              hint="optional · public as a dev holding"
            >
              <div className="flex items-center rounded-sm border border-line bg-bg px-2.5 focus-within:border-line-strong">
                <input
                  value={devBuy}
                  onChange={(e) => {
                    if (/^\d*\.?\d*$/.test(e.target.value)) setDevBuy(e.target.value);
                  }}
                  inputMode="decimal"
                  placeholder="0.00"
                  className="num h-11 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
                />
                <span className="num text-[12px] text-ink-2">USDC</span>
              </div>
            </Field>
          </div>
        </div>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-16 lg:self-start">
        <div className="rounded-md border border-line bg-surface p-3.5">
          <div className="label mb-2.5">Preview</div>
          <div className="flex items-start gap-2.5">
            <CoinArt seed={seed} hue={hue} size={40} imageUrl={imagePreview} alt={name} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-ink">
                {name || "Untitled"}
              </div>
              <div className="num mt-0.5 text-[11px] text-ink-2">
                ${ticker || "TICKER"}
              </div>
            </div>
          </div>
          <p className="mt-2.5 line-clamp-2 min-h-[2.6em] text-[11.5px] leading-relaxed text-ink-2">
            {description || "No description yet."}
          </p>
          <div className="mt-3">
            <GraduationBar marketCapUsd={marketCapAfterRaise(devBuyValue)} graduated={false} showLabel />
          </div>
        </div>

        <div className="rounded-md border border-line bg-surface p-3.5">
          <div className="label mb-2.5">Cost</div>
          <dl className="space-y-1.5">
            <Summary label="Creation fee" value="Free" />
            <Summary
              label="First buy"
              value={devBuyValue > 0 ? usd(devBuyValue) : "—"}
            />
            <Summary
              label="Network fee"
              value={`$${networkFee.toFixed(4)}`}
              hint="paid in USDC"
            />
            <div className="border-t border-line pt-1.5">
              <Summary label="Total" value={usd(total)} strong />
            </div>
          </dl>

          {/* One line, not a paragraph. The cost panel is scanned, not
              read, and burying the earnings pitch in four sentences of
              caveats meant nobody reached the end of it. */}
          <div className="mt-3 flex items-baseline justify-between border-t border-line pt-3">
            <span className="text-[12px] text-up">You earn</span>
            <span className="num text-[12.5px] text-up">
              {CURVE.creatorFeeShareBps / 100}% of every trade
            </span>
          </div>

          <button
            onClick={submit}
            disabled={connected && (!valid || insufficient || busy)}
            className="mt-3.5 h-10 w-full rounded-sm bg-accent text-[13px] font-medium text-white transition-colors hover:bg-accent-hi disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-ink-3"
          >
            {!connected
              ? "Connect wallet to launch"
              : phase === "signing"
                ? "Confirm in wallet…"
                : phase === "pending"
                  ? "Deploying…"
                  : insufficient
                  ? "Insufficient USDC"
                  : !valid
                    ? "Name and ticker required"
                    : "Launch coin"}
          </button>

          {error && (
            <p className="slide-in mt-2.5 rounded-sm border border-down/25 bg-down/8 px-2.5 py-2 text-[11px] text-down">
              {error}
            </p>
          )}

          <p className="mt-2.5 text-[10.5px] leading-relaxed text-ink-3">
            Supply is fixed at {compact(CURVE.totalSupply)} and the contract has
            no mint function. Deployment is irreversible.
          </p>
        </div>
      </aside>
    </div>
  );
}

/**
 * Deliberately larger than the rest of the app.
 *
 * A board is scanned, so it wants density; a form is filled in, and the
 * same 10px-tall inputs that read as tidy in a table read as cramped when
 * someone is typing into them. Bigger targets are also the difference
 * between usable and not on a phone.
 */
const inputClass =
  "h-11 w-full rounded-sm border border-line bg-bg px-3 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-line-strong";

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <label className="text-[12.5px] text-ink-2">{label}</label>
        {error ? (
          <span className="text-[11px] text-down">{error}</span>
        ) : hint ? (
          <span className="num text-[11px] text-ink-3">{hint}</span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function Summary({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[11.5px] text-ink-2">
        {label}
        {hint && <span className="ml-1 text-[10px] text-ink-3">{hint}</span>}
      </dt>
      <dd className={`num text-[11.5px] ${strong ? "text-ink" : "text-ink-2"}`}>
        {value}
      </dd>
    </div>
  );
}
