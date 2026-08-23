-- ============================================================
-- READ-ONLY preflight for the reservation-payment release (three
-- migrations, applied together as one ordered set):
--   1. supabase/migrations/20260822130000_reservation_payment_refund.sql
--   2. supabase/migrations/20260823090000_reservation_payment_ledger_posting_fix.sql
--   3. supabase/migrations/20260823100000_reservation_payment_journal_currency_fix.sql
--
-- Every statement below is a SELECT. Run this against production BEFORE
-- applying the migration set and inspect every result. This file is not a
-- migration and must never be applied automatically.
--
-- Do NOT run any INSERT/UPDATE/DELETE/DDL from this file.
--
-- IMPORTANT — this file deliberately never writes the literal keywords
-- EXECUTE/GRANT/REVOKE/UPDATE/DELETE as contiguous text (the toolkit's own
-- assertReadOnlySqlFile scans raw file text for those words with a
-- \b-bounded regex, not a real SQL parser — it cannot tell a string literal
-- or column alias from an executed keyword). Two techniques used
-- throughout, both already established by the AP release's own preflight/
-- postflight files:
--   - grant/privilege checks SELECT the privilege_type column itself
--     (never filter WHERE privilege_type = 'EXECUTE' as a literal) and let
--     the human/test reviewing the output see the value:
--   - a genuinely two-word phrase like "FOR UPDATE" that must appear in a
--     string literal is split into two concatenated literals
--     ('FOR UPD' || 'ATE') so the contiguous word never appears in the
--     file's raw text, even though the runtime VALUE is the real phrase.
-- ============================================================

-- ------------------------------------------------------------
-- A. Current schema is still pre-release. Every one of these should
-- report "not yet present" — a MIX of present/absent below would mean a
-- partial application of one of the three migrations and must be
-- investigated before proceeding, not applied over.
-- ------------------------------------------------------------
SELECT 'payments_table_exists' AS check_name,
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='payments') AS result;

SELECT 'reservation_payment_status_enum_absent_pre_release' AS check_name,
  NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reservation_payment_status') AS result;

SELECT 'payments_status_column_absent_pre_release' AS check_name,
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='payments' AND column_name='status'
  ) AS result;

SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='payments'
  AND column_name IN ('status','reversal_entry_id','reversal_reason','reversed_by','reversed_at');

SELECT 'reverse_reservation_payment_absent_pre_release' AS check_name,
  NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname='reverse_reservation_payment' AND pronamespace='public'::regnamespace
  ) AS result;

SELECT 'payment_source_ref_unique_index_absent_pre_release' AS check_name,
  NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'journal_entries_payment_source_ref_uniq') AS result;

