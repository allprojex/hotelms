/**
 * Client-side image optimization for the gallery upload flow.
 *
 * Architecture decision (Phase 5): no image-processing library exists
 * anywhere in this codebase (no sharp/pica/browser-image-compression), and
 * no Supabase Storage image-transformation usage exists either — this
 * project's Supabase plan is not confirmed to support it reliably. Rather
 * than add a new dependency or depend on an unconfirmed platform feature,
 * this uses the browser's native Canvas/ImageBitmap APIs, which are already
 * available with zero install. Both the optimized full image and the
 * thumbnail are produced client-side, before upload, so the server never
 * receives (or needs to hold in memory) the original oversized file.
 *
 * `imageOrientation: "from-image"` makes createImageBitmap apply the EXIF
 * orientation tag itself, so the canvas we draw into is already
 * correctly-oriented — this is what "do not silently corrupt orientation"
 * means in practice here.
 */

const MAX_SOURCE_PIXELS = 40_000_000; // ~40MP — guards against a small file that decodes to a huge bitmap (decompression-bomb style input)

export type ResizedImage = { blob: Blob; width: number; height: number };

async function decodeBitmap(file: File | Blob): Promise<ImageBitmap> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  if (bitmap.width * bitmap.height > MAX_SOURCE_PIXELS) {
    bitmap.close();
    throw new Error("Image dimensions are too large to process");
  }
  return bitmap;
}

async function renderResized(
  bitmap: ImageBitmap,
  opts: { maxDimension: number; quality: number; mimeType: string },
): Promise<ResizedImage> {
  const scale = Math.min(1, opts.maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process image");
  ctx.drawImage(bitmap, 0, 0, width, height);

  const blob: Blob | null = await new Promise((resolve) =>
    canvas.toBlob(resolve, opts.mimeType, opts.quality),
  );
  if (!blob) throw new Error("Could not process image");
  return { blob, width, height };
}

const OPTIMIZED_MAX_DIMENSION = 2000;
const OPTIMIZED_QUALITY = 0.85;
const THUMBNAIL_MAX_DIMENSION = 480;
const THUMBNAIL_QUALITY = 0.75;
const OUTPUT_MIME_TYPE = "image/webp";

/**
 * Produces both variants from a single decode of the source file. Only the
 * two resulting blobs are ever uploaded — the original file bytes never
 * leave the browser.
 */
export async function prepareGalleryImageVariants(
  file: File,
): Promise<{ optimized: ResizedImage; thumbnail: ResizedImage }> {
  const bitmap = await decodeBitmap(file);
  try {
    const optimized = await renderResized(bitmap, {
      maxDimension: OPTIMIZED_MAX_DIMENSION,
      quality: OPTIMIZED_QUALITY,
      mimeType: OUTPUT_MIME_TYPE,
    });
    const thumbnail = await renderResized(bitmap, {
      maxDimension: THUMBNAIL_MAX_DIMENSION,
      quality: THUMBNAIL_QUALITY,
      mimeType: OUTPUT_MIME_TYPE,
    });
    return { optimized, thumbnail };
  } finally {
    bitmap.close();
  }
}
