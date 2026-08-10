-- ============================================================
-- Phase AR/AP-1 — Payment Integrity Foundation + AR Receipts
--
-- Extends the existing AR/AP foundation (20260705040642) without
-- replacing it. Two parts:
--
--   PART A — AP payment safety (hardens post_ap_payment(), which is
--   also confirmed to have a pre-existing bug: it posted journal
--   entries with source 'ap_payment', which is not a member of the
--   journal_source enum. Every AP payment insert has therefore been
--   failing at the trigger and rolling back since this feature was
--   built. Fixed as part of hardening the same function.)
--
--   PART B — AR receipts: a new, additive ar_receipts /
--   ar_receipt_allocations pair plus a single atomic post_ar_receipt()
--   RPC, following the same posting_rules/resolve_account/post_journal
--   architecture and RLS conventions already used by ar_invoices/ap_bills.
--
-- Model decision (see accompanying report): receipts in this phase
-- must be FULLY allocated — receipt amount is derived as the exact
-- sum of its allocations. There is no unapplied-customer-credit
-- concept anywhere in the existing schema (no customer master table,
-- no credit-balance ledger), and introducing one is explicitly out of
-- scope for this phase per the brief. Requiring full allocation avoids
-- creating money that "disappears" into an unapplied bucket with no
-- mechanism to track or later apply it.
-- ============================================================

-- ============================================================
-- PART A — AP PAYMENT SAFETY
-- ============================================================

-- Composite FK so a payment's property_id is declaratively guaranteed
-- to match its bill's property_id (mirrors the property-scoped
-- composite-FK pattern already used by the Phase 6A expense tables).
ALTER TABLE public.ap_bills
  ADD CONSTRAINT ap_bills_property_id_uniq UNIQUE (property_id, id);

ALTER TABLE public.ap_payments
  ADD CONSTRAINT ap_payments_property_bill_fkey
  FOREIGN KEY (property_id, bill_id) REFERENCES public.ap_bills(property_id, id);

-- Table-level guards. Safe against existing data: amount_paid has
-- always been maintained by post_ap_payment() itself (never bypassed
-- by another writer), and every prior payment attempt failed before
-- committing (see bug note above), so amount_paid <= total already
-- holds for every existing row. See the Phase 9 preflight queries
-- before applying this to a real production database.
ALTER TABLE public.ap_payments
  ADD CONSTRAINT ap_payments_amount_positive CHECK (amount > 0);

ALTER TABLE public.ap_bills
  ADD CONSTRAINT ap_bills_amount_paid_bounds CHECK (amount_paid >= 0 AND amount_paid <= total);

-- Hardened, corrected post_ap_payment(). Preserves the existing GL
-- direction (Debit AP / Credit cash-bank) and the existing
-- resolve_account() rule keys ('payment_cash'/'payment_bank',
-- 'ap_liability') exactly as before. Adds:
--   - fix: valid journal_source ('ap' instead of the invalid
--     'ap_payment' literal, which is not in the enum)
--   - idempotency: unchanged behavior, still short-circuits if
--     already posted
--   - row lock on the bill to make concurrent payments safe
--   - amount > 0
--   - payment.property_id must match bill.property_id
--   - bill must be 'open' (rejects draft/void/paid)
--   - amount must not exceed the remaining balance
CREATE OR REPLACE FUNCTION public.post_ap_payment(_id UUID) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  p RECORD; b RECORD; _cash UUID; _ap UUID; _lines JSONB; _entry UUID; _cur TEXT; _remaining NUMERIC;
BEGIN
  SELECT * INTO p FROM public.ap_payments WHERE id=_id;
  IF p IS NULL THEN RETURN NULL; END IF;
  IF p.posted_entry_id IS NOT NULL THEN RETURN p.posted_entry_id; END IF;

  -- Lock the bill row for the remainder of this transaction so two
  -- concurrent payments against the same bill can't both read a
  -- remaining balance that's stale by the time either one commits.
  SELECT * INTO b FROM public.ap_bills WHERE id=p.bill_id FOR UPDATE;
  IF b IS NULL THEN RAISE EXCEPTION 'Bill not found'; END IF;

  IF p.property_id IS DISTINCT FROM b.property_id THEN
    RAISE EXCEPTION 'Payment property does not match bill property';
  END IF;

  IF p.amount IS NULL OR p.amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero';
  END IF;

  IF b.status <> 'open' THEN
    RAISE EXCEPTION 'Bill is not open for payment (status: %)', b.status;
  END IF;

  _remaining := b.total - b.amount_paid;
  IF p.amount > _remaining THEN
    RAISE EXCEPTION 'Payment amount % exceeds remaining balance % on bill %', p.amount, _remaining, b.code;
  END IF;

  _cash := public.resolve_account(p.property_id, CASE WHEN p.method='cash' THEN 'payment_cash' ELSE 'payment_bank' END,
                                  CASE WHEN p.method='cash' THEN 'cash' ELSE 'bank' END);
  _ap := public.resolve_account(p.property_id,'ap_liability','ap');
  _cur := COALESCE(b.currency,'USD');
  _lines := jsonb_build_array(
    jsonb_build_object('account_id',_ap,'debit',p.amount,'credit',0,'memo','AP payment '||b.code),
    jsonb_build_object('account_id',_cash,'debit',0,'credit',p.amount,'memo','Cash out')
  );
  -- Fix: 'ap_payment' is not a member of journal_source; 'ap' is the
  -- established AP-domain value. source_ref is the payment id (not
  -- the bill id), so the payment entry remains distinguishable from
  -- the bill's own posting entry.
  _entry := public.post_journal(p.property_id, p.paid_at::date, _cur, 'AP Payment '||b.code, 'ap', p.id::text, _lines);
  UPDATE public.ap_payments SET posted_entry_id=_entry WHERE id=_id;
  UPDATE public.ap_bills SET amount_paid = amount_paid + p.amount,
    status = CASE WHEN amount_paid + p.amount >= total THEN 'paid'::ap_status ELSE status END
    WHERE id=p.bill_id;
  RETURN _entry;
