import { describe, expect, it } from "vitest";
import {
  GALLERY_CONTEXTS,
  GALLERY_IMAGE_MIME_TYPES,
  MAX_GALLERY_IMAGE_BYTES,
  validateGalleryImageFile,
  validateGalleryContext,
  galleryImageStoragePath,
  galleryThumbnailStoragePath,
  assertGalleryImageNamespace,
  assertGalleryThumbnailNamespace,
  uuid,
  optionalUuid,
  optionalShortText,
} from "@/lib/gallery/domain";

const PROPERTY_A = "11111111-1111-1111-1111-111111111111";
const PROPERTY_B = "22222222-2222-2222-2222-222222222222";
const IMAGE_ID = "33333333-3333-3333-3333-333333333333";

describe("validateGalleryImageFile", () => {
  it("3. rejects an invalid MIME type", () => {
    expect(() => validateGalleryImageFile({ type: "application/pdf", size: 1000 })).toThrow(
      /unsupported/i,
    );
  });

  it("4. rejects an oversized file (> 8 MB)", () => {
    expect(() =>
      validateGalleryImageFile({ type: "image/jpeg", size: MAX_GALLERY_IMAGE_BYTES + 1 }),
    ).toThrow(/8 MB/);
  });

  it("5. rejects SVG explicitly — not part of the accepted whitelist", () => {
    expect(GALLERY_IMAGE_MIME_TYPES).not.toContain("image/svg+xml");
    expect(() => validateGalleryImageFile({ type: "image/svg+xml", size: 1000 })).toThrow(
      /unsupported/i,
    );
  });

  it("1. accepts every whitelisted MIME type within the size limit (single-image upload path)", () => {
    for (const type of GALLERY_IMAGE_MIME_TYPES) {
      expect(() => validateGalleryImageFile({ type, size: 1024 })).not.toThrow();
    }
  });

  it("rejects a zero-byte file", () => {
    expect(() => validateGalleryImageFile({ type: "image/jpeg", size: 0 })).toThrow();
  });

  it("rejects a negative or non-finite size (defensive against a spoofed value)", () => {
    expect(() => validateGalleryImageFile({ type: "image/jpeg", size: -1 })).toThrow();
    expect(() => validateGalleryImageFile({ type: "image/jpeg", size: NaN })).toThrow();
  });
});

describe("validateGalleryContext", () => {
  it("accepts every declared context", () => {
    for (const c of GALLERY_CONTEXTS) {
      expect(validateGalleryContext(c)).toBe(c);
    }
  });

  it("rejects an arbitrary/unknown context string", () => {
    expect(() => validateGalleryContext("spa")).toThrow(/invalid/i);
  });

  it("15. the context set is a fixed closed enum, not an open admin-editable taxonomy — this is the deliberate substitute for a separate categories table", () => {
    expect(GALLERY_CONTEXTS).toEqual([
      "hotel",
      "room_type",
      "restaurant",
      "bar",
      "gym",
      "swimming_pool",
      "facility",
      "other",
    ]);
  });
});

