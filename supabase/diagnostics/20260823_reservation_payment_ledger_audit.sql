-- ============================================================
-- READ-ONLY diagnostic: reservation payment ledger audit.
--
-- Purpose: classify every historical public.payments row by whether it has
-- a matching journal_entries posting, in support of a future, separately-
-- approved backfill decision (see the accompanying
-- 20260823_reservation_payment_backfill_PROPOSAL.sql in this same
-- directory — NOT a migration, requires explicit human approval before
-- ever being run, and is not run by this diagnostic or by any automated
-- process).
--
-- Context: 20260823090000_reservation_payment_ledger_posting_fix.sql fixed
-- post_payment() so NEW reservation payments post correctly going forward.
-- Every payment inserted BEFORE that fix shipped almost certainly has no
-- journal entry at all (post_payment() silently failed on every invocation
-- due to a since-fixed column-name bug) — this file lets an operator
-- confirm the actual scope of that gap in a real environment (most usefully
-- production) before deciding whether/how to backfill it.
--
-- This file is NOT a migration — it must never be placed under
-- supabase/migrations/ or applied via `supabase db push`. Every statement
-- below is a SELECT. Do NOT add INSERT/UPDATE/DELETE/DDL to this file.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Overall classification and total exposure.
-- ------------------------------------------------------------
SELECT
  CASE
    WHEN je.cnt IS NULL OR je.cnt = 0 THEN 'no_journal'
    WHEN je.cnt = 1 THEN 'has_journal'
    ELSE 'ambiguous_multiple_journals'
  END AS classification,
  p.status AS payment_status,
  count(*) AS payment_count,
  min(p.received_at) AS earliest_received_at,
  max(p.received_at) AS latest_received_at,
  sum(p.amount) AS total_amount
FROM public.payments p
LEFT JOIN (
  SELECT source_ref, count(*) AS cnt
  FROM public.journal_entries
  WHERE source = 'payment' AND is_reversal_of IS NULL
  GROUP BY source_ref
) je ON je.source_ref = p.id::text
GROUP BY classification, p.status
ORDER BY classification, p.status;

-- ------------------------------------------------------------
-- 2. Per-property breakdown, for triage / prioritization.
-- ------------------------------------------------------------
SELECT
  r.property_id,
  pr.name AS property_name,
  CASE
    WHEN je.cnt IS NULL OR je.cnt = 0 THEN 'no_journal'
    WHEN je.cnt = 1 THEN 'has_journal'
    ELSE 'ambiguous_multiple_journals'
  END AS classification,
  count(*) AS payment_count,
  sum(p.amount) AS total_amount
FROM public.payments p
JOIN public.reservations r ON r.id = p.reservation_id
JOIN public.properties pr ON pr.id = r.property_id
LEFT JOIN (
  SELECT source_ref, count(*) AS cnt
  FROM public.journal_entries
  WHERE source = 'payment' AND is_reversal_of IS NULL
  GROUP BY source_ref
) je ON je.source_ref = p.id::text
GROUP BY r.property_id, pr.name, classification
ORDER BY pr.name, classification;

-- ------------------------------------------------------------
-- 3. Backfill blocker check A: properties missing a required system
-- account. A backfill attempt against any of these properties' payments
-- would hit post_payment()'s own "accounting setup is incomplete" guard.
-- ------------------------------------------------------------
SELECT
  pr.id AS property_id,
  pr.name AS property_name,
  bool_or(a.system_key = 'cash') AS has_cash_account,
  bool_or(a.system_key = 'ar') AS has_ar_account
FROM public.properties pr
LEFT JOIN public.accounts a ON a.property_id = pr.id AND a.system_key IN ('cash', 'ar')
GROUP BY pr.id, pr.name
HAVING NOT bool_or(a.system_key = 'cash') OR NOT bool_or(a.system_key = 'ar')
ORDER BY pr.name;

-- ------------------------------------------------------------
-- 4. Backfill blocker check B: no-journal payments whose received_at date
-- falls inside a currently locked/closed accounting period. A backfill
-- attempt would correctly be rejected for these rows unless the period is
-- temporarily reopened first (a separate, explicit decision — not implied
-- by running this diagnostic).
-- ------------------------------------------------------------
SELECT
  r.property_id,
  pr.name AS property_name,
  ap.start_date, ap.end_date, ap.status AS period_status,
  count(*) AS blocked_payment_count,
  sum(p.amount) AS blocked_amount
FROM public.payments p
JOIN public.reservations r ON r.id = p.reservation_id
JOIN public.properties pr ON pr.id = r.property_id
JOIN public.accounting_periods ap
  ON ap.property_id = r.property_id
  AND p.received_at::date BETWEEN ap.start_date AND ap.end_date
  AND ap.status IN ('locked', 'closed')
WHERE NOT EXISTS (
  SELECT 1 FROM public.journal_entries je
  WHERE je.source = 'payment' AND je.source_ref = p.id::text AND je.is_reversal_of IS NULL
)
GROUP BY r.property_id, pr.name, ap.start_date, ap.end_date, ap.status
ORDER BY pr.name;

-- ------------------------------------------------------------
-- 5. Ambiguous rows (should be structurally impossible after
-- journal_entries_payment_source_ref_uniq — this is a corroborating check,
-- not the primary defense).
-- ------------------------------------------------------------
SELECT p.id AS payment_id, p.reservation_id, p.amount, p.received_at, je.cnt AS journal_count
FROM public.payments p
JOIN (
  SELECT source_ref, count(*) AS cnt
  FROM public.journal_entries
  WHERE source = 'payment' AND is_reversal_of IS NULL
  GROUP BY source_ref
  HAVING count(*) > 1
) je ON je.source_ref = p.id::text;

-- ------------------------------------------------------------
-- 6. Refunded (void) payments with no journal — informational only. These
-- do NOT need backfilling to be refundable (reverse_reservation_payment()'s
-- defensive design already handles a missing original entry safely, and
-- has already marked these void) — listed here only so an operator can see
-- the overlap between "never posted" and "already refunded" rows.
-- ------------------------------------------------------------
SELECT count(*) AS void_payments_with_no_journal, sum(p.amount) AS total_amount
FROM public.payments p
WHERE p.status = 'void'
  AND NOT EXISTS (
    SELECT 1 FROM public.journal_entries je
    WHERE je.source = 'payment' AND je.source_ref = p.id::text AND je.is_reversal_of IS NULL
  );