END; $$;

-- ============================================================
-- PART B — AR RECEIPT SCHEMA
-- ============================================================

-- Composite unique so ar_invoices can be the target of a
-- property-scoped composite FK from ar_receipt_allocations.
ALTER TABLE public.ar_invoices
  ADD CONSTRAINT ar_invoices_property_id_uniq UNIQUE (property_id, id);

-- amount_paid has never been written by any existing code path
-- (confirmed: no function in the codebase updates it), so every
-- existing row satisfies amount_paid = 0 <= total and this bound is
-- safe to add unconditionally. See Phase 9 preflight queries.
ALTER TABLE public.ar_invoices
  ADD CONSTRAINT ar_invoices_amount_paid_bounds CHECK (amount_paid >= 0 AND amount_paid <= total);

CREATE TABLE public.ar_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  receipt_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  method payment_method NOT NULL DEFAULT 'cash',
  reference TEXT,
  notes TEXT,
  -- Client-supplied idempotency key: a resubmitted call with the same
  -- key (double-click, network retry) is a safe no-op — see
  -- post_ar_receipt() below. NULL is allowed (no dedup requested) but
  -- the RPC always supplies one.
  idempotency_key TEXT,
  posted_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, code),
  UNIQUE (property_id, idempotency_key)
);
-- Only SELECT is granted directly: every write must go through
-- post_ar_receipt() (SECURITY DEFINER, runs as owner, bypasses these
-- grants), mirroring the Phase 6A expense tables' "no direct client
-- writes" model rather than the older ar_invoices/ap_bills pattern of
-- granting full CRUD to authenticated. This is deliberate: the
-- invariants this phase requires (sum of allocations vs receipt
-- amount, remaining balance across all prior allocations) cannot be
-- expressed as a per-row CHECK constraint, so the RPC must be the
-- only entry point.
GRANT SELECT ON public.ar_receipts TO authenticated;
GRANT ALL ON public.ar_receipts TO service_role;
ALTER TABLE public.ar_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ar_receipts read" ON public.ar_receipts FOR SELECT TO authenticated
  USING (public.can_access_property(auth.uid(), property_id));
CREATE TRIGGER trg_ar_receipts_updated BEFORE UPDATE ON public.ar_receipts FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE TABLE public.ar_receipt_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  receipt_id UUID NOT NULL REFERENCES public.ar_receipts(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES public.ar_invoices(id) ON DELETE RESTRICT,
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (receipt_id, invoice_id)
);
ALTER TABLE public.ar_receipt_allocations
  ADD CONSTRAINT ar_receipt_allocations_receipt_fkey
  FOREIGN KEY (property_id, receipt_id) REFERENCES public.ar_receipts(property_id, id);
ALTER TABLE public.ar_receipt_allocations
  ADD CONSTRAINT ar_receipt_allocations_invoice_fkey
  FOREIGN KEY (property_id, invoice_id) REFERENCES public.ar_invoices(property_id, id);
