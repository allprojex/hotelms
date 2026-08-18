-- AR invoice reversal (void).
--
-- There is currently no way to correct a posted (status='sent') AR invoice
-- other than leaving it permanently on the books. journal_entries/lines are
-- immutable by design (no UPDATE/DELETE RLS policy — see the 2026-07-05
-- foundation migration's own comment: "reverse via new entry"), so a
-- correction must be a brand-new offsetting journal entry, never an edit or
-- delete of the original.
--
-- Architecture decisions, made after auditing post_ar_invoice(), post_journal(),
-- post_ar_receipt(), the payroll/expense reversal patterns, and ar_aging/AR
-- statement code:
--
-- 1. Reversal is built directly from the ORIGINAL journal_lines (debit/credit
--    swapped 1:1, including fx_rate/debit_base/credit_base copied verbatim),
--    not recomputed from ar_invoice_lines/tax_rate and not routed through
--    post_journal()'s own fx_convert(). This guarantees the combined
--    original+reversal net effect is exactly zero per account, in both
--    invoice currency and base currency, even if fx_rates or tax
--    configuration changed between the original posting date and today.
--    (post_ar_invoice() itself is deliberately left untouched — it still
--    recomputes from invoice lines, which is correct for a first posting.)
--
-- 2. journal_entries.is_reversal_of (existing, previously-unused column) is
--    used to link the reversal to the original entry. ar_invoices.posted_entry_id
--    is left untouched, still pointing at the ORIGINAL posting — never
--    overloaded to reference the reversal. No new ar_invoices column is
--    added: the reversal entry is always reachable via
--    `journal_entries WHERE is_reversal_of = ar_invoices.posted_entry_id`,
--    and the UI only needs to know an invoice is void (status already
--    conveys that) — it doesn't currently render journal entry ids anywhere
--    for any invoice, reversed or not, so a denormalized column would add
--    sync-integrity risk for no present benefit.
--
-- 3. Post-reversal state reuses the existing 'void' value of the ar_status
--    enum (already defined, already excluded by ar_aging's
--    `WHERE status <> 'void'` and by AR_STATEMENT_INCLUDED_STATUSES =
--    ['sent','paid'] in ar-statement-calc.ts) rather than inventing a new
--    status or returning the invoice to 'draft'.
--
-- 4. Eligibility: only status='sent' with posted_entry_id set, amount_paid=0,
--    and zero ar_receipt_allocations rows. 'draft' has nothing posted to
--    reverse; 'paid'/partially-paid ('sent' with amount_paid>0) are rejected
--    outright per the instruction not to reverse a posted invoice with
--    payment activity blindly — receipt reversal is a separate, unbuilt
--    capability. 'void' is rejected as already-reversed.
--
-- 5. Double-reversal protection is layered: (a) `SELECT ... FOR UPDATE` on
--    the ar_invoices row serializes concurrent attempts on the same invoice
--    — the loser blocks until the winner commits, then re-reads status='void'
--    and raises; (b) an explicit check that no journal_entries row already
--    has is_reversal_of = this invoice's posted_entry_id; (c) a DB-level
--    UNIQUE index backs that same invariant so it holds even outside this
--    function.
--
-- 6. Permission: reuses the exact role set post_ar_invoice() itself already
--    requires to post (super_admin, hotel_owner, general_manager,
--    accountant) — reversal is at least as sensitive as posting, and
--    front_desk (which can create/edit draft invoices) is deliberately
--    excluded from both. No new permission-table capability is introduced;
--    this mirrors post_ar_invoice()'s own has_any_role() gate exactly.
--
-- 7. Audit: uses the existing, established admin_log() RPC (the same
--    mechanism ar-statement-pdf.functions.ts uses for print audit) — not the
--    log_audit_event() name referenced by the payroll migration, which has
--    no CREATE FUNCTION anywhere in this repo's migration history and does
--    not exist. Known limitation: admin_log()'s own internal role check
--    (super_admin/hotel_owner/general_manager) does not include
--    'accountant', so a reversal performed by an accountant will still
--    succeed but will not produce an admin_action_logs row. This is a
--    pre-existing gap in admin_log() itself (affects every other admin_log
--    call site in the app identically), not something introduced or
--    silently patched by this migration.

CREATE UNIQUE INDEX journal_entries_reversal_of_uniq
  ON public.journal_entries(is_reversal_of)
  WHERE is_reversal_of IS NOT NULL;

CREATE OR REPLACE FUNCTION public.reverse_ar_invoice(_id UUID, _reason TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  inv RECORD; jl RECORD; orig_entry RECORD;
  _reversal_entry UUID; _existing_reversal UUID;
  _alloc_count INT; _period_id UUID; _trimmed_reason TEXT;
  _dr NUMERIC; _cr NUMERIC;
BEGIN
  _trimmed_reason := btrim(COALESCE(_reason, ''));
  IF char_length(_trimmed_reason) < 5 THEN
    RAISE EXCEPTION 'A reversal reason of at least 5 characters is required';
  END IF;
  IF char_length(_trimmed_reason) > 500 THEN
    RAISE EXCEPTION 'Reversal reason must be 500 characters or fewer';
  END IF;

  -- Row lock: the primary defense against a concurrent double reversal.
  SELECT * INTO inv FROM public.ar_invoices WHERE id=_id FOR UPDATE;
  IF inv IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;

  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], inv.property_id) THEN
    RAISE EXCEPTION 'Not permitted to reverse an AR invoice';
  END IF;

  IF inv.status = 'void' THEN
    RAISE EXCEPTION 'Invoice % has already been reversed', inv.code;
  END IF;
  IF inv.status = 'draft' THEN
    RAISE EXCEPTION 'A draft invoice has no posting to reverse';
  END IF;
  IF inv.status = 'paid' THEN
    RAISE EXCEPTION 'Invoice % is fully paid and cannot be reversed in this version', inv.code;
  END IF;
  IF inv.status <> 'sent' THEN
    RAISE EXCEPTION 'Invoice % is not in a reversible state (status: %)', inv.code, inv.status;
  END IF;
  IF inv.posted_entry_id IS NULL THEN
    RAISE EXCEPTION 'Invoice % has no posted journal entry to reverse', inv.code;
  END IF;
  IF inv.amount_paid <> 0 THEN
    RAISE EXCEPTION 'Invoice % has payments applied and cannot be reversed in this version', inv.code;
  END IF;

  SELECT count(*) INTO _alloc_count FROM public.ar_receipt_allocations WHERE invoice_id = _id;
  IF _alloc_count > 0 THEN
    RAISE EXCEPTION 'Invoice % has receipt allocations and cannot be reversed in this version', inv.code;
  END IF;

  SELECT id INTO _existing_reversal FROM public.journal_entries WHERE is_reversal_of = inv.posted_entry_id;
  IF _existing_reversal IS NOT NULL THEN
    RAISE EXCEPTION 'Invoice % already has a reversal journal entry', inv.code;
  END IF;

  SELECT * INTO orig_entry FROM public.journal_entries WHERE id = inv.posted_entry_id;
  IF orig_entry IS NULL THEN
    RAISE EXCEPTION 'Original journal entry for invoice % was not found', inv.code;
  END IF;

  -- Same period-lock rule post_journal() enforces for every other posting.
  SELECT id INTO _period_id FROM public.accounting_periods
    WHERE property_id=inv.property_id AND CURRENT_DATE BETWEEN start_date AND end_date AND status IN ('locked','closed')
    LIMIT 1;
  IF _period_id IS NOT NULL THEN
    RAISE EXCEPTION 'Current accounting period is locked';
  END IF;

  INSERT INTO public.journal_entries(property_id, entry_date, memo, source, source_ref, currency, posted_by, is_reversal_of)
  VALUES (inv.property_id, CURRENT_DATE, 'Reversal of AR Invoice '||inv.code||' — '||_trimmed_reason, 'ar', inv.id::text, orig_entry.currency, auth.uid(), inv.posted_entry_id)
  RETURNING id INTO _reversal_entry;

  FOR jl IN SELECT * FROM public.journal_lines WHERE entry_id = inv.posted_entry_id ORDER BY created_at LOOP
    INSERT INTO public.journal_lines(entry_id, account_id, debit, credit, currency, fx_rate, debit_base, credit_base, memo)
    VALUES (_reversal_entry, jl.account_id, jl.credit, jl.debit, jl.currency, jl.fx_rate, jl.credit_base, jl.debit_base, 'Reversal of '||COALESCE(jl.memo, inv.code));
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM public.journal_lines WHERE entry_id = _reversal_entry) THEN
    RAISE EXCEPTION 'Original journal entry for invoice % has no lines', inv.code;
  END IF;

  -- Defensive re-check: the reversal must itself be balanced. Mathematically
  -- guaranteed by swapping a balanced set's own columns, but asserted
  -- explicitly rather than assumed.
  SELECT COALESCE(SUM(debit_base),0), COALESCE(SUM(credit_base),0) INTO _dr, _cr
    FROM public.journal_lines WHERE entry_id = _reversal_entry;
  IF ROUND(_dr,2) <> ROUND(_cr,2) THEN
    RAISE EXCEPTION 'Reversal journal is not balanced (DR %, CR %)', _dr, _cr;
  END IF;

  UPDATE public.ar_invoices SET status = 'void' WHERE id = _id;

  PERFORM public.admin_log(
    inv.property_id, 'ar_invoice', inv.id::text, 'update',
    jsonb_build_object('status', inv.status, 'postedEntryId', inv.posted_entry_id),
    jsonb_build_object('status', 'void', 'postedEntryId', inv.posted_entry_id, 'reversalEntryId', _reversal_entry),
    'AR invoice '||inv.code||' reversed: '||_trimmed_reason
  );

  RETURN _reversal_entry;
END; $$;

REVOKE EXECUTE ON FUNCTION public.reverse_ar_invoice(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_ar_invoice(uuid, text) TO authenticated;
