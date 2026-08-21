-- AR Credit Notes / Receipts — PR B: posted credit-note and receipt
-- reversal.
--
-- Design decisions, made after auditing ar_credit_notes,
-- ar_receipts/ar_receipt_allocations, ar_invoices, ar_invoice_balances,
-- journal_entries/journal_lines, reverse_ar_invoice(), post_ar_credit_note(),
-- post_ar_receipt(), post_journal(), and ar-statement-calc.ts:
--
-- 1. Neither reversal deletes anything. A posted credit note/receipt, its
--    lines/allocations, and its original journal entry are all left exactly
--    as posted — reversal is represented entirely by (a) a NEW,
--    balance-swapped journal entry linked via the existing
--    journal_entries.is_reversal_of column (the same mechanism
--    reverse_ar_invoice() already uses — no new journal architecture), and
--    (b) new state on the credit note/receipt row itself.
--
-- 2. ar_credit_notes already has a THIRD status value, 'void', that no
--    existing code path ever sets — reserved, unused headroom from
--    20260819120000_ar_credit_notes_pr1.sql for exactly this feature.
--    Reused as-is (no ALTER TYPE needed) rather than inventing a new
--    'reversed' value, mirroring how reverse_ar_invoice() already reuses
--    ar_invoices' own 'void' for the identical concept.
--
-- 3. ar_receipts has no status column at all today (post_ar_receipt()
--    always creates a receipt already fully posted — there is no draft
--    receipt concept). A new ar_receipt_status ENUM ('posted', 'void') is
--    added, defaulting every existing row to 'posted' (true for 100% of
--    existing rows — no function anywhere ever set a receipt to any other
--    state), using the same 'void' terminology as ar_invoices/
--    ar_credit_notes for "this posted document has been reversed".
--
-- 4. Both tables gain reversal_entry_id/reversal_reason/reversed_by/
--    reversed_at columns. reverse_ar_invoice() itself does NOT store
--    reversal metadata as dedicated columns (it relies on
--    journal_entries.is_reversal_of + admin_action_logs alone) — this PR
--    deliberately goes one step further than that older precedent, because
--    this PR's own UI requirement ("reversed documents must be visually
--    distinct", with a reason) needs that metadata directly displayable
--    without an extra join to journal_entries/admin_action_logs on every
--    list render. This is additive-only and does not change how
--    reverse_ar_invoice() or any existing reversed invoice already works.
--
-- 5. Balance/status are RECOMPUTED from the invariant, never "restored"
--    from a stored prior value. A credit note or receipt can only ever be
--    reversed while its invoice is 'sent' or 'paid' (post_ar_credit_note()/
--    post_ar_receipt() only ever operate against a 'sent' invoice, and
--    reverse_ar_invoice() itself refuses to void an invoice that has any
--    posted credit note or receipt allocation — so an invoice reachable by
--    either new RPC below can never be 'draft' or 'void'). After removing
--    a credit note's or receipt's economic effect, status is recomputed as
--    net_balance <= 0 ? 'paid' : 'sent', the exact same rule
--    post_ar_credit_note()/post_ar_receipt() already use going forward —
--    not a separate "reopen" rule. This produces exactly the invariants
--    specified for PR B: reversing the 60 receipt against a 100/40-credited
--    invoice reopens it to 'sent' with balance 60; reversing the 40 credit
--    note afterward brings it to balance 100; reversing the credit note
--    first while the 60 receipt remains posted yields balance 40, still
--    'sent'.
--
-- 6. ar_receipt_allocations is never modified or deleted — per instruction,
--    and because it was never designed to carry its own status (unlike
--    ar_credit_notes, which already had one for its own lifecycle).
--    Immutable history + a status-aware parent row is used instead: each
--    affected invoice's amount_paid is decremented by exactly the
--    allocation amount originally added (post_ar_receipt() itself always
--    increments amount_paid by exactly that same allocation amount, so
--    subtracting it back out is an exact undo, leaving every other
--    receipt's contribution to that invoice untouched), and
--    ar_receipts.status = 'void' marks the parent so downstream readers
--    (customer statements — see part D below) know to exclude it.
--
-- 7. ar_invoice_balances and ar_aging need NO changes: both already
--    compute net_balance from ar_invoices.amount_paid and
--    ar_invoice_credited_total() (which already excludes non-'posted'
--    credit notes) — since both new RPCs update amount_paid/credited
--    state on the real ar_invoices row rather than a separate cache, both
--    views stay correct automatically.
--
-- 8. computeArCustomerStatement() DOES need a fix (part D): it currently
--    treats every ar_receipt_allocations row unconditionally as a credit,
--    with no concept of a voided receipt (none existed before this PR).
--    Left unfixed, a reversed receipt would still misstate a customer's
--    statement as if the payment were still in effect — the exact same
--    class of gap PR1's own header note 10 found and fixed for credit
--    notes in that same PR rather than deferring it. Fixed here, in this
--    PR, for the same reason.
--
-- 9. Role gating for both reversal RPCs is
--    ['super_admin','hotel_owner','general_manager','accountant'] — the
--    same set reverse_ar_invoice() already uses, deliberately NOT
--    including front_desk even though post_ar_receipt() itself does.
--    Receiving a guest's payment is a routine front-desk action; reversing
--    a posted financial transaction is a correction action and is held to
--    the same, stricter accounting-admin bar every other reversal/void
--    action in this module already uses.
--
-- 10. Both RPC signatures are (_id UUID, _reason TEXT) — identical shape to
--    reverse_ar_invoice(_id UUID, _reason TEXT) — no _property_id
--    parameter. The row lock taken first, then has_any_role() checked
--    against that locked row's own property_id, is what actually enforces
--    property scope; a client-supplied _property_id would only ever be
--    something to double-check against, never a substitute for it, so it
--    is omitted entirely, matching the existing precedent exactly.

-- ============================================================
-- PART A — ar_credit_notes: reuse 'void', add reversal metadata
-- ============================================================

ALTER TABLE public.ar_credit_notes
  ADD COLUMN IF NOT EXISTS reversal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT,
  ADD COLUMN IF NOT EXISTS reversed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;

-- ============================================================
-- PART B — ar_receipts: add status + reversal metadata
-- ============================================================

CREATE TYPE public.ar_receipt_status AS ENUM ('posted', 'void');

-- Every existing row is genuinely 'posted' today — post_ar_receipt() is
-- the only function that has ever written this table, and it always
-- completes the journal posting before the row is visible (no draft
-- receipt concept exists), so this default backfills every historical
-- row correctly.
ALTER TABLE public.ar_receipts
  ADD COLUMN IF NOT EXISTS status public.ar_receipt_status NOT NULL DEFAULT 'posted',
  ADD COLUMN IF NOT EXISTS reversal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT,
  ADD COLUMN IF NOT EXISTS reversed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ar_receipts_property_status ON public.ar_receipts(property_id, status);

-- ============================================================
-- PART C — reverse_ar_credit_note()
-- ============================================================
CREATE OR REPLACE FUNCTION public.reverse_ar_credit_note(_id UUID, _reason TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cn RECORD; inv RECORD; jl RECORD; orig_entry RECORD;
  _reversal_entry UUID; _existing_reversal UUID;
  _period_id UUID; _trimmed_reason TEXT;
  _dr NUMERIC; _cr NUMERIC;
  _credited_total NUMERIC; _net_balance NUMERIC; _new_status ar_status;
BEGIN
  _trimmed_reason := btrim(COALESCE(_reason, ''));
  IF char_length(_trimmed_reason) < 5 THEN
    RAISE EXCEPTION 'A reversal reason of at least 5 characters is required';
  END IF;
  IF char_length(_trimmed_reason) > 500 THEN
    RAISE EXCEPTION 'Reversal reason must be 500 characters or fewer';
  END IF;

  -- Primary defense against a concurrent double reversal of the SAME
  -- credit note.
  SELECT * INTO cn FROM public.ar_credit_notes WHERE id = _id FOR UPDATE;
  IF cn IS NULL THEN RAISE EXCEPTION 'Credit note not found'; END IF;

  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], cn.property_id) THEN
    RAISE EXCEPTION 'Not permitted to reverse an AR credit note';
  END IF;

  IF cn.status = 'draft' THEN
    RAISE EXCEPTION 'Credit note % is still a draft and has nothing to reverse', cn.code;
  END IF;
  IF cn.status = 'void' THEN
    RAISE EXCEPTION 'Credit note % has already been reversed', cn.code;
  END IF;
  IF cn.status <> 'posted' THEN
    RAISE EXCEPTION 'Credit note % is not in a reversible state (status: %)', cn.code, cn.status;
  END IF;
  IF cn.posted_entry_id IS NULL THEN
    RAISE EXCEPTION 'Credit note % has no posted journal entry to reverse', cn.code;
  END IF;

  -- Secondary lock: the invoice row, for balance/status recompute safety
  -- against other concurrent postings/reversals on the same invoice —
  -- same lock post_ar_credit_note()/post_ar_receipt() already take.
  SELECT * INTO inv FROM public.ar_invoices WHERE id = cn.invoice_id FOR UPDATE;
  IF inv IS NULL THEN RAISE EXCEPTION 'Linked invoice not found'; END IF;

  SELECT id INTO _period_id FROM public.accounting_periods
    WHERE property_id = cn.property_id AND CURRENT_DATE BETWEEN start_date AND end_date AND status IN ('locked','closed')
    LIMIT 1;
  IF _period_id IS NOT NULL THEN RAISE EXCEPTION 'Current accounting period is locked'; END IF;

  SELECT id INTO _existing_reversal FROM public.journal_entries WHERE is_reversal_of = cn.posted_entry_id;
  IF _existing_reversal IS NOT NULL THEN
    RAISE EXCEPTION 'Credit note % already has a reversal journal entry', cn.code;
  END IF;

  SELECT * INTO orig_entry FROM public.journal_entries WHERE id = cn.posted_entry_id;
  IF orig_entry IS NULL THEN
    RAISE EXCEPTION 'Original journal entry for credit note % was not found', cn.code;
  END IF;

  INSERT INTO public.journal_entries(property_id, entry_date, memo, source, source_ref, currency, posted_by, is_reversal_of)
  VALUES (cn.property_id, CURRENT_DATE, 'Reversal of AR Credit Note '||cn.code||' — '||_trimmed_reason, 'ar', cn.id::text, orig_entry.currency, auth.uid(), cn.posted_entry_id)
  RETURNING id INTO _reversal_entry;

  FOR jl IN SELECT * FROM public.journal_lines WHERE entry_id = cn.posted_entry_id ORDER BY created_at LOOP
    INSERT INTO public.journal_lines(entry_id, account_id, debit, credit, currency, fx_rate, debit_base, credit_base, memo)
    VALUES (_reversal_entry, jl.account_id, jl.credit, jl.debit, jl.currency, jl.fx_rate, jl.credit_base, jl.debit_base, 'Reversal of '||COALESCE(jl.memo, cn.code));
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM public.journal_lines WHERE entry_id = _reversal_entry) THEN
    RAISE EXCEPTION 'Original journal entry for credit note % has no lines', cn.code;
  END IF;

  SELECT COALESCE(SUM(debit_base),0), COALESCE(SUM(credit_base),0) INTO _dr, _cr
    FROM public.journal_lines WHERE entry_id = _reversal_entry;
  IF ROUND(_dr,2) <> ROUND(_cr,2) THEN
    RAISE EXCEPTION 'Reversal journal is not balanced (DR %, CR %)', _dr, _cr;
  END IF;

  UPDATE public.ar_credit_notes
    SET status = 'void', reversal_entry_id = _reversal_entry, reversal_reason = _trimmed_reason,
        reversed_by = auth.uid(), reversed_at = now()
    WHERE id = cn.id;

  -- Recomputed fresh, not "restored": ar_invoice_credited_total() now
  -- excludes this note (status is no longer 'posted' as of the UPDATE
  -- above, visible within this same transaction).
  _credited_total := public.ar_invoice_credited_total(inv.id);
  _net_balance := inv.total - inv.amount_paid - _credited_total;
  _new_status := CASE WHEN _net_balance <= 0 THEN 'paid'::ar_status ELSE 'sent'::ar_status END;
  UPDATE public.ar_invoices SET status = _new_status WHERE id = inv.id;

  INSERT INTO public.admin_action_logs(
    property_id, actor_id, entity_type, entity_id, action, before_snapshot, after_snapshot, memo
  ) VALUES (
    cn.property_id, auth.uid(), 'ar_credit_note', cn.id::text, 'update',
    jsonb_build_object('status', 'posted', 'code', cn.code, 'invoiceId', cn.invoice_id, 'postedEntryId', cn.posted_entry_id),
    jsonb_build_object('status', 'void', 'code', cn.code, 'invoiceId', cn.invoice_id, 'reversalEntryId', _reversal_entry, 'reason', _trimmed_reason),
    'AR credit note '||cn.code||' reversed: '||_trimmed_reason
  );

  RETURN _reversal_entry;
