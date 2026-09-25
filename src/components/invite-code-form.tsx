"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { resolveInviteCode } from "@/lib/use-club";

/**
 * Type an invite code, land on the coin with the invite applied.
 *
 * The code resolves to exactly what an invite link carries, and the form then
 * puts that in the coin page's ?invite= — so from there on it is the link path,
 * checks and all, rather than a second way of joining to keep in step with it.
 *
 * On the coin the code is for, the page stays put and just picks the invite up.
 * A code for a different coin goes to that coin: the person wanted in, and the
 * code says where.
 */
export function InviteCodeForm({
  currentToken,
  autoFocus,
  size = "sm",
}: {
  /** The coin being viewed, if any. */
  currentToken?: string;
  autoFocus?: boolean;
  size?: "sm" | "lg";
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { token, invite } = await resolveInviteCode(text);
      const here = currentToken && currentToken.toLowerCase() === token.toLowerCase();
      if (here) router.replace(`${pathname}?invite=${invite}`, { scroll: false });
      else router.push(`/coin/${token}?invite=${invite}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code didn't work.");
      setBusy(false);
    }
  }

  const lg = size === "lg";
  return (
    <form onSubmit={submit} className="space-y-1.5">
      <div className="flex gap-1.5">
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          placeholder="Invite code"
          aria-label="Invite code"
          autoFocus={autoFocus}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={16}
          className={`num min-w-0 flex-1 rounded-sm border border-line bg-bg px-2.5 uppercase tracking-[0.12em] text-ink outline-none placeholder:normal-case placeholder:tracking-normal placeholder:text-ink-3 focus:border-line-strong ${
            lg ? "h-11 text-[15px]" : "h-9 text-[12.5px]"
          }`}
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className={`shrink-0 rounded-sm bg-up px-3.5 font-semibold text-bg transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-ink-3 ${
            lg ? "h-11 text-[13.5px]" : "h-9 text-[12px]"
          }`}
        >
          {busy ? "Checking…" : "Use code"}
        </button>
      </div>
      {error && <p className="text-[11px] leading-relaxed text-down">{error}</p>}
    </form>
  );
}
