-- AP posting/reversal hardening.
--
-- Architecture decisions, made after fully tracing ap_bills, ap_bill_lines,
-- ap_payments, post_ap_bill(), post_ap_payment(), journal_entries/lines,
-- accounting_periods, admin_action_logs, and the proven AR reversal design
-- (20260818090000, 20260819120000, 20260821120000) — the AR pattern is used
-- as a guide, not copied blindly: AP's own invariants differ in two
-- material ways documented below.
--
-- 1. AP PAYMENTS DO NOT ALLOCATE ACROSS MULTIPLE BILLS. Unlike
--    ar_receipts/ar_receipt_allocations, ap_payments.bill_id is a direct,
--    single FK — there is no ap_payment_allocations table and never has
--    been. Every payment belongs to exactly one bill. This makes payment
--    reversal structurally simpler than AR receipt reversal: one row lock
--    on the bill, not a loop over N allocations in deterministic order.
--
-- 2. THERE IS NO AP CREDIT-NOTE EQUIVALENT. AR's invariant ("an invoice
--    reachable by reverse_ar_invoice can never have posted credit notes,
--    because reverse_ar_invoice's own guard forbids it") has no AP analogue
--    to worry about — the only thing that can stand between a posted bill
--    and reversibility is a posted payment. reverse_ap_bill() therefore
--    only ever needs to check amount_paid / the existence of a payment row,
--    nothing else.
--
-- 3. A bill with ANY posted payment against it cannot be reversed directly
--    — mirrors reverse_ar_invoice()'s own "has payments -> refuse" rule
--    exactly (20260818090000's header note: "receipt reversal is a
--    separate, unbuilt capability" — now built, for both AR and AP, via
--    dedicated payment-reversal RPCs). To undo a paid bill: reverse its
--    payment(s) first (bringing amount_paid back to 0), then reverse the
--    bill. Same combined-reversal ordering AR already established.
--
-- 4. NEW FINDING, fixed here as directly in-scope hardening (not scope
--    creep): post_ap_bill() has never taken a row lock on the bill before
--    checking/setting posted_entry_id. Two concurrent posts of the same
--    still-draft bill could both read posted_entry_id IS NULL before
--    either commits, both proceed, and double-post the same bill (two
--    journal entries, ap_bills row updated twice). This is exactly the
--    class of bug the rest of this migration is about preventing, on the
--    very entity this migration adds reversal to — redeclared here with a
--    FOR UPDATE lock added, everything else copied verbatim.
--
-- 5. Reversal metadata (reversal_entry_id/reversal_reason/reversed_by/
--    reversed_at) is added directly to ap_bills and ap_payments, exactly
--    mirroring ar_credit_notes/ar_receipts — additive only, no change to
--    how any existing reversed-nothing-yet row behaves.
--
-- 6. ap_bills.status already reserves an unused 'void' value
--    (CREATE TYPE ap_status AS ENUM ('draft','open','paid','void') —
--    20260705040642), exactly like ar_credit_notes'/ar_invoices' own
--    'void' before their reversal work — reused as-is. ap_payments has no
--    status column at all today (post_ap_payment() always fully posts on
--    insert, same as ar_receipts before its own reversal work), so a new
--    ap_payment_status ENUM ('posted','void') is added, defaulting every
--    existing row to 'posted' — true for 100% of existing rows, since
--    post_ap_payment() is the only function that has ever written this
--    table and (post-20260807120000 hardening) every insert either fully
--    posts or the whole transaction rolls back via the AFTER INSERT
--    trigger — there is no partially-posted payment row possible.
--
-- 7. Role gating for every new/hardened function here is exactly
--    ['super_admin','hotel_owner','general_manager','accountant'] — the
--    SAME set every existing AP policy/function already uses without
--    exception (ap_bills_write, ap_payments_write, post_ap_bill,
--    post_ap_payment, assign_ap_bill_supplier). Unlike AR, AP has never
--    included front_desk anywhere, so there is no "broader creation set
--    vs. narrower reversal set" distinction to make here — one set, used
--    consistently, same as it always has been.
--
-- 8. create_ap_bill() replaces the two-step, non-transactional client
--    insert (accounting.ap.tsx: raw insert into ap_bills, then raw insert
--    into ap_bill_lines — a failure between the two could leave a bill
--    with zero lines) with one atomic RPC, mirroring create_ar_invoice()'s
--    shape. Direct INSERT/UPDATE/DELETE grants on ap_bills/ap_bill_lines
--    are revoked from authenticated (SELECT preserved) — confirmed by
--    grepping the whole application that accounting.ap.tsx's bill-creation
--    dialog is the ONLY code path that ever wrote to either table directly
--    (post_ap_bill, post_ap_payment, assign_ap_bill_supplier are all
--    already SECURITY DEFINER and unaffected by this). This makes "no
--    partially-created bill possible" a structural guarantee, not an app
--    convention — matching ar_receipts' own "no direct client writes"
--    model, one step stricter than ar_invoices'/ap_bills' original
--    (pre-this-migration) grant-everything-to-authenticated posture.

