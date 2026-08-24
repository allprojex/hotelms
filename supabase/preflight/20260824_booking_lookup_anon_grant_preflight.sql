-- ============================================================
-- READ-ONLY preflight for the public-booking-RPC anon-grant incident fix
-- (supabase/migrations/20260824120000_restore_booking_lookup_anon_grant.sql).
--
-- Every statement below is a SELECT. Confirms production is currently in
-- the broken state this migration fixes for all four affected functions
-- (booking_lookup, booking_create, booking_cancel, booking_modify: anon
-- cannot execute any of them), that no partial version of this fix already
-- exists, captures the current grants of booking_search_availability for
-- later comparison (this migration must not change it), and records each
-- affected function's current definition/hardening so postflight can
-- confirm the fix changed grants only, never any function body.
--
-- CLI-safety note (established pattern): no write/DDL keyword appears as
-- contiguous text anywhere in this file, including inside string literals.
-- ============================================================

-- ------------------------------------------------------------
-- A. Confirm the incident: all four affected functions exist, with their
-- exact signatures, and anon currently CANNOT execute any of them while
-- authenticated currently CAN (matches this incident's exact live
-- symptom -- HTTP 401 / 42501 for anon on booking_lookup, and the
-- identical grant state confirmed for the other three via local replay of
-- this exact migration history).
-- ------------------------------------------------------------
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS args,
  (p.oid IS NOT NULL) AS function_exists,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('booking_lookup', 'booking_create', 'booking_cancel', 'booking_modify')
ORDER BY p.proname;

SELECT
  'all_four_currently_anon_broken' AS check_name,
  bool_and(NOT has_function_privilege('anon', p.oid, 'EXECUTE')) AS anon_currently_cannot_execute_any,
  bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS authenticated_currently_can_execute_all
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('booking_lookup', 'booking_create', 'booking_cancel', 'booking_modify');

-- ------------------------------------------------------------
-- B. Baseline grant for the one sibling this migration must NOT touch --
-- booking_search_availability was already restored by 20260712183400 and
-- must remain exactly as-is.
-- ------------------------------------------------------------
SELECT
  p.proname,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'booking_search_availability';

-- ------------------------------------------------------------
-- C. Function hardening/body baseline for all four -- confirm SECURITY
-- DEFINER, search_path pinning, and the exact function body hash, so
-- postflight can prove the fix changed only grants, never any function
-- definition.
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
-- D. Preservation baseline -- this migration touches no table, so
-- reservation/guest/property/room counts must be identical before and
-- after.
-- ------------------------------------------------------------
SELECT
  'core_baseline_counts' AS check_name,
  (SELECT count(*) FROM public.reservations) AS reservations_count,
  (SELECT count(*) FROM public.guests) AS guests_count,
  (SELECT count(*) FROM public.properties) AS properties_count,
  (SELECT count(*) FROM public.rooms) AS rooms_count;

-- ------------------------------------------------------------
-- E. No partial version of this fix already exists -- if any of the four
-- already has anon EXECUTE, this migration's additive GRANT is still safe
-- (idempotent), but this check makes the starting point explicit rather
-- than assumed.
-- ------------------------------------------------------------
SELECT
  'partial_fix_check' AS check_name,
  count(*) FILTER (
    WHERE has_function_privilege('anon', p.oid, 'EXECUTE')
  ) AS how_many_of_the_four_already_anon_executable
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('booking_lookup', 'booking_create', 'booking_cancel', 'booking_modify');

-- ------------------------------------------------------------
-- F. Full anon-executable SECURITY DEFINER function snapshot -- must equal
-- postflight's equivalent snapshot PLUS exactly the four newly-restored
-- functions. Proves no unrelated function's grants are altered by this
-- narrow fix.
-- ------------------------------------------------------------
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef = true
  AND has_function_privilege('anon', p.oid, 'EXECUTE')
ORDER BY p.proname, args;
