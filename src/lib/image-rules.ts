/**
 * What counts as an acceptable token image.
 *
 * Shared between the browser and the API on purpose: the client checks so
 * someone learns their file is wrong before waiting on a 5MB upload, and
 * the server checks because the client's opinion is a courtesy, not a
 * guarantee. Anyone can POST straight to the endpoint.
 */

export const IMAGE_RULES = {
  maxBytes: 5 * 1024 * 1024,
  /**
   * Everything is resized to this before pinning, so what a creator
   * uploads and what the web sees are different files.
   *
   * Normalising rather than demanding an exact size is the whole trick:
   * insisting on 512x512 uploads would mean most people's first attempt is
   * rejected and they go and find an image editor, which is a terrible
   * thing to put between someone and launching. Accept what they have,
   * standardise it here.
   *
   * It is also the difference between a board page pulling 120MB of
   * originals to draw 24 thumbnails and pulling under 1MB.
   */
  outputSize: 512,
  /**
   * Dimension caps matter more than the byte cap, and for a reason the
   * byte cap cannot cover: compressed formats decode far larger than they
   * store. A 5MB PNG of 30,000 x 30,000 pixels is a few megabytes on disk
   * and several gigabytes decoded — a decompression bomb that exhausts
   * memory on whatever tries to render it. Checking dimensions from the
   * header, before anything decodes the pixels, is the actual defence.
   */
  maxDimension: 4096,
  /** Below this, upscaling to the output size looks obviously soft. */
  minDimension: 128,
  /** Total pixels, so a 4096 x 4096 limit can't be dodged with 4096 x 40000. */
  maxPixels: 4096 * 4096,
  /**
   * Art renders square with object-cover, so a very long image is mostly
   * cropped away — the creator would be uploading something quite unlike
   * what anyone sees. 2:1 either way is generous and still recognisable.
   */
  maxAspectRatio: 2,
  allowedTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] as const,
} as const;

export type ImageProblem = string | null;

/** Returns a human-readable problem, or null when the file is acceptable. */
export function checkImageFile(type: string, bytes: number): ImageProblem {
  if (!IMAGE_RULES.allowedTypes.includes(type as (typeof IMAGE_RULES.allowedTypes)[number])) {
    return "Use a PNG, JPEG, GIF or WebP image";
  }
  if (bytes === 0) return "That image is empty";
  if (bytes > IMAGE_RULES.maxBytes) {
    return `Image must be under ${IMAGE_RULES.maxBytes / 1024 / 1024}MB`;
  }
  return null;
}

export function checkImageDimensions(width: number, height: number): ImageProblem {
  if (!width || !height) return "Couldn't read that image's dimensions";

  if (width < IMAGE_RULES.minDimension || height < IMAGE_RULES.minDimension) {
    return `Image must be at least ${IMAGE_RULES.minDimension}×${IMAGE_RULES.minDimension} — smaller looks blurry on a coin page`;
  }
  if (width > IMAGE_RULES.maxDimension || height > IMAGE_RULES.maxDimension) {
    return `Image must be at most ${IMAGE_RULES.maxDimension}×${IMAGE_RULES.maxDimension} (yours is ${width}×${height})`;
  }
  if (width * height > IMAGE_RULES.maxPixels) {
    return "That image has too many pixels";
  }

  const ratio = Math.max(width / height, height / width);
  if (ratio > IMAGE_RULES.maxAspectRatio) {
    return `Image is too far from square (${width}×${height}) — coin art is shown as a square, so most of it would be cropped`;
  }
  return null;
}
