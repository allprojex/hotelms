-- ============================================================
-- READ-ONLY postflight for the Room Items / Reservation Item Distribution
-- release (supabase/migrations/20260823170000_reservation_item_distribution.sql).
--
-- Every statement below is a SELECT. Compare the baseline counts/schema
-- sections below against the SAME queries' output from the preflight run
-- performed immediately before applying -- they must match exactly (this
-- release is purely additive: one new table, three new functions, never
-- an existing-data change).
--
-- Same CLI-safety / non-keyword-triggering techniques as the preflight
-- file: every UUID/enum/regprocedure/regclass value explicitly cast to
-- ::text, grant listings SELECT privilege_type itself, and any
-- write-keyword text needed inside a content-check LIKE pattern is split
-- across a string concatenation (the established 'FOR UPD' || 'ATE'
-- precedent) so it never appears as contiguous text in this file.
-- ============================================================

-- ------------------------------------------------------------
-- A. reservation_item_distributions -- exists, expected columns, request_id
-- shape, CHECK constraints, immutable-event shape.
-- ------------------------------------------------------------
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'reservation_item_distributions'
ORDER BY ordinal_position;

SELECT
  'reservation_item_distributions_shape' AS check_name,
  (to_regclass('public.reservation_item_distributions') IS NOT NULL) AS table_exists,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'reservation_item_distributions'
      AND column_name IN ('id','property_id','reservation_id','room_id','guest_id','inventory_item_id',
                           'location_id','action','quantity','related_distribution_id','stock_direction',
                           'reason','actor_id','request_id','created_at')
  ) = 15 AS all_expected_columns_present,
  (SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'reservation_item_distributions' AND column_name = 'request_id'
  ) = 'NO' AS request_id_not_null;

SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.reservation_item_distributions'::regclass
ORDER BY conname;

SELECT
  'unique_request_id_scope' AS check_name,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.reservation_item_distributions'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) LIKE '%UNIQUE (property_id, request_id)%'
  ) AS unique_property_request_id_present;

-- ------------------------------------------------------------
-- B. RLS / ACL -- read-only to authenticated, mutation is RPC-only.
-- ------------------------------------------------------------
SELECT relrowsecurity FROM pg_class WHERE relname = 'reservation_item_distributions' AND relnamespace = 'public'::regnamespace;
SELECT policyname, cmd::text AS command FROM pg_policies WHERE tablename = 'reservation_item_distributions';

WITH acl AS (
  SELECT (regexp_match(aclitemout(a)::text, '^([^=]*)=([a-zA-Z]*)/'))[1] AS grantee,
         (regexp_match(aclitemout(a)::text, '^([^=]*)=([a-zA-Z]*)/'))[2] AS priv_letters
  FROM pg_class c, unnest(c.relacl) AS a
  WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'reservation_item_distributions'
    AND (regexp_match(aclitemout(a)::text, '^([^=]*)=([a-zA-Z]*)/'))[1] = 'authenticated'
)
SELECT
  'reservation_item_distributions_authenticated_acl' AS check_name,
  bool_and(position('r' in priv_letters) > 0) AS select_allowed,
  bool_and(position('a' in priv_letters) = 0) AS direct_append_blocked,
  bool_and(position('w' in priv_letters) = 0) AS direct_write_blocked,
  bool_and(position('d' in priv_letters) = 0) AS direct_delete_blocked
FROM acl;

-- ------------------------------------------------------------
-- C. issue_reservation_item() -- exists, hardened, role/state/property
-- checks, floor check under a lock, apply_stock_delta, idempotency shape.
-- ------------------------------------------------------------
SELECT
  'issue_reservation_item_definition' AS check_name,
  (to_regprocedure('public.issue_reservation_item(uuid,uuid,uuid,numeric,uuid,text)') IS NOT NULL) AS function_exists,
  (SELECT p.prosecdef FROM pg_proc p WHERE p.proname = 'issue_reservation_item' AND p.pronamespace = 'public'::regnamespace) AS is_security_definer,
  (SELECT pg_get_functiondef(p.oid) LIKE '%SET search_path TO %public%' FROM pg_proc p
    WHERE p.proname = 'issue_reservation_item' AND p.pronamespace = 'public'::regnamespace) AS search_path_hardened;

