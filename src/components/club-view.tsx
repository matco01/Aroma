"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useClubAuction, useBidOnClub, useUpdateClubDraft, useWithdrawFromClub } from "@/lib/use-club-auction";
import { CLUB, minNextBidUsdg } from "@/lib/robinhood";
import { IMAGE_RULES, checkImageFile, checkImageDimensions } from "@/lib/image-rules";
import { usdExact, shortAddr, ago } from "@/lib/format";
import type { ClubBidData, ClubData } from "@/lib/use-club-auction";
import { CoinArt } from "./coin-art";
import { useWallet } from "./wallet";

/**
 * The Club: one 24-hour auction, gating every launch.
 *
 * Only the top bidder edits the coin. Everyone else sees it read-only, as
 * the preview of what launches if the lead holds. Outbidding carries the
 * current coin forward unchanged — the contract needs a name and ticker on
 * every bid — and once you're on top, it's yours to rewrite.
 *
 * The one exception is the first bid of a round: there's no coin yet to
 * carry forward, so that bidder names it.
 *
 * Edits stay local and free until the top bidder presses "Save changes"
 * (ClubAuction.updateDraft, which moves no funds). Typing never fires a
 * transaction by itself.
 */
export function ClubView() {
  const { connected, address, connect } = useWallet();
  const { data, isLoading, error: clubError } = useClubAuction();
  const current = data?.current ?? null;

  const { bid, phase: bidPhase, error: bidError } = useBidOnClub();
  const { updateDraft, phase: draftPhase, error: draftError } = useUpdateClubDraft();
  const { withdraw, phase: withdrawPhase } = useWithdrawFromClub();

  const isTopBidder = Boolean(
    connected && address && current?.topBidder?.toLowerCase() === address.toLowerCase(),
  );
  // No bids yet means no coin yet: the first bidder has to name it.
  const hasDraft = Boolean(current?.topBidder);
  const canEdit = isTopBidder || !hasDraft;

  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [x, setX] = useState("");
  const [telegram, setTelegram] = useState("");
  const [bidAmount, setBidAmount] = useState("");
  const [devBuy, setDevBuy] = useState("");

  const [imagePreview, setImagePreview] = useState("");
  const [imageUri, setImageUri] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Sync the editor from the chain when the round or the lead changes hands
  // — never on every poll tick, or the top bidder's unsaved typing would be
  // overwritten out from under them every 7 seconds. Image and links come
  // across too: a save re-pins metadata, and without them it would wipe
  // the coin's picture.
  const syncedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!current) return;
    const key = `${current.id}:${current.topBidder ?? ""}`;
    if (syncedKey.current === key) return;
    syncedKey.current = key;
    setName(current.name);
    setTicker(current.symbol);
    setDescription(current.description);
    setImagePreview(current.imageUrl);
    setImageUri(current.imageUri);
    setWebsite(current.links.website);
    setX(current.links.x);
    setTelegram(current.links.telegram);
  }, [current]);

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(id);
  }, []);

  const secondsLeft = current ? Math.max(0, current.endsAt - now) : 0;
  const ended = current !== null && secondsLeft === 0;

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

  const minBid = current ? minNextBidUsdg(current.topBidUsdg) : CLUB.minOpeningBidUsdg;
  const namesOk = !canEdit || (name.trim().length > 0 && ticker.trim().length > 0);
  const bidValid = namesOk && Number(bidAmount || 0) >= minBid && !ended;

  /**
   * Pins the editor's image and links as metadata. If pinning fails, falls
   * back to the coin's existing metadata rather than an empty URI — losing
   * an edit to a link is recoverable, wiping the coin's picture on-chain is
   * not something the top bidder asked for.
   */
  async function pinMetadata(): Promise<string> {
    if (!imageUri && !website.trim() && !x.trim() && !telegram.trim()) return "";
    const fallback = current?.metadataUri ?? "";
    try {
      const res = await fetch("/api/metadata", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          symbol: ticker.trim(),
          description: description.trim(),
          image: imageUri,
          website: website.trim(),
          x: x.trim(),
          telegram: telegram.trim(),
        }),
      });
      const json = (await res.json()) as { metadataUri?: string };
      return res.ok && json.metadataUri ? json.metadataUri : fallback;
    } catch {
      return fallback;
    }
  }

  async function submitBid() {
    if (!connected) return connect();
    if (!bidValid || !current) return;
    // Outbidding someone keeps their coin exactly as it is — you only get
    // to change it once you're on top.
    const draft = canEdit
      ? {
          name: name.trim(),
          symbol: ticker.trim(),
          description: description.trim(),
          metadataUri: await pinMetadata(),
        }
      : {
          name: current.name,
          symbol: current.symbol,
          description: current.description,
          metadataUri: current.metadataUri,
        };
    await bid(bidAmount, devBuy || "0", draft);
  }

  async function saveDraft() {
    if (!isTopBidder) return;
    const metadataUri = await pinMetadata();
    await updateDraft({
      name: name.trim(),
      symbol: ticker.trim(),
      description: description.trim(),
      metadataUri,
    });
  }

  async function onPickImage(file: File | undefined) {
    if (!file) return;
    setUploadError(null);
    setImageUri("");

    const fileProblem = checkImageFile(file.type, file.size);
    if (fileProblem) {
      setUploadError(fileProblem);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    const dims = await new Promise<{ width: number; height: number }>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve({ width: 0, height: 0 });
      img.src = objectUrl;
    });
    const dimensionProblem = checkImageDimensions(dims.width, dims.height);
    if (dimensionProblem) {
      setUploadError(dimensionProblem);
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
      const json = (await res.json()) as { image?: string; error?: string };
      if (!res.ok || !json.image) throw new Error(json.error ?? "Upload failed");
      setImageUri(json.image);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  const bidBusy = bidPhase === "signing" || bidPhase === "pending";
  const draftBusy = draftPhase === "signing" || draftPhase === "pending";

  if (isLoading && !current) {
    return <div className="mx-auto max-w-[1000px] px-4 py-10 text-center text-ink-2">Loading the Club…</div>;
  }

  if (!current) {
    // A failed fetch and an empty auction are different answers — the first
    // usually means nothing is deployed or indexed yet, and saying "no Club
    // has opened" would imply the contract is live and idle.
    return (
      <div className="mx-auto max-w-[480px] rounded-md border border-line bg-surface px-6 py-12 text-center">
        <p className="text-[14px] text-ink">
          {clubError ? "The Club isn't connected yet" : "No Club has opened yet"}
        </p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">
          {clubError
            ? "The auction contract hasn't been deployed or indexed on Robinhood Chain yet. Once it is, the live round shows here."
            : "The first round opens when the auction contract is deployed."}
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="min-w-0 space-y-4">
        <div className="rounded-md border border-line bg-surface p-5">
          <div className="flex items-baseline justify-between">
            <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">
              Club #{current.id}
            </h1>
            <CountdownBadge secondsLeft={secondsLeft} ended={ended} />
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatBlock label="Top bid" value={usdExact(current.topBidUsdg)} />
            <StatBlock
              label="Top bidder"
              value={current.topBidder ? shortAddr(current.topBidder) : "No bids yet"}
            />
            <StatBlock label="Minimum next bid" value={usdExact(minBid)} />
          </div>

          {isTopBidder && (
            <p className="mt-3 rounded-sm border border-up/25 bg-up/8 px-3 py-2 text-[12px] text-up">
              You&apos;re the top bidder — edit the coin below and save, or place a higher
              bid yourself to be extra safe.
            </p>
          )}
        </div>

        <BidList bids={data?.bids ?? []} topBidder={current.topBidder} you={address} now={now} />

        {canEdit && (
        <div className="rounded-md border border-line bg-surface p-5">
          <h2 className="text-[15px] font-semibold text-ink">
            {isTopBidder ? "Your coin" : "Name the coin"}
          </h2>
          <p className="mt-1 text-[12px] text-ink-2">
            {isTopBidder
              ? "This is what launches if your bid holds. Edit freely — nothing is sent until you save."
              : "No one has bid yet, so the first bidder names the coin. Whoever outbids you takes it over as-is."}
          </p>

          <div className="mt-4 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" hint={`${name.length}/32`}>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, 32))}
                  placeholder="Dollar Doge"
                  className={inputClass}
                />
              </Field>
              <Field label="Ticker" hint={`${ticker.length}/10`}>
                <div className="flex items-center rounded-sm border border-line bg-bg px-2.5 focus-within:border-line-strong">
                  <span className="num text-[14px] text-ink-3">$</span>
                  <input
                    value={ticker}
                    onChange={(e) =>
                      setTicker(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10))
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
                <CoinArt seed={seed} hue={hue} size={38} radius={5} imageUrl={imagePreview} alt="" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-ink-2">
                    {uploading ? "Pinning to IPFS…" : imageUri ? "Pinned to IPFS" : "Choose image"}
                  </span>
                  <span className="block truncate text-[11px] text-ink-3">
                    {uploadError ?? `PNG, JPG, GIF or WebP · ${IMAGE_RULES.minDimension}–${IMAGE_RULES.maxDimension}px`}
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

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Website">
                <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" className={inputClass} />
              </Field>
              <Field label="X">
                <input value={x} onChange={(e) => setX(e.target.value)} placeholder="@handle" className={inputClass} />
              </Field>
              <Field label="Telegram">
                <input value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="t.me/" className={inputClass} />
              </Field>
            </div>
          </div>

          {isTopBidder && (
            <div className="mt-4 border-t border-line pt-4">
              <button
                onClick={saveDraft}
                disabled={draftBusy || !name.trim() || !ticker.trim()}
                className="h-10 w-full rounded-sm border border-line-strong text-[13px] font-medium text-ink transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {draftPhase === "signing" ? "Confirm in wallet…" : draftPhase === "pending" ? "Saving…" : "Save changes"}
              </button>
              {draftError && <p className="mt-2 text-[11px] text-down">{draftError}</p>}
            </div>
          )}
        </div>
        )}
      </div>

      <aside className="space-y-4 lg:sticky lg:top-[calc(var(--header-h)+16px)] lg:self-start">
        {!canEdit ? (
          <ReadOnlyCoin club={current} />
        ) : (
        <div className="rounded-md border border-line bg-surface p-3.5">
          <div className="label mb-2.5">Preview</div>
          <div className="flex items-start gap-2.5">
            <CoinArt seed={seed} hue={hue} size={40} imageUrl={imagePreview} alt={name} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-ink">{name || "Untitled"}</div>
              <div className="num mt-0.5 text-[11px] text-ink-2">${ticker || "TICKER"}</div>
            </div>
          </div>
          <p className="mt-2.5 line-clamp-2 min-h-[2.6em] text-[11.5px] leading-relaxed text-ink-2">
            {description || "No description yet."}
          </p>
        </div>
        )}

        <div className="rounded-md border border-line bg-surface p-3.5">
          <div className="label mb-2.5">{isTopBidder ? "Raise your bid" : "Place a bid"}</div>
          <div className="space-y-2.5">
            <div className="flex items-center rounded-sm border border-line bg-bg px-2.5 focus-within:border-line-strong">
              <input
                value={bidAmount}
                onChange={(e) => /^\d*\.?\d*$/.test(e.target.value) && setBidAmount(e.target.value)}
                inputMode="decimal"
                placeholder={minBid.toString()}
                className="num h-11 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
              />
              <span className="num text-[12px] text-ink-2">USDG</span>
            </div>
            <p className="text-[10.5px] leading-relaxed text-ink-3">
              Minimum {usdExact(minBid)}. This is the price of the launch: it goes
              to the protocol treasury if you win, and comes back to you if
              you&apos;re outbid.
            </p>

            <div className="flex items-center rounded-sm border border-line bg-bg px-2.5 focus-within:border-line-strong">
              <input
                value={devBuy}
                onChange={(e) => /^\d*\.?\d*$/.test(e.target.value) && setDevBuy(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="num h-11 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
              />
              <span className="num text-[12px] text-ink-2">USDG</span>
            </div>
            <p className="text-[10.5px] leading-relaxed text-ink-3">
              <span className="text-ink-2">First buy, optional.</span> If you
              win, this much of your own coin is bought for you the moment it
              launches — at the opening price, before anyone else can trade.
              The tokens are yours. Up to{" "}
              {CLUB.maxDevBuyUsdg.toLocaleString("en-US")} USDG; refunded with
              your bid if you&apos;re outbid.
            </p>
          </div>

          <button
            onClick={submitBid}
            disabled={connected && (!bidValid || bidBusy)}
            className="mt-3.5 h-10 w-full rounded-sm bg-accent text-[13px] font-medium text-white transition-colors hover:bg-accent-hi disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-ink-3"
          >
            {!connected
              ? "Connect wallet to bid"
              : bidPhase === "signing"
                ? "Confirm in wallet…"
                : bidPhase === "pending"
                  ? "Bidding…"
                  : ended
                    ? "Round ended"
                    : !namesOk
                      ? "Name and ticker required"
                      : isTopBidder
                        ? "Raise bid"
                        : "Place bid"}
          </button>
          {bidError && (
            <p className="slide-in mt-2.5 rounded-sm border border-down/25 bg-down/8 px-2.5 py-2 text-[11px] text-down">
              {bidError}
            </p>
          )}
        </div>

        {connected && <WithdrawPanel onWithdraw={withdraw} phase={withdrawPhase} />}
      </aside>
    </div>
  );
}

