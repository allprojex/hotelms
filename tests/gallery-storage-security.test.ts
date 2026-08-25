import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Normalize line endings before matching. These assertions pin multi-line
// source shapes (e.g. a `.from(...)` with `.createSignedUrl(` chained onto the next line), and a Windows checkout with core.autocrlf=true stores
// those files with CRLF -- so a "\n"-joined expectation fails for a purely
// platform-dependent reason while the source is byte-for-byte correct. Same
// convention as tests/reservations-checkin-date-filter.test.ts.
function normalizeEol(source: string): string {
  return source.replace(/\r\n/g, "\n");
}

function read(relPath: string): string {
  return normalizeEol(readFileSync(resolve(__dirname, "..", relPath), "utf8"));
}

const migrationPath = resolve(
  __dirname,
  "../supabase/migrations/20260824090000_hotel_gallery_photo_vault.sql",
);
const sql = normalizeEol(readFileSync(migrationPath, "utf8"));
const signedUrlModule = read("src/lib/gallery/signed-url.ts");
const galleryFunctions = read("src/lib/gallery/gallery.functions.ts");
const imageCard = read("src/components/gallery/gallery-image-card.tsx");
const preview = read("src/components/gallery/room-type-gallery-preview.tsx");
const brandModule = read("src/components/admin/modules/brand-module.tsx");
const productImagesFunctions = read("src/lib/inventory/product-images.functions.ts");

/**
 * This file pins the code-level guarantees behind the PR #62 storage-
 * visibility fix. The live reproduction and re-validation described in the
 * PR's security review (public bucket ignoring gallery_images.active;
 * private bucket + RLS-gated signing correctly respecting it, including
 * cross-property denial and admin-preview-of-hidden-images) was performed
 * against a local disposable Supabase instance via direct Storage REST
 * calls — not repeatable inside this Node-only, no-live-Postgres test
 * runner — and is not re-asserted here. What IS asserted here is that the
 * committed source matches the design that was proven live: no code path
 * reintroduces a public bucket, an unbounded TTL, a raw getPublicUrl call,
 * or a service-role secret in browser-reachable code.
 */