-- ============================================================
-- PART A — post_ap_bill(): add the missing row lock (redeclared,
-- everything else copied verbatim from 20260705040642)
-- ============================================================
CREATE OR REPLACE FUNCTION public.post_ap_bill(_id UUID) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  b RECORD; ln RECORD; _lines JSONB := '[]'::jsonb;
  _sub NUMERIC := 0; _tax NUMERIC := 0; _total NUMERIC := 0;
  _ap UUID; _tax_acc UUID; _exp UUID; _entry UUID;
BEGIN
  -- Row lock: the primary defense against a concurrent double-post of the
  -- same bill (this was previously missing — see this migration's header
  -- note 4). The loser blocks here until the winner commits, then re-reads
  -- posted_entry_id IS NOT NULL and returns the existing entry instead of
  -- posting a second time.
  SELECT * INTO b FROM public.ap_bills WHERE id=_id FOR UPDATE;
  IF b IS NULL THEN RAISE EXCEPTION 'Bill not found'; END IF;
  IF b.posted_entry_id IS NOT NULL THEN RETURN b.posted_entry_id; END IF;
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], b.property_id) THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  _ap := public.resolve_account(b.property_id,'ap_liability','ap');
  _tax_acc := public.resolve_account(b.property_id,'ap_tax','tax_payable');
  FOR ln IN SELECT * FROM public.ap_bill_lines WHERE bill_id=_id LOOP
    _sub := _sub + (ln.quantity * ln.unit_price);
    _tax := _tax + ROUND((ln.quantity * ln.unit_price) * ln.tax_rate / 100, 4);
    _exp := COALESCE(ln.expense_account_id, public.resolve_account(b.property_id,'ap_expense','opex'));
    _lines := _lines || jsonb_build_array(jsonb_build_object('account_id',_exp,'debit',ln.quantity*ln.unit_price,'credit',0,'memo',ln.description));
  END LOOP;
  _total := _sub + _tax;
  IF _tax > 0 THEN
    _lines := _lines || jsonb_build_array(jsonb_build_object('account_id',_tax_acc,'debit',_tax,'credit',0,'memo','Tax on '||b.code));
  END IF;
  _lines := _lines || jsonb_build_array(jsonb_build_object('account_id',_ap,'debit',0,'credit',_total,'memo','AP '||b.code));
  _entry := public.post_journal(b.property_id, b.bill_date, b.currency, 'AP Bill '||b.code, 'ap', b.id::text, _lines);
  UPDATE public.ap_bills SET subtotal=_sub, tax=_tax, total=_total, status='open', posted_entry_id=_entry WHERE id=_id;
  RETURN _entry;
END; $$;

-- ============================================================
-- PART B — ap_bills: reversal metadata (reuses existing 'void' status)
-- ============================================================
ALTER TABLE public.ap_bills
  ADD COLUMN IF NOT EXISTS reversal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT,
  ADD COLUMN IF NOT EXISTS reversed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;

-- ============================================================
-- PART C — ap_payments: status + reversal metadata
-- ============================================================
CREATE TYPE public.ap_payment_status AS ENUM ('posted', 'void');

-- Every existing row is genuinely 'posted' today — see header note 6.
ALTER TABLE public.ap_payments
  ADD COLUMN IF NOT EXISTS status public.ap_payment_status NOT NULL DEFAULT 'posted',
  ADD COLUMN IF NOT EXISTS reversal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT,
  ADD COLUMN IF NOT EXISTS reversed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ap_payments_property_status ON public.ap_payments(property_id, status);
CREATE INDEX IF NOT EXISTS ap_bills_property_status_void ON public.ap_bills(property_id, status);

