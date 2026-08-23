-- ============================================================
-- READ-ONLY preflight for the Hotel Gallery / Photo Vault release
-- (supabase/migrations/20260824090000_hotel_gallery_photo_vault.sql).
--
-- Every statement below is a SELECT. Confirms production is genuinely
-- pre-release for the new tables/enum/RPCs/bucket, captures baseline
-- counts for postflight comparison (including storage.objects per existing
-- bucket, so the postflight can prove this release added zero objects to
-- any pre-existing bucket), and records the current room_types schema and
-- role_permissions/admin_action_logs baselines.
--
-- CLI-safety note (established pattern): every UUID, enum/custom-type, and
-- regprocedure/regclass/regtype value is explicitly cast to ::text before
-- being selected -- `supabase db query --output json` fails to scan an
-- uncast custom OID-based type. No write/DDL keyword appears as contiguous
-- text anywhere in this file, including inside string literals --
-- assertReadOnlySqlFile() scans raw file text, not just real SQL syntax.
-- ============================================================

-- ------------------------------------------------------------
-- A. New objects must not exist yet (schema_fully_pre_release aggregate).
-- ------------------------------------------------------------
SELECT
  'schema_pre_release_checks' AS check_name,
  (to_regclass('public.gallery_albums') IS NULL) AS gallery_albums_absent,
  (to_regclass('public.gallery_images') IS NULL) AS gallery_images_absent,
  (to_regtype('public.gallery_context') IS NULL) AS gallery_context_enum_absent,
  (to_regprocedure('public.set_gallery_room_type_cover(uuid,uuid,uuid)') IS NULL) AS set_cover_fn_absent,
  (to_regprocedure('public.reorder_gallery_images(uuid,uuid[])') IS NULL) AS reorder_fn_absent,
  (to_regprocedure('public.seed_gallery_permissions(uuid)') IS NULL) AS seed_permissions_fn_absent,
  (to_regprocedure('public.seed_gallery_permissions_for_property()') IS NULL) AS seed_permissions_trigger_fn_absent,
  (NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'gallery-images')) AS bucket_absent,
  (NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'properties_seed_gallery_permissions')) AS seed_trigger_absent;

SELECT
  'schema_fully_pre_release' AS check_name,
  (
    to_regclass('public.gallery_albums') IS NULL
    AND to_regclass('public.gallery_images') IS NULL
    AND to_regtype('public.gallery_context') IS NULL
    AND to_regprocedure('public.set_gallery_room_type_cover(uuid,uuid,uuid)') IS NULL
    AND to_regprocedure('public.reorder_gallery_images(uuid,uuid[])') IS NULL
    AND to_regprocedure('public.seed_gallery_permissions(uuid)') IS NULL
    AND to_regprocedure('public.seed_gallery_permissions_for_property()') IS NULL
    AND NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'gallery-images')
    AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'properties_seed_gallery_permissions')
  ) AS result;

-- ------------------------------------------------------------
-- B. Baseline counts for postflight comparison -- this release must add
-- nothing to any pre-existing table, and must not create any gallery data.
-- ------------------------------------------------------------
SELECT
  'core_baseline_counts' AS check_name,
  (SELECT count(*) FROM public.properties) AS properties_count,
  (SELECT count(*) FROM public.room_types) AS room_types_count,
  (SELECT count(*) FROM public.reservations) AS reservations_count,
  (SELECT count(*) FROM public.admin_action_logs) AS admin_action_logs_count;

SELECT
  'role_permissions_baseline' AS check_name,
  (SELECT count(*) FROM public.role_permissions) AS role_permissions_total,
  (SELECT count(*) FROM public.role_permissions WHERE property_id IS NULL) AS role_permissions_global,
  (SELECT count(*) FROM public.role_permissions WHERE property_id IS NOT NULL) AS role_permissions_property_overrides,
  (SELECT count(*) FROM public.role_permissions WHERE module = 'gallery') AS role_permissions_gallery_module_rows;

-- ------------------------------------------------------------
-- C. Existing storage buckets and their per-bucket object counts -- the
-- postflight must show these unchanged, proving this release only ever
-- adds a new, separate bucket.
-- ------------------------------------------------------------
SELECT id::text AS bucket_id, "public", file_size_limit
FROM storage.buckets
ORDER BY id;

SELECT bucket_id::text, count(*) AS object_count
FROM storage.objects
GROUP BY bucket_id
ORDER BY bucket_id;

-- ------------------------------------------------------------
-- D. Current room_types schema snapshot -- confirm this release never
-- alters an existing table's shape (additive-only: two new tables, one new
-- enum, two new functions, one new bucket).
-- ------------------------------------------------------------
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'room_types'
ORDER BY ordinal_position;

-- ------------------------------------------------------------
-- E. Defensive: if the new objects somehow already exist in a
-- partially-applied state, confirm their grants/policies before assuming a
-- clean pre-release baseline (should return no rows when genuinely absent).
-- ------------------------------------------------------------
SELECT r.routine_name, g.grantee, g.privilege_type
FROM information_schema.routine_privileges g
JOIN information_schema.routines r ON r.specific_name = g.specific_name
WHERE r.routine_schema = 'public'
  AND r.routine_name IN ('set_gallery_room_type_cover', 'reorder_gallery_images', 'seed_gallery_permissions')
  AND g.grantee IN ('authenticated', 'anon', 'PUBLIC')
ORDER BY r.routine_name, g.grantee;

SELECT policyname, tablename::text
FROM pg_policies
WHERE tablename IN ('gallery_albums', 'gallery_images')
   OR (tablename = 'objects' AND policyname LIKE 'gallery_images_storage_%')
ORDER BY tablename, policyname;