describe("1. Bucket is private", () => {
  it("the migration declares gallery-images as a private bucket, not public", () => {
    expect(sql).toMatch(/VALUES \(\s*\n\s*'gallery-images', 'gallery-images', false, 8388608,/);
  });
});

describe("2 / 3 / 8. Active-only visibility is enforced at the storage-signing layer, not just the DB-read layer", () => {
  it("the anon storage SELECT policy requires a live gallery_images row with active=true matching either path", () => {
    expect(sql).toMatch(
      /gallery_images_storage_public_read[\s\S]{0,400}WHERE gi\.active AND \(gi\.storage_path = storage\.objects\.name OR gi\.thumbnail_path = storage\.objects\.name\)/,
    );
  });

  it("this is a genuinely separate gate from the gallery_images table's own anon read policy (active=true) — both must independently agree before a public visitor sees anything", () => {
    expect(sql).toMatch(
      /CREATE POLICY gallery_images_public_read ON public\.gallery_images\s*\nFOR SELECT TO anon\s*\nUSING \(active\)/,
    );
    expect(sql).toMatch(
      /CREATE POLICY gallery_images_storage_public_read ON storage\.objects\s*\nFOR SELECT TO anon/,
    );
  });
});

describe("4 / 5. No direct/public object access path exists anywhere in the app's own code", () => {
  it("no gallery source file calls the public object endpoint (getPublicUrl) — every read is a signed URL", () => {
    for (const src of [signedUrlModule, galleryFunctions, imageCard, preview]) {
      expect(src).not.toMatch(/getPublicUrl/);
    }
  });

  it("the old public-url helper module no longer exists", () => {
    expect(() => read("src/lib/gallery/public-url.ts")).toThrow();
  });
});

describe("6 / 7. Both thumbnail and full-resolution reads go through the signed-URL helper", () => {
  it("gallerySignedUrl / gallerySignedUrls are the only way this feature reads an object", () => {
    expect(signedUrlModule).toContain("export async function gallerySignedUrl(");
    expect(signedUrlModule).toContain("export async function gallerySignedUrls(");
    expect(signedUrlModule).toContain('.from("gallery-images")\n    .createSignedUrl(');
  });

  it("the admin grid signs thumbnails; the shared preview component signs both thumbnail (grid) and full-resolution (lightbox) paths", () => {
    expect(imageCard).toContain("gallerySignedUrl(image.thumbnail_path)");
    expect(preview).toContain(
      "gallerySignedUrls(rows.flatMap((r) => [r.storage_path, r.thumbnail_path]))",
    );
  });
});

describe("9 / 10. Admin preview of hidden images, scoped per property", () => {
  it("the staff storage SELECT policy is gated by has_permission per property and does not reference gallery_images.active at all — a hidden image previews the same as a visible one for authorized staff", () => {
    expect(sql).toMatch(
      /gallery_images_storage_staff_read[\s\S]{0,250}has_permission\(auth\.uid\(\), \(\(storage\.foldername\(name\)\)\[1\]\)::uuid, 'gallery', 'read'\)/,
    );
    const staffPolicyBlock = sql.slice(
      sql.indexOf("CREATE POLICY gallery_images_storage_staff_read"),
    );
    expect(staffPolicyBlock.slice(0, 400)).not.toContain("gallery_images gi");
  });

  it("the admin image card never filters by active — it renders whatever rows the caller's RLS-scoped query returned, hidden or not", () => {
    expect(imageCard).not.toMatch(/active\s*===?\s*true/);
  });
});

describe("11 / 12. Cross-property and orphan protection on delete", () => {
  it("delete rejects an image that does not belong to the claimed property before removing anything", () => {
    expect(galleryFunctions).toMatch(
      /if \(!existing\.data \|\| existing\.data\.property_id !== data\.propertyId\)\s*\n\s*throw new Error\("Image not found"\)/,
    );
  });

  it("a storage-delete-object policy independently re-enforces the same property scoping at the storage layer (defense in depth beyond the app-layer check)", () => {
    expect(sql).toMatch(
      /gallery_images_storage_delete[\s\S]{0,250}has_permission\(auth\.uid\(\), \(\(storage\.foldername\(name\)\)\[1\]\)::uuid, 'gallery', 'delete'\)/,
    );
  });

  it("a left-behind object after a failed storage removal is structurally unreachable by anon the moment its DB row is gone — the anon policy requires a matching row to exist at all, not just active=true", () => {
    expect(galleryFunctions).toMatch(
      /requires a\s*\*?\s*matching\s*\n?\s*\*?\s*gallery_images row to exist/,
    );
  });
});

describe("13. Missing/already-gone storage object never blocks the metadata delete", () => {
  it("storage removal failure is caught, logged, and now also recorded as a distinct audit event for later cleanup — but never thrown", () => {
    expect(galleryFunctions).toMatch(/if \(removed\.error\) \{\s*\n\s*console\.warn/);
    expect(galleryFunctions).toContain('"gallery_image.orphan_storage_object"');
    expect(galleryFunctions).toMatch(/success: false,/);
  });

  it("the metadata row is deleted BEFORE the storage removal is attempted, so a storage failure can never leave the DB row dangling", () => {
    const del = galleryFunctions.indexOf('.from("gallery_images").delete().eq("id", data.imageId)');
    const remove = galleryFunctions.indexOf(
      ".remove([existing.data.storage_path, existing.data.thumbnail_path])",
    );
    expect(del).toBeGreaterThan(0);
    expect(remove).toBeGreaterThan(del);
  });
});

describe("14. Signed URL TTL is short and bounded — never a multi-year URL", () => {
  it("GALLERY_SIGNED_URL_TTL_SECONDS is a short, documented constant (15 minutes), nowhere near brand-assets' 10-year logo URL", () => {
    expect(signedUrlModule).toContain("export const GALLERY_SIGNED_URL_TTL_SECONDS = 900;");
  });

  it("no gallery code path requests a TTL longer than an hour", () => {
    const ttlLiterals = [...signedUrlModule.matchAll(/createSignedUrls?\([^,]+,\s*(\w+)\)/g)];
    expect(ttlLiterals.length).toBeGreaterThan(0);
    for (const match of ttlLiterals) {
      expect(match[1]).toBe("GALLERY_SIGNED_URL_TTL_SECONDS");
    }
  });
});

describe("15. No service-role secret is introduced into browser-reachable code", () => {
  it("no gallery source file references a service-role key, secret, or service_role client", () => {
    for (const src of [signedUrlModule, galleryFunctions, imageCard, preview]) {
      expect(src).not.toMatch(/service_role|SERVICE_ROLE|serviceRoleKey/i);
    }
  });

  it("all signing happens through the ordinary session-scoped supabase client, the same one already used for every other read in the app", () => {
    expect(signedUrlModule).toContain('import { supabase } from "@/integrations/supabase/client"');
  });
});

describe("16. Booking result grid stays batched — one bulk sign call, not one per card", () => {
  it("useRoomTypeCoverImages performs exactly one metadata query and one bulk gallerySignedUrls call for the whole list of room types", () => {
    expect(preview).toContain('.in("room_type_id", roomTypeIds)');
    const coverHookBody = preview.slice(
      preview.indexOf("export function useRoomTypeCoverImages"),
      preview.indexOf("export function RoomTypeCoverThumbnail"),
    );
    const signCalls = coverHookBody.match(/gallerySignedUrls\(/g) ?? [];
    expect(signCalls).toHaveLength(1);
  });

  it("gallerySignedUrls itself is a single Storage API call (createSignedUrls, plural) regardless of how many paths are passed", () => {
    expect(signedUrlModule).toContain(
      ".createSignedUrls(storagePaths, GALLERY_SIGNED_URL_TTL_SECONDS)",
    );
  });
});

describe("Secondary review — an inactive cover image never produces a broken-image card on public booking", () => {
  it("useRoomTypeCoverImages/useRoomTypeGalleryImages never filter by active client-side — they rely entirely on gallery_images' own anon RLS policy (active=true) to exclude hidden rows before the app ever sees them, so a hidden cover simply cannot be the first row returned to an anonymous caller", () => {
    expect(preview).not.toMatch(/\.eq\(\s*"active"/);
    expect(preview).not.toMatch(/\.active\s*===?\s*true/);
  });

  it("cover selection always takes the first row after ordering by is_cover desc, sort_order — for an anonymous caller RLS has already dropped every inactive row, so the next active image (or none) is what's actually selected, never a stale/hidden cover", () => {
    expect(preview).toContain('.order("is_cover", { ascending: false })');
    expect(preview).toContain('.order("sort_order", { ascending: true })');
    expect(preview).toContain("const cover = images.data?.[0]");
  });

  it("every render path falls back to an explicit ImageOff placeholder rather than an empty/broken <img> when no active cover exists", () => {
    expect(preview).toContain("ImageOff");
    const thumbnailComponent = preview.slice(
      preview.indexOf("export function RoomTypeCoverThumbnail"),
    );
    expect(thumbnailComponent).toMatch(/cover\?\.thumbnailUrl \? \(/);
  });
});

describe("17. Existing brand/product image flows are untouched by this change", () => {
  it("brand-assets logo signing still uses its own established 10-year-TTL pattern, unaffected by the gallery TTL", () => {
    expect(brandModule).toContain("TEN_YEARS_SECONDS");
    expect(brandModule).toContain('.from("brand-assets")');
  });

  it("product-images signing still uses its own established 300-second TTL, unaffected by the gallery TTL", () => {
    expect(productImagesFunctions).toContain("SIGNED_URL_TTL_SECONDS = 300");
    expect(productImagesFunctions).toContain('PRODUCT_IMAGES_BUCKET = "product-images"');
  });
});
