import { safeStorageSegment } from "@/lib/hrm/domain";

/**
 * Which photo represents a room type: the first row of a result already
 * ordered is_cover DESC, sort_order ASC — i.e. the explicitly-flagged cover if
 * there is one, otherwise the first photo in the curator's own order. A room
 * type with no photos is simply absent from the map, which is what makes a
 * caller fall back to a placeholder rather than to a broken image.
 *
 * Domain rule rather than component code so it can be asserted on its own and
 * so every surface that shows "the room type's photo" agrees on what that is.
 */
export function pickRoomTypeCoverPaths(
  rows: ReadonlyArray<{ room_type_id: string; thumbnail_path: string }>,
): Map<string, string> {
  const coverByRoomType = new Map<string, string>();
  for (const row of rows) {
    if (!coverByRoomType.has(row.room_type_id))
      coverByRoomType.set(row.room_type_id, row.thumbnail_path);
  }
  return coverByRoomType;
}

export function uuid(value: unknown): string {
  const v = String(value ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v)) throw new Error("Valid identifier required");
  return v;
}

export function optionalUuid(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return uuid(value);
}

export function optionalShortText(value: unknown, max = 200): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

export const GALLERY_CONTEXTS = [
  "hotel",
  "room_type",
  "restaurant",
  "bar",
  "gym",
  "swimming_pool",
  "facility",
  "other",
] as const;
export type GalleryContext = (typeof GALLERY_CONTEXTS)[number];

export const GALLERY_CONTEXT_LABELS: Record<GalleryContext, string> = {
  hotel: "Hotel / General",
  room_type: "Room Type",
  restaurant: "Restaurant",
  bar: "Bar",
  gym: "Gym",
  swimming_pool: "Swimming Pool",
  facility: "Facility",
  other: "Other",
};

export function validateGalleryContext(value: unknown): GalleryContext {
  if (!GALLERY_CONTEXTS.includes(value as GalleryContext)) {
    throw new Error("Invalid gallery context");
  }
  return value as GalleryContext;
}

export const GALLERY_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_GALLERY_IMAGE_BYTES = 8 * 1024 * 1024;

export function validateGalleryImageFile(file: { type: string; size: number }): void {
  if (!GALLERY_IMAGE_MIME_TYPES.includes(file.type as (typeof GALLERY_IMAGE_MIME_TYPES)[number])) {
    throw new Error("Unsupported image file type. Use JPEG, PNG, or WebP.");
  }
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_GALLERY_IMAGE_BYTES) {
    throw new Error("Image must be between 1 byte and 8 MB");
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

/**
 * Storage key for the full (optimized) gallery image. `imageId` is always a
 * fresh client-generated UUID minted before the row exists — the storage RLS
 * policy is property-scoped, not image-scoped, so no DB row needs to exist
 * first (same reasoning as productImageStoragePath).
 */
export function galleryImageStoragePath(input: {
  propertyId: string;
  imageId: string;
  fileName: string;
}): string {
  if (![input.propertyId, input.imageId].every((value) => UUID_RE.test(value))) {
    throw new Error("Invalid storage identifier");
  }
  return `${input.propertyId}/${input.imageId}-${safeStorageSegment(input.fileName)}`;
}

/** Thumbnail lives in a nested prefix so a bucket listing trivially separates the two sizes. */
export function galleryThumbnailStoragePath(input: {
  propertyId: string;
  imageId: string;
  fileName: string;
}): string {
  if (![input.propertyId, input.imageId].every((value) => UUID_RE.test(value))) {
    throw new Error("Invalid storage identifier");
  }
  return `${input.propertyId}/thumbnails/${input.imageId}-${safeStorageSegment(input.fileName)}`;
}

const GALLERY_IMAGE_PATH_RE = /^([0-9a-f]{8}-[0-9a-f-]{27})\/[^/]+$/i;
const GALLERY_THUMB_PATH_RE = /^([0-9a-f]{8}-[0-9a-f-]{27})\/thumbnails\/[^/]+$/i;

/**
 * Confirms a storage path is actually shaped like one this feature would
 * have generated, under the given property — not just prefix-matching text.
 * Used before every insert/update/delete that carries a client-supplied path.
 */
export function assertGalleryImageNamespace(storagePath: string, propertyId: string): void {
  const match = GALLERY_IMAGE_PATH_RE.exec(storagePath);
  if (!match || match[1].toLowerCase() !== propertyId.toLowerCase()) {
    throw new Error("Invalid image reference");
  }
}

export function assertGalleryThumbnailNamespace(storagePath: string, propertyId: string): void {
  const match = GALLERY_THUMB_PATH_RE.exec(storagePath);
  if (!match || match[1].toLowerCase() !== propertyId.toLowerCase()) {
    throw new Error("Invalid thumbnail reference");
  }
}