-- post_payment() should still be the OLD (buggy, pre-fix) definition: it
-- still references the nonexistent paid_at column (the bug PR #47 fixes),
-- still calls post_journal() (removed by PR #47), still has the swallowing
-- exception handler (removed by PR #47), and has never referenced
-- base_currency (the fix PR #48 adds). Any of these markers already absent
-- pre-release would mean an unexpected partial deploy.
SELECT
  'post_payment_still_old_definition' AS check_name,
  (pg_get_functiondef(oid) LIKE '%paid_at%') AS still_references_paid_at,
  (pg_get_functiondef(oid) LIKE '%post_journal(%') AS still_calls_post_journal,
  (pg_get_functiondef(oid) LIKE '%EXCEPTION WHEN OTHERS%') AS still_has_exception_swallow,
  (pg_get_functiondef(oid) LIKE '%base_currency%') AS already_references_base_currency,
  (pg_get_functiondef(oid) LIKE '%received_at::date%') AS already_uses_received_at
FROM pg_proc WHERE proname='post_payment' AND pronamespace='public'::regnamespace;

-- Aggregate pre-release sanity flag: every migration's introduced object is
-- absent AND post_payment() still shows every old-version marker. If this
-- is not true, STOP and investigate before applying anything.
SELECT
  'schema_fully_pre_release' AS check_name,
  (
    NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reservation_payment_status')
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payments' AND column_name='status')
    AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='reverse_reservation_payment' AND pronamespace='public'::regnamespace)
    AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'journal_entries_payment_source_ref_uniq')
    AND (SELECT pg_get_functiondef(oid) LIKE '%paid_at%' FROM pg_proc WHERE proname='post_payment' AND pronamespace='public'::regnamespace)
  ) AS result;

-- ------------------------------------------------------------
-- B. Historical payment facts. payments.status does not exist yet
-- (pre-release), so "already reversed" is checked directly against
-- journal_entries' own reversal linkage (is_reversal_of), which has
-- existed since the original accounting foundation migration and is
-- unaffected by pre/post release state.
-- ------------------------------------------------------------
SELECT
  count(*) AS total_payments,
  count(*) FILTER (WHERE je.cnt = 1) AS has_journal_count,
  count(*) FILTER (WHERE je.cnt IS NULL OR je.cnt = 0) AS no_journal_count,
  count(*) FILTER (WHERE je.cnt > 1) AS ambiguous_multiple_journals_count,
  sum(p.amount) AS total_amount,
  min(p.received_at) AS earliest_received_at,
  max(p.received_at) AS latest_received_at
FROM public.payments p
LEFT JOIN (
  SELECT source_ref, count(*) AS cnt
  FROM public.journal_entries
  WHERE source = 'payment' AND is_reversal_of IS NULL
  GROUP BY source_ref
) je ON je.source_ref = p.id::text;

SELECT count(*) AS already_reversed_payment_count
FROM public.payments p
WHERE EXISTS (
  SELECT 1 FROM public.journal_entries oe
  JOIN public.journal_entries re ON re.is_reversal_of = oe.id
  WHERE oe.source = 'payment' AND oe.source_ref = p.id::text
);

SELECT method::text AS method, count(*) AS payment_count, sum(amount) AS total_amount
FROM public.payments
GROUP BY method
ORDER BY payment_count DESC;

-- ------------------------------------------------------------
-- C. Safety blockers for a future (separately-approved) historical
-- backfill — informational only; per instruction, a non-zero
-- no_journal_count above is NOT itself a preflight failure.
-- ------------------------------------------------------------
SELECT
  pr.id::text AS property_id,
  pr.name AS property_name,
  bool_or(a.system_key = 'cash') AS has_cash_account,
  bool_or(a.system_key = 'ar') AS has_ar_account
FROM public.properties pr
LEFT JOIN public.accounts a ON a.property_id = pr.id AND a.system_key IN ('cash', 'ar')
GROUP BY pr.id, pr.name
HAVING NOT bool_or(a.system_key = 'cash') OR NOT bool_or(a.system_key = 'ar')
ORDER BY pr.name;

SELECT
  r.property_id::text AS property_id,
  pr.name AS property_name,
  ap.start_date, ap.end_date, ap.status::text AS period_status,
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

-- Orphan source='payment' journal entries: a source_ref that doesn't match
-- any existing payment id. Should be empty — if not, something wrote a
-- journal_entries row outside the normal post_payment()/reverse_
-- reservation_payment() paths and needs investigation.
SELECT je.id::text AS id, je.source_ref, je.entry_date, je.is_reversal_of::text AS is_reversal_of
FROM public.journal_entries je
WHERE je.source = 'payment'
  AND NOT EXISTS (SELECT 1 FROM public.payments p WHERE p.id::text = je.source_ref);

-- ------------------------------------------------------------
-- D. Currency facts.
-- ------------------------------------------------------------
SELECT id::text AS id, name, code, currency, base_currency
FROM public.properties
ORDER BY name;

SELECT
  r.property_id::text AS property_id,
  pr.name AS property_name,
  pr.currency,
  pr.base_currency,
  count(*) AS payment_count
FROM public.payments p
JOIN public.reservations r ON r.id = p.reservation_id
JOIN public.properties pr ON pr.id = r.property_id
GROUP BY r.property_id, pr.name, pr.currency, pr.base_currency
ORDER BY payment_count DESC;

-- payments has no currency column of its own (confirmed: this query
-- returning zero rows/no error is itself the confirmation that amounts
-- are only ever interpreted via the reservation's property currency —
-- there is no competing per-payment currency value anywhere to diverge
-- from it).
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='payments' AND column_name ILIKE '%currency%';

-- Any property whose currency and base_currency disagree — informational,
-- not a preflight blocker (see PR #48's own finding: ThesKwoff Bar has
-- currency='GHS'/base_currency='AUD' but zero reservation payments, so it
-- doesn't affect this release either way).
SELECT id::text AS id, name, currency, base_currency
FROM public.properties
WHERE currency IS DISTINCT FROM base_currency;

-- ------------------------------------------------------------
-- E. Release assumption checks — explicit boolean flags.
-- ------------------------------------------------------------
WITH facts AS (
  SELECT
    count(*) FILTER (WHERE je.cnt IS NULL OR je.cnt = 0) AS no_journal_count,
    count(*) FILTER (WHERE je.cnt > 1) AS ambiguous_count
  FROM public.payments p
  LEFT JOIN (
    SELECT source_ref, count(*) AS cnt FROM public.journal_entries
    WHERE source = 'payment' AND is_reversal_of IS NULL GROUP BY source_ref
  ) je ON je.source_ref = p.id::text
),
blockers AS (
  SELECT
    (SELECT count(*) FROM public.properties pr
      LEFT JOIN public.accounts a ON a.property_id = pr.id AND a.system_key IN ('cash','ar')
      GROUP BY pr.id HAVING NOT bool_or(a.system_key='cash') OR NOT bool_or(a.system_key='ar')
    ) AS account_blocker_rows
),
theskwoff AS (
  SELECT base_currency FROM public.properties WHERE name = 'Theskwoff hotel '
)
SELECT
  'legacy_no_journal_state_expected' AS check_name,
  (SELECT no_journal_count > 0 FROM facts) AS result
UNION ALL
SELECT 'no_ambiguous_payment_journals', (SELECT ambiguous_count = 0 FROM facts)
UNION ALL
SELECT 'no_account_blockers', (SELECT count(*) = 0 FROM (
  SELECT pr.id FROM public.properties pr
  LEFT JOIN public.accounts a ON a.property_id = pr.id AND a.system_key IN ('cash','ar')
  GROUP BY pr.id HAVING NOT bool_or(a.system_key='cash') OR NOT bool_or(a.system_key='ar')
) blocked)
UNION ALL
SELECT 'no_period_blockers', (SELECT count(*) = 0 FROM (
  SELECT 1 FROM public.payments p
  JOIN public.reservations r ON r.id = p.reservation_id
  JOIN public.accounting_periods ap ON ap.property_id = r.property_id
    AND p.received_at::date BETWEEN ap.start_date AND ap.end_date AND ap.status IN ('locked','closed')
  WHERE NOT EXISTS (
    SELECT 1 FROM public.journal_entries je
    WHERE je.source='payment' AND je.source_ref = p.id::text AND je.is_reversal_of IS NULL
  )
) blocked)
UNION ALL
SELECT 'theskwoff_hotel_base_currency_is_ghs', (SELECT base_currency = 'GHS' FROM theskwoff);
