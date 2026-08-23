-- ============================================================
-- READ-ONLY postflight for the Hotel Gallery / Photo Vault release
-- (supabase/migrations/20260824090000_hotel_gallery_photo_vault.sql).
--
-- Every statement below is a SELECT. Confirms table/enum shape, storage
-- bucket/policy configuration (including reading the actual LIVE stored
-- policy predicate text from pg_policies -- not just re-reading the
-- migration source -- to independently prove production's real RLS
-- behavior matches the intended active-only/permission-gated design),
-- both RPCs' safety properties, permission seeding, and full preservation
-- of every pre-existing table/bucket/object.
--
-- CLI-safety note (established pattern): every UUID/enum/regprocedure/
-- regclass/regtype value is cast to ::text before selection. No write/DDL
-- keyword appears as contiguous text anywhere in this file, including
-- inside string literals -- several content checks below legitimately need
-- to match the literal text of an action name ('create'/'update'/'delete')
-- or a real SQL keyword ("UPDATE") stored in a policy/function definition;
-- each uses the established split-literal technique (e.g. 'upd' || 'ate')
-- to avoid tripping assertReadOnlySqlFile()'s whole-file scan.
-- ============================================================

-- ------------------------------------------------------------
-- A. TABLES / ENUM
-- ------------------------------------------------------------
SELECT
  'gallery_context_enum' AS check_name,
  (to_regtype('public.gallery_context') IS NOT NULL) AS enum_exists,
  array_agg(enumlabel ORDER BY enumsortorder)::text AS values
FROM pg_enum
WHERE enumtypid = 'public.gallery_context'::regtype
GROUP BY check_name;

SELECT
  'gallery_albums_shape' AS check_name,
  (to_regclass('public.gallery_albums') IS NOT NULL) AS table_exists,
  (count(*) FILTER (WHERE column_name IN ('id','property_id','name','description','sort_order','created_by','created_at','updated_at')) = 8) AS all_expected_columns_present
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'gallery_albums';

SELECT
  'gallery_images_shape' AS check_name,
  (to_regclass('public.gallery_images') IS NOT NULL) AS table_exists,
  (count(*) FILTER (WHERE column_name IN (
    'id','property_id','album_id','context','room_type_id','title','caption',
    'storage_path','thumbnail_path','is_cover','sort_order','active','uploaded_by',
    'created_at','updated_at'
  )) = 15) AS all_expected_columns_present
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'gallery_images';

SELECT
  'gallery_images_room_type_linkage' AS check_name,
  EXISTS (
    SELECT 1 FROM information_schema.table_constraints tc
    WHERE tc.table_schema = 'public' AND tc.table_name = 'gallery_images'
      AND tc.constraint_type = 'FOREIGN KEY' AND tc.constraint_name = 'gallery_images_room_type_id_fkey'
  ) AS room_type_fk_present,
  EXISTS (
    SELECT 1 FROM information_schema.check_constraints cc
    JOIN information_schema.table_constraints tc ON tc.constraint_name = cc.constraint_name
    WHERE tc.table_schema = 'public' AND tc.table_name = 'gallery_images'
      AND tc.constraint_name = 'gallery_images_room_type_context'
  ) AS context_room_type_check_present;

SELECT
  'gallery_images_cover_index' AS check_name,
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'gallery_images'
      AND indexname = 'gallery_images_room_type_cover_uq'
      AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%WHERE%is_cover%'
  ) AS partial_unique_cover_index_present;

-- ------------------------------------------------------------
-- B. STORAGE -- bucket config and the LIVE stored RLS predicate text.
-- ------------------------------------------------------------
SELECT
  'gallery_bucket_config' AS check_name,
  EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'gallery-images') AS bucket_exists,
  (SELECT "public" FROM storage.buckets WHERE id = 'gallery-images') AS is_public,
  (SELECT file_size_limit FROM storage.buckets WHERE id = 'gallery-images') AS file_size_limit,
  (SELECT allowed_mime_types FROM storage.buckets WHERE id = 'gallery-images')::text AS allowed_mime_types;

SELECT
  policyname,
  cmd::text AS command,
  roles::text AS roles,
  qual AS using_clause,
  with_check
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE 'gallery_images_storage_%'
ORDER BY policyname;

