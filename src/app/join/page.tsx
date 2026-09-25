import type { Metadata } from "next";
import { InviteCodeForm } from "@/components/invite-code-form";

export const metadata: Metadata = {
  title: "Join a club",
  description: "Enter an invite code from a member to join their club on Aroma.",
};

/**
 * Where an invite code goes when you don't know which coin it's for — the
 * whole point of a code being that nobody had to send you a link to it.
 */
export default function JoinPage() {
  return (
    <div className="mx-auto max-w-[440px] px-4 py-16">
      <h1 className="text-[22px] font-semibold text-ink">Join a club</h1>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
        Clubs are invite-only. Enter the code a member gave you and you&apos;ll go straight to
        their coin, with the invite ready. Your first buy makes you a member.
      </p>
      <div className="mt-6">
        <InviteCodeForm autoFocus size="lg" />
      </div>
      <p className="mt-4 text-[11.5px] leading-relaxed text-ink-3">
        Codes look like K7Q2-XMPD. Capitals, spaces and the dash don&apos;t matter. Invites can
        only be used by the first people to buy with them, so use yours soon.
      </p>
    </div>
  );
}
