-- Hotel Gallery / Photo Vault. Admin-managed photo gallery: albums for
-- free-form curation, a fixed `gallery_context` enum for the closed set of
-- subject types the client actually asked for (hotel/room_type/restaurant/
-- bar/gym/swimming_pool/facility/other). No separate "categories" table:
-- the client's own examples ("Room, Facility, Restaurant") are exactly this
-- fixed, code-meaningful set already, so a second free-text taxonomy table
-- would just duplicate it with no operational use. Albums remain the only
-- open-ended, admin-created grouping ("Deluxe Rooms", "Pool & Leisure").
--
-- Mirrors the product_images permission/storage pattern (see
-- 20260812150000_product_image_generation.sql) as closely as possible:
-- same has_permission()-gated storage RLS shape, same
-- seed_..._permissions()-on-property-insert trigger convention. The one
-- deliberate divergence is that this bucket is PUBLIC (product-images is
-- private) — gallery images must render in a plain <img src> on the
-- unauthenticated public booking pages with no signed-URL/session
-- requirement, and this bucket holds nothing but gallery images, so making
-- it public does not expose any unrelated private file (Phase 4's own
-- stated condition for choosing a public bucket).

-- ============ CONTEXT ENUM ============
DO $$ BEGIN
  CREATE TYPE public.gallery_context AS ENUM (
    'hotel', 'room_type', 'restaurant', 'bar', 'gym', 'swimming_pool', 'facility', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============ ALBUMS ============
CREATE TABLE public.gallery_albums (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES public.properties(id),
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, name)
);

CREATE TRIGGER gallery_albums_set_updated_at
BEFORE UPDATE ON public.gallery_albums
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.gallery_albums ENABLE ROW LEVEL SECURITY;

CREATE POLICY gallery_albums_read ON public.gallery_albums
FOR SELECT TO authenticated
USING (public.can_access_property(auth.uid(), property_id));

CREATE POLICY gallery_albums_insert ON public.gallery_albums
FOR INSERT TO authenticated
WITH CHECK (public.has_permission(auth.uid(), property_id, 'gallery', 'create'));

CREATE POLICY gallery_albums_update ON public.gallery_albums
FOR UPDATE TO authenticated
USING (public.has_permission(auth.uid(), property_id, 'gallery', 'update'))
WITH CHECK (public.has_permission(auth.uid(), property_id, 'gallery', 'update'));

CREATE POLICY gallery_albums_delete ON public.gallery_albums
FOR DELETE TO authenticated
USING (public.has_permission(auth.uid(), property_id, 'gallery', 'delete'));

REVOKE ALL ON public.gallery_albums FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gallery_albums TO authenticated;

-- ============ IMAGES ============
CREATE TABLE public.gallery_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES public.properties(id),
  album_id UUID REFERENCES public.gallery_albums(id) ON DELETE SET NULL,
  context public.gallery_context NOT NULL DEFAULT 'other',
  -- CASCADE is a referential-integrity safety net, not an active application
  -- path: no room_type deletion UI/RPC exists anywhere in this codebase today
  -- (rooms.types.tsx only ever inserts/updates). If a hard-delete is ever
  -- added, it must be paired with explicit storage cleanup for any rows this
  -- cascades away, mirroring how deleteGalleryImage already removes storage
  -- objects for a normal single-image delete — see the implementation report
  -- for this flagged as an unresolved concern.
  room_type_id UUID REFERENCES public.room_types(id) ON DELETE CASCADE,
  title TEXT,
  caption TEXT,
  storage_path TEXT NOT NULL,
  thumbnail_path TEXT NOT NULL,
  is_cover BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  uploaded_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gallery_images_room_type_context CHECK (
    (context = 'room_type' AND room_type_id IS NOT NULL) OR
    (context <> 'room_type' AND room_type_id IS NULL)
  )
);

-- At most one cover image per room type — a partial unique index rather than
-- a boolean-toggle dance, so "set cover" can never race into two rows both
-- reading true; the second concurrent UPDATE simply fails the constraint.
CREATE UNIQUE INDEX gallery_images_room_type_cover_uq
  ON public.gallery_images (room_type_id)
  WHERE is_cover AND room_type_id IS NOT NULL;

CREATE INDEX gallery_images_property_context_idx ON public.gallery_images (property_id, context, sort_order);
CREATE INDEX gallery_images_album_idx ON public.gallery_images (album_id, sort_order);
CREATE INDEX gallery_images_room_type_idx ON public.gallery_images (room_type_id, sort_order);
CREATE INDEX gallery_images_public_read_idx ON public.gallery_images (property_id, context) WHERE active;

