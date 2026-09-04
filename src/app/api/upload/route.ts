import { NextResponse } from "next/server";
import { pinImage, pinMetadata, hasPinata, gatewayUrl, IpfsError } from "@/lib/server/ipfs";

/**
 * Takes a creator's image, pins it and its metadata to IPFS, and returns
 * the URI that goes on-chain.
 *
 * One round trip rather than two: the client uploads once and gets back a
 * URI ready to pass to createToken. Doing it server-side keeps the Pinata
 * JWT out of the browser — otherwise anyone could pin to this account.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export async function POST(request: Request) {
  if (!hasPinata) {
    return NextResponse.json(
      { error: "Image uploads aren't configured on this deployment." },
      { status: 503 },
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
  if (!ALLOWED.has(file.type)) {
    return NextResponse.json(
      { error: "Use a PNG, JPEG, GIF or WebP image" },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Image must be under ${MAX_BYTES / 1024 / 1024}MB` },
      { status: 400 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "That image is empty" }, { status: 400 });
  }

  const name = String(form.get("name") ?? "").slice(0, 64);
  const symbol = String(form.get("symbol") ?? "").slice(0, 16);
  const description = String(form.get("description") ?? "").slice(0, 500);

  try {
    const image = await pinImage(file);
    const metadataUri = await pinMetadata({ name, symbol, description, image });

    return NextResponse.json({
      metadataUri,
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
