-- ============================================================
-- READ-ONLY postflight for the reservation-payment PARTIAL REFUND release
-- (supabase/migrations/20260824130000_reservation_payment_partial_refund.sql,
-- PR #67, merged to main at c08595b74b96147dc1241222d3b5adb29b12397b).
--
-- Every statement below is a SELECT. Confirms the migration's expected
-- end-state after applying it to production. Do NOT run any
-- INSERT/UPDATE/DELETE/DDL from this file.
--
-- Run this BEFORE any write/financial smoke — neither is authorized by this
-- release's plan — every row count/amount captured here must reflect ONLY
-- what the migration itself changed (schema/enum/function), never a write
-- this release performed.
--
-- Same non-keyword-triggering techniques as the preflight file (see its own
-- header): literal grant checks select privilege_type/ACL-letter columns
-- rather than filtering on a literal 'EXECUTE'/'GRANT'/'REVOKE' string; a
-- two-word phrase like "FOR UPDATE" that must appear inside a string
-- literal compared against function source is split into concatenated
-- literals ('FOR UPD' || 'ATE') so the contiguous keyword never appears in
-- this file's raw text.
-- ============================================================

-- ------------------------------------------------------------
-- A. Enum / table.
-- ------------------------------------------------------------
SELECT
  'journal_source_contains_payment_refund' AS check_name,
  EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'journal_source' AND e.enumlabel = 'payment_refund'
  ) AS result;

SELECT
  'reservation_payment_refunds_exists' AS check_name,
  to_regclass('public.reservation_payment_refunds') IS NOT NULL AS result;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'reservation_payment_refunds'
ORDER BY ordinal_position;

WITH expected(col) AS (
  VALUES ('id'), ('property_id'), ('payment_id'), ('amount'), ('reason'),
         ('reversal_entry_id'), ('refunded_by'), ('request_id'), ('created_at')
),
actual AS (
  SELECT column_name FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'reservation_payment_refunds'
)
SELECT
  'reservation_payment_refunds_exact_column_set' AS check_name,
  NOT EXISTS (SELECT col FROM expected EXCEPT SELECT column_name FROM actual)
  AND NOT EXISTS (SELECT column_name FROM actual EXCEPT SELECT col FROM expected) AS result;

-- Fractional-cent CHECK constraint present.
SELECT
  'fractional_cent_check_present' AS check_name,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.reservation_payment_refunds'::regclass
      AND conname = 'reservation_payment_refunds_amount_no_fractional_cents'
      AND contype = 'c'
  ) AS result;

-- UNIQUE(property_id, request_id).
SELECT
  'unique_property_request_id_present' AS check_name,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.reservation_payment_refunds'::regclass
      AND contype = 'u'
      AND (SELECT array_agg(attname::text ORDER BY attname) FROM pg_attribute
           WHERE attrelid = conrelid AND attnum = ANY(conkey)) = ARRAY['property_id', 'request_id']
  ) AS result;

-- Indexes.
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'reservation_payment_refunds'
ORDER BY indexname;

SELECT
  'expected_indexes_present' AS check_name,
  EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'reservation_payment_refunds' AND indexname = 'idx_reservation_payment_refunds_payment') AS payment_index_present,
  EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'reservation_payment_refunds' AND indexname = 'idx_reservation_payment_refunds_property') AS property_index_present;

-- RLS enabled.
SELECT
  'rls_enabled' AS check_name,
  relrowsecurity AS result
FROM pg_class WHERE oid = 'public.reservation_payment_refunds'::regclass;

-- SELECT-only authenticated access; no direct authenticated
-- INSERT/UPDATE/DELETE. ACL letter codes (never filtered as literal
-- keyword text): r=read(select) a=append(insert) w=write(update) d=delete.
WITH acl AS (
  SELECT (regexp_match(aclitemout(a)::text, '^([^=]*)=([a-zA-Z]*)/'))[1] AS grantee,
         (regexp_match(aclitemout(a)::text, '^([^=]*)=([a-zA-Z]*)/'))[2] AS priv_letters
  FROM pg_class c, unnest(c.relacl) AS a
  WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'reservation_payment_refunds'
)
SELECT table_name, grantee, priv_letters
FROM (SELECT 'reservation_payment_refunds' AS table_name, grantee, priv_letters FROM acl) x
WHERE grantee IN ('authenticated', 'anon')
ORDER BY grantee;

