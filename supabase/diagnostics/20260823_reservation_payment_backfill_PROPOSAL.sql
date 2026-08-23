-- ============================================================
-- PROPOSAL ONLY — NOT A MIGRATION. DO NOT APPLY WITHOUT SEPARATE, EXPLICIT
-- HUMAN APPROVAL OF A SPECIFIC RUN. This file must never be placed under
-- supabase/migrations/ and is not applied by `supabase db push`, by any
-- guarded release script, or by any automated process. It is a design
-- proposal for a future task, written and validated locally but not
-- executed against production by this task.
--
-- Purpose: retroactively post a journal entry for every historical
-- public.payments row that has none, using the now-correct post_payment()
-- (20260823090000_reservation_payment_ledger_posting_fix.sql). Run
-- 20260823_reservation_payment_ledger_audit.sql FIRST and have a human
-- review the counts/amounts before ever considering running this.
--
-- Why this is a SEPARATE script, not folded into the posting fix migration:
-- backfilling changes the accounting HISTORY of a live property (it posts
-- entries dated on their original payments' received_at, which may fall in
-- an already-reported period) — that is a business decision requiring
-- explicit sign-off, not a mechanical schema/function fix. Per instruction,
-- this task builds the proposal and read-only audit only; it does not
-- decide FOR the business whether/when to run it, and does not run it.
--
-- Design differences from the LIVE payment path (post_payment() itself,
-- invoked synchronously by the AFTER INSERT trigger) are deliberate and
-- documented in 20260823090000's own header: the live path now propagates
-- any failure loudly (payment + journal succeed or fail together, correct
-- for a single real-time payment). A BULK BACKFILL over many historical
-- rows should NOT abort entirely on the first failure (e.g. one payment
-- whose received_at falls in a period that has since been locked) — it
-- should attempt every eligible row independently, report every outcome,
-- and let a human decide what to do with the rows it could not post. That
-- is a different, equally correct design choice for a bulk tool, not a
-- contradiction of the live path's atomicity decision.
--
-- Mechanically safe by construction:
--   - Only rows with public.payments.status = 'posted' are considered —
--     void (refunded) payments are already correctly handled by
--     reverse_reservation_payment()'s defensive no-journal-found path and
--     do not need (and should not receive) a backfilled original entry.
--   - Only rows with NO existing journal_entries row
--     (source='payment', source_ref=payment id, is_reversal_of IS NULL)
--     are considered — never re-posts an already-posted payment.
--   - Delegates to post_payment() itself for the actual posting logic, so
--     every guard that function enforces (row lock, authorization,
--     locked-period rejection, missing-account rejection, the DB-level
--     journal_entries_payment_source_ref_uniq index) applies identically
--     here — this script adds no new posting logic of its own.
--   - Each row is attempted in its own subtransaction (EXCEPTION block) so
--     one failure (e.g. a locked period, a property missing its cash/AR
--     account) does not block any other row.
--   - Every original payment field (received_at, received_by, method,
--     reference, amount) is read-only here — never modified.
--   - Produces a summary count before returning; intended to be run inside
--     a transaction that a human COMMITs or ROLLBACKs after reviewing the
--     reported counts (shown as an explicit instruction at the bottom).
--
-- Recommended review workflow when this is eventually approved:
--   1. Run 20260823_reservation_payment_ledger_audit.sql against
--      production (read-only) and review the counts/amounts with the
--      business.
--   2. Decide WHO the backfilled entries should be attributed to as
--      posted_by/actor — this is itself a business/audit decision, not
--      something this script infers. post_payment() requires the caller to
--      hold one of super_admin/hotel_owner/general_manager/front_desk/
--      cashier/accountant (see 20260823090000's PART B) at each payment's
--      property, checked via auth.uid(). Run this script in a session with
--      that identity established first, e.g.:
--        SET LOCAL ROLE authenticated;
--        SET LOCAL request.jwt.claim.sub = '<chosen operator user id>';
--      A plain superuser/service-role session with no JWT claim set will
--      have auth.uid() = NULL and every row will fail the role check —
--      that failure is caught per-row (see design notes above) and
--      reported, not silently skipped, but the whole run would report 0
--      posted if this step is missed. A single global-role operator
--      (super_admin, or any role with a NULL property_id row) is
--      sufficient for all properties in one run.
--   3. Run this script wrapped in BEGIN; ... (do not COMMIT yet).
--   4. Review the RAISE NOTICE summary and spot-check a sample of newly
--      created journal_entries/journal_lines rows.
--   5. Only then COMMIT — or ROLLBACK if anything looks wrong.
--   6. Re-run the audit diagnostic afterward to confirm the expected
--      reduction in "no_journal" rows.

DO $$
DECLARE
  r RECORD;
  _posted_count INT := 0;
  _failed_count INT := 0;
  _entry_id UUID;
BEGIN
  FOR r IN
    SELECT p.id, p.amount, p.received_at
    FROM public.payments p
    WHERE p.status = 'posted'
      AND NOT EXISTS (
        SELECT 1 FROM public.journal_entries je
        WHERE je.source = 'payment' AND je.source_ref = p.id::text AND je.is_reversal_of IS NULL
      )
    ORDER BY p.received_at
  LOOP
    BEGIN
      _entry_id := public.post_payment(r.id);
      IF _entry_id IS NOT NULL THEN
        _posted_count := _posted_count + 1;
      ELSE
        _failed_count := _failed_count + 1;
        RAISE NOTICE 'post_payment(%) returned NULL unexpectedly (payment not found?)', r.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      _failed_count := _failed_count + 1;
      RAISE NOTICE 'Backfill failed for payment % (amount %, received_at %): %', r.id, r.amount, r.received_at, SQLERRM;
    END;
  END LOOP;

  RAISE NOTICE 'Reservation payment ledger backfill: % posted, % failed.', _posted_count, _failed_count;
  RAISE NOTICE 'Review the failures above, then COMMIT or ROLLBACK this transaction explicitly.';
END $$;
