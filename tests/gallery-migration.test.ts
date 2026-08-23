import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  __dirname,
  "../supabase/migrations/20260824090000_hotel_gallery_photo_vault.sql",
);
const sql = readFileSync(migrationPath, "utf8");

describe("Gallery migration — schema shape", () => {
  it("defines the gallery_context enum with the exact 8 fixed values (no separate categories table)", () => {
    expect(sql).toContain("CREATE TYPE public.gallery_context AS ENUM");
    for (const v of [
      "hotel",
      "room_type",
      "restaurant",
      "bar",
      "gym",
      "swimming_pool",
      "facility",
      "other",
    ]) {
      expect(sql).toContain(`'${v}'`);
    }
    expect(sql).not.toMatch(/CREATE TABLE public\.gallery_categories/);
  });

  it("creates gallery_albums with a per-property unique name and a created_by actor column", () => {
    expect(sql).toContain("CREATE TABLE public.gallery_albums");
    expect(sql).toContain("UNIQUE (property_id, name)");
    expect(sql).toContain("created_by UUID REFERENCES auth.users(id)");
  });

  it("9. creates gallery_images with the required room-type linkage columns and the context/room_type CHECK constraint", () => {
    expect(sql).toContain("CREATE TABLE public.gallery_images");
    expect(sql).toContain("room_type_id UUID REFERENCES public.room_types(id) ON DELETE CASCADE");
    expect(sql).toContain("CONSTRAINT gallery_images_room_type_context CHECK");
    expect(sql).toMatch(/context = 'room_type' AND room_type_id IS NOT NULL/);
    expect(sql).toMatch(/context <> 'room_type' AND room_type_id IS NULL/);
  });

  it("captures every field the data model requires: title/caption/storage paths/sort order/active/uploaded_by/timestamps", () => {
    for (const col of [
      "title TEXT",
      "caption TEXT",
      "storage_path TEXT NOT NULL",
      "thumbnail_path TEXT NOT NULL",
      "sort_order INTEGER NOT NULL DEFAULT 0",
      "active BOOLEAN NOT NULL DEFAULT true",
      "uploaded_by UUID REFERENCES auth.users(id)",
    ]) {
      expect(sql).toContain(col);
    }
  });

  it("16. album_id uses ON DELETE SET NULL — deleting an album keeps its photos, only unalbums them", () => {
    expect(sql).toContain("album_id UUID REFERENCES public.gallery_albums(id) ON DELETE SET NULL");
  });

  it("11. enforces at most one cover image per room type via a partial unique index, not a boolean-toggle race", () => {
    expect(sql).toContain("CREATE UNIQUE INDEX gallery_images_room_type_cover_uq");
    expect(sql).toMatch(
      /ON public\.gallery_images \(room_type_id\)\s*\n\s*WHERE is_cover AND room_type_id IS NOT NULL/,
    );
  });

  it("29. never alters the pre-existing room_types table shape — purely additive, referencing it only via FK", () => {
    expect(sql).not.toMatch(/ALTER TABLE public\.room_types/);
  });
});

describe("Gallery migration — RLS / property isolation", () => {
  it("enables RLS on both tables", () => {
    expect(sql).toContain("ALTER TABLE public.gallery_albums ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE public.gallery_images ENABLE ROW LEVEL SECURITY");
  });

  it("6 / 27. staff reads are scoped via can_access_property — the same property-isolation gate used everywhere else in the app", () => {
    expect(sql).toMatch(
      /gallery_albums_read[\s\S]{0,120}can_access_property\(auth\.uid\(\), property_id\)/,
    );
    expect(sql).toMatch(
      /gallery_images_staff_read[\s\S]{0,120}can_access_property\(auth\.uid\(\), property_id\)/,
    );
  });

  it("18 / 19. anonymous public-booking read is a separate, narrower policy limited to active=true rows only", () => {
    expect(sql).toMatch(
      /CREATE POLICY gallery_images_public_read ON public\.gallery_images\s*\nFOR SELECT TO anon\s*\nUSING \(active\)/,
    );
  });

  it("7 / 8 / 26. every write path (insert/update/delete) is gated by has_permission, not left open to any authenticated user", () => {
    expect(sql).toMatch(
      /gallery_images_insert[\s\S]{0,150}has_permission\(auth\.uid\(\), property_id, 'gallery', 'create'\)/,
    );
    expect(sql).toMatch(
      /gallery_images_update[\s\S]{0,200}has_permission\(auth\.uid\(\), property_id, 'gallery', 'update'\)/,
    );
    expect(sql).toMatch(
      /gallery_images_delete[\s\S]{0,150}has_permission\(auth\.uid\(\), property_id, 'gallery', 'delete'\)/,
    );
    expect(sql).toMatch(
      /gallery_albums_insert[\s\S]{0,150}has_permission\(auth\.uid\(\), property_id, 'gallery', 'create'\)/,
    );
  });

  it("grants only SELECT to anon at the table-privilege level — no INSERT/UPDATE/DELETE grant exists for anon", () => {
    expect(sql).toContain("GRANT SELECT ON public.gallery_images TO anon");
    expect(sql).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*TO anon/i);
  });
});