-- ============================================================
-- PART D — create_ap_bill(): atomic draft creation
-- ============================================================
-- _lines shape: [{"description": "...", "quantity": <number>, "unit_price": <number>, "tax_rate": <number>}, ...]
-- Draft only — mirrors create_ar_invoice()/create_ar_credit_note(): no
-- journal, no posting side effect. subtotal/tax/total are computed
-- server-side as a preview (never trusted from the client) but are NOT
-- authoritative — post_ap_bill() recomputes them fresh from the lines at
-- posting time regardless, exactly as it already did before this
-- migration; this function does not change that.
CREATE OR REPLACE FUNCTION public.create_ap_bill(
  _property_id UUID,
  _supplier_id UUID,
  _supplier_name TEXT,
  _reference TEXT,
  _bill_date DATE,
  _due_date DATE,
  _currency TEXT,
  _notes TEXT,
  _lines JSONB
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _supplier RECORD;
  _bill_id UUID;
  _line JSONB;
  _quantity NUMERIC;
  _unit_price NUMERIC;
  _tax_rate NUMERIC;
  _description TEXT;
  _sub NUMERIC := 0;
  _tax NUMERIC := 0;
  _trimmed_supplier_name TEXT;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id) THEN
    RAISE EXCEPTION 'Not permitted to create AP bills';
  END IF;

  _trimmed_supplier_name := btrim(COALESCE(_supplier_name, ''));
  IF _trimmed_supplier_name = '' THEN
    RAISE EXCEPTION 'Supplier name is required';
  END IF;

  -- If a supplier_id is given, it must genuinely belong to this property —
  -- never trust a client-supplied id at face value. Activity status is not
  -- checked here, matching the existing UI's own picker (which does not
  -- filter by active) — this function preserves existing behavior, not a
  -- new restriction.
  IF _supplier_id IS NOT NULL THEN
    SELECT * INTO _supplier FROM public.suppliers WHERE id = _supplier_id AND property_id = _property_id;
    IF _supplier.id IS NULL THEN
      RAISE EXCEPTION 'Supplier not found for this property';
    END IF;
  END IF;

  IF _currency IS NULL OR btrim(_currency) = '' THEN
    RAISE EXCEPTION 'Currency is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.currencies WHERE code = _currency) THEN
    RAISE EXCEPTION 'Currency % is not a recognized currency code', _currency;
  END IF;

  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'At least one bill line is required';
  END IF;

  INSERT INTO public.ap_bills(
    property_id, supplier_id, supplier_name, reference, bill_date, due_date, currency, notes, status, created_by
  ) VALUES (
    _property_id, _supplier_id, _trimmed_supplier_name, NULLIF(btrim(COALESCE(_reference, '')), ''),
    COALESCE(_bill_date, CURRENT_DATE), COALESCE(_due_date, CURRENT_DATE + INTERVAL '30 days'),
    _currency, NULLIF(btrim(COALESCE(_notes, '')), ''), 'draft', auth.uid()
  ) RETURNING id INTO _bill_id;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    _description := btrim(COALESCE(_line->>'description', ''));
    IF _description = '' THEN
      RAISE EXCEPTION 'Every bill line requires a description';
    END IF;

    _quantity := (_line->>'quantity')::NUMERIC;
    IF _quantity IS NULL OR _quantity <= 0 THEN
      RAISE EXCEPTION 'Bill line quantity must be greater than zero';
    END IF;

    _unit_price := (_line->>'unit_price')::NUMERIC;
    IF _unit_price IS NULL OR _unit_price < 0 THEN
      RAISE EXCEPTION 'Bill line unit price must not be negative';
    END IF;

    _tax_rate := COALESCE((_line->>'tax_rate')::NUMERIC, 0);
    IF _tax_rate < 0 OR _tax_rate > 100 THEN
      RAISE EXCEPTION 'Bill line tax rate must be between 0 and 100';
    END IF;

    INSERT INTO public.ap_bill_lines(bill_id, description, quantity, unit_price, tax_rate)
    VALUES (_bill_id, _description, _quantity, _unit_price, _tax_rate);

    _sub := _sub + ROUND(_quantity * _unit_price, 4);
    _tax := _tax + ROUND(ROUND(_quantity * _unit_price, 4) * _tax_rate / 100, 4);
  END LOOP;

  -- Preview totals only — see this function's own header comment.
  UPDATE public.ap_bills SET subtotal = _sub, tax = _tax, total = _sub + _tax WHERE id = _bill_id;

  RETURN _bill_id;
END; $$;