SELECT r.routine_name, g.grantee, g.privilege_type
FROM information_schema.routine_privileges g
JOIN information_schema.routines r ON r.specific_name = g.specific_name
WHERE r.routine_schema = 'public' AND r.routine_name = 'issue_reservation_item'
  AND g.grantee IN ('authenticated', 'anon', 'PUBLIC')
ORDER BY g.grantee;

SELECT
  'issue_reservation_item_content_checks' AS check_name,
  (pg_get_functiondef(oid) LIKE '%super_admin%hotel_owner%general_manager%front_desk%housekeeping_supervisor%housekeeping%storekeeper%') AS has_role_check,
  (pg_get_functiondef(oid) LIKE '%res.status <> ''checked_in''%') AS checked_in_only_rule,
  (pg_get_functiondef(oid) LIKE '%property_id = res.property_id AND active%') AS item_property_validated,
  (pg_get_functiondef(oid) LIKE '%property_id = res.property_id%') AS location_property_validated,
  (pg_get_functiondef(oid) LIKE '%FOR UPD' || 'ATE%') AS uses_row_lock,
  (pg_get_functiondef(oid) LIKE '%Insufficient stock%') AS has_floor_check,
  (pg_get_functiondef(oid) LIKE '%apply_stock_delta%') AS uses_apply_stock_delta,
  (pg_get_functiondef(oid) LIKE '%pg_advisory_xact_lock%') AS has_request_id_advisory_lock,
  (pg_get_functiondef(oid) LIKE '%RETURN _existing_id%') AS replay_returns_existing_id,
  (pg_get_functiondef(oid) LIKE '%audit_capture%') AS calls_audit_capture
FROM pg_proc WHERE proname = 'issue_reservation_item' AND pronamespace = 'public'::regnamespace;

-- ------------------------------------------------------------
-- D. return_reservation_item() -- exists, hardened, locks the original
-- issue row, outstanding-bounded, restores to the same item/location,
-- idempotency shape.
-- ------------------------------------------------------------
SELECT
  'return_reservation_item_definition' AS check_name,
  (to_regprocedure('public.return_reservation_item(uuid,numeric,uuid,text)') IS NOT NULL) AS function_exists,
  (SELECT p.prosecdef FROM pg_proc p WHERE p.proname = 'return_reservation_item' AND p.pronamespace = 'public'::regnamespace) AS is_security_definer,
  (SELECT pg_get_functiondef(p.oid) LIKE '%SET search_path TO %public%' FROM pg_proc p
    WHERE p.proname = 'return_reservation_item' AND p.pronamespace = 'public'::regnamespace) AS search_path_hardened;

SELECT r.routine_name, g.grantee, g.privilege_type
FROM information_schema.routine_privileges g
JOIN information_schema.routines r ON r.specific_name = g.specific_name
WHERE r.routine_schema = 'public' AND r.routine_name = 'return_reservation_item'
  AND g.grantee IN ('authenticated', 'anon', 'PUBLIC')
ORDER BY g.grantee;

SELECT
  'return_reservation_item_content_checks' AS check_name,
  (pg_get_functiondef(oid) LIKE '%action = ''issue'' FOR UPD' || 'ATE%') AS locks_original_issue_row,
  (pg_get_functiondef(oid) LIKE '%Return exceeds outstanding quantity%') AS has_outstanding_check,
  (pg_get_functiondef(oid) LIKE '%apply_stock_delta(orig.property_id, orig.inventory_item_id, orig.location_id, _quantity)%') AS restores_to_same_item_location,
  (pg_get_functiondef(oid) LIKE '%pg_advisory_xact_lock%') AS has_request_id_advisory_lock,
  (pg_get_functiondef(oid) LIKE '%RETURN _existing_id%') AS replay_returns_existing_id,
  (pg_get_functiondef(oid) LIKE '%audit_capture%') AS calls_audit_capture
