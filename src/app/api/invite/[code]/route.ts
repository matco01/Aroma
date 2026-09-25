import { NextResponse } from "next/server";
import { normalizeInviteCode } from "@/lib/invite-code";
import { hasInviteStore, inviteForCode } from "@/lib/server/invite-codes";
import { rateLimit, clientKey } from "@/lib/server/rate-limit";

/**
 * Looks an invite code up: which coin it is for, and the invite itself.
 *
 * Rate limited harder than anything else here, because a live code is a seat.
 * The code space is ~10^12, so guessing is hopeless at this rate — the limit is
 * what keeps it hopeless rather than merely slow.
 */

const LOOKUPS_PER_WINDOW = 20;
const WINDOW_MS = 60_000;

export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  if (!hasInviteStore) {
    return NextResponse.json({ error: "Invite codes aren't available on this deployment." }, { status: 503 });
  }

  const limited = rateLimit(`invite-lookup:${clientKey(request)}`, LOOKUPS_PER_WINDOW, WINDOW_MS);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many tries. Wait a minute and try again." },
      { status: 429, headers: { "retry-after": String(limited.retryAfter) } },
    );
  }

  const code = normalizeInviteCode((await params).code);
  const found = code ? inviteForCode(code) : null;
  if (!found) {
    return NextResponse.json({ error: "That code doesn't match an invite, or it has expired." }, { status: 404 });
  }
  return NextResponse.json(found, { headers: { "cache-control": "no-store" } });
}