REVOKE EXECUTE ON FUNCTION public.create_ap_bill(uuid, uuid, text, text, date, date, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_ap_bill(uuid, uuid, text, text, date, date, text, text, jsonb) TO authenticated;

-- No more direct client writes to ap_bills/ap_bill_lines — every write now
-- routes through create_ap_bill() (draft), post_ap_bill() (post),
-- assign_ap_bill_supplier() (historical mapping), or reverse_ap_bill()
-- (below), all SECURITY DEFINER. SELECT is preserved for the existing
-- list/aging/statement queries, none of which write.
REVOKE INSERT, UPDATE, DELETE ON public.ap_bills FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.ap_bill_lines FROM authenticated;

-- ============================================================
-- PART E — reverse_ap_bill()
-- ============================================================
CREATE OR REPLACE FUNCTION public.reverse_ap_bill(_id UUID, _reason TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  bl RECORD; jl RECORD; orig_entry RECORD;
  _reversal_entry UUID; _existing_reversal UUID;
  _period_id UUID; _trimmed_reason TEXT;
  _dr NUMERIC; _cr NUMERIC;
  _payment_count INT;
BEGIN
  _trimmed_reason := btrim(COALESCE(_reason, ''));
  IF char_length(_trimmed_reason) < 5 THEN
    RAISE EXCEPTION 'A reversal reason of at least 5 characters is required';
  END IF;
  IF char_length(_trimmed_reason) > 500 THEN
    RAISE EXCEPTION 'Reversal reason must be 500 characters or fewer';
  END IF;

  -- Primary defense against a concurrent double reversal of the SAME bill.
  SELECT * INTO bl FROM public.ap_bills WHERE id = _id FOR UPDATE;
  IF bl IS NULL THEN RAISE EXCEPTION 'Bill not found'; END IF;

  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], bl.property_id) THEN
    RAISE EXCEPTION 'Not permitted to reverse an AP bill';
  END IF;

  IF bl.status = 'draft' THEN
    RAISE EXCEPTION 'Bill % is still a draft and has nothing to reverse', bl.code;
  END IF;
  IF bl.status = 'void' THEN
    RAISE EXCEPTION 'Bill % has already been reversed', bl.code;
  END IF;
  IF bl.status <> 'open' THEN
    RAISE EXCEPTION 'Bill % is not in a reversible state (status: %)', bl.code, bl.status;
  END IF;
  IF bl.posted_entry_id IS NULL THEN
    RAISE EXCEPTION 'Bill % has no posted journal entry to reverse', bl.code;
  END IF;

  -- A bill with any posted payment cannot be reversed directly — see this
  -- migration's header note 3. amount_paid <> 0 and "any ap_payments row
  -- exists" are equivalent in practice (payments always have amount > 0
  -- per ap_payments_amount_positive), but both are checked explicitly —
  -- same defensive-redundancy posture reverse_ar_invoice() already uses
  -- for its own amount_paid / ar_receipt_allocations pair of guards.
  IF bl.amount_paid <> 0 THEN
    RAISE EXCEPTION 'Bill % has payments applied and cannot be reversed directly — reverse the payment(s) first', bl.code;
  END IF;
  SELECT count(*) INTO _payment_count FROM public.ap_payments WHERE bill_id = bl.id AND status = 'posted';
  IF _payment_count > 0 THEN
    RAISE EXCEPTION 'Bill % has posted payments and cannot be reversed directly — reverse the payment(s) first', bl.code;
  END IF;

  SELECT id INTO _period_id FROM public.accounting_periods
    WHERE property_id = bl.property_id AND CURRENT_DATE BETWEEN start_date AND end_date AND status IN ('locked','closed')
    LIMIT 1;
  IF _period_id IS NOT NULL THEN RAISE EXCEPTION 'Current accounting period is locked'; END IF;

  SELECT id INTO _existing_reversal FROM public.journal_entries WHERE is_reversal_of = bl.posted_entry_id;
  IF _existing_reversal IS NOT NULL THEN
    RAISE EXCEPTION 'Bill % already has a reversal journal entry', bl.code;
  END IF;

  SELECT * INTO orig_entry FROM public.journal_entries WHERE id = bl.posted_entry_id;
  IF orig_entry IS NULL THEN
    RAISE EXCEPTION 'Original journal entry for bill % was not found', bl.code;
  END IF;

  INSERT INTO public.journal_entries(property_id, entry_date, memo, source, source_ref, currency, posted_by, is_reversal_of)
  VALUES (bl.property_id, CURRENT_DATE, 'Reversal of AP Bill '||bl.code||' — '||_trimmed_reason, 'ap', bl.id::text, orig_entry.currency, auth.uid(), bl.posted_entry_id)
  RETURNING id INTO _reversal_entry;

  FOR jl IN SELECT * FROM public.journal_lines WHERE entry_id = bl.posted_entry_id ORDER BY created_at LOOP
    INSERT INTO public.journal_lines(entry_id, account_id, debit, credit, currency, fx_rate, debit_base, credit_base, memo)
    VALUES (_reversal_entry, jl.account_id, jl.credit, jl.debit, jl.currency, jl.fx_rate, jl.credit_base, jl.debit_base, 'Reversal of '||COALESCE(jl.memo, bl.code));
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM public.journal_lines WHERE entry_id = _reversal_entry) THEN
    RAISE EXCEPTION 'Original journal entry for bill % has no lines', bl.code;
  END IF;

  SELECT COALESCE(SUM(debit_base),0), COALESCE(SUM(credit_base),0) INTO _dr, _cr
    FROM public.journal_lines WHERE entry_id = _reversal_entry;
  IF ROUND(_dr,2) <> ROUND(_cr,2) THEN
    RAISE EXCEPTION 'Reversal journal is not balanced (DR %, CR %)', _dr, _cr;
  END IF;

  UPDATE public.ap_bills
    SET status = 'void', reversal_entry_id = _reversal_entry, reversal_reason = _trimmed_reason,
        reversed_by = auth.uid(), reversed_at = now()
    WHERE id = bl.id;

  INSERT INTO public.admin_action_logs(
    property_id, actor_id, entity_type, entity_id, action, before_snapshot, after_snapshot, memo
  ) VALUES (
    bl.property_id, auth.uid(), 'ap_bill', bl.id::text, 'update',
    jsonb_build_object('status', 'open', 'code', bl.code, 'supplierName', bl.supplier_name, 'postedEntryId', bl.posted_entry_id),
    jsonb_build_object('status', 'void', 'code', bl.code, 'reversalEntryId', _reversal_entry, 'reason', _trimmed_reason),
    'AP bill '||bl.code||' reversed: '||_trimmed_reason
  );

  RETURN _reversal_entry;
