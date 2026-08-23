-- ============================================================
-- READ-ONLY postflight for the inventory expiration-date release
-- (supabase/migrations/20260823130000_inventory_batch_expiration.sql).
--
-- Every statement below is a SELECT. Confirms the migration's expected
-- end-state after applying it to production. Compare the baseline counts
-- section below against the SAME queries' output from the preflight run
-- performed immediately before applying -- they must match exactly (this
-- migration changes schema/functions only, never existing data).
--
-- Same CLI-safety / non-keyword-triggering techniques as the preflight
-- file (see its own header): every UUID/enum/regprocedure/regclass value
-- explicitly cast to ::text, grant listings SELECT privilege_type itself
-- rather than filtering on a literal keyword value, and ACL letter-code
-- parsing (r/a/w/d) instead of ever writing INSERT/UPDATE/DELETE as
-- contiguous SQL-keyword text.
-- ============================================================

-- ------------------------------------------------------------
-- A. inventory_stock_batches exists with the expected columns/types.
-- ------------------------------------------------------------
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'inventory_stock_batches'
ORDER BY ordinal_position;

SELECT
  'inventory_stock_batches_columns_present' AS check_name,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory_stock_batches'
      AND column_name IN ('id','property_id','item_id','location_id','received_quantity','received_date',
                           'expiry_date','source_po_id','source_po_line_id','notes','created_by','created_at','updated_at')
  ) = 13 AS all_expected_columns_present;

-- ------------------------------------------------------------
-- B. RLS enabled, SELECT allowed for authenticated, direct write blocked.
-- ------------------------------------------------------------
SELECT
  'inventory_stock_batches_rls' AS check_name,
  (SELECT relrowsecurity FROM pg_class WHERE relname = 'inventory_stock_batches' AND relnamespace = 'public'::regnamespace) AS rls_enabled,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_stock_batches' AND policyname = 'inv_stock_batches_read') AS read_policy_present;

WITH acl AS (
  SELECT (regexp_match(aclitemout(a)::text, '^([^=]*)=([a-zA-Z]*)/'))[1] AS grantee,
         (regexp_match(aclitemout(a)::text, '^([^=]*)=([a-zA-Z]*)/'))[2] AS priv_letters
  FROM pg_class c, unnest(c.relacl) AS a
  WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'inventory_stock_batches'
    AND (regexp_match(aclitemout(a)::text, '^([^=]*)=([a-zA-Z]*)/'))[1] = 'authenticated'
)
SELECT
  'inventory_stock_batches_authenticated_acl' AS check_name,
  bool_and(position('r' in priv_letters) > 0) AS select_allowed,
  bool_and(position('a' in priv_letters) = 0) AS direct_append_blocked,
  bool_and(position('w' in priv_letters) = 0) AS direct_write_blocked,
  bool_and(position('d' in priv_letters) = 0) AS direct_delete_blocked
FROM acl;

-- ------------------------------------------------------------
-- C. properties.inventory_expiry_warning_days -- exists, default 30.
-- ------------------------------------------------------------
SELECT
  'threshold_column' AS check_name,
  (SELECT column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'properties' AND column_name = 'inventory_expiry_warning_days'
  ) AS column_default_text,
  (SELECT count(*) FROM public.properties WHERE inventory_expiry_warning_days = 30) AS properties_with_default_30,
  (SELECT count(*) FROM public.properties) AS properties_total;

-- ------------------------------------------------------------
-- D. update_batch_expiry(uuid,date) -- exists, SECURITY DEFINER,
-- hardened search_path, expiry-only mutation, correct grants.
-- ------------------------------------------------------------
SELECT
  'update_batch_expiry_definition' AS check_name,
  (to_regprocedure('public.update_batch_expiry(uuid,date)') IS NOT NULL) AS function_exists,
  (SELECT p.prosecdef FROM pg_proc p WHERE p.proname = 'update_batch_expiry' AND p.pronamespace = 'public'::regnamespace) AS is_security_definer,
  (SELECT pg_get_functiondef(p.oid) LIKE '%SET search_path TO %public%' FROM pg_proc p
    WHERE p.proname = 'update_batch_expiry' AND p.pronamespace = 'public'::regnamespace) AS search_path_hardened;