CREATE TRIGGER gallery_images_set_updated_at
BEFORE UPDATE ON public.gallery_images
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.gallery_images ENABLE ROW LEVEL SECURITY;

-- Staff: any role with property access can read every image (active or not)
-- for that property — mirrors room_types_read, so reception can see a photo
-- an admin just uploaded before deciding to publish it.
CREATE POLICY gallery_images_staff_read ON public.gallery_images
FOR SELECT TO authenticated
USING (public.can_access_property(auth.uid(), property_id));

-- Public/anon: online booking is unauthenticated. Only active=true rows are
-- visible, and only via SELECT — anon can never write.
CREATE POLICY gallery_images_public_read ON public.gallery_images
FOR SELECT TO anon
USING (active);

CREATE POLICY gallery_images_insert ON public.gallery_images
FOR INSERT TO authenticated
WITH CHECK (public.has_permission(auth.uid(), property_id, 'gallery', 'create'));

CREATE POLICY gallery_images_update ON public.gallery_images
FOR UPDATE TO authenticated
USING (public.has_permission(auth.uid(), property_id, 'gallery', 'update'))
WITH CHECK (public.has_permission(auth.uid(), property_id, 'gallery', 'update'));

CREATE POLICY gallery_images_delete ON public.gallery_images
FOR DELETE TO authenticated
USING (public.has_permission(auth.uid(), property_id, 'gallery', 'delete'));

REVOKE ALL ON public.gallery_images FROM PUBLIC;
GRANT SELECT ON public.gallery_images TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gallery_images TO authenticated;

