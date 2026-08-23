-- ============================================================
-- READ-ONLY preflight for the Room Items / Reservation Item Distribution
-- release (supabase/migrations/20260823170000_reservation_item_distribution.sql).
--
-- Every statement below is a SELECT. Confirms production is genuinely
-- pre-release for the new table and all three new RPCs, captures baseline
-- counts/totals for postflight comparison (including every table this
-- release must NEVER touch: reservation_charges/payments/journal_entries/
-- pos_orders, and inventory_items/item_stock/inventory_stock_batches
-- themselves), and records existing property/location facts.
--
-- CLI-safety note (avoiding a previously-hit issue): every UUID,
-- enum/custom-type, and regprocedure/regclass value is explicitly cast to
-- ::text before being selected -- `supabase db query --output json` fails
-- to scan an uncast custom OID-based type. No write/DDL keyword appears as
-- contiguous text anywhere in this file, including inside string literals
-- -- assertReadOnlySqlFile() scans raw file text, not just real SQL
-- syntax. Grant listings SELECT the privilege_type column itself rather
-- than filtering on a literal value.
-- ============================================================

-- ------------------------------------------------------------
-- A. New objects must not exist yet (schema_fully_pre_release aggregate).
-- ------------------------------------------------------------
SELECT
  'schema_pre_release_checks' AS check_name,
  (to_regclass('public.reservation_item_distributions') IS NULL) AS table_absent,
  (to_regprocedure('public.issue_reservation_item(uuid,uuid,uuid,numeric,uuid,text)') IS NULL) AS issue_fn_absent,
  (to_regprocedure('public.return_reservation_item(uuid,numeric,uuid,text)') IS NULL) AS return_fn_absent,
  (to_regprocedure('public.adjust_reservation_item_distribution(uuid,numeric,text,text,uuid)') IS NULL) AS adjust_fn_absent;

SELECT
  'schema_fully_pre_release' AS check_name,
  (
    to_regclass('public.reservation_item_distributions') IS NULL
    AND to_regprocedure('public.issue_reservation_item(uuid,uuid,uuid,numeric,uuid,text)') IS NULL
    AND to_regprocedure('public.return_reservation_item(uuid,numeric,uuid,text)') IS NULL
    AND to_regprocedure('public.adjust_reservation_item_distribution(uuid,numeric,text,text,uuid)') IS NULL
  ) AS result;

-- ------------------------------------------------------------
-- B. Baseline counts for postflight comparison -- this release must
-- change none of these (it only adds a new table + three new functions).
-- ------------------------------------------------------------
SELECT
  'reservation_baseline_counts' AS check_name,
  (SELECT count(*) FROM public.reservations) AS reservations_total,
  (SELECT count(*) FROM public.reservations WHERE status = 'confirmed') AS reservations_confirmed,
  (SELECT count(*) FROM public.reservations WHERE status = 'checked_in') AS reservations_checked_in,
  (SELECT count(*) FROM public.reservations WHERE status = 'checked_out') AS reservations_checked_out,
  (SELECT count(*) FROM public.reservations WHERE status = 'cancelled') AS reservations_cancelled,
  (SELECT count(*) FROM public.reservations WHERE status = 'no_show') AS reservations_no_show;

SELECT
  'inventory_and_financial_baseline_counts' AS check_name,
  (SELECT count(*) FROM public.inventory_items) AS inventory_items_count,
  (SELECT count(*) FROM public.stock_locations) AS stock_locations_count,
  (SELECT count(*) FROM public.item_stock) AS item_stock_row_count,
  (SELECT coalesce(sum(quantity), 0) FROM public.item_stock) AS item_stock_total_quantity,
  (SELECT count(*) FROM public.inventory_stock_batches) AS inventory_stock_batches_count,
  (SELECT count(*) FROM public.reservation_charges) AS reservation_charges_count,
  (SELECT count(*) FROM public.payments) AS payments_count,
  (SELECT count(*) FROM public.journal_entries) AS journal_entries_count,
  (SELECT count(*) FROM public.pos_orders) AS pos_orders_count,
  (SELECT count(*) FROM public.admin_action_logs) AS admin_action_logs_count;

-- ------------------------------------------------------------
-- C. Schema snapshots -- confirm this release never alters an existing
-- table's shape (additive-only: one new table, three new functions).
-- ------------------------------------------------------------
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'item_stock'
ORDER BY ordinal_position;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'reservations'
ORDER BY ordinal_position;

-- ------------------------------------------------------------
-- D. Current RLS/grants baseline for the tables this release's functions
-- read or mutate, for postflight to confirm none of them changed.
-- ------------------------------------------------------------
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relname IN ('reservations', 'inventory_items', 'item_stock', 'stock_locations', 'guests', 'rooms')
ORDER BY c.relname;

-- ------------------------------------------------------------
-- E. Existing property/location facts a real issue/return/adjustment
-- against this property set would need to respect.
-- ------------------------------------------------------------
SELECT property_id::text, name, kind::text
FROM public.stock_locations
ORDER BY property_id, name;

-- ------------------------------------------------------------
-- F. Defensive: if the new table somehow already exists in a
-- partially-applied state, confirm its grants before assuming a clean
-- pre-release baseline (should return no rows when genuinely absent).
-- ------------------------------------------------------------
SELECT r.routine_name, g.grantee, g.privilege_type
FROM information_schema.routine_privileges g
JOIN information_schema.routines r ON r.specific_name = g.specific_name
WHERE r.routine_schema = 'public'
  AND r.routine_name IN ('issue_reservation_item', 'return_reservation_item', 'adjust_reservation_item_distribution')
  AND g.grantee IN ('authenticated', 'anon', 'PUBLIC')
ORDER BY r.routine_name, g.grantee;
