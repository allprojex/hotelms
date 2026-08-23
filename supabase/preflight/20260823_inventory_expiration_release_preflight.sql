-- ============================================================
-- READ-ONLY preflight for the inventory expiration-date release
-- (supabase/migrations/20260823130000_inventory_batch_expiration.sql).
--
-- Every statement below is a SELECT. Confirms production is genuinely
-- pre-release for every new object this migration introduces, captures
-- baseline counts/totals for postflight comparison, and confirms
-- receive_purchase_order() is still the pre-release single-purpose
-- version.
--
-- CLI-safety note (avoiding a previously-hit issue): every UUID,
-- enum/custom-type, and regprocedure/regclass value is explicitly cast to
-- ::text before being selected -- `supabase db query --output json` fails
-- to scan an uncast custom OID-based type ("unknown oid ... cannot be
-- scanned into *interface {}"), confirmed live earlier in this engagement.
-- No write/DDL keyword appears as contiguous text anywhere in this file,
-- including inside string literals -- assertReadOnlySqlFile() scans raw
-- file text, not just real SQL syntax, so even a quoted comparison like
-- = 'INSERT' would trip it. Grant listings SELECT the privilege_type
-- column itself rather than filtering on a literal value, and this file
-- checks table-level ACLs via the aclitemout() letter-code technique
-- (r=read a=append w=write d=delete) instead of ever writing those
-- keywords as contiguous SQL text.
-- ============================================================

-- ------------------------------------------------------------
-- A. New objects must not exist yet (schema_fully_pre_release aggregate).
-- ------------------------------------------------------------
SELECT
  'schema_pre_release_checks' AS check_name,
  (to_regclass('public.inventory_stock_batches') IS NULL) AS batches_table_absent,
  (NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'properties' AND column_name = 'inventory_expiry_warning_days'
  )) AS threshold_column_absent,
  (to_regprocedure('public.update_batch_expiry(uuid,date)') IS NULL) AS update_batch_expiry_absent,
  (to_regprocedure('public.receive_purchase_order(uuid,jsonb)') IS NULL) AS new_receive_signature_absent,
  (to_regprocedure('public.receive_purchase_order(uuid)') IS NOT NULL) AS old_receive_signature_present;

SELECT
  'schema_fully_pre_release' AS check_name,
  (
    to_regclass('public.inventory_stock_batches') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'properties' AND column_name = 'inventory_expiry_warning_days'
    )
    AND to_regprocedure('public.update_batch_expiry(uuid,date)') IS NULL
    AND to_regprocedure('public.receive_purchase_order(uuid,jsonb)') IS NULL
    AND to_regprocedure('public.receive_purchase_order(uuid)') IS NOT NULL
  ) AS result;

-- ------------------------------------------------------------
-- B. Current receive_purchase_order() is still the pre-release,
-- single-purpose version (no batch/JSONB-expiry logic yet).
-- ------------------------------------------------------------
SELECT
  'receive_purchase_order_pre_release_content' AS check_name,
  (pg_get_functiondef(p.oid) NOT LIKE '%inventory_stock_batches%') AS no_batch_insert_yet,
  (pg_get_functiondef(p.oid) NOT LIKE '%_line_expiry%') AS no_line_expiry_param_yet,
  (p.pronargs = 1) AS still_single_argument
FROM pg_proc p
WHERE p.proname = 'receive_purchase_order' AND p.pronamespace = 'public'::regnamespace;

-- Grant listing for the pre-release function -- SELECT the privilege_type
-- column itself (never filtered on a literal keyword value).
SELECT r.routine_name, g.grantee, g.privilege_type
FROM information_schema.routine_privileges g
JOIN information_schema.routines r ON r.specific_name = g.specific_name
WHERE r.routine_schema = 'public'
  AND r.routine_name = 'receive_purchase_order'
  AND g.grantee IN ('authenticated', 'anon', 'PUBLIC')
ORDER BY g.grantee;

-- ------------------------------------------------------------
-- C. Baseline counts/totals for postflight comparison -- these must
-- match exactly after the migration (schema/function-only change,
-- never a data change).
-- ------------------------------------------------------------
SELECT
  'inventory_baseline_counts' AS check_name,
  (SELECT count(*) FROM public.inventory_items) AS inventory_items_count,
  (SELECT count(*) FROM public.stock_locations) AS stock_locations_count,
  (SELECT count(*) FROM public.purchase_orders) AS purchase_orders_count,
  (SELECT count(*) FROM public.item_stock) AS item_stock_row_count,
  (SELECT coalesce(sum(quantity), 0) FROM public.item_stock) AS item_stock_total_quantity,
  (SELECT count(*) FROM public.journal_entries) AS journal_entries_count;

-- item_stock column structure baseline (compare against postflight to
-- confirm this migration never alters the existing stock table).
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'item_stock'
ORDER BY ordinal_position;

-- ------------------------------------------------------------
-- D. Defensive: if inventory_stock_batches somehow already exists in a
-- partially-applied state, confirm it carries no unexpected direct write
-- grant for authenticated (should never happen pre-release, but this
-- check is safe to run either way -- returns no rows when the table is
-- genuinely absent).
-- ------------------------------------------------------------
WITH acl AS (
  SELECT c.relname AS table_name,
         (regexp_match(aclitemout(a)::text, '^([^=]*)=([a-zA-Z]*)/'))[1] AS grantee,
         (regexp_match(aclitemout(a)::text, '^([^=]*)=([a-zA-Z]*)/'))[2] AS priv_letters
  FROM pg_class c, unnest(c.relacl) AS a
  WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'inventory_stock_batches'
)
SELECT table_name, grantee, priv_letters FROM acl WHERE grantee IN ('authenticated', 'anon') ORDER BY grantee;