function CountdownBadge({ secondsLeft, ended }: { secondsLeft: number; ended: boolean }) {
  if (ended) {
    return (
      <span className="rounded-full border border-warn/30 bg-warn/8 px-3 py-1 text-[12px] font-medium text-warn">
        Round ended — launching soon
      </span>
    );
  }
  const h = Math.floor(secondsLeft / 3600);
  const m = Math.floor((secondsLeft % 3600) / 60);
  const s = secondsLeft % 60;
  return (
    <span className="num rounded-full border border-line-strong px-3 py-1 text-[13px] font-medium text-ink">
      {h}h {m.toString().padStart(2, "0")}m {s.toString().padStart(2, "0")}s
    </span>
  );
}

function StatBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="num mt-1 truncate text-[15px] text-ink">{value}</div>
    </div>
  );
}

function WithdrawPanel({
  onWithdraw,
  phase,
}: {
  onWithdraw: () => Promise<boolean>;
  phase: "idle" | "quoting" | "signing" | "pending" | "success" | "error";
}) {
  return (
    <div className="rounded-md border border-line bg-surface p-3.5">
      <div className="label mb-1.5">Outbid?</div>
      <p className="text-[11.5px] leading-relaxed text-ink-2">
        If you were outbid, your USDG is waiting for you here — it isn&apos;t sent back
        automatically.
      </p>
      <button
        onClick={onWithdraw}
        disabled={phase === "signing" || phase === "pending"}
        className="mt-2.5 h-9 w-full rounded-sm border border-line text-[12.5px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40"
      >
        {phase === "pending" ? "Withdrawing…" : "Withdraw refund"}
      </button>
    </div>
  );
}

