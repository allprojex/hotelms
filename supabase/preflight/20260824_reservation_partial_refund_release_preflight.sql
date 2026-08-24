-- ============================================================
-- READ-ONLY preflight for the reservation-payment PARTIAL REFUND release
-- (supabase/migrations/20260824130000_reservation_payment_partial_refund.sql,
-- PR #67, merged to main at c08595b74b96147dc1241222d3b5adb29b12397b).
--
-- Every statement below is a SELECT. Run this against production BEFORE
-- applying the migration and inspect every result. This file is not a
-- migration and must never be applied automatically.
--
-- Do NOT run any INSERT/UPDATE/DELETE/DDL from this file.
--
-- Same non-keyword-triggering techniques established by the prior
-- reservation-payment release's own preflight/postflight (never filter a
-- grant/privilege query on a literal 'EXECUTE' string; select the
-- privilege_type/ACL-letter column itself instead; a genuine two-word
-- phrase like "FOR UPDATE" that must appear inside a string literal is
-- split into concatenated literals, e.g. 'FOR UPD' || 'ATE', so the
-- contiguous keyword never appears in this file's raw text even though the
-- runtime VALUE compared against is the real phrase) — assertReadOnlySqlFile
-- strips -- and /* */ comments before scanning, then does a raw \b-bounded
-- keyword scan of what remains; it is not a real SQL parser and cannot tell
-- a string literal from an executed keyword.
-- ============================================================

-- ------------------------------------------------------------
-- A. Current schema is still pre-release. Every one of these should report
-- "not yet present" / "still the pre-release grant" — any mix here would
-- mean a partial application and must be investigated before proceeding.
-- ------------------------------------------------------------
SELECT 'reservation_payment_refunds_absent_pre_release' AS check_name,
  to_regclass('public.reservation_payment_refunds') IS NULL AS result;

SELECT 'refund_reservation_payment_absent_pre_release' AS check_name,
  to_regprocedure('public.refund_reservation_payment(uuid,numeric,text,uuid)') IS NULL AS result;

SELECT 'journal_source_lacks_payment_refund_pre_release' AS check_name,
  NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'journal_source' AND e.enumlabel = 'payment_refund'
  ) AS result;

-- Current production grant state of the OLD full-refund RPC — must still
-- show authenticated able to execute it (this release's own migration is
-- what revokes that, in a later step, not yet applied). Grant listing
-- selects privilege_type itself rather than filtering on a literal value —
-- read the output, don't just trust an aggregate.
SELECT r.routine_name, g.grantee, g.privilege_type
FROM information_schema.routine_privileges g
JOIN information_schema.routines r ON r.specific_name = g.specific_name
WHERE r.routine_schema = 'public'
  AND r.routine_name = 'reverse_reservation_payment'
  AND g.grantee IN ('authenticated', 'anon', 'PUBLIC')
ORDER BY g.grantee;

WITH acl AS (
  SELECT (regexp_match(aclitemout(a)::text, '^([^=]*)=([a-zA-Z]*)/'))[1] AS grantee,
         (regexp_match(aclitemout(a)::text, '^([^=]*)=([a-zA-Z]*)/'))[2] AS priv_letters
  FROM pg_proc p, unnest(p.proacl) AS a
  WHERE p.proname = 'reverse_reservation_payment' AND p.pronamespace = 'public'::regnamespace
)
SELECT
  'reverse_reservation_payment_still_authenticated_executable_pre_release' AS check_name,
  bool_or(grantee = 'authenticated' AND position('X' in priv_letters) > 0) AS result
FROM acl;

-- Body-hash fingerprint of the OLD RPC — record this value; postflight must
-- capture and report the SAME value (this migration is grants-only for this
-- function, it never redefines the body).
SELECT
  'reverse_reservation_payment_body_fingerprint' AS check_name,
  md5(pg_get_functiondef(oid)) AS body_md5
FROM pg_proc WHERE proname = 'reverse_reservation_payment' AND pronamespace = 'public'::regnamespace;

-- Aggregate pre-release sanity flag.
SELECT
  'schema_fully_pre_release' AS check_name,
  (
    to_regclass('public.reservation_payment_refunds') IS NULL
    AND to_regprocedure('public.refund_reservation_payment(uuid,numeric,text,uuid)') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'journal_source' AND e.enumlabel = 'payment_refund'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.routine_privileges g
      JOIN information_schema.routines r ON r.specific_name = g.specific_name
      WHERE r.routine_schema = 'public' AND r.routine_name = 'reverse_reservation_payment'
        AND g.grantee = 'authenticated'
    )
  ) AS result;

