-- ============================================================
-- READ-ONLY postflight for the booking_lookup anon-grant incident fix
-- (supabase/migrations/20260824120000_restore_booking_lookup_anon_grant.sql).
--
-- Every statement below is a SELECT. Confirms anon EXECUTE is restored,
-- PUBLIC remains excluded, authenticated is unaffected, the function body
-- is byte-identical to preflight's baseline (grants-only change), every
-- sibling booking RPC's grants are unchanged, and no table was touched.
--
-- CLI-safety note (established pattern): no write/DDL keyword appears as
-- contiguous text anywhere in this file, including inside string literals.
-- ============================================================

-- ------------------------------------------------------------
-- A. The fix: anon can now execute booking_lookup; authenticated still can;
-- PUBLIC pseudo-role still cannot (defense-in-depth, matches the original
-- 2026-07-05 contract, which never granted PUBLIC directly).
-- ------------------------------------------------------------
SELECT
  'booking_lookup_fixed_grants' AS check_name,
  has_function_privilege('anon', to_regprocedure('public.booking_lookup(text,text)'), 'EXECUTE') AS anon_can_execute,
  has_function_privilege('authenticated', to_regprocedure('public.booking_lookup(text,text)'), 'EXECUTE') AS authenticated_can_execute,
  has_function_privilege('public', to_regprocedure('public.booking_lookup(text,text)'), 'EXECUTE') AS public_pseudo_role_can_execute;

-- ------------------------------------------------------------
-- B. Sibling booking-flow RPCs unchanged -- compare directly against
-- preflight's section B output. booking_search_availability must remain
-- anon-executable; booking_create/cancel/modify must remain exactly as
-- broken as they were before this migration (a separate, out-of-scope
-- incident, not silently widened by this fix).
-- ------------------------------------------------------------
SELECT
  p.proname,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('booking_search_availability', 'booking_create', 'booking_cancel', 'booking_modify')
ORDER BY p.proname;

-- ------------------------------------------------------------
-- C. Function body unchanged -- this must equal preflight's
-- function_definition_md5 exactly. A grants-only fix never touches
-- pg_get_functiondef()'s output (which does not include ACL state).
-- ------------------------------------------------------------
SELECT
  'booking_lookup_definition_unchanged' AS check_name,
  p.prosecdef AS security_definer,
  (p.proconfig::text LIKE '%search_path=public%') AS search_path_hardened,
  md5(pg_get_functiondef(p.oid)) AS function_definition_md5
FROM pg_proc p
WHERE p.oid = to_regprocedure('public.booking_lookup(text,text)');

-- ------------------------------------------------------------
-- D. Preservation -- this migration created/deleted no row in any table.
-- Must equal preflight's section D output exactly.
-- ------------------------------------------------------------
SELECT
  'core_baseline_counts' AS check_name,
  (SELECT count(*) FROM public.reservations) AS reservations_count,
  (SELECT count(*) FROM public.guests) AS guests_count,
  (SELECT count(*) FROM public.properties) AS properties_count;

-- ------------------------------------------------------------
-- E. Full anon-executable SECURITY DEFINER function snapshot -- must equal
-- preflight's section E snapshot PLUS exactly one new row: booking_lookup.
-- Proves no unrelated function's grants were widened by this migration.
-- ------------------------------------------------------------
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef = true
  AND has_function_privilege('anon', p.oid, 'EXECUTE')
ORDER BY p.proname, args;

-- ------------------------------------------------------------
-- F. End-to-end functional proof via a real reservation, if any exists in
-- production with a confirmation_code already set (read-only: selects an
-- existing row's own code/email back through the function, never inserts
-- test data). Returns no rows harmlessly if no such reservation exists yet.
-- ------------------------------------------------------------
SELECT
  'booking_lookup_end_to_end_smoke' AS check_name,
  bl.confirmation_code = r.confirmation_code AS returns_matching_row,
  bl.property_id = r.property_id AS property_matches_source_row
FROM public.reservations r
CROSS JOIN LATERAL public.booking_lookup(r.confirmation_code, r.confirmation_email) bl
WHERE r.confirmation_code IS NOT NULL AND r.confirmation_email IS NOT NULL
LIMIT 1;