-- ============ REORDER RPC ============
-- Batched, single-transaction sort_order update so a reorder can never leave
-- a partially-applied ordering visible to a concurrent reader. Scoped to one
-- album/room_type/context group at a time: the caller must own (via
-- has_permission) the property of every id it passes, and every id must
-- already belong to the property it claims — cross-property reorder is
-- rejected outright rather than silently reordering only the matching subset.
CREATE OR REPLACE FUNCTION public.reorder_gallery_images(_property_id UUID, _image_ids UUID[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _matched INTEGER;
BEGIN
  IF _image_ids IS NULL OR array_length(_image_ids, 1) IS NULL THEN
    RETURN;
  END IF;
  IF NOT public.has_permission(auth.uid(), _property_id, 'gallery', 'update') THEN
    RAISE EXCEPTION 'Not authorized to reorder gallery images';
  END IF;

  SELECT count(*) INTO _matched
  FROM public.gallery_images
  WHERE id = ANY(_image_ids) AND property_id = _property_id;
  IF _matched <> array_length(_image_ids, 1) THEN
    RAISE EXCEPTION 'One or more images do not belong to this property';
  END IF;

  UPDATE public.gallery_images gi
  SET sort_order = ord.position
  FROM (SELECT unnest(_image_ids) AS id, generate_subscripts(_image_ids, 1) - 1 AS position) ord
  WHERE gi.id = ord.id;
END;
$$;
REVOKE ALL ON FUNCTION public.reorder_gallery_images(UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reorder_gallery_images(UUID, UUID[]) TO authenticated;

-- ============ SET COVER RPC ============
-- Atomically clears any existing cover for the room type and sets the new
-- one in a single transaction, so the partial-unique-index invariant ("at
-- most one cover per room_type") can never be violated by a naive
-- read-then-two-updates race between two concurrent admins.
CREATE OR REPLACE FUNCTION public.set_gallery_room_type_cover(_property_id UUID, _room_type_id UUID, _image_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_permission(auth.uid(), _property_id, 'gallery', 'update') THEN
    RAISE EXCEPTION 'Not authorized to change the cover image';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.gallery_images
    WHERE id = _image_id AND property_id = _property_id AND room_type_id = _room_type_id
  ) THEN
    RAISE EXCEPTION 'Image does not belong to this room type';
  END IF;

  UPDATE public.gallery_images
  SET is_cover = false
  WHERE room_type_id = _room_type_id AND property_id = _property_id AND is_cover AND id <> _image_id;

  UPDATE public.gallery_images
  SET is_cover = true
  WHERE id = _image_id;
END;
$$;
REVOKE ALL ON FUNCTION public.set_gallery_room_type_cover(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_gallery_room_type_cover(UUID, UUID, UUID) TO authenticated;

-- ============ PERMISSION SEEDING ============
-- Same default tier as room_types_write / branding property-scope writes:
-- super_admin, hotel_owner, general_manager. Extendable per-property via
-- role_permissions afterwards (e.g. granting front_desk edit) without a
-- further migration, exactly like product_images.
CREATE OR REPLACE FUNCTION public.seed_gallery_permissions(_property_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.role_permissions(property_id, role, module, action, allowed)
  SELECT _property_id, role_name::public.app_role, module_name, action_name, true
  FROM (VALUES
    ('gallery', 'read'),
    ('gallery', 'create'),
    ('gallery', 'update'),
    ('gallery', 'delete')
  ) permission(module_name, action_name)
  CROSS JOIN (VALUES ('super_admin'), ('hotel_owner'), ('general_manager')) role(role_name)
  ON CONFLICT DO NOTHING;
END; $$;
SELECT public.seed_gallery_permissions(id) FROM public.properties;
REVOKE ALL ON FUNCTION public.seed_gallery_permissions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_gallery_permissions(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.seed_gallery_permissions_for_property()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN PERFORM public.seed_gallery_permissions(NEW.id); RETURN NEW; END $$;
CREATE TRIGGER properties_seed_gallery_permissions AFTER INSERT ON public.properties
FOR EACH ROW EXECUTE FUNCTION public.seed_gallery_permissions_for_property();
REVOKE ALL ON FUNCTION public.seed_gallery_permissions_for_property() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_gallery_permissions_for_property() TO service_role;

-- ============ STORAGE BUCKET ============
-- PRIVATE. An earlier version of this migration made the bucket public,
-- reasoning that gallery_images.active alone would gate visibility. That is
-- wrong: Supabase's public-object endpoint serves a public bucket's objects
-- unconditionally, bypassing storage.objects RLS (and therefore bypassing
-- gallery_images.active) entirely. Proven live: with the bucket public, an
-- object stayed fetchable at 200 after its row was set active=false, and
-- again after the row was deleted outright, leaving a permanently-public
-- orphan. See PR #62's storage-visibility review for the full reproduction.
--
-- With the bucket private, the ONLY way to read an object is a signed URL,
-- and Supabase only mints one if the requesting role currently passes a
-- SELECT policy on storage.objects at *signing time* — so visibility always
-- reflects the live value of gallery_images.active, not a URL's shape.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'gallery-images', 'gallery-images', false, 8388608,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = false, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Property-scoped: first storage path segment must be the property_id, same
-- convention as product-images/employee-documents.
CREATE POLICY gallery_images_storage_insert ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'gallery-images'
  AND public.has_permission(auth.uid(), ((storage.foldername(name))[1])::uuid, 'gallery', 'create')
);

-- Public/anon signing path: a signed URL can only ever be minted for an
-- object that currently has a matching gallery_images row with active=true.
-- The instant active flips to false, this policy stops matching and any new
-- signing attempt is denied (an already-issued signed URL from before the
-- flip keeps working until its own short embedded expiry — inherent to any
-- signed-URL design, and the reason the TTL is kept short; see
-- GALLERY_SIGNED_URL_TTL_SECONDS in src/lib/gallery/signed-url.ts).
CREATE POLICY gallery_images_storage_public_read ON storage.objects
FOR SELECT TO anon
USING (
  bucket_id = 'gallery-images'
  AND EXISTS (
    SELECT 1 FROM public.gallery_images gi
    WHERE gi.active AND (gi.storage_path = storage.objects.name OR gi.thumbnail_path = storage.objects.name)
  )
);

-- Staff signing path: any authenticated user holding the gallery read
-- permission for this property can sign ANY image under it regardless of
-- active — this is what lets Gallery Management preview hidden images
-- without making the bucket public. Deliberately does not join against
-- gallery_images at all (unlike the anon policy above) so upload-in-progress
-- objects with no row yet can still be previewed by the uploader.
CREATE POLICY gallery_images_storage_staff_read ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'gallery-images'
  AND public.has_permission(auth.uid(), ((storage.foldername(name))[1])::uuid, 'gallery', 'read')
);

CREATE POLICY gallery_images_storage_update ON storage.objects
FOR UPDATE TO authenticated
USING (
  bucket_id = 'gallery-images'
  AND public.has_permission(auth.uid(), ((storage.foldername(name))[1])::uuid, 'gallery', 'update')
)
WITH CHECK (
  bucket_id = 'gallery-images'
  AND public.has_permission(auth.uid(), ((storage.foldername(name))[1])::uuid, 'gallery', 'update')
);

CREATE POLICY gallery_images_storage_delete ON storage.objects
FOR DELETE TO authenticated
USING (
  bucket_id = 'gallery-images'
  AND public.has_permission(auth.uid(), ((storage.foldername(name))[1])::uuid, 'gallery', 'delete')
);
