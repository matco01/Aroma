"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { zeroAddress } from "viem";
import type { Coin } from "@/lib/mock";
import { CLUB } from "@/lib/arc";
import { shortAddr, usdPrecise } from "@/lib/format";
import { useClub } from "@/lib/use-club";
import { decodeInvite } from "@/lib/club-trade";
import { useWallet } from "./wallet";

/**
 * A club coin's panel: whether you're in, who let you in, your invites, and
 * what you've earned. Takes the place of the creator-fees card, which describes
 * a 70/30 split club coins do not have.
 *
 * The invite is the product, so it is the loudest thing here. Making one is a
 * signature, not a transaction, and the panel says so — "costs nothing" is the
 * sentence that gets people to actually press it.
 */
export function ClubPanel({ coin }: { coin: Coin }) {
  const { connected, connect } = useWallet();
  const club = useClub(coin.contract, true);
  const [copied, setCopied] = useState(false);
  const searchParams = useSearchParams();
  const hasInvite = useMemo(() => Boolean(decodeInvite(searchParams.get("invite"))), [searchParams]);

  const busy = club.phase === "signing" || club.phase === "pending";
  const invitedBy = club.inviter && club.inviter !== zeroAddress ? club.inviter : null;

  async function copy() {
    if (!club.link) return;
    try {
      await navigator.clipboard.writeText(club.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // The link is on screen and selectable; a refused clipboard write loses
      // nothing but the shortcut.
    }
  }

  return (
    <div className="rounded-md border border-line bg-surface p-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="label">Club</span>
        <span className="num text-[11px] text-ink-3">invite-only</span>
      </div>

      {!connected ? (
        <div className="mt-2 space-y-2.5">
          <p className="text-[12px] leading-relaxed text-ink-2">
            Only members can buy {coin.ticker}. Members get in with an invite link from
            someone already inside. Anyone holding it can sell.
          </p>
          <button
            type="button"
            onClick={connect}
            className="h-9 w-full rounded-sm border border-line text-[12.5px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
          >
            Connect to see your invites
          </button>
        </div>
      ) : club.loading ? (
        <p className="mt-2 text-[12px] text-ink-3">Reading membership…</p>
      ) : !club.isMember ? (
        // The buy box already says whether this person can get in. This says
        // what getting in is worth, rather than repeating it — and never tells
        // someone who arrived holding an invite that they need one.
        <p className="mt-2 text-[12px] leading-relaxed text-ink-2">
          {hasInvite
            ? `Your first buy makes you a member. You'll get ${CLUB.memberSeats} invites of your own, and earn when the people you bring in trade.`
            : `Members can buy ${coin.ticker} and get ${CLUB.memberSeats} invites of their own to hand out. You get in with a link from someone already inside.`}
        </p>
      ) : (
        <div className="mt-2.5 space-y-2.5">
          <dl className="space-y-1.5 text-[12px]">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-2">Your invites</dt>
              <dd className="num text-ink">
                {club.seatsLeft} of {club.seatsTotal} left
              </dd>
            </div>
            {invitedBy && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-2">Invited by</dt>
                <dd className="num text-ink-2" title={invitedBy}>
                  {shortAddr(invitedBy)}
                </dd>
              </div>
            )}
          </dl>

          {club.link ? (
            <div className="space-y-2">
              <div className="flex gap-1.5">
                <input
                  readOnly
                  value={club.link}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Invite link"
                  className="num h-9 min-w-0 flex-1 rounded-sm border border-line bg-bg px-2 text-[11px] text-ink-2 outline-none"
                />
                <button
                  type="button"
                  onClick={copy}
                  className="h-9 shrink-0 rounded-sm bg-up px-3 text-[12px] font-semibold text-bg transition-colors hover:brightness-110"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="text-[11px] leading-relaxed text-ink-3">
                Valid for {Math.round(CLUB.inviteTtlSeconds / 86_400)} days. The first{" "}
                {club.seatsLeft === 1 ? "person" : `${club.seatsLeft} people`} to buy with it
                take your {club.seatsLeft === 1 ? "last seat" : "seats"}.
              </p>
            </div>
          ) : (
            <button
              type="button"
              onClick={club.createInvite}
              disabled={busy || club.seatsLeft === 0}
              className="h-10 w-full rounded-sm bg-up text-[13px] font-semibold text-bg transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-ink-3"
            >
              {club.seatsLeft === 0
                ? "All your invites are used"
                : busy
                  ? "Sign in your wallet…"
                  : "Create invite link"}
            </button>
          )}

          {!club.link && club.seatsLeft > 0 && (
            <p className="text-[11px] leading-relaxed text-ink-3">
              Free to make — it's a signature, not a transaction. You earn from everyone
              who joins with your link, and from the people they bring in.
            </p>
          )}

          {club.link && (
            <button
              type="button"
              onClick={club.revoke}
              disabled={busy}
              className="text-[11px] text-ink-3 underline-offset-2 transition-colors hover:text-down hover:underline disabled:opacity-50"
            >
              Cancel all my links for this coin
            </button>
          )}
        </div>
      )}

      {/* Only for someone this concerns: a member, or anyone who has earned
          from any club. A stranger does not need a $0.00 and a dead button. */}
      {connected && (club.isMember || club.claimableRaw > 0n) && (
        <div className="mt-3 border-t border-line pt-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[12px] text-ink-2">Your club earnings</span>
            <span className="num text-[14px] text-ink">{usdPrecise(club.claimableUsd)}</span>
          </div>
          <p className="mt-0.5 text-[10.5px] text-ink-3">From every club you're in, claimed together.</p>
          <button
            type="button"
            onClick={club.claim}
            disabled={busy || club.claimableRaw === 0n}
            className="mt-2.5 h-9 w-full rounded-sm border border-line text-[12.5px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {club.claimableRaw === 0n ? "Nothing to claim yet" : "Claim"}
          </button>
        </div>
      )}

      {club.error && (
        <p className="slide-in mt-2.5 rounded-sm border border-down/25 bg-down/8 px-2.5 py-2 text-[11px] text-down">
          {club.error}
        </p>
      )}

      <p className="mt-3 border-t border-line pt-3 text-[10.5px] leading-relaxed text-ink-3">
        Trades pay {CLUB.tradeFeeBps / 100}%: {CLUB.protocolFeeBps / 100}% to Aroma,{" "}
        {CLUB.rootFeeBps / 100}% to the creator, and {CLUB.treeFeeBps / 100}% to whoever
        invited the trader and the people above them.
      </p>
    </div>
  );
}
