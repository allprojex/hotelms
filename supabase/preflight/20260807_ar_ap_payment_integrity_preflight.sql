-- ============================================================
-- READ-ONLY preflight for supabase/migrations/20260807120000_ar_ap_payment_integrity.sql
--
-- Every statement below is a SELECT. Run this against a
-- production/staging *copy* before applying the migration and inspect
-- every non-empty result. This file is not a migration and must never
-- be applied automatically — it exists purely to surface historical
-- data that would violate the new constraints (which would make
-- ALTER TABLE ... ADD CONSTRAINT fail) or would silently misbehave
-- under the hardened functions.
--
-- Do NOT run any INSERT/UPDATE/DELETE/DDL from this file.
-- ============================================================

-- ------------------------------------------------------------
-- AP: would ap_bills_amount_paid_bounds (0 <= amount_paid <= total) reject
-- any existing row?
-- ------------------------------------------------------------
SELECT id, property_id, code, status, total, amount_paid
FROM public.ap_bills
WHERE amount_paid < 0 OR amount_paid > total;

-- AP: zero/negative historical payments (would violate
-- ap_payments_amount_positive: amount > 0)
SELECT id, property_id, bill_id, amount, method, paid_at
FROM public.ap_payments
WHERE amount IS NULL OR amount <= 0;

-- AP: payments whose property_id does not match their bill's
-- property_id (would violate the new composite FK
-- ap_payments_property_bill_fkey, since (property_id, bill_id) would
-- no longer resolve against ap_bills(property_id, id))
SELECT p.id AS payment_id, p.property_id AS payment_property_id,
       b.id AS bill_id, b.property_id AS bill_property_id
FROM public.ap_payments p
JOIN public.ap_bills b ON b.id = p.bill_id
WHERE p.property_id IS DISTINCT FROM b.property_id;

-- AP: bills marked 'paid' whose amount_paid does not actually cover
-- total, and bills below 'paid' whose amount_paid already covers total
-- (status/amount_paid inconsistency the hardened post_ap_payment()
-- would not itself have produced, so likely from a different write path)
SELECT id, property_id, code, status, total, amount_paid
FROM public.ap_bills
WHERE (status = 'paid' AND amount_paid < total)
   OR (status <> 'paid' AND status <> 'void' AND amount_paid >= total AND total > 0);

-- AP: payments recorded against bills that are draft/void (the
-- hardened function only allows payment against 'open' bills — any
-- existing payment against a non-open bill indicates it was written by
-- a path other than post_ap_payment(), or the bill's status changed
-- after payment)
SELECT p.id AS payment_id, p.bill_id, b.status AS bill_status, p.amount, p.paid_at
FROM public.ap_payments p
JOIN public.ap_bills b ON b.id = p.bill_id
WHERE b.status NOT IN ('open', 'paid');

-- AP: per-bill payment totals that exceed the bill total (would violate
-- the "amount must not exceed remaining balance" invariant retroactively;
-- amount_paid on the bill may already be wrong if some other process
-- wrote it directly instead of via post_ap_payment())
SELECT b.id AS bill_id, b.property_id, b.code, b.total, b.amount_paid,
       COALESCE(SUM(p.amount), 0) AS sum_of_payments
FROM public.ap_bills b
LEFT JOIN public.ap_payments p ON p.bill_id = b.id
GROUP BY b.id, b.property_id, b.code, b.total, b.amount_paid
HAVING COALESCE(SUM(p.amount), 0) > b.total
    OR COALESCE(SUM(p.amount), 0) <> b.amount_paid;

-- AP: possible duplicate payments — same bill, amount, and method
-- posted within the same minute (heuristic for double-submission, not
-- a hard rule; review manually, don't auto-delete)
SELECT bill_id, amount, method, date_trunc('minute', paid_at) AS minute_bucket, COUNT(*) AS occurrences
FROM public.ap_payments
GROUP BY bill_id, amount, method, date_trunc('minute', paid_at)
HAVING COUNT(*) > 1;

-- ------------------------------------------------------------
-- AR: would ar_invoices_amount_paid_bounds (0 <= amount_paid <= total)
-- reject any existing row?
-- ------------------------------------------------------------
SELECT id, property_id, code, status, total, amount_paid
FROM public.ar_invoices
WHERE amount_paid < 0 OR amount_paid > total;

-- AR: sanity check on the migration's assumption that no existing code
-- path has ever written ar_invoices.amount_paid — if this returns any
-- rows, the "safe to add unconditionally" rationale in the migration
-- no longer holds and the bound needs re-justifying before applying.
SELECT id, property_id, code, status, total, amount_paid
FROM public.ar_invoices
WHERE amount_paid <> 0;

-- AR: do the new ar_receipts / ar_receipt_allocations tables already
-- exist with data (e.g. from a partially-applied prior attempt at this
-- migration)? Should return "relation does not exist" (i.e. this
-- query should fail / be skipped) on a database that has never had
-- this migration applied. If it succeeds and returns rows, do not
-- reapply the migration blindly.
-- SELECT count(*) FROM public.ar_receipts;
-- SELECT count(*) FROM public.ar_receipt_allocations;

-- ------------------------------------------------------------
-- Composite-FK / constraint-name collisions: would ADD CONSTRAINT
-- fail because an object with the same name already exists? (Should
-- return zero rows on a database that has never had this migration
-- applied.)
-- ------------------------------------------------------------
SELECT conname FROM pg_constraint
WHERE conname IN (
  'ap_bills_property_id_uniq', 'ap_payments_property_bill_fkey',
  'ap_payments_amount_positive', 'ap_bills_amount_paid_bounds',
  'ar_invoices_property_id_uniq', 'ar_invoices_amount_paid_bounds',
  'ar_receipt_allocations_receipt_fkey', 'ar_receipt_allocations_invoice_fkey'
);
SELECT indexname FROM pg_indexes
WHERE indexname IN (
  'ar_receipt_allocations_invoice', 'ar_invoices_property_status', 'ap_bills_property_status'
);

-- ------------------------------------------------------------
-- resolve_account() dependency check: every property must have
-- accounts seeded with system_key IN ('cash','bank','ap','ar') and no
-- posting_rules override missing an account, or post_ar_receipt() /
-- post_ap_payment() will try to post a journal_line with a NULL
-- account_id and fail with a NOT NULL violation instead of a clean
-- business-rule error.
-- ------------------------------------------------------------
SELECT p.id AS property_id, p.name, missing.system_key
FROM public.properties p
CROSS JOIN (VALUES ('cash'), ('bank'), ('ap'), ('ar')) AS missing(system_key)
WHERE NOT EXISTS (
  SELECT 1 FROM public.accounts a
  WHERE a.property_id = p.id AND a.system_key = missing.system_key
);