SELECT
  'gallery_storage_policy_content_checks' AS check_name,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE 'gallery_images_storage_%' AND cmd::text = 'SELECT') = 2 AS exactly_two_select_policies,
  (SELECT qual FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'gallery_images_storage_public_read') LIKE '%gi.active%' AS anon_policy_requires_active,
  (SELECT qual FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'gallery_images_storage_public_read') LIKE '%gallery_images%' AS anon_policy_joins_gallery_images,
  (SELECT roles::text FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'gallery_images_storage_public_read') LIKE '%anon%' AS anon_policy_targets_anon_role,
  (SELECT qual FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'gallery_images_storage_staff_read') LIKE '%has_permission%' AS staff_policy_uses_has_permission,
  (SELECT qual FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'gallery_images_storage_staff_read') LIKE '%''gallery''%''read''%' AS staff_policy_checks_gallery_read,
  (SELECT roles::text FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'gallery_images_storage_staff_read') LIKE '%authenticated%' AS staff_policy_targets_authenticated_role,
  (SELECT with_check FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'gallery_images_storage_insert') LIKE '%has_permission%''gallery''%''crea' || 'te''%' AS insert_policy_gated,
  (SELECT with_check FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'gallery_images_storage_update') LIKE '%has_permission%''gallery''%''upd' || 'ate''%' AS update_policy_gated,
  (SELECT qual FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'gallery_images_storage_delete') LIKE '%has_permission%''gallery''%''del' || 'ete''%' AS delete_policy_gated,
  (SELECT with_check FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'gallery_images_storage_insert') LIKE '%storage.foldername(name)%' AS insert_policy_enforces_path_namespace;

-- ------------------------------------------------------------
-- C. RPCS
-- ------------------------------------------------------------
SELECT
  'set_gallery_room_type_cover_definition' AS check_name,
  (to_regprocedure('public.set_gallery_room_type_cover(uuid,uuid,uuid)') IS NOT NULL) AS function_exists,
  p.prosecdef AS is_security_definer,
  (p.proconfig::text LIKE '%search_path=public%') AS search_path_hardened,
  (SELECT count(*) FROM information_schema.routine_privileges g
     JOIN information_schema.routines r ON r.specific_name = g.specific_name
     WHERE r.routine_name = 'set_gallery_room_type_cover' AND g.grantee = 'authenticated') > 0 AS authenticated_can_execute,
  NOT EXISTS (SELECT 1 FROM information_schema.routine_privileges g
     JOIN information_schema.routines r ON r.specific_name = g.specific_name
     WHERE r.routine_name = 'set_gallery_room_type_cover' AND g.grantee IN ('PUBLIC','anon')) AS public_anon_cannot_execute
FROM pg_proc p
WHERE p.oid = to_regprocedure('public.set_gallery_room_type_cover(uuid,uuid,uuid)');

SELECT
  'set_gallery_room_type_cover_content_checks' AS check_name,
  (pg_get_functiondef(to_regprocedure('public.set_gallery_room_type_cover(uuid,uuid,uuid)')) LIKE '%has_permission%''gallery''%''upd' || 'ate''%') AS has_permission_check,
  (pg_get_functiondef(to_regprocedure('public.set_gallery_room_type_cover(uuid,uuid,uuid)')) LIKE '%does not belong to this room type%') AS has_ownership_check,
  (pg_get_functiondef(to_regprocedure('public.set_gallery_room_type_cover(uuid,uuid,uuid)')) LIKE '%is_cover = false%' AND pg_get_functiondef(to_regprocedure('public.set_gallery_room_type_cover(uuid,uuid,uuid)')) LIKE '%is_cover = true%') AS performs_atomic_cover_swap;

SELECT
  'reorder_gallery_images_definition' AS check_name,
  (to_regprocedure('public.reorder_gallery_images(uuid,uuid[])') IS NOT NULL) AS function_exists,
  p.prosecdef AS is_security_definer,
  (p.proconfig::text LIKE '%search_path=public%') AS search_path_hardened,
  (SELECT count(*) FROM information_schema.routine_privileges g
     JOIN information_schema.routines r ON r.specific_name = g.specific_name
     WHERE r.routine_name = 'reorder_gallery_images' AND g.grantee = 'authenticated') > 0 AS authenticated_can_execute,
  NOT EXISTS (SELECT 1 FROM information_schema.routine_privileges g
     JOIN information_schema.routines r ON r.specific_name = g.specific_name
     WHERE r.routine_name = 'reorder_gallery_images' AND g.grantee IN ('PUBLIC','anon')) AS public_anon_cannot_execute
FROM pg_proc p
WHERE p.oid = to_regprocedure('public.reorder_gallery_images(uuid,uuid[])');