/** A user-supplied link, only if it's plain http(s) — never javascript: or data:. */
function safeUrl(raw: string, base?: string): string | null {
  let v = raw.trim();
  if (!v) return null;
  if (base && !/^https?:\/\//i.test(v)) v = base + v.replace(/^@/, "").replace(/^t\.me\//i, "");
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * The coin as everyone but the top bidder sees it: what launches if the
 * current lead holds. Read-only — outbidding is how you get to change it.
 * Sized for the sidebar, next to the bid form it's the subject of.
 */
function ReadOnlyCoin({ club }: { club: ClubData }) {
  let hue = 0;
  for (const ch of club.symbol || "Aroma") hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  let seed = 7;
  for (const ch of (club.name + club.symbol) || "Aroma") seed = (seed * 33 + ch.charCodeAt(0)) >>> 0;

  const links = [
    { label: "Website", href: safeUrl(club.links.website) },
    { label: "X", href: safeUrl(club.links.x, "https://x.com/") },
    { label: "Telegram", href: safeUrl(club.links.telegram, "https://t.me/") },
  ].filter((l): l is { label: string; href: string } => l.href !== null);

  return (
    <div className="rounded-md border border-line bg-surface p-3.5">
      <div className="label mb-2.5">Launching if this bid holds</div>
      <div className="flex items-start gap-3">
        <CoinArt seed={seed} hue={hue} size={52} radius={6} imageUrl={club.imageUrl} alt={club.name} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-ink">{club.name}</div>
          <div className="num mt-0.5 text-[12px] text-ink-2">${club.symbol}</div>
          {links.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-0.5">
              {links.map((l) => (
                <a
                  key={l.label}
                  href={l.href}
                  target="_blank"
                  rel="noreferrer nofollow"
                  className="text-[11.5px] text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink"
                >
                  {l.label} ↗
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
      <p className="mt-2.5 text-[12px] leading-relaxed text-ink-2">
        {club.description || "No description."}
      </p>
      <p className="mt-2.5 border-t border-line pt-2.5 text-[11px] leading-relaxed text-ink-3">
        Only the top bidder can change this. Outbid them and it carries over to
        you as it is — then it&apos;s yours to edit.
      </p>
    </div>
  );
}

/**
 * Every bid on this round, newest first — the auction as it happened.
 *
 * "Extended the clock" marks a bid that landed inside the anti-snipe window
 * and pushed the deadline out: its endsAt is later than the one in force
 * before it (the previous bid's, or the round's original deadline).
 */
function BidList({
  bids,
  topBidder,
  you,
  now,
}: {
  bids: ClubBidData[];
  topBidder: string | null;
  you: string | null;
  now: number;
}) {
  const same = (a: string | null, b: string | null) =>
    Boolean(a && b && a.toLowerCase() === b.toLowerCase());

  return (
    <div className="rounded-md border border-line bg-surface p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold text-ink">Bids</h2>
        <span className="num text-[12px] text-ink-3">
          {bids.length} {bids.length === 1 ? "bid" : "bids"}
        </span>
      </div>

      {bids.length === 0 ? (
        <p className="mt-4 rounded-sm border border-dashed border-line px-4 py-8 text-center text-[12.5px] text-ink-2">
          No bids yet. The first bid names the coin.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {bids.map((b, i) => {
            const leading = i === 0 && same(b.bidder, topBidder);
            const older = bids[i + 1];
            const extended = older ? b.endsAt > older.endsAt : false;
            return (
              <li key={b.id} className="flex items-center gap-3 py-2.5">
                <span className="num w-[110px] shrink-0 truncate text-[12.5px] text-ink-2">
                  {same(b.bidder, you) ? "You" : shortAddr(b.bidder)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`num text-[14px] ${leading ? "text-ink" : "text-ink-2"}`}>
                    {usdExact(b.bidUsdg)}
                  </span>
                  {b.firstBuyUsdg > 0 && (
                    <span className="ml-2 text-[11px] text-ink-3">
                      + {usdExact(b.firstBuyUsdg)} first buy
                    </span>
                  )}
                  {extended && (
                    <span className="ml-2 text-[11px] text-warn">extended the clock</span>
                  )}
                </span>
                {leading ? (
                  <span className="shrink-0 rounded-full border border-up/30 bg-up/8 px-2 py-0.5 text-[10.5px] font-medium text-up">
                    Leading
                  </span>
                ) : (
                  <span className="shrink-0 text-[11px] text-ink-3">Outbid</span>
                )}
                <span className="num w-[48px] shrink-0 text-right text-[11.5px] text-ink-3">
                  {ago(Math.max(1, now - b.timestamp))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const inputClass =
  "h-11 w-full rounded-sm border border-line bg-bg px-3 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-line-strong";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <label className="text-[12.5px] text-ink-2">{label}</label>
        {hint && <span className="num text-[11px] text-ink-3">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
