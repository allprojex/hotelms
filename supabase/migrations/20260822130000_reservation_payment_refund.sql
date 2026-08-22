-- Reservation payment refund.
--
-- Client request: after a guest has paid for a reservation and later decides
-- not to stay, authorized staff need a proper Refund action on that payment
-- — never a silent delete, with preserved history and auditability, mirroring
-- the AR/AP reversal work (20260818090000, 20260821120000, 20260822120000).
--
-- Phase 1 investigation findings (repository evidence, not assumption):
--
-- 1. public.payments (20260705025821) stores every reservation payment —
--    reservation_id, method, amount, reference, received_by, received_at.
--    No status column exists today; every row is implicitly "live". One
--    reservation may have MANY payments (no unique constraint on
--    reservation_id) — refunds must therefore target one specific payment
--    row, never "the reservation" as a whole.
--
-- 2. reservation_charges/payments/invoices totals are NEVER stored on
--    reservations itself — src/routes/_authenticated/reservations.$id.tsx
--    computes totalCharges/totalPaid/balance live, client-side, by summing
--    charges/payments on every render. There is no reservations.amount_paid
--    column to keep in sync, unlike ap_bills/ar_invoices. "Recomputing the
--    balance" therefore only requires the UI to stop counting a refunded
--    payment in that client-side sum (this migration's sibling app-code
--    change), not any new server-side aggregate column.
--
-- 3. CRITICAL FINDING: reservation payments DO have an intended accounting
--    linkage — post_payment(_pay_id) (20260705035515) is AFTER-INSERT
--    trigger-invoked on every public.payments row and is meant to post
--    Debit Cash / Credit AR via post_journal(), tagged
--    source='payment', source_ref=payment_id. However post_payment() reads
--    `p.paid_at` (line 350 of that migration) — a column that has never
--    existed on public.payments (the real column is `received_at`). Every
--    invocation therefore raises "record p has no field paid_at", which is
--    silently swallowed by that function's own
--    `EXCEPTION WHEN OTHERS THEN RAISE NOTICE ...; RETURN NULL;` handler.
--    Confirmed by reading every migration that touches public.payments or
--    redefines post_payment(): it is never fixed or redefined anywhere in
--    this repository's history. CONCLUSION: no reservation payment has ever
--    actually been posted to the general ledger, despite the trigger firing
--    on every insert. This is a genuine pre-existing bug, but fixing it is
--    explicitly out of scope for this PR (client instruction: "reservation-
--    payment refund only", no AR/AP redesign) — fixing it would also require
--    a reviewed historical backfill decision (should every past payment
--    suddenly post today?), which is a materially different, larger change.
--    reverse_reservation_payment() below is written defensively so it is
--    correct in BOTH states: today, where no journal entry exists for any
--    payment (the common case — the reversal step is skipped, payment is
--    still marked refunded), and in the future, if post_payment() is ever
--    fixed separately (the reversal step then finds and correctly reverses
--    the real entry, no further change needed here).
--
-- 4. Reservation lifecycle (reservation_status: confirmed, checked_in,
--    checked_out, cancelled, no_show — 20260705025821; no_show is set
--    automatically by night-audit's business-date rollover for a still-
--    'confirmed' reservation past its check_in date, 20260705040642) is
--    orthogonal to payment refund eligibility. Every one of those five
--    states is a legitimate real-world refund scenario (pre-stay
--    cancellation — the client's own example; post-checkout billing
--    correction; early-checkout adjustment while still checked_in; a
--    no-show's deposit; a cancelled booking's deposit). reverse_ap_payment()
--    (20260822120000) sets the precedent this migration follows: it gates
--    eligibility on the PAYMENT's own status, never on its parent bill's
--    lifecycle status. reverse_reservation_payment() does the same —
--    eligibility is "this specific payment has not already been refunded",
--    full stop. No reservation.status check is added. A refund is therefore
--    always a separate, explicit action from Cancel — it never auto-cancels
--    the reservation, and Cancel never auto-refunds a payment. Staff decide
--    both independently, in whichever order the situation calls for.
--
-- 5. Multiple payments / partial vs full: confirmed no allocation table
--    exists (unlike ar_receipts/ar_receipt_allocations) — one payments row
--    is independent of every other payments row on the same reservation.
--    Per client instruction, this PR implements FULL reversal of one
--    existing payment only (mirroring reverse_ap_payment's own scope, which
--    also has no partial-reversal concept). Partial refund (refunding less
--    than a payment's full amount) is NOT implemented — it would require a
--    new partial-amount concept the existing payments/journal model has no
--    precedent for anywhere in this codebase (AR/AP reversal is 100%-only
--    too), and is explicitly deferred to a later PR if ever requested.
--
-- 6. Overpayments are structurally possible today (AddPayment's UI amount
--    field is not validated against the outstanding balance) — irrelevant to
--    a single-payment full reversal, which always un-does exactly this one
--    payment's own amount regardless of the reservation's overall balance.
--
-- 7. Accounting periods: accounting_periods (20260705035515) is checked for
--    a locked/closed period covering the refund's own posting date
--    (CURRENT_DATE), exactly mirroring reverse_ap_payment()'s own guard —
--    even though, per finding 3, there is usually no journal entry to post
--    against today, the guard is kept unconditionally (not only when an
--    entry exists) so a future post_payment() fix inherits period-lock
--    protection automatically.
--
-- 8. Payment-gateway refunds are out of scope: no payment-provider
--    integration exists anywhere in this repository (payments.method is a
--    plain enum: cash/card/bank_transfer/mobile_money/wallet/other, with a
--    free-text `reference`, never a gateway transaction id or webhook). This
--    is, and remains, an internal PMS refund RECORD only — it does not call
--    out to any card processor or mobile-money provider to move real money;
--    it records that staff have already done so by other means (this is the
--    same posture ap_payments/ar_receipts already have — no gateway
--    integration exists for those either).
--
-- 9. Roles: payments_write RLS (20260705025821) already allows
--    front_desk/cashier, alongside super_admin/hotel_owner/general_manager,
--    to INSERT a payment. Per client instruction ("do not grant front desk
--    refund authority automatically just because front desk can receive
--    payment"), refund authority is deliberately narrower — reused verbatim
--    from ACCOUNTING_ADMIN_ROLES (src/lib/accounting/permissions.ts):
--    super_admin, hotel_owner, general_manager, accountant. This is the same
--    role set every AR/AP reversal RPC already requires, front_desk
--    excluded from all of them.
--
-- 10. Never-delete guarantee: today public.payments GRANTs
--     INSERT/UPDATE/DELETE to `authenticated`, gated only by the
--     `payments_write` RLS role check — meaning any front_desk/cashier/
--     accountant/etc. actor could already call
--     `supabase.from("payments").delete()` or `.update({amount: ...})`
--     directly from the client today, silently destroying or altering a
--     posted financial record with zero audit trail. Exactly the AP
--     precedent (20260822120000 PART C) fixes this: UPDATE and DELETE are
--     revoked from `authenticated` below, closing the direct-bypass hole so
--     "never DELETE the original payment" is a structural database
--     guarantee, not merely a UI habit. INSERT is deliberately kept — the
--     existing AddPayment path (reservations.$id.tsx) still does a raw
--     `supabase.from("payments").insert()`, and this migration does not
--     change payment CREATION, only refund/reversal.
--
-- ============================================================
-- PART A — payments: status + reversal metadata (additive only)
-- ============================================================
CREATE TYPE public.reservation_payment_status AS ENUM ('posted', 'void');

-- Every existing row is genuinely 'posted' today — nothing has ever written
-- any other state to this table.
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS status public.reservation_payment_status NOT NULL DEFAULT 'posted',
  ADD COLUMN IF NOT EXISTS reversal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT,
  ADD COLUMN IF NOT EXISTS reversed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS payments_reservation_status ON public.payments(reservation_id, status);

-- ============================================================
-- PART B — close the direct-write bypass (see finding 10 above)
-- ============================================================
REVOKE UPDATE, DELETE ON public.payments FROM authenticated;

-- ============================================================
-- PART C — reverse_reservation_payment(): the refund RPC
-- ============================================================
CREATE OR REPLACE FUNCTION public.reverse_reservation_payment(_id UUID, _reason TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  pay RECORD; res RECORD; jl RECORD; orig_entry RECORD;
  _reversal_entry UUID; _existing_reversal UUID;
  _period_id UUID; _trimmed_reason TEXT;
  _dr NUMERIC; _cr NUMERIC;
BEGIN
  _trimmed_reason := btrim(COALESCE(_reason, ''));
  IF char_length(_trimmed_reason) < 5 THEN
    RAISE EXCEPTION 'A refund reason of at least 5 characters is required';
  END IF;
  IF char_length(_trimmed_reason) > 500 THEN
    RAISE EXCEPTION 'Refund reason must be 500 characters or fewer';
  END IF;

  -- Primary defense against a concurrent double refund of the SAME payment.
  SELECT * INTO pay FROM public.payments WHERE id = _id FOR UPDATE;
  IF pay IS NULL THEN RAISE EXCEPTION 'Payment not found'; END IF;

  -- Reservation (and therefore property) is derived from the locked payment
  -- row, never taken as a client-supplied parameter — cross-property refund
  -- is impossible by construction, and a global-role actor (super_admin, or
  -- anyone with a NULL-property_id role row) is intentionally still allowed,
  -- matching has_any_role()'s existing, established semantics.
  SELECT * INTO res FROM public.reservations WHERE id = pay.reservation_id;
  IF res IS NULL THEN RAISE EXCEPTION 'Reservation for this payment was not found'; END IF;

  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], res.property_id) THEN
    RAISE EXCEPTION 'Not permitted to refund a reservation payment';
  END IF;

  IF pay.status = 'void' THEN
    RAISE EXCEPTION 'Payment has already been refunded';
  END IF;

  SELECT id INTO _period_id FROM public.accounting_periods
    WHERE property_id = res.property_id AND CURRENT_DATE BETWEEN start_date AND end_date AND status IN ('locked','closed')
    LIMIT 1;
  IF _period_id IS NOT NULL THEN RAISE EXCEPTION 'Current accounting period is locked'; END IF;

  -- See this migration's header, finding 3: no posted_entry_id column exists
  -- on payments (unlike ap_payments/ar_receipts), and post_payment()'s own
  -- bug means this will almost always find nothing today. That is expected
  -- and safe: the reversal below is skipped entirely when no entry exists,
  -- and the payment is still correctly marked refunded. `is_reversal_of IS
  -- NULL` guarantees this always selects the ORIGINAL posting, never a
  -- reversal entry, even though that distinction is unreachable in practice
  -- (pay.status='void' above already blocks a second call once one exists).
  SELECT * INTO orig_entry FROM public.journal_entries
    WHERE source = 'payment' AND source_ref = pay.id::text AND is_reversal_of IS NULL
    LIMIT 1;

  IF orig_entry IS NOT NULL THEN
    SELECT id INTO _existing_reversal FROM public.journal_entries WHERE is_reversal_of = orig_entry.id;
    IF _existing_reversal IS NOT NULL THEN
      RAISE EXCEPTION 'Payment already has a reversal journal entry';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.journal_lines WHERE entry_id = orig_entry.id) THEN
      RAISE EXCEPTION 'Original journal entry for this payment has no lines';
    END IF;

    INSERT INTO public.journal_entries(property_id, entry_date, memo, source, source_ref, currency, posted_by, is_reversal_of)
    VALUES (res.property_id, CURRENT_DATE, 'Refund of reservation payment — '||_trimmed_reason, 'payment', pay.id::text, orig_entry.currency, auth.uid(), orig_entry.id)
    RETURNING id INTO _reversal_entry;

    -- Built directly from the ORIGINAL journal_lines (debit/credit swapped
    -- 1:1, fx_rate/base amounts copied verbatim) — never recomputed — so the
    -- combined original+reversal net effect is exactly zero per account,
    -- exactly mirroring reverse_ar_invoice()/reverse_ap_payment().
    FOR jl IN SELECT * FROM public.journal_lines WHERE entry_id = orig_entry.id ORDER BY created_at LOOP
      INSERT INTO public.journal_lines(entry_id, account_id, debit, credit, currency, fx_rate, debit_base, credit_base, memo)
      VALUES (_reversal_entry, jl.account_id, jl.credit, jl.debit, jl.currency, jl.fx_rate, jl.credit_base, jl.debit_base, 'Refund of '||COALESCE(jl.memo, 'reservation payment'));
    END LOOP;

    IF NOT EXISTS (SELECT 1 FROM public.journal_lines WHERE entry_id = _reversal_entry) THEN
      RAISE EXCEPTION 'Reversal journal entry ended up with no lines';
    END IF;

    SELECT COALESCE(SUM(debit_base),0), COALESCE(SUM(credit_base),0) INTO _dr, _cr
      FROM public.journal_lines WHERE entry_id = _reversal_entry;
    IF ROUND(_dr,2) <> ROUND(_cr,2) THEN
      RAISE EXCEPTION 'Reversal journal is not balanced (DR %, CR %)', _dr, _cr;
    END IF;
  END IF;
  -- _reversal_entry stays NULL when orig_entry was not found — an expected,
  -- non-error outcome today (see finding 3), not a failure.

  -- The reservation's own paid/outstanding figures are never stored (see
  -- finding 2) — nothing to update here. Original payment row is preserved
  -- permanently; only its status/reversal metadata change.
  UPDATE public.payments
    SET status = 'void', reversal_entry_id = _reversal_entry, reversal_reason = _trimmed_reason,
        reversed_by = auth.uid(), reversed_at = now()
    WHERE id = pay.id;

  INSERT INTO public.admin_action_logs(
    property_id, actor_id, entity_type, entity_id, action, before_snapshot, after_snapshot, memo
  ) VALUES (
    res.property_id, auth.uid(), 'reservation_payment', pay.id::text, 'update',
    jsonb_build_object('status', 'posted', 'reservationId', pay.reservation_id, 'method', pay.method, 'amount', pay.amount, 'receivedAt', pay.received_at),
    jsonb_build_object('status', 'void', 'reversalEntryId', _reversal_entry, 'reason', _trimmed_reason),
    'Reservation payment refunded: '||_trimmed_reason
  );

  RETURN _reversal_entry;
END; $$;

REVOKE EXECUTE ON FUNCTION public.reverse_reservation_payment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_reservation_payment(uuid, text) TO authenticated;
