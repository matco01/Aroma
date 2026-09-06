import { NextResponse } from "next/server";
import { pinMetadata, hasPinata, IpfsError } from "@/lib/server/ipfs";
import { rateLimit, clientKey } from "@/lib/server/rate-limit";

/**
 * Writes the document a token's on-chain URI points at.
 *
 * Split out of /api/upload because the metadata has to be written at
 * submit, not when a picture is chosen. Pinned at pick time it captured
 * whatever had been typed so far — links added afterwards silently never
 * made it — and a coin launched without a picture got no metadata at all,
 * so its links were discarded outright.
 *
 * Links are normalised here rather than trusted: anything that is not an
 * http(s) URL becomes empty, because these end up in an href and a
 * javascript: URL there is script execution on our origin.
 */

const PINS_PER_WINDOW = 15;
const WINDOW_MS = 60_000;

const clean = (v: unknown, max = 200): string => {
  if (typeof v !== "string") return "";
  const trimmed = v.trim().slice(0, max);
  if (!trimmed) return "";
  try {
    const u = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : "";
  } catch {
    return "";
  }
};

export async function POST(request: Request) {
  if (!hasPinata) {
    return NextResponse.json(
      { error: "Metadata pinning isn't configured on this deployment." },
      { status: 503 },
    );
  }

  const limited = rateLimit(`metadata:${clientKey(request)}`, PINS_PER_WINDOW, WINDOW_MS);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many at once. Wait a moment." },
      { status: 429, headers: { "retry-after": String(limited.retryAfter) } },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Expected metadata" }, { status: 400 });
  }

  const name = String(body.name ?? "").slice(0, 64);
  const symbol = String(body.symbol ?? "").slice(0, 16);
  if (!name || !symbol) {
    return NextResponse.json({ error: "A coin needs a name and a ticker" }, { status: 400 });
  }

  try {
    const metadataUri = await pinMetadata({
      name,
      symbol,
      description: String(body.description ?? "").slice(0, 500),
      // Empty when the creator uploaded no picture. The document still
      // exists, so the links survive either way.
      image: typeof body.image === "string" && body.image.startsWith("ipfs://") ? body.image : "",
      links: {
        website: clean(body.website),
        x: clean(body.x),
        telegram: clean(body.telegram),
      },
    });
    return NextResponse.json({ metadataUri });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof IpfsError ? e.message : "Could not save that. Try again." },
      { status: 502 },
    );
  }
}