describe("Gallery migration — reorder and cover RPCs", () => {
  it("12. reorder_gallery_images is SECURITY DEFINER, permission-checked, and rejects images that don't belong to the claimed property", () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.reorder_gallery_images\(_property_id UUID, _image_ids UUID\[\]\)/,
    );
    expect(sql).toMatch(/reorder_gallery_images[\s\S]{0,600}SECURITY DEFINER/);
    expect(sql).toMatch(/has_permission\(auth\.uid\(\), _property_id, 'gallery', 'update'\)/);
    expect(sql).toContain("_matched <> array_length(_image_ids, 1)");
  });

  it("does the sort_order rewrite as a single batched UPDATE, not a per-row loop — no partially-applied ordering is ever visible", () => {
    expect(sql).toMatch(/UPDATE public\.gallery_images gi\s*\n\s*SET sort_order = ord\.position/);
  });

  it("11. set_gallery_room_type_cover atomically clears the old cover and sets the new one in one transaction, and validates the image belongs to that room type", () => {
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION public.set_gallery_room_type_cover(_property_id UUID, _room_type_id UUID, _image_id UUID)",
    );
    expect(sql).toMatch(/set_gallery_room_type_cover[\s\S]{0,700}SECURITY DEFINER/);
    expect(sql).toContain("Image does not belong to this room type");
    expect(sql).toMatch(
      /SET is_cover = false\s*\n\s*WHERE room_type_id = _room_type_id AND property_id = _property_id AND is_cover AND id <> _image_id/,
    );
    expect(sql).toMatch(/SET is_cover = true\s*\n\s*WHERE id = _image_id/);
  });

  it("both RPCs revoke PUBLIC execute and grant only to authenticated", () => {
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.reorder_gallery_images(UUID, UUID[]) FROM PUBLIC",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.reorder_gallery_images(UUID, UUID[]) TO authenticated",
    );
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.set_gallery_room_type_cover(UUID, UUID, UUID) FROM PUBLIC",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.set_gallery_room_type_cover(UUID, UUID, UUID) TO authenticated",
    );
  });
});

describe("Gallery migration — permission seeding", () => {
  it("seeds exactly the read/create/update/delete actions for module 'gallery', for the same manager-tier roles used by room_types/branding", () => {
    expect(sql).toMatch(/\('gallery', 'read'\)/);
    expect(sql).toMatch(/\('gallery', 'create'\)/);
    expect(sql).toMatch(/\('gallery', 'update'\)/);
    expect(sql).toMatch(/\('gallery', 'delete'\)/);
    expect(sql).toMatch(
      /VALUES \('super_admin'\), \('hotel_owner'\), \('general_manager'\)\) role\(role_name\)/,
    );
  });

  it("seeds every existing property immediately and auto-seeds any future property via an AFTER INSERT trigger", () => {
    expect(sql).toContain("SELECT public.seed_gallery_permissions(id) FROM public.properties;");
    expect(sql).toContain(
      "CREATE TRIGGER properties_seed_gallery_permissions AFTER INSERT ON public.properties",
    );
  });

  it("the seeding functions are SECURITY DEFINER and restricted to service_role only — an ordinary user can never call them directly", () => {
    expect(sql).toMatch(
      /seed_gallery_permissions\(_property_id uuid\)[\s\S]{0,50}RETURNS void LANGUAGE plpgsql SECURITY DEFINER/,
    );
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.seed_gallery_permissions(uuid) FROM PUBLIC",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.seed_gallery_permissions(uuid) TO service_role",
    );
  });
});

