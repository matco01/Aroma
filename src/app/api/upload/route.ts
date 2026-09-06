import { NextResponse } from "next/server";
import { imageSize } from "image-size";
import {
  pinImage,
  normalizeImage,
  hasPinata,
  gatewayUrl,
  IpfsError,
} from "@/lib/server/ipfs";
import { checkImageFile, checkImageDimensions, IMAGE_RULES } from "@/lib/image-rules";
import { rateLimit, clientKey } from "@/lib/server/rate-limit";

/**
 * Takes a creator's image, pins it and its metadata to IPFS, and returns
 * the URI that goes on-chain.
 *
 * One round trip rather than two: the client uploads once and gets back a
 * URI ready to pass to createToken. Doing it server-side keeps the Pinata
 * JWT out of the browser — otherwise anyone could pin to this account.
 *
 * Keeping the JWT server-side stops the key leaking, but on its own it did
 * not stop the abuse it was protecting against: the endpoint was open and
 * unmetered, so anyone could still pin unlimited content to our account
 * through it. That is our storage bill and our name on whatever they
 * uploaded. Hence the limit below, and the length check before the body is
 * read at all.
 */

/** Generous for a person launching a coin, useless for a script. */
const UPLOADS_PER_WINDOW = 10;
const WINDOW_MS = 60_000;

/** Slack over the per-image cap for multipart overhead and the text fields. */
const MAX_BODY_BYTES = IMAGE_RULES.maxBytes + 1_000_000;

export async function POST(request: Request) {
  if (!hasPinata) {
    return NextResponse.json(
      { error: "Image uploads aren't configured on this deployment." },
      { status: 503 },
    );
  }

  const limited = rateLimit(`upload:${clientKey(request)}`, UPLOADS_PER_WINDOW, WINDOW_MS);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many uploads. Wait a moment and try again." },
      { status: 429, headers: { "retry-after": String(limited.retryAfter) } },
    );
  }

  // Refuse oversized bodies before parsing rather than after. checkImageFile
  // runs on file.size, which is only known once the whole multipart body has
  // been read into memory — by which point a hostile 2GB upload has already
  // cost us the memory it was meant to be rejected for.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "That file is too large." },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart upload" }, { status: 400 });
  }

  const file = form.get("image");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No image supplied" }, { status: 400 });
  }

  // Validate before spending an upload. Type is checked against an
  // allowlist rather than a denylist — an SVG, for instance, is an image
  // that can carry script, and is deliberately absent.
  const fileProblem = checkImageFile(file.type, file.size);
  if (fileProblem) {
    return NextResponse.json({ error: fileProblem }, { status: 400 });
  }

  // Dimensions come from the header only — imageSize parses metadata and
  // never decodes pixels, which is the whole point. Decoding first to find
  // out an image is too big is exactly the bomb we are guarding against.
  const bytes = Buffer.from(await file.arrayBuffer());
  let width = 0;
  let height = 0;
  try {
    const size = imageSize(bytes);
    width = size.width ?? 0;
    height = size.height ?? 0;
  } catch {
    return NextResponse.json(
      { error: "That file isn't a readable image" },
      { status: 400 },
    );
  }

  const dimensionProblem = checkImageDimensions(width, height);
  if (dimensionProblem) {
    return NextResponse.json({ error: dimensionProblem }, { status: 400 });
  }

  try {
    // Resize before pinning, never after: IPFS is content-addressed, so a
    // pinned original would keep its own permanent CID whether or not
    // anything ever pointed at it again.
    //
    // Failures here are the file's fault, not the network's, and are
    // reported separately below — "try again in a moment" is actively
    // misleading advice for an image that will never decode.
    let normalized;
    try {
      normalized = await normalizeImage(bytes, file.type === "image/gif");
    } catch {
      return NextResponse.json(
        { error: "That image is corrupt or in a format we can't read" },
        { status: 400 },
      );
    }
    const image = await pinImage(
      // Buffer is not a BlobPart; a Uint8Array view over the same
      // bytes is, and copies nothing.
      new File([new Uint8Array(normalized.data)], "image.webp", {
        type: normalized.type,
      }),
    );

    // The metadata document is NOT written here. It used to be, which meant
    // it captured whatever had been typed at the moment a picture was
    // chosen — links added afterwards never reached it, and a coin launched
    // without a picture had no metadata at all. /api/metadata writes it at
    // submit instead, from the final values.
    return NextResponse.json({
      image,
      // The gateway URL is for previewing right now; the ipfs:// URI is
      // what goes on-chain and outlives any particular gateway.
      previewUrl: gatewayUrl(image),
    });
  } catch (e) {
    const message =
      e instanceof IpfsError ? e.message : "Upload failed. Try again in a moment.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