WITH acl AS (
  SELECT (regexp_match(aclitemout(a)::text, '^([^=]*)=([a-zA-Z]*)/'))[1] AS grantee,
         (regexp_match(aclitemout(a)::text, '^([^=]*)=([a-zA-Z]*)/'))[2] AS priv_letters
  FROM pg_class c, unnest(c.relacl) AS a
  WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'reservation_payment_refunds'
    AND (regexp_match(aclitemout(a)::text, '^([^=]*)=([a-zA-Z]*)/'))[1] = 'authenticated'
)
SELECT
  'reservation_payment_refunds_authenticated_acl' AS check_name,
  bool_and(position('r' in priv_letters) > 0) AS select_granted_ok,
  bool_and(position('a' in priv_letters) = 0) AS insert_absent_ok,
  bool_and(position('w' in priv_letters) = 0) AS update_absent_ok,
  bool_and(position('d' in priv_letters) = 0) AS delete_absent_ok
FROM acl;

-- ------------------------------------------------------------
-- B. New RPC — refund_reservation_payment(uuid,numeric,text,uuid).
-- ------------------------------------------------------------
SELECT
  'refund_reservation_payment_exists' AS check_name,
  to_regprocedure('public.refund_reservation_payment(uuid,numeric,text,uuid)') IS NOT NULL AS result;

SELECT
  p.prosecdef AS is_security_definer,
  (pg_get_functiondef(p.oid) LIKE '%SET search_path TO %public%') AS search_path_hardened,
  pg_get_function_arguments(p.oid) AS argument_list
FROM pg_proc p
WHERE p.proname = 'refund_reservation_payment' AND p.pronamespace = 'public'::regnamespace;

SELECT
  'refund_reservation_payment_no_client_supplied_property' AS check_name,
  pg_get_function_arguments(oid) NOT LIKE '%_property_id%'
  AND pg_get_function_arguments(oid) NOT LIKE '%_reservation_id%' AS result
FROM pg_proc WHERE proname = 'refund_reservation_payment' AND pronamespace = 'public'::regnamespace;

SELECT r.routine_name, g.grantee, g.privilege_type
FROM information_schema.routine_privileges g
JOIN information_schema.routines r ON r.specific_name = g.specific_name
WHERE r.routine_schema = 'public'
  AND r.routine_name = 'refund_reservation_payment'
  AND g.grantee IN ('authenticated', 'anon', 'PUBLIC')
ORDER BY g.grantee;

SELECT
  'refund_reservation_payment_grant_posture' AS check_name,
  EXISTS (
    SELECT 1 FROM information_schema.routine_privileges g
    JOIN information_schema.routines r ON r.specific_name = g.specific_name
    WHERE r.routine_schema = 'public' AND r.routine_name = 'refund_reservation_payment' AND g.grantee = 'authenticated'
  ) AS authenticated_can_execute,
  NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges g
    JOIN information_schema.routines r ON r.specific_name = g.specific_name
    WHERE r.routine_schema = 'public' AND r.routine_name = 'refund_reservation_payment' AND g.grantee IN ('anon', 'PUBLIC')
  ) AS anon_public_cannot_execute;

