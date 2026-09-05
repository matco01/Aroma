import "server-only";
import { IMAGE_RULES } from "../image-rules";

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

/**
 * A CID, and nothing else.
 *
 * Both halves of what this guards are attacker-supplied: `metadataUri` is
 * free text on a token anyone can create, and the `image` field inside the
 * metadata is whatever that document says. Pasting either straight into a
 * URL means a stranger picks the path we fetch server-side and the src we
 * hand a browser. Base32 CIDv1 and base58 CIDv0 are both covered; a
 * trailing path segment is allowed because that is legitimate IPFS
 * addressing, and anything with a scheme, a host, a dot-segment or a
 * backslash in it is not a CID and is refused.
 */
const CID = /^[A-Za-z0-9]{46,64}(\/[A-Za-z0-9._-]{1,128})*$/;

/** What a browser will actually render an image from. */
export function gatewayUrl(uri: string): string {
  if (!uri) return "";
  const cid = uri.startsWith("ipfs://") ? uri.slice("ipfs://".length) : uri;
  if (!CID.test(cid)) return "";
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

/** One entry per token ever launched, otherwise. Launching costs gas, so
 *  this grows slowly — but "slowly" is not "never", and this process is
 *  meant to stay up. */
const MAX_IMAGE_CACHE = 5_000;

/** A token's metadata document is a few hundred bytes of JSON. Anything
 *  approaching this is not metadata, and reading it would be our memory
 *  spent on someone else's decision. */
const MAX_METADATA_BYTES = 64 * 1024;

/** Reads at most `limit` bytes, and gives up rather than truncating —
 *  a half-read JSON document is not something to guess at. */
async function readCapped(res: Response, limit: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > limit) return null;

  const reader = res.body?.getReader();
  if (!reader) return null;

  const decoder = new TextDecoder();
  let out = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

export async function resolveImage(metadataUri: string): Promise<string> {
  if (!metadataUri) return "";

  const cached = imageCache.get(metadataUri);
  if (cached !== undefined) return cached;

  const url = gatewayUrl(metadataUri);
  if (!url) return "";

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) throw new Error(String(res.status));

    const body = await readCapped(res, MAX_METADATA_BYTES);
    if (body === null) throw new Error("metadata too large");

    const meta = JSON.parse(body) as { image?: unknown };
    const image = typeof meta.image === "string" ? gatewayUrl(meta.image) : "";

    if (imageCache.size >= MAX_IMAGE_CACHE) {
      const oldest = imageCache.keys().next();
      if (!oldest.done) imageCache.delete(oldest.value);
    }
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

/**
 * Standardises an upload before it is pinned.
 *
 * Square, 512px, WebP. Creators upload whatever they have — a screenshot,
 * a phone photo, a 4000px export — and everyone downloads the same small
 * file. Without this a board of 24 coins could pull 120MB of originals to
 * draw 24 forty-pixel thumbnails.
 *
 * `fit: "cover"` centre-crops rather than squashing: a face stays a face
 * instead of being stretched to fit a square. The aspect-ratio rule
 * upstream exists so nobody is surprised by how much gets cropped.
 *
 * Animated GIFs stay animated — converting one to a still image would
 * silently throw away the thing the creator chose it for.
 */
export async function normalizeImage(
  bytes: Buffer,
  isAnimated: boolean,
): Promise<{ data: Buffer; type: string }> {
  const sharp = (await import("sharp")).default;

  const pipeline = sharp(bytes, {
    animated: isAnimated,
    // Defence in depth behind the header check: even if a malformed image
    // slipped past dimension validation, the decoder itself refuses.
    limitInputPixels: IMAGE_RULES.maxPixels,
  })
    .resize(IMAGE_RULES.outputSize, IMAGE_RULES.outputSize, {
      fit: "cover",
      position: "centre",
      withoutEnlargement: false,
    })
    .webp({ quality: 82, effort: 4 });

  return { data: await pipeline.toBuffer(), type: "image/webp" };
}