GRANT SELECT ON public.ar_receipt_allocations TO authenticated;
GRANT ALL ON public.ar_receipt_allocations TO service_role;
ALTER TABLE public.ar_receipt_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ar_receipt_allocations read" ON public.ar_receipt_allocations FOR SELECT TO authenticated
  USING (public.can_access_property(auth.uid(), property_id));
CREATE INDEX ar_receipt_allocations_invoice ON public.ar_receipt_allocations(invoice_id);

-- Helpful for the new "eligible invoices" query the UI needs (sent,
-- not yet fully paid) and for aging/detail lookups generally.
CREATE INDEX ar_invoices_property_status ON public.ar_invoices(property_id, status);
CREATE INDEX ap_bills_property_status ON public.ap_bills(property_id, status);

-- ============================================================
-- PART C — POST AR RECEIPT (atomic RPC)
-- ============================================================
-- _allocations shape: [{"invoice_id": "<uuid>", "amount": <number>}, ...]
-- Receipt currency and receipt_date/method/reference/notes are
-- derived/validated inside the function; amount is derived as the
-- exact sum of allocations (Model A — fully allocated receipts only).
CREATE OR REPLACE FUNCTION public.post_ar_receipt(
  _property_id UUID,
  _receipt_date DATE,
  _method payment_method,
  _reference TEXT,
  _notes TEXT,
  _idempotency_key TEXT,
  _allocations JSONB
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  _existing_id UUID; _existing_entry UUID;
  _receipt_id UUID; _receipt_code TEXT;
  _alloc JSONB; _invoice_id UUID; _alloc_amount NUMERIC;
  _total_allocated NUMERIC := 0;
  _currency TEXT;
  _inv RECORD; _remaining NUMERIC;
  _cash UUID; _ar UUID; _lines JSONB;
  _entry UUID;
  _new_paid NUMERIC; _new_status ar_status;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant','front_desk']::app_role[], _property_id) THEN
    RAISE EXCEPTION 'Not permitted to record an AR receipt';
  END IF;

  -- Idempotent resubmission: a repeat call with the same key is a
  -- safe no-op that returns the already-posted journal entry instead
  -- of creating a second receipt/allocation/journal set.
  IF _idempotency_key IS NOT NULL THEN
    SELECT id, posted_entry_id INTO _existing_id, _existing_entry
      FROM public.ar_receipts WHERE property_id=_property_id AND idempotency_key=_idempotency_key;
    IF _existing_id IS NOT NULL THEN
      RETURN _existing_entry;
    END IF;
  END IF;

  IF _allocations IS NULL OR jsonb_array_length(_allocations) = 0 THEN
    RAISE EXCEPTION 'At least one allocation is required';
  END IF;

  -- Pass 1: validate shape and compute the fully-allocated receipt total.
  FOR _alloc IN SELECT * FROM jsonb_array_elements(_allocations) LOOP
    _alloc_amount := (_alloc->>'amount')::NUMERIC;
    IF (_alloc->>'invoice_id') IS NULL THEN
      RAISE EXCEPTION 'Allocation is missing invoice_id';
    END IF;
    IF _alloc_amount IS NULL OR _alloc_amount <= 0 THEN
      RAISE EXCEPTION 'Allocation amount must be greater than zero';
    END IF;
    _total_allocated := _total_allocated + _alloc_amount;
  END LOOP;

  -- Reject duplicate invoice_id entries within the same submission —
  -- each invoice may appear at most once per receipt (use one
  -- allocation row, not two, if the amount needs adjusting).
  IF (SELECT COUNT(DISTINCT value->>'invoice_id') FROM jsonb_array_elements(_allocations)) <>
     jsonb_array_length(_allocations) THEN
    RAISE EXCEPTION 'Each invoice may only appear once per receipt';
  END IF;

  _receipt_code := public.short_code('RCT');

  -- Pass 2: lock and validate every allocated invoice, in a
  -- deterministic order (by invoice_id) so two concurrent receipts
  -- touching overlapping invoices can't deadlock each other.
  FOR _alloc IN SELECT * FROM jsonb_array_elements(_allocations) ORDER BY (value->>'invoice_id') LOOP
    _invoice_id := (_alloc->>'invoice_id')::UUID;
    _alloc_amount := (_alloc->>'amount')::NUMERIC;

    SELECT * INTO _inv FROM public.ar_invoices WHERE id=_invoice_id AND property_id=_property_id FOR UPDATE;
    IF _inv IS NULL THEN
      RAISE EXCEPTION 'Invoice not found for this property';
    END IF;
    IF _inv.status <> 'sent' THEN
      RAISE EXCEPTION 'Invoice % is not eligible to receive payment (status: %)', _inv.code, _inv.status;
    END IF;

    IF _currency IS NULL THEN
      _currency := _inv.currency;
    ELSIF _inv.currency IS DISTINCT FROM _currency THEN
      RAISE EXCEPTION 'Invoice % currency (%) does not match the other allocated invoices (%)', _inv.code, _inv.currency, _currency;
    END IF;

    _remaining := _inv.total - _inv.amount_paid;
    IF _alloc_amount > _remaining THEN
      RAISE EXCEPTION 'Allocation % for invoice % exceeds its remaining balance %', _alloc_amount, _inv.code, _remaining;
    END IF;
  END LOOP;

  -- Pass 1 and 2 both passed: create the receipt header now that the
  -- final, validated amount and currency are known.
  --
  -- Two concurrent calls carrying the same idempotency_key can both pass
  -- the pre-check above (neither has committed yet) and race here; the
  -- UNIQUE (property_id, idempotency_key) constraint lets exactly one
  -- INSERT succeed. Catch the loser's unique_violation and fall back to
  -- returning the winner's already-posted entry, so a concurrent retry is
  -- still a safe no-op rather than a surfaced duplicate-key error.
  BEGIN
    INSERT INTO public.ar_receipts(property_id, code, receipt_date, amount, currency, method, reference, notes, idempotency_key, created_by)
    VALUES (_property_id, _receipt_code, COALESCE(_receipt_date, CURRENT_DATE), _total_allocated, _currency, _method, _reference, _notes, _idempotency_key, auth.uid())
    RETURNING id INTO _receipt_id;
  EXCEPTION WHEN unique_violation THEN
    IF _idempotency_key IS NOT NULL THEN
      SELECT id, posted_entry_id INTO _existing_id, _existing_entry
        FROM public.ar_receipts WHERE property_id=_property_id AND idempotency_key=_idempotency_key;
      IF _existing_id IS NOT NULL THEN
        RETURN _existing_entry;
      END IF;
    END IF;
    RAISE;
  END;

  -- Pass 3: write the allocations and advance each invoice's balance/status.
  FOR _alloc IN SELECT * FROM jsonb_array_elements(_allocations) LOOP
    _invoice_id := (_alloc->>'invoice_id')::UUID;
    _alloc_amount := (_alloc->>'amount')::NUMERIC;

    INSERT INTO public.ar_receipt_allocations(property_id, receipt_id, invoice_id, amount)
    VALUES (_property_id, _receipt_id, _invoice_id, _alloc_amount);

    SELECT * INTO _inv FROM public.ar_invoices WHERE id=_invoice_id FOR UPDATE;
    _new_paid := _inv.amount_paid + _alloc_amount;
    _new_status := CASE WHEN _new_paid >= _inv.total THEN 'paid'::ar_status ELSE _inv.status END;
    UPDATE public.ar_invoices SET amount_paid = _new_paid, status = _new_status WHERE id = _invoice_id;
  END LOOP;

  -- Single two-line GL entry for the whole receipt (the invoice-level
  -- detail lives in the sub-ledger via ar_receipt_allocations, not in
  -- the journal — the same convention post_ar_invoice/post_ap_bill
  -- already use for their own sub-ledger vs. GL split).
  _cash := public.resolve_account(_property_id, CASE WHEN _method='cash' THEN 'payment_cash' ELSE 'payment_bank' END,
                                  CASE WHEN _method='cash' THEN 'cash' ELSE 'bank' END);
  _ar := public.resolve_account(_property_id,'ar_receivable','ar');
  _lines := jsonb_build_array(
    jsonb_build_object('account_id',_cash,'debit',_total_allocated,'credit',0,'memo','AR receipt '||_receipt_code),
    jsonb_build_object('account_id',_ar,'debit',0,'credit',_total_allocated,'memo','Applied to AR — '||_receipt_code)
  );
  _entry := public.post_journal(_property_id, COALESCE(_receipt_date, CURRENT_DATE), _currency, 'AR Receipt '||_receipt_code, 'ar', _receipt_id::text, _lines);

  UPDATE public.ar_receipts SET posted_entry_id = _entry WHERE id = _receipt_id;

  RETURN _entry;
END; $$;

GRANT EXECUTE ON FUNCTION public.post_ar_receipt(uuid, date, payment_method, text, text, text, jsonb) TO authenticated;
