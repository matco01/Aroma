import { NextResponse } from "next/server";
import { imageSize } from "image-size";
import { pinImage, pinMetadata, hasPinata, gatewayUrl, IpfsError } from "@/lib/server/ipfs";
import { checkImageFile, checkImageDimensions } from "@/lib/image-rules";

/**
 * Takes a creator's image, pins it and its metadata to IPFS, and returns
 * the URI that goes on-chain.
 *
 * One round trip rather than two: the client uploads once and gets back a
 * URI ready to pass to createToken. Doing it server-side keeps the Pinata
 * JWT out of the browser — otherwise anyone could pin to this account.
 */

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

  const name = String(form.get("name") ?? "").slice(0, 64);
  const symbol = String(form.get("symbol") ?? "").slice(0, 16);
  const description = String(form.get("description") ?? "").slice(0, 500);

  try {
    const image = await pinImage(new File([bytes], file.name || "image", { type: file.type }));
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
