import { NextResponse } from "next/server";
import { createPublicClient, zeroAddress, type Address } from "viem";
import { activeChain } from "@/lib/chain";
import { chainTransport } from "@/lib/transport";
import { clubsDeployed } from "@/lib/network";
import { decodeInvite, inviteProblem } from "@/lib/club-trade";
import { codeForInvite, hasInviteStore } from "@/lib/server/invite-codes";
import { rateLimit, clientKey } from "@/lib/server/rate-limit";

/**
 * Turns a signed invite into a short code a member can read out or paste,
 * for anyone who would rather not send (or click) a link.
 *
 * The invite is checked against the vault before it gets a code, the same
 * check signInvite makes in the browser. Nothing stored here is trusted later
 * — redemption re-checks everything on-chain — but a code for an invite that
 * never worked would only be a dead end handed to someone's friend.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A member making invites, not a script filling the store. */
const CODES_PER_WINDOW = 20;
const WINDOW_MS = 60_000;

const client = createPublicClient({ chain: activeChain, transport: chainTransport() });

export async function POST(request: Request) {
  if (!hasInviteStore || !clubsDeployed) {
    return NextResponse.json({ error: "Invite codes aren't available on this deployment." }, { status: 503 });
  }

  const limited = rateLimit(`invite-code:${clientKey(request)}`, CODES_PER_WINDOW, WINDOW_MS);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many invites at once. Wait a moment and try again." },
      { status: 429, headers: { "retry-after": String(limited.retryAfter) } },
    );
  }

  let body: { token?: unknown; invite?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token : "";
  const encoded = typeof body.invite === "string" ? body.invite : "";
  const invite = decodeInvite(encoded);
  if (!ADDRESS.test(token) || !invite) {
    return NextResponse.json({ error: "Not a valid invite" }, { status: 400 });
  }

  let problem: string;
  try {
    problem = await inviteProblem(client, token as Address, zeroAddress, invite);
  } catch {
    return NextResponse.json({ error: "Couldn't check the invite right now." }, { status: 502 });
  }
  if (problem) return NextResponse.json({ error: problem }, { status: 422 });

  const code = codeForInvite(token, encoded, Number(invite.deadline));
  return NextResponse.json({ code }, { headers: { "cache-control": "no-store" } });
}