-- ------------------------------------------------------------
-- B. Payment baseline.
-- ------------------------------------------------------------
SELECT
  count(*) AS total_payments,
  count(*) FILTER (WHERE status = 'posted') AS posted_payments,
  count(*) FILTER (WHERE status = 'void') AS void_payments,
  sum(amount) AS total_payment_amount
FROM public.payments;

SELECT
  count(*) FILTER (WHERE je.cnt >= 1) AS payments_with_original_journal_entry,
  count(*) FILTER (WHERE je.cnt IS NULL OR je.cnt = 0) AS payments_without_journal_entry
FROM public.payments p
LEFT JOIN (
  SELECT source_ref, count(*) AS cnt
  FROM public.journal_entries
  WHERE source = 'payment' AND is_reversal_of IS NULL
  GROUP BY source_ref
) je ON je.source_ref = p.id::text;

SELECT
  pr.id::text AS property_id, pr.name AS property_name,
  count(p.id) AS payment_count, COALESCE(sum(p.amount), 0) AS total_amount
FROM public.properties pr
LEFT JOIN public.reservations r ON r.property_id = pr.id
LEFT JOIN public.payments p ON p.reservation_id = r.id
GROUP BY pr.id, pr.name
ORDER BY pr.name;

SELECT
  pr.id::text AS property_id, pr.name AS property_name,
  count(r.id) AS reservation_count
FROM public.properties pr
LEFT JOIN public.reservations r ON r.property_id = pr.id
GROUP BY pr.id, pr.name
ORDER BY pr.name;

-- ------------------------------------------------------------
-- C. Accounting baseline.
-- ------------------------------------------------------------
SELECT
  (SELECT count(*) FROM public.journal_entries) AS journal_entries_count,
  (SELECT count(*) FROM public.journal_lines) AS journal_lines_count;

SELECT enumlabel FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typname = 'journal_source'
ORDER BY e.enumsortorder;

SELECT
  property_id::text AS property_id, start_date, end_date, status::text AS period_status
FROM public.accounting_periods
WHERE status IN ('locked', 'closed')
ORDER BY property_id, start_date;

-- Original payment journal shape facts: this release's refund RPC assumes
-- (and structurally guards) that a payment's original journal entry has
-- EXACTLY two lines, each equal to the full payment amount. Confirm how
-- many existing payment journal entries already match that shape vs. any
-- that don't — informational, not a blocker (the guard rejects a
-- mismatched shape at refund time rather than assuming it), but any
-- non-matching count here should be understood before relying on partial
-- refund for those specific payments.
WITH shapes AS (
  SELECT je.id, je.source_ref,
    (SELECT count(*) FROM public.journal_lines jl WHERE jl.entry_id = je.id) AS line_count,
    (SELECT COALESCE(sum(jl.debit), 0) FROM public.journal_lines jl WHERE jl.entry_id = je.id) AS debit_total,
    (SELECT COALESCE(sum(jl.credit), 0) FROM public.journal_lines jl WHERE jl.entry_id = je.id) AS credit_total,
    p.amount AS payment_amount
  FROM public.journal_entries je
  JOIN public.payments p ON p.id::text = je.source_ref
  WHERE je.source = 'payment' AND je.is_reversal_of IS NULL
)
SELECT
  count(*) FILTER (WHERE line_count = 2 AND ROUND(debit_total, 2) = ROUND(payment_amount, 2) AND ROUND(credit_total, 2) = ROUND(payment_amount, 2)) AS matches_expected_two_line_full_amount_shape,
  count(*) FILTER (WHERE NOT (line_count = 2 AND ROUND(debit_total, 2) = ROUND(payment_amount, 2) AND ROUND(credit_total, 2) = ROUND(payment_amount, 2))) AS does_not_match_expected_shape
FROM shapes;

-- ------------------------------------------------------------
-- D. Financial baseline — compare against postflight after applying the
-- migration; every number here must be identical afterward (the migration
-- is schema/function only, it writes zero rows of its own).
-- ------------------------------------------------------------
SELECT
  (SELECT count(*) FROM public.reservation_charges) AS reservation_charges_count,
  (SELECT COALESCE(sum(amount), 0) FROM public.reservation_charges) AS reservation_charges_total,
  (SELECT count(*) FROM public.payments) AS payments_count,
  (SELECT COALESCE(sum(amount), 0) FROM public.payments) AS payments_total,
  (SELECT count(*) FROM public.journal_entries) AS journal_entries_count,
  (SELECT count(*) FROM public.journal_lines) AS journal_lines_count,
  (SELECT count(*) FROM public.admin_action_logs) AS admin_action_logs_count;
