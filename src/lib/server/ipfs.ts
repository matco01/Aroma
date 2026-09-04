import "server-only";

/**
 * Pins token images and metadata to IPFS.
 *
 * The image itself can never live on-chain at a sane cost, but the pointer
 * can — and that pointer is what makes a token self-describing. A launchpad
 * that keeps images only in its own database is one whose tokens go blank
 * the day it shuts down. pump.fun puts the IPFS URI on-chain for exactly
 * this reason, and so do we.
 *
 * The JWT is server-side only. If it reached the browser anyone could pin
 * to this account on our quota, so uploads go through the API route rather
 * than direct from the client.
 */

const PINATA_JWT = process.env.PINATA_JWT ?? "";
export const hasPinata = PINATA_JWT.length > 0;

/**
 * Dedicated gateways are strongly preferred: the shared one is rate-limited
 * hard enough that token art visibly pops in late, or not at all, once more
 * than a handful of people are looking.
 */
const GATEWAY = process.env.NEXT_PUBLIC_PINATA_GATEWAY || "gateway.pinata.cloud";

const PIN_FILE = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const PIN_JSON = "https://api.pinata.cloud/pinning/pinJSONToIPFS";

/** What a browser will actually render an image from. */
export function gatewayUrl(uri: string): string {
  if (!uri) return "";
  const cid = uri.startsWith("ipfs://") ? uri.slice("ipfs://".length) : uri;
  return `https://${GATEWAY}/ipfs/${cid}`;
}

export class IpfsError extends Error {}

async function pinataFetch(url: string, body: BodyInit, headers: HeadersInit = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${PINATA_JWT}`, ...headers },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // Never echo the response wholesale — it can contain request context we
    // would rather not surface to a browser.
    throw new IpfsError(`Pinata responded ${res.status}${detail ? `: ${detail.slice(0, 120)}` : ""}`);
  }
  return (await res.json()) as { IpfsHash: string };
}

export async function pinImage(file: File): Promise<string> {
  if (!hasPinata) throw new IpfsError("PINATA_JWT is not configured");

  const form = new FormData();
  form.append("file", file, file.name || "image");
  form.append(
    "pinataOptions",
    JSON.stringify({ cidVersion: 1 }),
  );

  const { IpfsHash } = await pinataFetch(PIN_FILE, form);
  return `ipfs://${IpfsHash}`;
}

export type TokenMetadata = {
  name: string;
  symbol: string;
  description: string;
  image: string;
};

/**
 * Pins the metadata JSON that the on-chain URI points at.
 *
 * Shaped like the metadata every wallet and explorer already knows how to
 * read, so a token is legible to tools that have never heard of Aroma —
 * which is the entire point of putting it on IPFS rather than in our
 * database.
 */
export async function pinMetadata(meta: TokenMetadata): Promise<string> {
  if (!hasPinata) throw new IpfsError("PINATA_JWT is not configured");

  const { IpfsHash } = await pinataFetch(
    PIN_JSON,
    JSON.stringify({
      pinataContent: meta,
      pinataOptions: { cidVersion: 1 },
      pinataMetadata: { name: `${meta.symbol}-metadata` },
    }),
    { "content-type": "application/json" },
  );
  return `ipfs://${IpfsHash}`;
}

/**
 * Resolves a metadata URI to a directly-renderable image URL.
 *
 * The on-chain pointer is to metadata JSON, not to the image — that
 * indirection is what makes a token legible to wallets and explorers that
 * have never heard of Aroma, so it's worth the extra hop.
 *
 * Cached permanently and deliberately: an IPFS CID addresses content, so
 * the bytes behind one can never change. Re-fetching is pure waste, and
 * without the cache a board render would be one HTTP request per token.
 */
const imageCache = new Map<string, string>();

export async function resolveImage(metadataUri: string): Promise<string> {
  if (!metadataUri) return "";

  const cached = imageCache.get(metadataUri);
  if (cached !== undefined) return cached;

  try {
    const res = await fetch(gatewayUrl(metadataUri), {
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) throw new Error(String(res.status));

    const meta = (await res.json()) as { image?: unknown };
    const image = typeof meta.image === "string" ? gatewayUrl(meta.image) : "";
    imageCache.set(metadataUri, image);
    return image;
  } catch {
    // A gateway hiccup must not fail the board — cache the miss briefly by
    // not caching it at all, so the next render retries, and fall back to
    // generated art in the meantime.
    return "";
  }
}

/** Resolve many at once, bounded by the page size the caller already caps. */
export async function resolveImages(uris: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(uris.filter(Boolean))];
  const resolved = await Promise.all(unique.map((u) => resolveImage(u)));
  return new Map(unique.map((u, i) => [u, resolved[i]]));
}
