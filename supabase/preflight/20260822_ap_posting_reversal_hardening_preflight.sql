-- ============================================================
-- READ-ONLY preflight for
-- supabase/migrations/20260822120000_ap_posting_reversal_hardening.sql
--
-- Every statement below is a SELECT. Run this against production before
-- applying the migration and inspect every non-empty result. This file
-- is not a migration and must never be applied automatically.
--
-- Do NOT run any INSERT/UPDATE/DELETE/DDL from this file.
-- ============================================================

-- ------------------------------------------------------------
-- Partial-apply detection: none of these should exist yet on a database
-- that has never had this migration applied. Any non-empty result here
-- means the migration (or an equivalent) was already (partially) applied
-- — do not reapply blindly; inspect first.
-- ------------------------------------------------------------
SELECT typname FROM pg_type WHERE typname = 'ap_payment_status';

SELECT proname, prosecdef FROM pg_proc
WHERE proname IN ('create_ap_bill', 'reverse_ap_bill', 'reverse_ap_payment')
  AND pronamespace = 'public'::regnamespace;

SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'ap_bills'
  AND column_name IN ('reversal_entry_id', 'reversal_reason', 'reversed_by', 'reversed_at');

SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'ap_payments'
  AND column_name IN ('status', 'reversal_entry_id', 'reversal_reason', 'reversed_by', 'reversed_at');

SELECT indexname FROM pg_indexes
WHERE indexname IN ('ap_payments_property_status', 'ap_bills_property_status_void');

-- ------------------------------------------------------------
-- Current grant state on the three tables this migration touches —
-- baseline to diff against the postflight check.
-- ------------------------------------------------------------
SELECT table_name, grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name IN ('ap_bills', 'ap_bill_lines', 'ap_payments')
  AND grantee IN ('authenticated', 'anon')
GROUP BY table_name, grantee ORDER BY table_name, grantee;

-- ------------------------------------------------------------
-- Existing 'void' ap_bills — the migration reuses this previously-
-- unused status value. A non-empty result here isn't necessarily wrong,
-- but should be reviewed (were any bills voided by a path other than
-- this migration's own reverse_ap_bill()?).
--
-- status::text — this and the next statement are the only ones in this
-- file that ever return an enum column directly. Discovered live
-- (2026-08-22, in the sibling postflight file, same root cause): the
-- Supabase CLI's --output json path cannot decode a raw custom-enum
-- value ("unknown oid ... cannot be scanned into *interface {}"). Both
-- statements here happened to match zero rows in the actual release run
-- (no void bills existed, no amount_paid inconsistency existed), so the
-- bug never fired here — but it is the exact same latent defect, fixed
-- proactively rather than left for the next time either WHERE clause
-- actually matches a row.
-- ------------------------------------------------------------
SELECT id, property_id, code, status::text, total, amount_paid
FROM public.ap_bills WHERE status = 'void';

-- ------------------------------------------------------------
-- Bills whose amount_paid/status already looks inconsistent before this
-- migration touches anything — reverse_ap_bill()'s "amount_paid <> 0 ->
-- reject" guard and reverse_ap_payment()'s balance-restoration math both
-- assume amount_paid accurately reflects posted, non-reversed payments.
-- ------------------------------------------------------------
SELECT b.id AS bill_id, b.property_id, b.code, b.status::text, b.total, b.amount_paid,
       COALESCE(SUM(p.amount), 0) AS sum_of_payments
FROM public.ap_bills b
LEFT JOIN public.ap_payments p ON p.bill_id = b.id
GROUP BY b.id, b.property_id, b.code, b.status, b.total, b.amount_paid
HAVING COALESCE(SUM(p.amount), 0) <> b.amount_paid;

-- ------------------------------------------------------------
-- post_ap_bill()'s current live source length/hash — a coarse baseline
-- to diff against the postflight capture, confirming the function body
-- actually changes when the migration applies (rather than the
-- CREATE-OR-REPLACE silently no-opping). Row-lock behavior itself was
-- already verified pre-production via code review and a live local
-- disposable-Postgres scenario (concurrent double-post prevention) —
-- not re-verified via a fragile text-substring match against
-- production source.
-- ------------------------------------------------------------
SELECT md5(pg_get_functiondef(oid)) AS current_definition_hash
FROM pg_proc WHERE proname = 'post_ap_bill' AND pronamespace = 'public'::regnamespace;

-- ------------------------------------------------------------
-- journal_entries_reversal_of_uniq must already exist (added by the AR
-- reversal migration) — this migration relies on it and does not
-- recreate it.
-- ------------------------------------------------------------
SELECT indexname FROM pg_indexes WHERE indexname = 'journal_entries_reversal_of_uniq';