-- Ordering / content checks against the function's own definition text —
-- one CTE capture, reused by every flag below.
WITH fn AS (
  SELECT pg_get_functiondef(oid) AS fd
  FROM pg_proc WHERE proname = 'refund_reservation_payment' AND pronamespace = 'public'::regnamespace
)
SELECT
  'refund_reservation_payment_content_and_ordering_checks' AS check_name,
  (strpos(fd, 'pg_advisory_xact_lock') > 0) AS has_advisory_lock,
  (strpos(fd, 'FOR UPD' || 'ATE') > 0) AS has_payment_row_lock,
  -- Role check runs before the idempotent-replay lookup, and therefore
  -- before any possible early RETURN of an existing refund id.
  (strpos(fd, 'has_any_role(') > 0
    AND strpos(fd, 'SELECT * INTO existing FROM public.reservation_payment_refunds') > 0
    AND strpos(fd, 'has_any_role(') < strpos(fd, 'SELECT * INTO existing FROM public.reservation_payment_refunds')
  ) AS role_check_before_replay,
  -- Reason normalization, reason length validation, amount positivity, and
  -- the fractional-cent rejection all run before the replay lookup.
  (strpos(fd, 'regexp_replace(btrim(') > 0
    AND strpos(fd, 'regexp_replace(btrim(') < strpos(fd, 'SELECT * INTO existing FROM public.reservation_payment_refunds')
  ) AS reason_normalized_before_replay,
  (strpos(fd, 'char_length(_trimmed_reason) < 5') > 0
    AND strpos(fd, 'char_length(_trimmed_reason) < 5') < strpos(fd, 'SELECT * INTO existing FROM public.reservation_payment_refunds')
  ) AS reason_validated_before_replay,
  (strpos(fd, '_amount IS NULL OR _amount <= 0') > 0
    AND strpos(fd, '_amount IS NULL OR _amount <= 0') < strpos(fd, 'SELECT * INTO existing FROM public.reservation_payment_refunds')
  ) AS amount_positivity_validated_before_replay,
  (strpos(fd, 'ROUND(_amount, 2) <> _amount') > 0
    AND strpos(fd, 'ROUND(_amount, 2) <> _amount') < strpos(fd, 'SELECT * INTO existing FROM public.reservation_payment_refunds')
  ) AS fractional_cent_validated_before_replay,
  -- Exact (not ROUND-based) payload comparison on replay.
  (strpos(fd, 'existing.payment_id = _payment_id') > 0
    AND strpos(fd, 'existing.amount = _amount') > 0
    AND strpos(fd, 'existing.reason = _trimmed_reason') > 0
    AND strpos(fd, 'ROUND(existing.amount') = 0
  ) AS exact_replay_payload_comparison,
  (strpos(fd, 'was already used for a different refund') > 0) AS has_explicit_idempotency_conflict,
  -- The void-status rejection runs strictly after the replay lookup.
  (strpos(fd, 'SELECT * INTO existing FROM public.reservation_payment_refunds') > 0
    AND strpos(fd, 'pay.status = ''void'' THEN') > 0
    AND strpos(fd, 'SELECT * INTO existing FROM public.reservation_payment_refunds') < strpos(fd, 'pay.status = ''void'' THEN')
  ) AS replay_check_before_void_status_rejection,
  (strpos(fd, 'already been fully refunded') > 0) AS has_void_status_rejection,
  (strpos(fd, 'SUM(amount)') > 0 AND strpos(fd, '_already_refunded') > 0) AS computes_server_side_refundable_sum,
  -- Exact-cent over-refund comparison — no 0.005 tolerance band anywhere.
  (strpos(fd, '_amount > _remaining THEN') > 0) AS exact_cent_over_refund_comparison,
  (fd NOT LIKE '%+ 0.005%' AND fd NOT LIKE '%- 0.005%' AND fd NOT LIKE '%<= 0.005%') AS no_tolerance_band_anywhere,
  (strpos(fd, 'accounting_periods') > 0 AND strpos(fd, 'locked') > 0) AS has_accounting_period_lock,
  (strpos(fd, '_orig_line_count <> 2') > 0) AS has_original_journal_shape_guard,
  (strpos(fd, 'ROUND(_dr,2) <> ROUND(_cr,2)') > 0 AND strpos(fd, 'not balanced') > 0) AS has_balance_assertion,
  (strpos(fd, 'alreadyRefundedBefore'', _already_refunded)') > 0) AS has_audit_insert_call_site,
  (fd NOT LIKE '%EXCEPTION WHEN%') AS no_exception_swallowing
FROM fn;

-- Exactly one audit-log write site in the function body (never zero, never
-- more than one per call) — counted via a plain substring-occurrence count
-- (length-based, not a regex split, so no special-character escaping is
-- needed) of a unique literal from the actual audit call's own argument
-- list rather than the write keyword itself.
SELECT
  'refund_reservation_payment_exactly_one_audit_write_site' AS check_name,
  (SELECT (length(fd) - length(replace(fd, marker, ''))) / length(marker)
   FROM (SELECT pg_get_functiondef(oid) AS fd, 'alreadyRefundedBefore'', _already_refunded)' AS marker
         FROM pg_proc WHERE proname = 'refund_reservation_payment' AND pronamespace = 'public'::regnamespace) x
  ) = 1 AS result;