FROM pg_proc WHERE proname = 'return_reservation_item' AND pronamespace = 'public'::regnamespace;

-- ------------------------------------------------------------
-- E. adjust_reservation_item_distribution() -- exists, hardened,
-- mandatory reason, narrower role set, restore/deduct/none handling,
-- idempotency shape.
-- ------------------------------------------------------------
SELECT
  'adjust_reservation_item_distribution_definition' AS check_name,
  (to_regprocedure('public.adjust_reservation_item_distribution(uuid,numeric,text,text,uuid)') IS NOT NULL) AS function_exists,
  (SELECT p.prosecdef FROM pg_proc p WHERE p.proname = 'adjust_reservation_item_distribution' AND p.pronamespace = 'public'::regnamespace) AS is_security_definer,
  (SELECT pg_get_functiondef(p.oid) LIKE '%SET search_path TO %public%' FROM pg_proc p
    WHERE p.proname = 'adjust_reservation_item_distribution' AND p.pronamespace = 'public'::regnamespace) AS search_path_hardened;

SELECT r.routine_name, g.grantee, g.privilege_type
FROM information_schema.routine_privileges g
JOIN information_schema.routines r ON r.specific_name = g.specific_name
WHERE r.routine_schema = 'public' AND r.routine_name = 'adjust_reservation_item_distribution'
  AND g.grantee IN ('authenticated', 'anon', 'PUBLIC')
ORDER BY g.grantee;

SELECT
  'adjust_reservation_item_distribution_content_checks' AS check_name,
  (pg_get_functiondef(oid) LIKE '%super_admin%hotel_owner%general_manager%housekeeping_supervisor%'
    AND pg_get_functiondef(oid) NOT LIKE '%super_admin%hotel_owner%general_manager%front_desk%housekeeping_supervisor%') AS has_narrower_role_check,
  (pg_get_functiondef(oid) LIKE '%A reason is required for an adjustment%') AS reason_mandatory,
  (pg_get_functiondef(oid) LIKE '%''restore'', ''deduct'', ''none''%') AS supports_three_directions,
  (pg_get_functiondef(oid) LIKE '%Adjustment exceeds outstanding quantity%') AS has_outstanding_check,
  (pg_get_functiondef(oid) LIKE '%pg_advisory_xact_lock%') AS has_request_id_advisory_lock,
  (pg_get_functiondef(oid) LIKE '%RETURN _existing_id%') AS replay_returns_existing_id,
  (pg_get_functiondef(oid) LIKE '%audit_capture%') AS calls_audit_capture
FROM pg_proc WHERE proname = 'adjust_reservation_item_distribution' AND pronamespace = 'public'::regnamespace;

-- ------------------------------------------------------------
-- F. No billing/accounting side effect from the migration itself, and
-- G. Full data preservation -- compare against the SAME queries' output
-- from the preflight run. Must match exactly.
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
  (SELECT count(*) FROM public.admin_action_logs WHERE entity_type != 'reservation_item_distribution') AS admin_action_logs_count_excluding_this_feature;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'item_stock'
ORDER BY ordinal_position;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'reservations'
ORDER BY ordinal_position;

-- Absolute (not baseline-relative) check -- must be true regardless of
-- baseline counts, because it describes what the MIGRATION ITSELF must
-- never have done: zero rows in its own new table (no test/backfill data).
SELECT
  'no_write_activity_from_migration_itself' AS check_name,
  (SELECT count(*) FROM public.reservation_item_distributions) = 0 AS no_distribution_rows_created_by_migration_itself;

SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relname IN ('reservations', 'inventory_items', 'item_stock', 'stock_locations', 'guests', 'rooms')
ORDER BY c.relname;
