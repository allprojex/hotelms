-- ============================================================
-- READ-ONLY preflight for the inventory CSV/XLSX import hardening release
-- (supabase/migrations/20260823150000_inventory_import_rpc.sql and
-- supabase/migrations/20260823160000_inventory_import_bulk_rpc.sql).
--
-- Every statement below is a SELECT. Confirms production is genuinely
-- pre-release for both new RPCs this release introduces, confirms
-- data_uploads.status is still its pre-release CHECK, captures baseline
-- counts/totals for postflight comparison, and captures the existing
-- SKU/location facts a real import against this property set would need
-- to respect.
--
-- CLI-safety note (avoiding a previously-hit issue): every UUID,
-- enum/custom-type, and regprocedure/regclass value is explicitly cast to
-- ::text before being selected -- `supabase db query --output json` fails
-- to scan an uncast custom OID-based type ("unknown oid ... cannot be
-- scanned into *interface {}"). No write/DDL keyword appears as contiguous
-- text anywhere in this file, including inside string literals --
-- assertReadOnlySqlFile() scans raw file text, not just real SQL syntax.
-- Grant listings SELECT the privilege_type column itself rather than
-- filtering on a literal value.
-- ============================================================

-- ------------------------------------------------------------
-- A. New objects must not exist yet (schema_fully_pre_release aggregate).
-- ------------------------------------------------------------
SELECT
  'schema_pre_release_checks' AS check_name,
  (to_regprocedure('public.import_inventory_item(uuid,text,text,text,text,numeric,numeric,numeric,text,numeric,date)') IS NULL) AS import_inventory_item_absent,
  (to_regprocedure('public.import_inventory_items(uuid,jsonb,text)') IS NULL) AS import_inventory_items_absent,
  (
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'data_uploads_status_check')
    NOT LIKE '%processing%'
  ) AS status_check_still_pre_release;

SELECT
  'schema_fully_pre_release' AS check_name,
  (
    to_regprocedure('public.import_inventory_item(uuid,text,text,text,text,numeric,numeric,numeric,text,numeric,date)') IS NULL
    AND to_regprocedure('public.import_inventory_items(uuid,jsonb,text)') IS NULL
    AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'data_uploads_status_check') NOT LIKE '%processing%'
  ) AS result;

-- ------------------------------------------------------------
-- B. Current data_uploads.status CHECK constraint -- exact pre-release
-- text, for a byte-for-byte postflight comparison of the widening.
-- ------------------------------------------------------------
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.data_uploads'::regclass AND contype = 'c'
ORDER BY conname;

-- ------------------------------------------------------------
-- C. Baseline counts/totals for postflight comparison -- these must match
-- exactly after the migrations (additive RPCs + one CHECK widening only,
-- never a data change).
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

-- ------------------------------------------------------------
-- D. Schema snapshots -- confirm this release never alters an existing
-- table's shape (both migrations are additive-only).
-- ------------------------------------------------------------
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'inventory_items'
ORDER BY ordinal_position;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'item_stock'
ORDER BY ordinal_position;

-- ------------------------------------------------------------
-- E. Current inventory RLS/grants baseline -- for postflight to confirm
-- neither migration touches an existing table's RLS policies or grants.
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- F. Existing SKU/location facts -- the exact pre-release inventory data
-- a real import against this property set will need to respect (existing
-- SKUs it must never duplicate, locations it may reference).
-- ------------------------------------------------------------
SELECT property_id::text, sku, name
FROM public.inventory_items
ORDER BY property_id, sku;

SELECT property_id::text, name, kind::text
FROM public.stock_locations
ORDER BY property_id, name;

-- ------------------------------------------------------------
-- G. Defensive: if either new function somehow already exists in a
-- partially-applied state, confirm its grants before assuming a clean
-- pre-release baseline (should return no rows when genuinely absent).
-- ------------------------------------------------------------
SELECT r.routine_name, g.grantee, g.privilege_type
FROM information_schema.routine_privileges g
JOIN information_schema.routines r ON r.specific_name = g.specific_name
WHERE r.routine_schema = 'public'
  AND r.routine_name IN ('import_inventory_item', 'import_inventory_items')
  AND g.grantee IN ('authenticated', 'anon', 'PUBLIC')
ORDER BY r.routine_name, g.grantee;