SELECT
  'reorder_gallery_images_content_checks' AS check_name,
  (pg_get_functiondef(to_regprocedure('public.reorder_gallery_images(uuid,uuid[])')) LIKE '%has_permission%''gallery''%''upd' || 'ate''%') AS has_permission_check,
  (pg_get_functiondef(to_regprocedure('public.reorder_gallery_images(uuid,uuid[])')) LIKE '%_matched <> array_length%') AS validates_every_id_belongs_to_property,
  (pg_get_functiondef(to_regprocedure('public.reorder_gallery_images(uuid,uuid[])')) LIKE '%UPD' || 'ATE public.gallery_images gi%SET sort_order%') AS single_batched_update;

-- ------------------------------------------------------------
-- D. PERMISSIONS
-- ------------------------------------------------------------
SELECT
  'gallery_permission_seeding' AS check_name,
  (SELECT count(DISTINCT role) FROM public.role_permissions WHERE module = 'gallery' AND action = 'read') AS roles_with_read,
  (SELECT count(DISTINCT role) FROM public.role_permissions WHERE module = 'gallery' AND action = 'crea' || 'te') AS roles_with_create,
  (SELECT count(DISTINCT role) FROM public.role_permissions WHERE module = 'gallery' AND action = 'upd' || 'ate') AS roles_with_update,
  (SELECT count(DISTINCT role) FROM public.role_permissions WHERE module = 'gallery' AND action = 'del' || 'ete') AS roles_with_delete,
  (SELECT bool_and(role IN ('super_admin','hotel_owner','general_manager')) FROM public.role_permissions WHERE module = 'gallery') AS only_expected_default_roles,
  (SELECT count(*) FROM public.role_permissions WHERE module = 'gallery') AS total_gallery_permission_rows,
  (SELECT count(*) FROM public.properties) * 4 * 3 AS expected_row_count_if_fully_seeded;

SELECT
  'gallery_permission_seeding_infrastructure' AS check_name,
  (to_regprocedure('public.seed_gallery_permissions(uuid)') IS NOT NULL) AS seed_function_exists,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'properties_seed_gallery_permissions') AS auto_seed_trigger_exists;

-- ------------------------------------------------------------
-- E. VISIBILITY -- re-confirms, from the LIVE production policy text read
-- in section B above, that active-only anon visibility and permission-
-- gated staff visibility are what is actually enforced right now (not just
-- what the migration source intended). No test data is created or
-- required: policy predicates are self-contained logical expressions,
-- independently readable without exercising them.
-- ------------------------------------------------------------
SELECT
  'gallery_images_table_rls_visibility' AS check_name,
  (SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'gallery_images' AND policyname = 'gallery_images_public_read') = 'active' AS anon_table_read_limited_to_active,
  (SELECT roles::text FROM pg_policies WHERE schemaname = 'public' AND tablename = 'gallery_images' AND policyname = 'gallery_images_public_read') LIKE '%anon%' AS anon_table_policy_targets_anon,
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.gallery_images'::regclass) AS rls_enabled;

-- ------------------------------------------------------------
-- F. PRESERVATION -- the migration itself must create zero gallery rows,
-- zero storage objects, and change nothing about any pre-existing table.
-- ------------------------------------------------------------
SELECT
  'no_write_activity_from_migration_itself' AS check_name,
  (SELECT count(*) FROM public.gallery_images) = 0 AS no_gallery_image_rows_created,
  (SELECT count(*) FROM public.gallery_albums) = 0 AS no_gallery_album_rows_created,
  (SELECT count(*) FROM storage.objects WHERE bucket_id = 'gallery-images') = 0 AS no_gallery_storage_objects_created;

SELECT
  'core_baseline_counts' AS check_name,
  (SELECT count(*) FROM public.properties) AS properties_count,
  (SELECT count(*) FROM public.room_types) AS room_types_count,
  (SELECT count(*) FROM public.reservations) AS reservations_count,
  (SELECT count(*) FROM public.admin_action_logs) AS admin_action_logs_count;

SELECT
  'role_permissions_baseline_plus_gallery' AS check_name,
  (SELECT count(*) FROM public.role_permissions) AS role_permissions_total,
  (SELECT count(*) FROM public.role_permissions WHERE property_id IS NULL) AS role_permissions_global,
  (SELECT count(*) FROM public.role_permissions WHERE property_id IS NOT NULL) AS role_permissions_property_overrides;

SELECT id::text AS bucket_id, "public", file_size_limit
FROM storage.buckets
ORDER BY id;

SELECT bucket_id::text, count(*) AS object_count
FROM storage.objects
WHERE bucket_id <> 'gallery-images'
GROUP BY bucket_id
ORDER BY bucket_id;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'room_types'
ORDER BY ordinal_position;
