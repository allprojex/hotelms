-- ============================================================
-- READ-ONLY postflight for the inventory CSV/XLSX import hardening
-- release (supabase/migrations/20260823150000_inventory_import_rpc.sql
-- and supabase/migrations/20260823160000_inventory_import_bulk_rpc.sql).
--
-- Every statement below is a SELECT. Confirms the expected end-state after
-- applying both migrations to production. Compare the baseline
-- counts/schema sections below against the SAME queries' output from the
-- preflight run performed immediately before applying -- they must match
-- exactly (this release changes functions/one CHECK constraint only,
-- never existing data).
--
-- Same CLI-safety / non-keyword-triggering techniques as the preflight
-- file (see its own header): every UUID/enum/regprocedure/regclass value
-- explicitly cast to ::text, grant listings SELECT privilege_type itself
-- rather than filtering on a literal keyword value, and any write-keyword
-- text needed inside a content-check LIKE pattern is split across a
-- string concatenation (the same 'FOR UPD' || 'ATE' precedent already
-- established in this repo's other postflight files) so it never appears
-- as contiguous text in this file.
-- ============================================================

-- ------------------------------------------------------------
-- A. import_inventory_item(uuid,text,text,text,text,numeric,numeric,numeric,text,numeric,date)
-- -- exists, SECURITY DEFINER, hardened search_path, correct grants.
-- ------------------------------------------------------------
SELECT
  'import_inventory_item_definition' AS check_name,
  (to_regprocedure('public.import_inventory_item(uuid,text,text,text,text,numeric,numeric,numeric,text,numeric,date)') IS NOT NULL) AS function_exists,
  (SELECT p.prosecdef FROM pg_proc p WHERE p.proname = 'import_inventory_item' AND p.pronamespace = 'public'::regnamespace) AS is_security_definer,
  (SELECT pg_get_functiondef(p.oid) LIKE '%SET search_path TO %public%' FROM pg_proc p
    WHERE p.proname = 'import_inventory_item' AND p.pronamespace = 'public'::regnamespace) AS search_path_hardened;

SELECT r.routine_name, g.grantee, g.privilege_type
FROM information_schema.routine_privileges g
JOIN information_schema.routines r ON r.specific_name = g.specific_name
WHERE r.routine_schema = 'public'
  AND r.routine_name = 'import_inventory_item'
  AND g.grantee IN ('authenticated', 'anon', 'PUBLIC')
ORDER BY g.grantee;

SELECT
  'import_inventory_item_content_checks' AS check_name,
  (pg_get_functiondef(oid) LIKE '%super_admin%hotel_owner%general_manager%') AS has_role_and_property_check,
  (pg_get_functiondef(oid) LIKE '%duplicate_sku%') AS is_duplicate_safe,
  (pg_get_functiondef(oid) LIKE '%WHERE property_id = _property_id AND lower(name) = lower(btrim(_location_name))%') AS location_is_property_scoped,
  (pg_get_functiondef(oid) LIKE '%apply_stock_delta%') AS uses_apply_stock_delta,
  (pg_get_functiondef(oid) LIKE '%' || 'INS' || 'ERT INTO public.inventory_stock_batches%') AS creates_batch_rows_when_applicable
FROM pg_proc WHERE proname = 'import_inventory_item' AND pronamespace = 'public'::regnamespace;

-- Expiry must only ever be written into the inventory_stock_batches
-- INSERT, never into the inventory_items INSERT's own column list.
SELECT
  'import_inventory_item_expiry_isolation' AS check_name,
  (
    substring(
      pg_get_functiondef(oid) from ('INS' || 'ERT INTO public\.inventory_items\([^)]*\)')
    ) NOT LIKE '%expiry%'
  ) AS inventory_items_insert_has_no_expiry_column
FROM pg_proc WHERE proname = 'import_inventory_item' AND pronamespace = 'public'::regnamespace;

-- ------------------------------------------------------------
-- B. import_inventory_items(uuid,jsonb,text) -- exists, SECURITY DEFINER,
-- hardened search_path, correct grants, whole-batch atomicity shape.
-- ------------------------------------------------------------
SELECT
  'import_inventory_items_definition' AS check_name,
  (to_regprocedure('public.import_inventory_items(uuid,jsonb,text)') IS NOT NULL) AS function_exists,
  (SELECT p.prosecdef FROM pg_proc p WHERE p.proname = 'import_inventory_items' AND p.pronamespace = 'public'::regnamespace) AS is_security_definer,
  (SELECT pg_get_functiondef(p.oid) LIKE '%SET search_path TO %public%' FROM pg_proc p
    WHERE p.proname = 'import_inventory_items' AND p.pronamespace = 'public'::regnamespace) AS search_path_hardened;

SELECT r.routine_name, g.grantee, g.privilege_type
FROM information_schema.routine_privileges g
JOIN information_schema.routines r ON r.specific_name = g.specific_name
WHERE r.routine_schema = 'public'
  AND r.routine_name = 'import_inventory_items'
  AND g.grantee IN ('authenticated', 'anon', 'PUBLIC')
ORDER BY g.grantee;

SELECT
  'import_inventory_items_content_checks' AS check_name,
  (pg_get_functiondef(oid) LIKE '%super_admin%hotel_owner%general_manager%') AS has_role_and_property_check,
  (pg_get_functiondef(oid) LIKE '%jsonb_array_elements(_rows)%') AS accepts_bulk_jsonb_input,
  (pg_get_functiondef(oid) LIKE '%' || '_duplicate_mode = ''reject''%') AS has_reject_mode_precheck,
  (pg_get_functiondef(oid) LIKE '%(_result ->> ''skipped'')::boolean%') AS has_skip_mode_path,
  -- The call site is "import_inventory_item(" (singular) followed
  -- immediately by an opening paren -- distinct from this function's own
  -- name "import_inventory_items(", where an 's' intervenes before the
  -- paren, so this LIKE pattern can only match a genuine call to the
  -- per-row helper, never a self-reference.
  (pg_get_functiondef(oid) LIKE '%public.import_inventory_item(%') AS calls_the_row_helper,
  -- No BEGIN...EXCEPTION WHEN...END catch block (the construct that would
  -- establish its own savepoint) exists anywhere in this function -- only
  -- plain top-level "RAISE EXCEPTION" validation statements, which are
  -- uncaught and correctly propagate out to abort the whole call. The
  -- whole point of the fix is that an unhandled exception from any row
  -- rolls back everything the call already did, so "EXCEPTION" appearing
  -- at all is expected (and required for the validation guards) --
  -- "EXCEPTION WHEN" (a catch clause) appearing is what would defeat it.
  (pg_get_functiondef(oid) NOT LIKE '%EXCEPTION WHEN%') AS no_per_row_exception_handler
FROM pg_proc WHERE proname = 'import_inventory_items' AND pronamespace = 'public'::regnamespace;

-- ------------------------------------------------------------
-- C. data_uploads.status -- 'processing' now allowed, every pre-release
-- status value preserved (compare against the preflight's own capture of
-- this same constraint).
-- ------------------------------------------------------------
SELECT
  'data_uploads_status_check' AS check_name,
  conname,
  pg_get_constraintdef(oid) AS definition,
  (pg_get_constraintdef(oid) LIKE '%processing%') AS processing_now_allowed,
  (pg_get_constraintdef(oid) LIKE '%pending%') AS pending_preserved,
  (pg_get_constraintdef(oid) LIKE '%approved%') AS approved_preserved,
  (pg_get_constraintdef(oid) LIKE '%rejected%') AS rejected_preserved,
  (pg_get_constraintdef(oid) LIKE '%imported%') AS imported_preserved
FROM pg_constraint
WHERE conrelid = 'public.data_uploads'::regclass AND conname = 'data_uploads_status_check';

-- ------------------------------------------------------------
-- D. Data preservation -- compare against the SAME queries' output from
-- the preflight run. Must match exactly.
-- ------------------------------------------------------------
SELECT
  'inventory_import_baseline_counts' AS check_name,
  (SELECT count(*) FROM public.inventory_items) AS inventory_items_count,
  (SELECT count(*) FROM public.stock_locations) AS stock_locations_count,
  (SELECT count(*) FROM public.item_stock) AS item_stock_row_count,
  (SELECT coalesce(sum(quantity), 0) FROM public.item_stock) AS item_stock_total_quantity,
  (SELECT count(*) FROM public.inventory_stock_batches) AS inventory_stock_batches_count,
  (SELECT count(*) FROM public.data_uploads) AS data_uploads_count,
  (SELECT count(*) FROM public.data_upload_rows) AS data_upload_rows_count;

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'inventory_items'
ORDER BY ordinal_position;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'item_stock'
ORDER BY ordinal_position;

-- Absolute (not baseline-relative) checks -- must be true regardless of
-- baseline counts, because they describe what these MIGRATIONS THEMSELVES
-- must never have done: no historical inventory backfill, no upload rows
-- fabricated by the migration itself, and (this release has zero
-- accounting/GL linkage by design, confirmed by the original inventory
-- audit) no journal/GL row created either.
SELECT
  'no_write_activity_from_migrations_themselves' AS check_name,
  (SELECT count(*) FROM public.inventory_stock_batches WHERE source_po_id IS NULL AND notes = 'Opening stock — inventory import') = 0
    AS no_import_created_batches_from_the_migration_itself,
  (SELECT count(*) FROM public.data_uploads WHERE target_kind = 'inventory') = 0
    AS no_upload_rows_created_by_the_migration_itself;

-- RLS/policies on every table this release's functions touch are
-- unchanged from the preflight capture (neither migration issues any
-- CREATE POLICY / ALTER TABLE ... ENABLE ROW LEVEL SECURITY / GRANT
-- statement against an existing table).
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relname IN ('inventory_items', 'item_stock', 'stock_locations', 'inventory_stock_batches', 'data_uploads', 'data_upload_rows')
ORDER BY c.relname;

SELECT schemaname, tablename, policyname, cmd::text AS command
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('inventory_items', 'item_stock', 'stock_locations', 'inventory_stock_batches', 'data_uploads', 'data_upload_rows')
ORDER BY tablename, policyname;
