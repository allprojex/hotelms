-- ============================================================
-- READ-ONLY preflight for the booking_lookup anon-grant incident fix
-- (supabase/migrations/20260824120000_restore_booking_lookup_anon_grant.sql).
--
-- Every statement below is a SELECT. Confirms production is currently in
-- the broken state this migration fixes (anon cannot execute
-- booking_lookup), captures the current grants of every sibling
-- booking-flow RPC for later comparison (this migration must not change
-- any of them), and records the function's current definition/hardening so
-- postflight can confirm the fix changed grants only, never the body.
--
-- CLI-safety note (established pattern): no write/DDL keyword appears as
-- contiguous text anywhere in this file, including inside string literals.
-- ============================================================

-- ------------------------------------------------------------
-- A. Confirm the incident: anon currently CANNOT execute booking_lookup,
-- authenticated currently CAN (matches this incident's exact live symptom:
-- HTTP 401 / 42501 for anon, never reported for an authenticated caller).
-- ------------------------------------------------------------
SELECT
  'booking_lookup_current_grants' AS check_name,
  (to_regprocedure('public.booking_lookup(text,text)') IS NOT NULL) AS function_exists,
  has_function_privilege('anon', to_regprocedure('public.booking_lookup(text,text)'), 'EXECUTE') AS anon_can_execute,
  has_function_privilege('authenticated', to_regprocedure('public.booking_lookup(text,text)'), 'EXECUTE') AS authenticated_can_execute,
  has_function_privilege('service_role', to_regprocedure('public.booking_lookup(text,text)'), 'EXECUTE') AS service_role_can_execute;

-- ------------------------------------------------------------
-- B. Baseline grants for the sibling booking-flow RPCs -- this migration
-- must not change any of these (booking_create/cancel/modify are a
-- separately tracked, out-of-scope regression; booking_search_availability
-- was already restored by 20260712183400 and must remain untouched here).
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
-- C. Function hardening/body baseline -- confirm SECURITY DEFINER,
-- search_path pinning, and the exact function body hash, so postflight can
-- prove the fix changed only grants, never the function definition.
-- ------------------------------------------------------------
SELECT
  'booking_lookup_definition_baseline' AS check_name,
  p.prosecdef AS security_definer,
  (p.proconfig::text LIKE '%search_path=public%') AS search_path_hardened,
  md5(pg_get_functiondef(p.oid)) AS function_definition_md5
FROM pg_proc p
WHERE p.oid = to_regprocedure('public.booking_lookup(text,text)');

-- ------------------------------------------------------------
-- D. Preservation baseline -- this migration touches no table, so
-- reservation/guest/property counts must be identical before and after.
-- ------------------------------------------------------------
SELECT
  'core_baseline_counts' AS check_name,
  (SELECT count(*) FROM public.reservations) AS reservations_count,
  (SELECT count(*) FROM public.guests) AS guests_count,
  (SELECT count(*) FROM public.properties) AS properties_count;

-- ------------------------------------------------------------
-- E. Confirm no other function's grants are altered by this narrow fix --
-- full snapshot of every anon-executable SECURITY DEFINER function in
-- public, for postflight to diff against (must be identical plus exactly
-- one new row: booking_lookup).
-- ------------------------------------------------------------
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef = true
  AND has_function_privilege('anon', p.oid, 'EXECUTE')
ORDER BY p.proname, args;