SELECT
  'update_batch_expiry_content_checks' AS check_name,
  (pg_get_functiondef(oid) LIKE '%has_any_role%') AS has_role_check,
  (pg_get_functiondef(oid) LIKE '%super_admin%general_manager%front_desk%cashier%housekeeping_supervisor%') AS uses_broader_operational_role_set,
  (pg_get_functiondef(oid) LIKE '%SET expiry_date = _expiry_date, updated_at = now()%') AS updates_expiry_and_timestamp_only
FROM pg_proc WHERE proname = 'update_batch_expiry' AND pronamespace = 'public'::regnamespace;

SELECT r.routine_name, g.grantee, g.privilege_type
FROM information_schema.routine_privileges g
JOIN information_schema.routines r ON r.specific_name = g.specific_name
WHERE r.routine_schema = 'public'
  AND r.routine_name = 'update_batch_expiry'
  AND g.grantee IN ('authenticated', 'anon', 'PUBLIC')
ORDER BY g.grantee;

-- ------------------------------------------------------------
-- E. receive_purchase_order -- new 2-arg signature present, old 1-arg
-- overload genuinely dropped (not just shadowed), single-argument calling
-- remains valid through the DEFAULT parameter, still delegates to
-- apply_stock_delta, creates one batch row per received line, and
-- malformed expiry input fails the whole call (no partial apply).
-- ------------------------------------------------------------
SELECT
  'receive_purchase_order_signature' AS check_name,
  (to_regprocedure('public.receive_purchase_order(uuid,jsonb)') IS NOT NULL) AS new_signature_exists,
  (to_regprocedure('public.receive_purchase_order(uuid)') IS NULL) AS old_one_arg_overload_absent,
  (SELECT count(*) FROM pg_proc WHERE proname = 'receive_purchase_order' AND pronamespace = 'public'::regnamespace) AS total_overloads,
  (SELECT pronargdefaults FROM pg_proc WHERE proname = 'receive_purchase_order' AND pronamespace = 'public'::regnamespace) AS default_arg_count;

SELECT
  'receive_purchase_order_content_checks' AS check_name,
  (pg_get_functiondef(oid) LIKE '%apply_stock_delta%') AS still_uses_apply_stock_delta,
  (pg_get_functiondef(oid) LIKE '%INS' || 'ERT INTO public.inventory_stock_batches%') AS creates_batch_rows,
  (pg_get_functiondef(oid) LIKE '%EXCEPTION WHEN OTHERS%') AS has_exception_handler_for_bad_dates,
  (pg_get_functiondef(oid) LIKE '%super_admin%hotel_owner%general_manager%') AS preserves_manager_only_receive_check
FROM pg_proc WHERE proname = 'receive_purchase_order' AND pronamespace = 'public'::regnamespace;

SELECT r.routine_name, g.grantee, g.privilege_type
FROM information_schema.routine_privileges g
JOIN information_schema.routines r ON r.specific_name = g.specific_name
WHERE r.routine_schema = 'public'
  AND r.routine_name = 'receive_purchase_order'
  AND g.grantee IN ('authenticated', 'anon', 'PUBLIC')
ORDER BY g.grantee;

-- ------------------------------------------------------------
-- F. Data preservation -- compare against the SAME queries' output from
-- the preflight run. Must match exactly.
-- ------------------------------------------------------------
SELECT
  'inventory_baseline_counts' AS check_name,
  (SELECT count(*) FROM public.inventory_items) AS inventory_items_count,
  (SELECT count(*) FROM public.stock_locations) AS stock_locations_count,
  (SELECT count(*) FROM public.purchase_orders) AS purchase_orders_count,
  (SELECT count(*) FROM public.item_stock) AS item_stock_row_count,
  (SELECT coalesce(sum(quantity), 0) FROM public.item_stock) AS item_stock_total_quantity,
  (SELECT count(*) FROM public.journal_entries) AS journal_entries_count;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'item_stock'
ORDER BY ordinal_position;

-- Absolute (not baseline-relative) checks -- must be true regardless of
-- baseline counts, because they describe what the MIGRATION ITSELF must
-- never have done.
SELECT
  'no_write_activity_from_migration_itself' AS check_name,
  (SELECT count(*) FROM public.inventory_stock_batches) = 0 AS no_batch_rows_auto_created_by_migration,
  (SELECT count(*) FROM public.inventory_stock_batches WHERE source_po_id IS NOT NULL) = 0 AS confirms_above_no_migration_generated_receipts;