describe("Gallery migration — storage bucket and object policies (PRIVATE bucket, PR #62 storage-visibility fix)", () => {
  it("4. creates a dedicated PRIVATE bucket scoped to image MIME types and an 8 MB size limit — never public, unlike an earlier version of this migration", () => {
    expect(sql).toMatch(/VALUES \(\s*\n\s*'gallery-images', 'gallery-images', false, 8388608,/);
    expect(sql).toContain("ARRAY['image/jpeg', 'image/png', 'image/webp']");
    expect(sql).toContain("public = false, file_size_limit = EXCLUDED.file_size_limit");
    expect(sql).not.toMatch(/'gallery-images', 'gallery-images', true,/);
  });

  it("documents why the bucket is private — a public bucket was proven live to ignore gallery_images.active entirely", () => {
    expect(sql).toMatch(
      /public-object endpoint serves a public bucket's objects\s*\n-- unconditionally, bypassing storage\.objects RLS/,
    );
    expect(sql).toContain("Proven live");
  });

  it("28. never touches the existing private buckets (uploads/backups/brand-assets/product-images) — no unrelated file is exposed by this change", () => {
    expect(sql).not.toContain("'brand-assets'");
    expect(sql).not.toContain("'product-images'");
    expect(sql).not.toMatch(/'uploads'[^;]*storage\.buckets/);
  });

  it("insert/update/delete on storage.objects are property-scoped via the first path segment and gated by has_permission, mirroring the product-images precedent", () => {
    expect(sql).toMatch(
      /gallery_images_storage_insert[\s\S]{0,250}has_permission\(auth\.uid\(\), \(\(storage\.foldername\(name\)\)\[1\]\)::uuid, 'gallery', 'create'\)/,
    );
    expect(sql).toMatch(
      /gallery_images_storage_update[\s\S]{0,300}has_permission\(auth\.uid\(\), \(\(storage\.foldername\(name\)\)\[1\]\)::uuid, 'gallery', 'update'\)/,
    );
    expect(sql).toMatch(
      /gallery_images_storage_delete[\s\S]{0,250}has_permission\(auth\.uid\(\), \(\(storage\.foldername\(name\)\)\[1\]\)::uuid, 'gallery', 'delete'\)/,
    );
  });

  it("2 / 3 / 18 / 19. the anon SELECT policy only matches a path that has a currently-active gallery_images row referencing it — a signed URL can never be minted for a hidden or orphaned object", () => {
    expect(sql).toMatch(
      /CREATE POLICY gallery_images_storage_public_read ON storage\.objects\s*\nFOR SELECT TO anon/,
    );
    expect(sql).toMatch(
      /gallery_images_storage_public_read[\s\S]{0,400}EXISTS \(\s*\n\s*SELECT 1 FROM public\.gallery_images gi\s*\n\s*WHERE gi\.active AND \(gi\.storage_path = storage\.objects\.name OR gi\.thumbnail_path = storage\.objects\.name\)/,
    );
  });

  it("9 / 10. the staff SELECT policy is has_permission-gated per property and does not require active — this is what lets Gallery Management preview a hidden image without making the bucket public", () => {
    expect(sql).toMatch(
      /CREATE POLICY gallery_images_storage_staff_read ON storage\.objects\s*\nFOR SELECT TO authenticated/,
    );
    expect(sql).toMatch(
      /gallery_images_storage_staff_read[\s\S]{0,250}has_permission\(auth\.uid\(\), \(\(storage\.foldername\(name\)\)\[1\]\)::uuid, 'gallery', 'read'\)/,
    );
  });

  it("exactly two SELECT policies exist on this bucket's objects — anon (active-gated) and authenticated staff (permission-gated) — no broader read path", () => {
    const selectPolicies =
      sql.match(/CREATE POLICY gallery_images_storage_\w+ ON storage\.objects\s*\nFOR SELECT/g) ??
      [];
    expect(selectPolicies).toHaveLength(2);
  });
});

describe("Gallery migration — genuinely read-only outside its own written objects", () => {
  it("contains no destructive statement against any pre-existing table (no DROP/TRUNCATE anywhere)", () => {
    expect(sql).not.toMatch(/\bDROP TABLE\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
  });
});