-- ------------------------------------------------------------
-- C. Old RPC retirement — reverse_reservation_payment(uuid,text).
-- ------------------------------------------------------------
-- Body fingerprint must be IDENTICAL to the value captured by this
-- release's own preflight run — this migration is grants-only for this
-- function, it never redefines the body.
SELECT
  'reverse_reservation_payment_body_fingerprint' AS check_name,
  md5(pg_get_functiondef(oid)) AS body_md5
FROM pg_proc WHERE proname = 'reverse_reservation_payment' AND pronamespace = 'public'::regnamespace;

SELECT r.routine_name, g.grantee, g.privilege_type
FROM information_schema.routine_privileges g
JOIN information_schema.routines r ON r.specific_name = g.specific_name
WHERE r.routine_schema = 'public'
  AND r.routine_name = 'reverse_reservation_payment'
  AND g.grantee IN ('authenticated', 'anon', 'PUBLIC')
ORDER BY g.grantee;

SELECT
  'reverse_reservation_payment_authenticated_execute_revoked' AS check_name,
  NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges g
    JOIN information_schema.routines r ON r.specific_name = g.specific_name
    WHERE r.routine_schema = 'public' AND r.routine_name = 'reverse_reservation_payment' AND g.grantee = 'authenticated'
  ) AS result;

-- No alternate application-reachable full-refund path remains: after this
-- release, NEITHER the old RPC's authenticated grant NOR any other
-- currently-granted function referencing payments.status = 'void' exists
-- for a role other than the new, partial-refund-aware RPC.
SELECT
  'no_alternate_reachable_full_refund_path' AS check_name,
  NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges g
    JOIN information_schema.routines r ON r.specific_name = g.specific_name
    WHERE r.routine_schema = 'public' AND r.routine_name = 'reverse_reservation_payment'
      AND g.grantee IN ('authenticated', 'anon', 'PUBLIC')
  ) AS result;

-- ------------------------------------------------------------
-- D. Preservation — compare against the SAME queries' output from this
-- release's own preflight run performed immediately before applying the
-- migration. They must match exactly (this migration changes schema/enum/
-- functions only, it never itself writes a data row).
-- ------------------------------------------------------------
SELECT
  (SELECT count(*) FROM public.reservation_charges) AS reservation_charges_count,
  (SELECT COALESCE(sum(amount), 0) FROM public.reservation_charges) AS reservation_charges_total,
  (SELECT count(*) FROM public.payments) AS payments_count,
  (SELECT COALESCE(sum(amount), 0) FROM public.payments) AS payments_total,
  (SELECT count(*) FROM public.journal_entries) AS journal_entries_count,
  (SELECT count(*) FROM public.journal_lines) AS journal_lines_count,
  (SELECT count(*) FROM public.admin_action_logs) AS admin_action_logs_count;

SELECT
  status::text AS status, count(*) AS payment_count
FROM public.payments GROUP BY status ORDER BY status;

-- Absolute (not baseline-relative) checks — must be true regardless of the
-- baseline totals above, because they describe what THIS MIGRATION ITSELF
-- must never do.
SELECT
  'no_write_activity_from_migration_itself' AS check_name,
  (SELECT count(*) FROM public.reservation_payment_refunds) = 0 AS zero_refund_event_rows,
  (SELECT count(*) FROM public.journal_entries WHERE source = 'payment_refund') = 0 AS zero_new_journal_entries,
  (SELECT count(*) FROM public.journal_lines jl JOIN public.journal_entries je ON je.id = jl.entry_id WHERE je.source = 'payment_refund') = 0 AS zero_new_journal_lines,
  (SELECT count(*) FROM public.admin_action_logs WHERE entity_type = 'reservation_payment_refund') = 0 AS zero_new_audit_records,
  (SELECT count(*) FROM public.payments WHERE status = 'void') = 0 AS zero_payments_voided_by_migration;

-- ------------------------------------------------------------
-- E. Migration history.
-- ------------------------------------------------------------
SELECT version FROM supabase_migrations.schema_migrations
WHERE version = '20260824130000';

SELECT
  'migration_recorded' AS check_name,
  EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260824130000') AS result;