END; $$;

REVOKE EXECUTE ON FUNCTION public.reverse_ar_credit_note(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_ar_credit_note(uuid, text) TO authenticated;

-- ============================================================
-- PART D — reverse_ar_receipt()
-- ============================================================
CREATE OR REPLACE FUNCTION public.reverse_ar_receipt(_id UUID, _reason TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  rec RECORD; alloc RECORD; inv RECORD; jl RECORD; orig_entry RECORD;
  _reversal_entry UUID; _existing_reversal UUID;
  _period_id UUID; _trimmed_reason TEXT;
  _dr NUMERIC; _cr NUMERIC;
  _new_paid NUMERIC; _credited_total NUMERIC; _net_balance NUMERIC; _new_status ar_status;
BEGIN
  _trimmed_reason := btrim(COALESCE(_reason, ''));
  IF char_length(_trimmed_reason) < 5 THEN
    RAISE EXCEPTION 'A reversal reason of at least 5 characters is required';
  END IF;
  IF char_length(_trimmed_reason) > 500 THEN
    RAISE EXCEPTION 'Reversal reason must be 500 characters or fewer';
  END IF;

  -- Primary defense against a concurrent double reversal of the SAME
  -- receipt.
  SELECT * INTO rec FROM public.ar_receipts WHERE id = _id FOR UPDATE;
  IF rec IS NULL THEN RAISE EXCEPTION 'Receipt not found'; END IF;

  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], rec.property_id) THEN
    RAISE EXCEPTION 'Not permitted to reverse an AR receipt';
  END IF;

  IF rec.status = 'void' THEN
    RAISE EXCEPTION 'Receipt % has already been reversed', rec.code;
  END IF;
  IF rec.status <> 'posted' THEN
    RAISE EXCEPTION 'Receipt % is not in a reversible state (status: %)', rec.code, rec.status;
  END IF;
  IF rec.posted_entry_id IS NULL THEN
    RAISE EXCEPTION 'Receipt % has no posted journal entry to reverse', rec.code;
  END IF;

  SELECT id INTO _period_id FROM public.accounting_periods
    WHERE property_id = rec.property_id AND CURRENT_DATE BETWEEN start_date AND end_date AND status IN ('locked','closed')
    LIMIT 1;
  IF _period_id IS NOT NULL THEN RAISE EXCEPTION 'Current accounting period is locked'; END IF;

  SELECT id INTO _existing_reversal FROM public.journal_entries WHERE is_reversal_of = rec.posted_entry_id;
  IF _existing_reversal IS NOT NULL THEN
    RAISE EXCEPTION 'Receipt % already has a reversal journal entry', rec.code;
  END IF;

  SELECT * INTO orig_entry FROM public.journal_entries WHERE id = rec.posted_entry_id;
  IF orig_entry IS NULL THEN
    RAISE EXCEPTION 'Original journal entry for receipt % was not found', rec.code;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.ar_receipt_allocations WHERE receipt_id = rec.id) THEN
    RAISE EXCEPTION 'Receipt % has no allocations to reverse', rec.code;
  END IF;

  INSERT INTO public.journal_entries(property_id, entry_date, memo, source, source_ref, currency, posted_by, is_reversal_of)
  VALUES (rec.property_id, CURRENT_DATE, 'Reversal of AR Receipt '||rec.code||' — '||_trimmed_reason, 'ar', rec.id::text, orig_entry.currency, auth.uid(), rec.posted_entry_id)
  RETURNING id INTO _reversal_entry;

  FOR jl IN SELECT * FROM public.journal_lines WHERE entry_id = rec.posted_entry_id ORDER BY created_at LOOP
    INSERT INTO public.journal_lines(entry_id, account_id, debit, credit, currency, fx_rate, debit_base, credit_base, memo)
    VALUES (_reversal_entry, jl.account_id, jl.credit, jl.debit, jl.currency, jl.fx_rate, jl.credit_base, jl.debit_base, 'Reversal of '||COALESCE(jl.memo, rec.code));
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM public.journal_lines WHERE entry_id = _reversal_entry) THEN
    RAISE EXCEPTION 'Original journal entry for receipt % has no lines', rec.code;
  END IF;

  SELECT COALESCE(SUM(debit_base),0), COALESCE(SUM(credit_base),0) INTO _dr, _cr
    FROM public.journal_lines WHERE entry_id = _reversal_entry;
  IF ROUND(_dr,2) <> ROUND(_cr,2) THEN
    RAISE EXCEPTION 'Reversal journal is not balanced (DR %, CR %)', _dr, _cr;
  END IF;

  -- Undo this receipt's exact contribution to each allocated invoice —
  -- never a recompute-from-scratch sum, so every OTHER receipt/credit
  -- note's own contribution to the same invoice is left untouched.
  -- Status is recomputed from the invariant (net_balance <= 0 ? 'paid' :
  -- 'sent'), never "restored" from a stored prior value — see header
  -- note 5 for why this is always safe here. Processed in a deterministic
  -- order (by invoice_id), exactly mirroring post_ar_receipt()'s own
  -- pass-2 lock ordering, so a concurrent post_ar_receipt()/
  -- post_ar_credit_note()/reverse_ar_credit_note() touching an
  -- overlapping invoice serializes safely instead of deadlocking.
  FOR alloc IN
    SELECT * FROM public.ar_receipt_allocations WHERE receipt_id = rec.id ORDER BY invoice_id
  LOOP
    SELECT * INTO inv FROM public.ar_invoices WHERE id = alloc.invoice_id FOR UPDATE;
    _new_paid := inv.amount_paid - alloc.amount;
    IF _new_paid < 0 THEN
      -- Structurally unreachable (post_ar_receipt() only ever increments
      -- amount_paid by exactly this same allocation amount), but guarded
      -- explicitly rather than surfacing a raw CHECK-constraint violation.
      RAISE EXCEPTION 'Reversing receipt % would drive invoice % amount_paid negative', rec.code, inv.code;
    END IF;
    _credited_total := public.ar_invoice_credited_total(inv.id);
    _net_balance := inv.total - _new_paid - _credited_total;
    _new_status := CASE WHEN _net_balance <= 0 THEN 'paid'::ar_status ELSE 'sent'::ar_status END;
    UPDATE public.ar_invoices SET amount_paid = _new_paid, status = _new_status WHERE id = inv.id;
  END LOOP;

  UPDATE public.ar_receipts
    SET status = 'void', reversal_entry_id = _reversal_entry, reversal_reason = _trimmed_reason,
        reversed_by = auth.uid(), reversed_at = now()
    WHERE id = rec.id;

  INSERT INTO public.admin_action_logs(
    property_id, actor_id, entity_type, entity_id, action, before_snapshot, after_snapshot, memo
  ) VALUES (
    rec.property_id, auth.uid(), 'ar_receipt', rec.id::text, 'update',
    jsonb_build_object('status', 'posted', 'code', rec.code, 'postedEntryId', rec.posted_entry_id, 'amount', rec.amount),
    jsonb_build_object('status', 'void', 'code', rec.code, 'reversalEntryId', _reversal_entry, 'reason', _trimmed_reason),
    'AR receipt '||rec.code||' reversed: '||_trimmed_reason
  );

  RETURN _reversal_entry;
END; $$;

REVOKE EXECUTE ON FUNCTION public.reverse_ar_receipt(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_ar_receipt(uuid, text) TO authenticated;
