-- ============================================================
-- READ-ONLY postflight for the public-booking-RPC anon-grant incident fix
-- (supabase/migrations/20260824120000_restore_booking_lookup_anon_grant.sql).
--
-- Every statement below is a SELECT. Confirms anon EXECUTE is restored on
-- exactly the four intended functions, PUBLIC remains excluded for all
-- four, authenticated is unaffected, each function's body/hardening is
-- byte-identical to preflight's baseline (grants-only change),
-- booking_search_availability is completely untouched, and no unrelated
-- function's grants changed.
--
-- CLI-safety note (established pattern): no write/DDL keyword appears as
-- contiguous text anywhere in this file, including inside string literals.
-- ============================================================

-- ------------------------------------------------------------
-- A. The fix: anon can now execute all four; authenticated still can;
-- PUBLIC pseudo-role still cannot for any of them (defense-in-depth,
-- matches each function's original 2026-07-05 contract, which never
-- granted PUBLIC directly).
-- ------------------------------------------------------------
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS args,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
  has_function_privilege('public', p.oid, 'EXECUTE') AS public_pseudo_role_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('booking_lookup', 'booking_create', 'booking_cancel', 'booking_modify')
ORDER BY p.proname;

SELECT
  'all_four_fixed' AS check_name,
  bool_and(has_function_privilege('anon', p.oid, 'EXECUTE')) AS anon_can_now_execute_all,
  bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS authenticated_still_can_execute_all,
  bool_and(NOT has_function_privilege('public', p.oid, 'EXECUTE')) AS public_pseudo_role_excluded_from_all
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('booking_lookup', 'booking_create', 'booking_cancel', 'booking_modify');

-- ------------------------------------------------------------
-- B. booking_search_availability completely unchanged -- compare directly
-- against preflight's section B output.
-- ------------------------------------------------------------
SELECT
  p.proname,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'booking_search_availability';

-- ------------------------------------------------------------
-- C. Function bodies unchanged for all four -- each row's
-- function_definition_md5 must equal preflight's section C output for the
-- same proname exactly. A grants-only fix never touches
-- pg_get_functiondef()'s output (which does not include ACL state).
-- ------------------------------------------------------------
SELECT
  p.proname,
  p.prosecdef AS security_definer,
  (p.proconfig::text LIKE '%search_path=public%') AS search_path_hardened,
  md5(pg_get_functiondef(p.oid)) AS function_definition_md5
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('booking_lookup', 'booking_create', 'booking_cancel', 'booking_modify')
ORDER BY p.proname;

-- ------------------------------------------------------------
-- D. Preservation -- this migration created/deleted no row in any table.
-- Must equal preflight's section D output exactly.
-- ------------------------------------------------------------
SELECT
  'core_baseline_counts' AS check_name,
  (SELECT count(*) FROM public.reservations) AS reservations_count,
  (SELECT count(*) FROM public.guests) AS guests_count,
  (SELECT count(*) FROM public.properties) AS properties_count,
  (SELECT count(*) FROM public.rooms) AS rooms_count;

-- ------------------------------------------------------------
-- E. Full anon-executable SECURITY DEFINER function snapshot -- must equal
-- preflight's section F snapshot PLUS exactly the four newly-restored
-- functions (booking_lookup, booking_create, booking_cancel,
-- booking_modify). Proves no unrelated function's grants were widened by
-- this migration.
-- ------------------------------------------------------------
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef = true
  AND has_function_privilege('anon', p.oid, 'EXECUTE')
ORDER BY p.proname, args;

-- ------------------------------------------------------------
-- F. End-to-end read-only functional proof of booking_lookup, via an
-- existing reservation, if any exists in production with a
-- confirmation_code already set (selects an existing row's own code/email
-- back through the function, never inserts test data). Returns no rows
-- harmlessly if no such reservation exists yet. booking_create,
-- booking_cancel, and booking_modify are mutating and are therefore NOT
-- exercised here -- their functional correctness was proven live against
-- a local disposable Postgres replaying this exact migration history (see
-- the incident report), not against production.
-- ------------------------------------------------------------
SELECT
  'booking_lookup_end_to_end_smoke' AS check_name,
  bl.confirmation_code = r.confirmation_code AS returns_matching_row,
  bl.property_id = r.property_id AS property_matches_source_row
FROM public.reservations r
CROSS JOIN LATERAL public.booking_lookup(r.confirmation_code, r.confirmation_email) bl
WHERE r.confirmation_code IS NOT NULL AND r.confirmation_email IS NOT NULL
LIMIT 1;