describe("galleryImageStoragePath / galleryThumbnailStoragePath", () => {
  it("produces a property-scoped path with the sanitized filename", () => {
    const path = galleryImageStoragePath({
      propertyId: PROPERTY_A,
      imageId: IMAGE_ID,
      fileName: "Pool View.jpg",
    });
    expect(path).toBe(`${PROPERTY_A}/${IMAGE_ID}-Pool-View.jpg`);
  });

  it("nests the thumbnail under a thumbnails/ prefix for the same property", () => {
    const path = galleryThumbnailStoragePath({
      propertyId: PROPERTY_A,
      imageId: IMAGE_ID,
      fileName: "Pool View.jpg",
    });
    expect(path).toBe(`${PROPERTY_A}/thumbnails/${IMAGE_ID}-Pool-View.jpg`);
  });

  it("24. sanitizes a malicious/path-traversal filename into a safe flat segment", () => {
    const path = galleryImageStoragePath({
      propertyId: PROPERTY_A,
      imageId: IMAGE_ID,
      fileName: "../../etc/passwd\0.jpg",
    });
    expect(path).not.toContain("..");
    expect(path).not.toContain("/etc/");
    expect(path.startsWith(`${PROPERTY_A}/${IMAGE_ID}-`)).toBe(true);
  });

  it("25. two uploads with an identical original filename never collide — the fresh per-upload imageId makes every path unique", () => {
    const otherImageId = "44444444-4444-4444-4444-444444444444";
    const pathA = galleryImageStoragePath({
      propertyId: PROPERTY_A,
      imageId: IMAGE_ID,
      fileName: "photo.jpg",
    });
    const pathB = galleryImageStoragePath({
      propertyId: PROPERTY_A,
      imageId: otherImageId,
      fileName: "photo.jpg",
    });
    expect(pathA).not.toBe(pathB);
  });

  it("rejects a non-UUID propertyId/imageId (defensive against a malformed ticket request)", () => {
    expect(() =>
      galleryImageStoragePath({ propertyId: "not-a-uuid", imageId: IMAGE_ID, fileName: "a.jpg" }),
    ).toThrow();
  });
});

describe("assertGalleryImageNamespace / assertGalleryThumbnailNamespace", () => {
  it("accepts a path whose leading segment matches the claimed property", () => {
    const path = galleryImageStoragePath({
      propertyId: PROPERTY_A,
      imageId: IMAGE_ID,
      fileName: "a.jpg",
    });
    expect(() => assertGalleryImageNamespace(path, PROPERTY_A)).not.toThrow();
  });

  it("6 / 26. rejects a path claiming a different property than the one it was generated for (cross-property access/delete attempt)", () => {
    const path = galleryImageStoragePath({
      propertyId: PROPERTY_A,
      imageId: IMAGE_ID,
      fileName: "a.jpg",
    });
    expect(() => assertGalleryImageNamespace(path, PROPERTY_B)).toThrow(/invalid image reference/i);
  });

  it("each assertion only accepts its own exact shape — a thumbnail path fails the full-image check and vice versa, since the thumbnails/ segment makes the two shapes mutually exclusive", () => {
    const fullPath = galleryImageStoragePath({
      propertyId: PROPERTY_A,
      imageId: IMAGE_ID,
      fileName: "a.jpg",
    });
    const thumbPath = galleryThumbnailStoragePath({
      propertyId: PROPERTY_A,
      imageId: IMAGE_ID,
      fileName: "a.jpg",
    });
    expect(() => assertGalleryThumbnailNamespace(fullPath, PROPERTY_A)).toThrow();
    expect(() => assertGalleryImageNamespace(thumbPath, PROPERTY_A)).toThrow();
    expect(() => assertGalleryThumbnailNamespace(thumbPath, PROPERTY_A)).not.toThrow();
    expect(() => assertGalleryImageNamespace(fullPath, PROPERTY_A)).not.toThrow();
  });

  it("rejects a path that is not shaped like a real storage key at all (not just prefix-matching text)", () => {
    expect(() =>
      assertGalleryImageNamespace(`${PROPERTY_A}-not-actually-a-uuid-boundary/x.jpg`, PROPERTY_A),
    ).toThrow();
  });
});

describe("small validators reused from the established pattern", () => {
  it("uuid() accepts a valid UUID and rejects garbage", () => {
    expect(uuid(PROPERTY_A)).toBe(PROPERTY_A);
    expect(() => uuid("nope")).toThrow();
  });

  it("optionalUuid() treats empty/undefined as null without throwing", () => {
    expect(optionalUuid(undefined)).toBeNull();
    expect(optionalUuid("")).toBeNull();
    expect(optionalUuid(PROPERTY_A)).toBe(PROPERTY_A);
  });

  it("optionalShortText() trims, empties-to-null, and truncates", () => {
    expect(optionalShortText("  hello  ")).toBe("hello");
    expect(optionalShortText("   ")).toBeNull();
    expect(optionalShortText("x".repeat(300), 10)).toHaveLength(10);
  });
});