END; $$;

REVOKE EXECUTE ON FUNCTION public.reverse_ap_bill(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_ap_bill(uuid, text) TO authenticated;

-- ============================================================
-- PART F — reverse_ap_payment()
-- ============================================================
CREATE OR REPLACE FUNCTION public.reverse_ap_payment(_id UUID, _reason TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  pay RECORD; bl RECORD; jl RECORD; orig_entry RECORD;
  _reversal_entry UUID; _existing_reversal UUID;
  _period_id UUID; _trimmed_reason TEXT;
  _dr NUMERIC; _cr NUMERIC;
  _new_paid NUMERIC; _new_status ap_status;
BEGIN
  _trimmed_reason := btrim(COALESCE(_reason, ''));
  IF char_length(_trimmed_reason) < 5 THEN
    RAISE EXCEPTION 'A reversal reason of at least 5 characters is required';
  END IF;
  IF char_length(_trimmed_reason) > 500 THEN
    RAISE EXCEPTION 'Reversal reason must be 500 characters or fewer';
  END IF;

  -- Primary defense against a concurrent double reversal of the SAME
  -- payment.
  SELECT * INTO pay FROM public.ap_payments WHERE id = _id FOR UPDATE;
  IF pay IS NULL THEN RAISE EXCEPTION 'Payment not found'; END IF;

  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], pay.property_id) THEN
    RAISE EXCEPTION 'Not permitted to reverse an AP payment';
  END IF;

  IF pay.status = 'void' THEN
    RAISE EXCEPTION 'Payment % has already been reversed', pay.id;
  END IF;
  IF pay.status <> 'posted' THEN
    RAISE EXCEPTION 'Payment is not in a reversible state (status: %)', pay.status;
  END IF;
  IF pay.posted_entry_id IS NULL THEN
    RAISE EXCEPTION 'Payment has no posted journal entry to reverse';
  END IF;

  SELECT id INTO _period_id FROM public.accounting_periods
    WHERE property_id = pay.property_id AND CURRENT_DATE BETWEEN start_date AND end_date AND status IN ('locked','closed')
    LIMIT 1;
  IF _period_id IS NOT NULL THEN RAISE EXCEPTION 'Current accounting period is locked'; END IF;

  SELECT id INTO _existing_reversal FROM public.journal_entries WHERE is_reversal_of = pay.posted_entry_id;
  IF _existing_reversal IS NOT NULL THEN
    RAISE EXCEPTION 'Payment already has a reversal journal entry';
  END IF;

  SELECT * INTO orig_entry FROM public.journal_entries WHERE id = pay.posted_entry_id;
  IF orig_entry IS NULL THEN
    RAISE EXCEPTION 'Original journal entry for this payment was not found';
  END IF;

  INSERT INTO public.journal_entries(property_id, entry_date, memo, source, source_ref, currency, posted_by, is_reversal_of)
  VALUES (pay.property_id, CURRENT_DATE, 'Reversal of AP Payment — '||_trimmed_reason, 'ap', pay.id::text, orig_entry.currency, auth.uid(), pay.posted_entry_id)
  RETURNING id INTO _reversal_entry;

  FOR jl IN SELECT * FROM public.journal_lines WHERE entry_id = pay.posted_entry_id ORDER BY created_at LOOP
    INSERT INTO public.journal_lines(entry_id, account_id, debit, credit, currency, fx_rate, debit_base, credit_base, memo)
    VALUES (_reversal_entry, jl.account_id, jl.credit, jl.debit, jl.currency, jl.fx_rate, jl.credit_base, jl.debit_base, 'Reversal of '||COALESCE(jl.memo, 'AP payment'));
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM public.journal_lines WHERE entry_id = _reversal_entry) THEN
    RAISE EXCEPTION 'Original journal entry for this payment has no lines';
  END IF;

  SELECT COALESCE(SUM(debit_base),0), COALESCE(SUM(credit_base),0) INTO _dr, _cr
    FROM public.journal_lines WHERE entry_id = _reversal_entry;
  IF ROUND(_dr,2) <> ROUND(_cr,2) THEN
    RAISE EXCEPTION 'Reversal journal is not balanced (DR %, CR %)', _dr, _cr;
  END IF;

  -- Lock the single affected bill (payment row already locked above —
  -- consistent ordering: payment row, then its one bill, exactly mirroring
  -- reverse_ar_receipt()'s receipt-row-then-invoice-row(s) ordering, which
  -- is also the order post_ap_payment() itself uses when it locks the bill
  -- during payment creation). Undo this payment's exact contribution —
  -- never a recompute-from-scratch sum — so any OTHER payment against the
  -- same bill is left untouched.
  SELECT * INTO bl FROM public.ap_bills WHERE id = pay.bill_id FOR UPDATE;
  IF bl IS NULL THEN RAISE EXCEPTION 'Bill for this payment was not found'; END IF;

  _new_paid := bl.amount_paid - pay.amount;
  IF _new_paid < 0 THEN
    -- Structurally unreachable (post_ap_payment() only ever increments
    -- amount_paid by exactly this same payment's own amount), but guarded
    -- explicitly rather than surfacing a raw CHECK-constraint violation.
    RAISE EXCEPTION 'Reversing this payment would drive bill % amount_paid negative', bl.code;
  END IF;
  _new_status := CASE WHEN _new_paid >= bl.total THEN 'paid'::ap_status ELSE 'open'::ap_status END;
  UPDATE public.ap_bills SET amount_paid = _new_paid, status = _new_status WHERE id = bl.id;

  UPDATE public.ap_payments
    SET status = 'void', reversal_entry_id = _reversal_entry, reversal_reason = _trimmed_reason,
        reversed_by = auth.uid(), reversed_at = now()
    WHERE id = pay.id;

  INSERT INTO public.admin_action_logs(
    property_id, actor_id, entity_type, entity_id, action, before_snapshot, after_snapshot, memo
  ) VALUES (
    pay.property_id, auth.uid(), 'ap_payment', pay.id::text, 'update',
    jsonb_build_object('status', 'posted', 'billId', pay.bill_id, 'postedEntryId', pay.posted_entry_id, 'amount', pay.amount),
    jsonb_build_object('status', 'void', 'reversalEntryId', _reversal_entry, 'reason', _trimmed_reason),
    'AP payment reversed: '||_trimmed_reason
  );

  RETURN _reversal_entry;
END; $$;

REVOKE EXECUTE ON FUNCTION public.reverse_ap_payment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_ap_payment(uuid, text) TO authenticated;
