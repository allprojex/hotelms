import { safeStorageSegment } from "@/lib/hrm/domain";

export function uuid(value: unknown): string {
  const v = String(value ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v)) throw new Error("Valid identifier required");
  return v;
}

export function optionalUuid(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return uuid(value);
}

export const PRODUCT_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_PRODUCT_IMAGE_BYTES = 8 * 1024 * 1024;

export function validateProductImageFile(file: { type: string; size: number }): void {
  if (!PRODUCT_IMAGE_MIME_TYPES.includes(file.type as (typeof PRODUCT_IMAGE_MIME_TYPES)[number])) {
    throw new Error("Unsupported image file type");
  }
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_PRODUCT_IMAGE_BYTES) {
    throw new Error("Image must be between 1 byte and 8 MB");
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

/**
 * Storage key for a product image. `itemId` is the real inventory_items id
 * when editing, or a client-generated UUID for a product that has not been
 * saved yet — the storage RLS policy is property-scoped, not item-scoped, so
 * either works without a database row existing first.
 */
export function productImageStoragePath(input: {
  propertyId: string;
  itemId: string;
  imageId: string;
  fileName: string;
}): string {
  if (![input.propertyId, input.itemId, input.imageId].every((value) => UUID_RE.test(value))) {
    throw new Error("Invalid storage identifier");
  }
  return `${input.propertyId}/inventory-items/${input.itemId}/${input.imageId}-${safeStorageSegment(input.fileName)}`;
}

export const PRODUCT_IMAGE_BACKGROUNDS = ["studio", "transparent", "lifestyle"] as const;
export type ProductImageBackground = (typeof PRODUCT_IMAGE_BACKGROUNDS)[number];

export function validateBackground(value: unknown): ProductImageBackground {
  if (!PRODUCT_IMAGE_BACKGROUNDS.includes(value as ProductImageBackground)) {
    return "studio";
  }
  return value as ProductImageBackground;
}

export const MIN_PRODUCT_IMAGE_PROMPT_LENGTH = 3;
export const MAX_PRODUCT_IMAGE_PROMPT_LENGTH = 800;

export function sanitizeProductImagePrompt(value: unknown): string {
  const trimmed = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (trimmed.length < MIN_PRODUCT_IMAGE_PROMPT_LENGTH) {
    throw new Error("Enter a description of the product image to generate");
  }
  if (trimmed.length > MAX_PRODUCT_IMAGE_PROMPT_LENGTH) {
    throw new Error(`Prompt must be ${MAX_PRODUCT_IMAGE_PROMPT_LENGTH} characters or fewer`);
  }
  return trimmed;
}

/** Bounded, optional descriptive fields — never cost, supplier, or internal data. */
export function optionalShortText(value: unknown, max = 120): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}
