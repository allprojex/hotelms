-- AR Credit Notes — PR 1: schema + create/post + receipt net-balance fix,
-- plus the reverse_ar_invoice() posted-credit-note guard, the duplicate-
-- source-line structural fix, and RLS-safe (security_invoker) views —
-- see points 10-14 below, added in response to PR #36 review.
--
-- Architecture decisions, made after auditing ar_invoices/ar_invoice_lines,
-- post_ar_invoice(), post_ar_receipt(), reverse_ar_invoice(), post_journal(),
-- and ar_aging:
--
-- 1. A credit note always references exactly one invoice (invoice_id is
--    mandatory in V1 — no standalone credit notes). customer_id and currency
--    are derived from the invoice, never independently supplied, mirroring
--    create_ar_invoice()'s own "copy from the authoritative parent" pattern.
--
-- 2. Every credit note line references its source invoice line. Cross-invoice
--    linkage is made structurally impossible (not just app-checked) via a
--    chain of composite foreign keys:
--      - ar_invoice_lines gets a new UNIQUE (id, invoice_id) (trivially true
--        since id is already the primary key — this just exposes the pair as
--        a valid FK target).
--      - ar_credit_notes gets a new UNIQUE (id, invoice_id) for the same
--        reason.
--      - ar_credit_note_lines stores a denormalized invoice_id and is
--        constrained by FOREIGN KEY (credit_note_id, invoice_id) REFERENCES
--        ar_credit_notes(id, invoice_id) — the row's invoice_id cannot
--        diverge from its own credit note's invoice_id.
--      - ar_credit_note_lines is further constrained by FOREIGN KEY
--        (source_invoice_line_id, invoice_id) REFERENCES
--        ar_invoice_lines(id, invoice_id) — the source line must literally
--        belong to that same invoice_id.
--    Combined, a credit note line can never point at a source line that
--    belongs to any invoice other than its own credit note's invoice.
--
-- 3. unit_price, tax_rate, and revenue_account_id are copied from the source
--    invoice line at both create and post time — never independently
--    user-selectable — so the per-line monetary cap follows directly from
--    the quantity cap (same unit price/tax rate cannot be re-priced to
--    smuggle more value out of a partially-credited line).
--
-- 4. net_balance is never stored on ar_invoices. It is exposed for
--    consumption via the ar_invoice_balances view (property_id, invoice_id,
--    total, amount_paid, credited_total, net_balance) and via the
--    ar_invoice_credited_total() scalar helper used internally by posting
--    functions. Every function that POSTS money (post_ar_credit_note,
--    post_ar_receipt) always locks the authoritative ar_invoices row with
--    SELECT ... FOR UPDATE and recomputes credited_total/net_balance fresh
--    inside that same transaction — the view/helper is read convenience
--    only, never a substitute for the lock.
--
-- 5. post_ar_credit_note(_id) locks the credit note row itself
--    (SELECT ... FOR UPDATE) before the invoice row, in that fixed order,
--    mirroring reverse_ar_invoice()'s "lock first, check status after"
--    pattern. This is the primary defense against double-posting the same
--    credit note concurrently: the loser blocks on the credit-note lock,
--    then (after the winner commits) re-reads status='posted' and returns
--    the existing posted_entry_id instead of re-posting. The invoice lock
--    that follows is the primary defense against concurrent over-credit
--    across different credit notes on the same invoice.
--
-- 6. Tax/rounding: a non-terminal partial credit uses
--    ROUND(qty * unit_price, 4) / ROUND(subtotal * tax_rate / 100, 4). A
--    credit that exhausts a source line's remaining quantity instead uses
--    the exact remaining original subtotal/tax (original amount minus the
--    sum already recorded on that line's previously POSTED credit note
--    lines), so cumulative posted credits against one source line can never
--    exceed its original subtotal/tax and never leave a rounding residual
--    after a full credit.
--
-- 7. Journal: DR revenue, DR tax payable (if any), CR accounts receivable —
--    a new economic event posted through the existing post_journal()/
--    resolve_account() architecture with today's posting-date FX rate, NOT
--    a copy of the original invoice's historical journal lines (that
--    pattern belongs to reverse_ar_invoice(), which is undoing the exact
--    same event; a credit note is a new one).
--
-- 8. post_ar_receipt() is changed in the same migration (not split into a
--    follow-up PR): its remaining-balance calculation now subtracts posted
--    credit-note totals, and its post-receipt status flip to 'paid' now
--    triggers at net_balance <= 0, not merely amount_paid >= total. A
--    credit-note posting capability must never exist while receipt posting
--    can still over-apply against credited receivables.
--
-- 9. Audit: posting inserts directly into admin_action_logs, in the same
--    SECURITY DEFINER transaction as the journal/invoice/credit-note
--    writes — not via the admin_log() RPC, whose own role check excludes
--    'accountant' (see reverse_ar_invoice()'s header comment for the same
--    reasoning). This guarantees every eligible role produces exactly one
--    audit row per successful post, with zero change to admin_log() itself.
--
-- 10. Ageing AND customer-statement release safety: this migration is the
--    first time a posted credit note becomes reachable at all (via the new
--    RPCs — there is no UI wired to them in this PR, but the RPCs
--    themselves are a new API surface any authenticated accountant/GM-
--    equivalent client can call directly once deployed). Two separate
--    balance-of-record surfaces existed before this PR, and BOTH are now
--    corrected in this same migration/PR rather than one being deferred:
--      - ar_aging's `balance` column now reads from ar_invoice_balances
--        (net_balance) instead of the old `total - amount_paid`.
--      - ar-statement-calc.ts's computeArCustomerStatement() (and its
--        server-side data loader, loadArCustomerStatement in
--        ar-statements.functions.ts) now also treat a posted credit note
--        as a CREDIT transaction, the same as a receipt allocation —
--        included in opening balance, period transactions, running
--        balance, and closing balance, per currency, with draft/void
--        credit notes excluded at both the DB query level (status='posted'
--        filter) and, defensively, inside the pure calculator itself
--        (mirroring the existing AR_STATEMENT_INCLUDED_STATUSES pattern
--        for invoice status). This was originally scoped out of PR 1 as a
--        "display gap, not a misstatement" — that reasoning was wrong: a
--        customer statement's closing balance is itself an authoritative
--        financial total, and once post_ar_credit_note() is reachable
--        through the authenticated RPC surface, leaving it out is a real
--        receivables misstatement on that surface, not merely a missing
--        row. It is fixed here, not deferred.
--    This remains a minimal, mechanical extension of the existing pure
--    calculator/loader — not the full credit-note UI/PDF feature (no
--    credit-note-specific PDF section, no dedicated credit-note management
--    UI). That remains out of scope for PR 1/2 as originally directed.
--
-- 11. reverse_ar_invoice() posted-credit-note guard (mandatory, shipped
--    atomically with post_ar_credit_note() in this same migration — not
--    deferred to the later credit-note-reversal PR): the original function
--    (20260818090000) predates credit notes entirely and would otherwise
--    let a sent, unpaid, zero-receipt-allocation invoice be reversed while
--    a posted credit note against it remains economically active, leaving
--    the credit note's DR revenue/DR tax/CR AR journal permanently
--    unreconciled against a reversed-out original posting. Redeclared here
--    via CREATE OR REPLACE FUNCTION under the identical signature (this
--    migration only adds new objects and never edits a historical
--    migration file in place — the same pattern already used above for
--    post_ar_receipt()); every other guard/behavior is copied verbatim
--    from the original, with exactly one new EXISTS check against
--    ar_credit_notes (status='posted') added alongside the existing
--    amount_paid/ar_receipt_allocations guards, under the same invoice row
--    lock. Draft and void credit notes never block reversal — they carry
--    no journal entry and never affected the invoice.
--
-- 12. ar_credit_note_lines_note_source_uniq: UNIQUE (credit_note_id,
--    source_invoice_line_id) closes a duplicate-source-line bypass in
--    post_ar_credit_note()'s remaining-quantity check. That check only
--    sums quantity from OTHER credit notes already status='posted' — two
--    sibling lines within the SAME draft credit note referencing the same
--    source line (e.g. qty 6 + qty 6 against a source line of qty 10)
--    would each independently see the full remaining quantity and both
--    pass, since the note being posted is still 'draft' throughout its own
--    posting loop. This is closed structurally with a table constraint,
--    not an aggregation workaround in the function, and not by relying on
--    the (weaker, invoice-wide) net-balance cap to catch it indirectly.
--
-- 13. View security: security_invoker = true is now declared explicitly on
--    both ar_invoice_balances (new) and ar_aging (redefined) in their own
--    CREATE OR REPLACE VIEW statements, plus a defensive ALTER VIEW ... SET
--    (security_invoker = true) immediately after each. Without it, a plain
--    view checks RLS against the VIEW OWNER (the migration-running role,
--    exempt from RLS as table owner/superuser), not the querying client —
--    GRANT SELECT ... TO authenticated would then let any authenticated
--    user of any property read every other property's balances straight
--    through the view. This project has hit exactly this bug before on
--    ar_aging itself and fixed it the same way twice: see
--    20260705040652_ca91242d-63f8-4436-aa72-3c3d68f10a95.sql ("Aging
--    views: honor caller's RLS instead of view-owner permissions") and
--    20260706002151_e5d271a3-0dc5-464a-bd70-f020a231e8ae.sql. This PR's own
--    CREATE OR REPLACE VIEW of ar_aging would otherwise have silently
--    reintroduced that exact cross-property leak a third time.
--
-- 14. create_ar_credit_note() now requires the linked invoice to be
--    'sent', not 'sent' or 'paid'. post_ar_credit_note() has always
--    rejected a 'paid' invoice (V1 does not support crediting a fully
--    paid invoice), so allowing a draft to be created against one only
--    produced a permanently unpostable draft with no cleanup path. There
--    is no workflow reason for that draft to exist; create-time now
--    matches post-time exactly.

-- ============================================================
-- PART A — SUPPORTING UNIQUE CONSTRAINTS ON ar_invoice_lines
-- ============================================================

-- Exposes (id, invoice_id) as a valid composite FK target. Safe
-- unconditionally: id is already the table's primary key, so this pair is
-- already unique for every existing row.
ALTER TABLE public.ar_invoice_lines
  ADD CONSTRAINT ar_invoice_lines_id_invoice_uniq UNIQUE (id, invoice_id);

-- ============================================================
-- PART B — ar_credit_notes
-- ============================================================

CREATE TYPE public.ar_credit_note_status AS ENUM ('draft', 'posted', 'void');

CREATE TABLE public.ar_credit_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  invoice_id UUID NOT NULL,
  customer_id UUID,
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  currency TEXT NOT NULL,
  reason TEXT NOT NULL,
  subtotal NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  total NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (total >= 0),
  status public.ar_credit_note_status NOT NULL DEFAULT 'draft',
  posted_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ar_credit_notes_property_id_uniq UNIQUE (property_id, id),
  CONSTRAINT ar_credit_notes_id_invoice_uniq UNIQUE (id, invoice_id),
  CONSTRAINT ar_credit_notes_property_code_uniq UNIQUE (property_id, code),
  CONSTRAINT ar_credit_notes_reason_not_blank CHECK (btrim(reason) <> ''),
  CONSTRAINT ar_credit_notes_total_eq_lines CHECK (total = subtotal + tax)
);

-- Invoice linkage structurally constrained to the same property.
ALTER TABLE public.ar_credit_notes
  ADD CONSTRAINT ar_credit_notes_invoice_fkey
  FOREIGN KEY (property_id, invoice_id) REFERENCES public.ar_invoices(property_id, id)
  ON DELETE RESTRICT;

-- customer_id is derived from the invoice at create time and may be NULL
-- for historical invoices whose own customer_id is NULL (see
-- 20260812120000_ar_customer_account_foundation.sql).
ALTER TABLE public.ar_credit_notes
  ADD CONSTRAINT ar_credit_notes_customer_fkey
  FOREIGN KEY (property_id, customer_id) REFERENCES public.ar_customers(property_id, id)
  ON DELETE RESTRICT;

CREATE INDEX ar_credit_notes_invoice ON public.ar_credit_notes(invoice_id);
CREATE INDEX ar_credit_notes_property_status ON public.ar_credit_notes(property_id, status);

-- No direct client writes — every write routes through create_ar_credit_note()
-- / post_ar_credit_note() (SECURITY DEFINER). Mirrors the ar_receipts model:
-- the invariants this table requires (source-line capacity, net-balance cap)
-- cannot be expressed as a per-row CHECK constraint.
GRANT SELECT ON public.ar_credit_notes TO authenticated;
GRANT ALL ON public.ar_credit_notes TO service_role;
ALTER TABLE public.ar_credit_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ar_credit_notes read" ON public.ar_credit_notes FOR SELECT TO authenticated
  USING (public.can_access_property(auth.uid(), property_id));
CREATE TRIGGER trg_ar_credit_notes_updated BEFORE UPDATE ON public.ar_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- ============================================================
-- PART C — ar_credit_note_lines
-- ============================================================

CREATE TABLE public.ar_credit_note_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  credit_note_id UUID NOT NULL,
  invoice_id UUID NOT NULL,
  source_invoice_line_id UUID NOT NULL,
  description TEXT NOT NULL,
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  tax_rate NUMERIC(6,3) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),
  revenue_account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  subtotal NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ar_credit_note_lines_property_id_uniq UNIQUE (property_id, id),
  -- One row per source invoice line per credit note. Without this, two
  -- lines in the SAME draft credit note referencing the same source line
  -- (e.g. qty 6 + qty 6 against a source line of qty 10) would each pass
  -- post_ar_credit_note()'s remaining-quantity check independently — that
  -- check only sums quantities from OTHER credit notes already
  -- status='posted', so two sibling lines within the note being posted
  -- right now are invisible to each other until after the loop. A
  -- structural uniqueness constraint closes this regardless of loop
  -- ordering; the invoice-level net-balance cap is not relied on to catch
  -- it, since that cap is a weaker, invoice-wide bound, not a per-line one.
  CONSTRAINT ar_credit_note_lines_note_source_uniq UNIQUE (credit_note_id, source_invoice_line_id)
);

-- Property isolation, declarative.
ALTER TABLE public.ar_credit_note_lines
  ADD CONSTRAINT ar_credit_note_lines_property_note_fkey
  FOREIGN KEY (property_id, credit_note_id) REFERENCES public.ar_credit_notes(property_id, id)
  ON DELETE CASCADE;

-- This row's invoice_id can never diverge from its own credit note's
-- invoice_id — structural, not app-checked.
ALTER TABLE public.ar_credit_note_lines
  ADD CONSTRAINT ar_credit_note_lines_note_invoice_fkey
  FOREIGN KEY (credit_note_id, invoice_id) REFERENCES public.ar_credit_notes(id, invoice_id)
  ON DELETE CASCADE;

-- The source line must literally belong to that same invoice_id — cross-
-- invoice linkage is structurally impossible, not just app-checked.
ALTER TABLE public.ar_credit_note_lines
  ADD CONSTRAINT ar_credit_note_lines_source_line_fkey
  FOREIGN KEY (source_invoice_line_id, invoice_id) REFERENCES public.ar_invoice_lines(id, invoice_id)
  ON DELETE RESTRICT;

CREATE INDEX ar_credit_note_lines_note ON public.ar_credit_note_lines(credit_note_id);
CREATE INDEX ar_credit_note_lines_source_line ON public.ar_credit_note_lines(source_invoice_line_id);

GRANT SELECT ON public.ar_credit_note_lines TO authenticated;
GRANT ALL ON public.ar_credit_note_lines TO service_role;
ALTER TABLE public.ar_credit_note_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ar_credit_note_lines read" ON public.ar_credit_note_lines FOR SELECT TO authenticated
  USING (public.can_access_property(auth.uid(), property_id));

-- ============================================================
-- PART D — READ ABSTRACTIONS: net balance
-- ============================================================

-- Scalar helper used internally by posting functions, always called after
-- the authoritative ar_invoices row is already locked FOR UPDATE in the
-- caller's transaction. Never a substitute for that lock on its own.
CREATE OR REPLACE FUNCTION public.ar_invoice_credited_total(_invoice_id UUID)
RETURNS NUMERIC LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(SUM(total), 0) FROM public.ar_credit_notes
    WHERE invoice_id = _invoice_id AND status = 'posted';
$$;

REVOKE EXECUTE ON FUNCTION public.ar_invoice_credited_total(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ar_invoice_credited_total(uuid) TO authenticated;

-- Consistent read model for consumption (UI/reporting). NOT used to gate
-- any posting decision — post_ar_credit_note()/post_ar_receipt() always
-- recompute credited_total fresh under their own row lock instead.
--
-- SECURITY: a plain view (security_invoker = false, the CREATE VIEW
-- default) checks permissions AND row-level security policies against the
-- VIEW OWNER — typically the migration-running role, which is exempt from
-- RLS as the table owner or via BYPASSRLS — not against the querying
-- client. Without security_invoker = true here, GRANT SELECT ... TO
-- authenticated would let any authenticated user of any property read
-- every other property's invoice balances straight through this view,
-- regardless of ar_invoices'/ar_credit_notes' own RLS policies. This
-- project has hit exactly this class of bug before and fixed it the same
-- way — see ALTER VIEW public.ar_aging SET (security_invoker = true) in
-- 20260705040652_ca91242d-63f8-4436-aa72-3c3d68f10a95.sql ("Aging views:
-- honor caller's RLS instead of view-owner permissions"), reapplied again
-- in 20260706002151_e5d271a3-0dc5-464a-bd70-f020a231e8ae.sql. Declaring it
-- explicitly on every CREATE OR REPLACE VIEW (rather than trusting a prior
-- ALTER VIEW to survive a later replace) is the safe, defensive form.
CREATE OR REPLACE VIEW public.ar_invoice_balances
WITH (security_invoker = true) AS
SELECT
  i.property_id,
  i.id AS invoice_id,
  i.total,
  i.amount_paid,
  public.ar_invoice_credited_total(i.id) AS credited_total,
  i.total - i.amount_paid - public.ar_invoice_credited_total(i.id) AS net_balance
FROM public.ar_invoices i;

-- Defensive redundancy: guarantees the option is set even if some future
-- CREATE OR REPLACE of this view ever drops the WITH clause, exactly the
-- failure mode ar_aging has hit twice in this repo's history.
ALTER VIEW public.ar_invoice_balances SET (security_invoker = true);

GRANT SELECT ON public.ar_invoice_balances TO authenticated;

-- Ageing release safety (see header note 10): balance/bucket now reflect
-- net_balance (which subtracts posted credit notes), not the old
-- total - amount_paid. Column list/order/types are unchanged from the
-- prior definition, so no dependent object needs to change.
--
-- SECURITY: security_invoker = true is REQUIRED here, same reasoning as
-- ar_invoice_balances above — this CREATE OR REPLACE VIEW supersedes the
-- original ar_aging definition (20260705040642), which did not carry this
-- option; only the two later ALTER VIEW migrations added it. Re-declaring
-- it explicitly here prevents this PR from silently reintroducing the
-- exact cross-property leak already fixed twice before.
CREATE OR REPLACE VIEW public.ar_aging
WITH (security_invoker = true) AS
SELECT i.property_id, i.id, i.code, i.bill_to_name, i.due_date, i.total, i.amount_paid,
  (i.total - i.amount_paid - public.ar_invoice_credited_total(i.id)) AS balance,
  GREATEST(0, (CURRENT_DATE - i.due_date))::int AS days_overdue,
  CASE
    WHEN i.total - i.amount_paid - public.ar_invoice_credited_total(i.id) <= 0 THEN 'paid'
    WHEN CURRENT_DATE <= i.due_date THEN 'current'
    WHEN CURRENT_DATE - i.due_date <= 30 THEN '1-30'
    WHEN CURRENT_DATE - i.due_date <= 60 THEN '31-60'
    WHEN CURRENT_DATE - i.due_date <= 90 THEN '61-90'
    ELSE '90+'
  END AS bucket
FROM public.ar_invoices i WHERE i.status <> 'void';

ALTER VIEW public.ar_aging SET (security_invoker = true);

GRANT SELECT ON public.ar_aging TO authenticated;

-- ============================================================
-- PART E — create_ar_credit_note()
-- ============================================================
-- _lines shape: [{"source_invoice_line_id": "<uuid>", "quantity": <number>}, ...]
-- Draft only — no journal, no capacity consumption. unit_price, tax_rate,
-- and revenue_account_id are always copied from the source invoice line,
-- never accepted from the caller.
CREATE OR REPLACE FUNCTION public.create_ar_credit_note(
  _property_id UUID,
  _invoice_id UUID,
  _issue_date DATE,
  _reason TEXT,
  _lines JSONB
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _inv RECORD;
  _source_line RECORD;
  _credit_note_id UUID;
  _code TEXT;
  _line JSONB;
  _quantity NUMERIC;
  _line_subtotal NUMERIC;
  _line_tax NUMERIC;
  _subtotal NUMERIC := 0;
  _tax NUMERIC := 0;
  _trimmed_reason TEXT;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id) THEN
    RAISE EXCEPTION 'Not permitted to create AR credit notes';
  END IF;

  _trimmed_reason := btrim(COALESCE(_reason, ''));
  IF char_length(_trimmed_reason) < 5 THEN
    RAISE EXCEPTION 'A credit note reason of at least 5 characters is required';
  END IF;
  IF char_length(_trimmed_reason) > 500 THEN
    RAISE EXCEPTION 'Credit note reason must be 500 characters or fewer';
  END IF;

  SELECT * INTO _inv FROM public.ar_invoices WHERE id = _invoice_id AND property_id = _property_id;
  IF _inv IS NULL THEN RAISE EXCEPTION 'Invoice not found for this property'; END IF;
  -- Only 'sent' is eligible, matching post_ar_credit_note()'s own
  -- eligibility exactly (V1 does not support crediting a fully paid
  -- invoice at all) — a draft created against a 'paid' invoice here would
  -- otherwise be permanently unpostable and never able to be cleaned up
  -- automatically, so create-time rejects it up front instead of letting
  -- users accumulate dead drafts.
  IF _inv.status <> 'sent' THEN
    RAISE EXCEPTION 'Credit notes can only be created against a sent invoice (status: %)', _inv.status;
  END IF;

  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'At least one credit note line is required';
  END IF;

  -- Reject a duplicate source_invoice_line_id within the same submission
  -- up front, with a clear error — the ar_credit_note_lines_note_source_uniq
  -- constraint below is the authoritative structural backstop regardless,
  -- but this gives an explicit rejection reason instead of a raw
  -- unique_violation, mirroring post_ar_receipt()'s identical
  -- duplicate-invoice-per-submission guard.
  IF (SELECT COUNT(DISTINCT value->>'source_invoice_line_id') FROM jsonb_array_elements(_lines)) <>
     jsonb_array_length(_lines) THEN
    RAISE EXCEPTION 'Each source invoice line may only appear once per credit note';
  END IF;

  _code := public.short_code('CN');

  INSERT INTO public.ar_credit_notes(
    property_id, code, invoice_id, customer_id, issue_date, currency, reason, created_by
  ) VALUES (
    _property_id, _code, _inv.id, _inv.customer_id, COALESCE(_issue_date, CURRENT_DATE), _inv.currency, _trimmed_reason, auth.uid()
  ) RETURNING id INTO _credit_note_id;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    IF (_line->>'source_invoice_line_id') IS NULL THEN
      RAISE EXCEPTION 'Credit note line is missing source_invoice_line_id';
    END IF;

    SELECT * INTO _source_line FROM public.ar_invoice_lines
      WHERE id = (_line->>'source_invoice_line_id')::UUID AND invoice_id = _inv.id;
    IF _source_line IS NULL THEN
      RAISE EXCEPTION 'Source invoice line not found on invoice %', _inv.code;
    END IF;

    _quantity := (_line->>'quantity')::NUMERIC;
    IF _quantity IS NULL OR _quantity <= 0 THEN
      RAISE EXCEPTION 'Credit note line quantity must be greater than zero';
    END IF;
    -- Early sanity check against the source line's ORIGINAL quantity.
    -- Non-authoritative: post_ar_credit_note() re-enforces the true
    -- REMAINING-quantity cap (accounting for prior posted credits) fresh
    -- under an invoice row lock at posting time.
    IF _quantity > _source_line.quantity THEN
      RAISE EXCEPTION 'Credit note line quantity % exceeds original invoice line quantity %', _quantity, _source_line.quantity;
    END IF;

    _line_subtotal := ROUND(_quantity * _source_line.unit_price, 4);
    _line_tax := ROUND(_line_subtotal * _source_line.tax_rate / 100, 4);

    INSERT INTO public.ar_credit_note_lines(
      property_id, credit_note_id, invoice_id, source_invoice_line_id,
      description, quantity, unit_price, tax_rate, revenue_account_id, subtotal, tax
    ) VALUES (
      _property_id, _credit_note_id, _inv.id, _source_line.id,
      _source_line.description, _quantity, _source_line.unit_price, _source_line.tax_rate,
      _source_line.revenue_account_id, _line_subtotal, _line_tax
    );

    _subtotal := _subtotal + _line_subtotal;
    _tax := _tax + _line_tax;
  END LOOP;

  UPDATE public.ar_credit_notes
    SET subtotal = _subtotal, tax = _tax, total = _subtotal + _tax
    WHERE id = _credit_note_id;

  RETURN _credit_note_id;
END; $$;

REVOKE EXECUTE ON FUNCTION public.create_ar_credit_note(uuid, uuid, date, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_ar_credit_note(uuid, uuid, date, text, jsonb) TO authenticated;

-- ============================================================
-- PART F — post_ar_credit_note()
-- ============================================================
CREATE OR REPLACE FUNCTION public.post_ar_credit_note(_id UUID) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cn RECORD; inv RECORD; ln RECORD;
  _period_id UUID;
  _net_balance NUMERIC;
  _posted_credit_total NUMERIC;
  _remaining_qty NUMERIC;
  _remaining_subtotal NUMERIC;
  _remaining_tax NUMERIC;
  _is_terminal BOOLEAN;
  _line_subtotal NUMERIC;
  _line_tax NUMERIC;
  _cum_qty NUMERIC;
  _cum_subtotal NUMERIC;
  _cum_tax NUMERIC;
  _orig_subtotal NUMERIC;
  _orig_tax NUMERIC;
  _lines JSONB := '[]'::jsonb;
  _sub NUMERIC := 0; _tax NUMERIC := 0; _total NUMERIC := 0;
  _ar UUID; _tax_acc UUID; _rev UUID; _entry UUID;
  _new_status ar_status;
  _new_balance NUMERIC;
BEGIN
  -- Primary defense against double-posting the SAME credit note
  -- concurrently: lock this row first, before any status decision.
  SELECT * INTO cn FROM public.ar_credit_notes WHERE id = _id FOR UPDATE;
  IF cn IS NULL THEN RAISE EXCEPTION 'Credit note not found'; END IF;

  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], cn.property_id) THEN
    RAISE EXCEPTION 'Not permitted to post an AR credit note';
  END IF;

  IF cn.status = 'posted' THEN
    RETURN cn.posted_entry_id;
  END IF;
  IF cn.status = 'void' THEN
    RAISE EXCEPTION 'Credit note % has been voided and cannot be posted', cn.code;
  END IF;
  IF cn.status <> 'draft' THEN
    RAISE EXCEPTION 'Credit note % is not in a postable state (status: %)', cn.code, cn.status;
  END IF;

  -- Secondary lock: the invoice row, for net-balance/capacity safety
  -- against other credit notes and receipts on the same invoice.
  SELECT * INTO inv FROM public.ar_invoices WHERE id = cn.invoice_id FOR UPDATE;
  IF inv IS NULL THEN RAISE EXCEPTION 'Linked invoice not found'; END IF;

  IF inv.status = 'draft' THEN
    RAISE EXCEPTION 'Invoice % is still a draft and has nothing to credit', inv.code;
  END IF;
  IF inv.status = 'void' THEN
    RAISE EXCEPTION 'Invoice % has been voided', inv.code;
  END IF;
  IF inv.status = 'paid' THEN
    RAISE EXCEPTION 'Invoice % is fully paid and cannot be credited in this version', inv.code;
  END IF;
  IF inv.status <> 'sent' THEN
    RAISE EXCEPTION 'Invoice % is not in a creditable state (status: %)', inv.code, inv.status;
  END IF;

  SELECT id INTO _period_id FROM public.accounting_periods
    WHERE property_id = cn.property_id AND CURRENT_DATE BETWEEN start_date AND end_date AND status IN ('locked','closed')
    LIMIT 1;
  IF _period_id IS NOT NULL THEN RAISE EXCEPTION 'Current accounting period is locked'; END IF;

  -- Fresh net balance under the invoice lock — never trust
  -- ar_invoice_balances for this decision.
  _posted_credit_total := public.ar_invoice_credited_total(inv.id);
  _net_balance := inv.total - inv.amount_paid - _posted_credit_total;

  -- Per-source-line cap: remaining quantity/subtotal/tax capacity,
  -- recomputed fresh under the same invoice lock. Because unit_price and
  -- tax_rate are copied and immutable, the quantity cap also enforces the
  -- monetary cap.
  FOR ln IN
    SELECT cnl.id, cnl.quantity, cnl.description, cnl.source_invoice_line_id,
           il.quantity AS source_quantity, il.unit_price AS source_unit_price,
           il.tax_rate AS source_tax_rate, il.revenue_account_id AS source_revenue_account_id
    FROM public.ar_credit_note_lines cnl
    JOIN public.ar_invoice_lines il ON il.id = cnl.source_invoice_line_id
    WHERE cnl.credit_note_id = cn.id
  LOOP
    SELECT COALESCE(SUM(x.quantity), 0), COALESCE(SUM(x.subtotal), 0), COALESCE(SUM(x.tax), 0)
      INTO _cum_qty, _cum_subtotal, _cum_tax
      FROM public.ar_credit_note_lines x
      JOIN public.ar_credit_notes xc ON xc.id = x.credit_note_id
      WHERE x.source_invoice_line_id = ln.source_invoice_line_id
        AND xc.status = 'posted';

    _orig_subtotal := ROUND(ln.source_quantity * ln.source_unit_price, 4);
    _orig_tax := ROUND(_orig_subtotal * ln.source_tax_rate / 100, 4);

    _remaining_qty := ln.source_quantity - _cum_qty;
    _remaining_subtotal := _orig_subtotal - _cum_subtotal;
    _remaining_tax := _orig_tax - _cum_tax;

    IF ln.quantity > _remaining_qty THEN
      RAISE EXCEPTION 'Credit note line quantity % exceeds remaining quantity % on source invoice line', ln.quantity, _remaining_qty;
    END IF;

    _is_terminal := (ln.quantity = _remaining_qty);

    IF _is_terminal THEN
      -- Exact remaining residual — guarantees cumulative posted credits
      -- can never exceed the original subtotal/tax and leaves zero
      -- rounding drift once a source line is fully credited.
      _line_subtotal := _remaining_subtotal;
      _line_tax := _remaining_tax;
    ELSE
      _line_subtotal := ROUND(ln.quantity * ln.source_unit_price, 4);
      _line_tax := ROUND(_line_subtotal * ln.source_tax_rate / 100, 4);
    END IF;

    UPDATE public.ar_credit_note_lines SET subtotal = _line_subtotal, tax = _line_tax WHERE id = ln.id;

    _rev := COALESCE(ln.source_revenue_account_id, public.resolve_account(cn.property_id,'ar_revenue','other_revenue'));
    _lines := _lines || jsonb_build_array(jsonb_build_object('account_id',_rev,'debit',_line_subtotal,'credit',0,'memo','Credit note '||cn.code||' — '||ln.description));

    _sub := _sub + _line_subtotal;
    _tax := _tax + _line_tax;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM public.ar_credit_note_lines WHERE credit_note_id = cn.id) THEN
    RAISE EXCEPTION 'Credit note % has no lines to post', cn.code;
  END IF;

  _total := _sub + _tax;

  -- Authoritative economic invariant: a credit note must never reduce
  -- net_balance below zero.
  IF _total > _net_balance THEN
    RAISE EXCEPTION 'Credit note % total % exceeds invoice % remaining net balance %', cn.code, _total, inv.code, _net_balance;
  END IF;

  _ar := public.resolve_account(cn.property_id,'ar_receivable','ar');
  _tax_acc := public.resolve_account(cn.property_id,'ar_tax','tax_payable');

  IF _tax > 0 THEN
    _lines := _lines || jsonb_build_array(jsonb_build_object('account_id',_tax_acc,'debit',_tax,'credit',0,'memo','Tax on credit note '||cn.code));
  END IF;
  _lines := _lines || jsonb_build_array(jsonb_build_object('account_id',_ar,'debit',0,'credit',_total,'memo','Credit note '||cn.code));

  _entry := public.post_journal(cn.property_id, cn.issue_date, cn.currency, 'AR Credit Note '||cn.code, 'ar', cn.id::text, _lines);

  UPDATE public.ar_credit_notes
    SET subtotal = _sub, tax = _tax, total = _total, status = 'posted', posted_entry_id = _entry
    WHERE id = cn.id;

  -- amount_paid is never touched by a credit note — it remains actual
  -- allocated receipt value only. Status advances to 'paid' only when the
  -- net balance reaches zero; no new invoice status is introduced.
  _new_balance := inv.total - inv.amount_paid - (_posted_credit_total + _total);
  _new_status := CASE WHEN _new_balance <= 0 THEN 'paid'::ar_status ELSE inv.status END;
  UPDATE public.ar_invoices SET status = _new_status WHERE id = inv.id;

  INSERT INTO public.admin_action_logs(
    property_id, actor_id, entity_type, entity_id, action, before_snapshot, after_snapshot, memo
  ) VALUES (
    cn.property_id, auth.uid(), 'ar_credit_note', cn.id::text, 'update',
    jsonb_build_object('status', 'draft', 'code', cn.code, 'invoiceId', cn.invoice_id),
    jsonb_build_object('status', 'posted', 'code', cn.code, 'invoiceId', cn.invoice_id, 'postedEntryId', _entry, 'total', _total, 'reason', cn.reason),
    'AR credit note '||cn.code||' posted against invoice '||inv.code
  );

  RETURN _entry;
END; $$;

REVOKE EXECUTE ON FUNCTION public.post_ar_credit_note(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_ar_credit_note(uuid) TO authenticated;

-- ============================================================
-- PART G — post_ar_receipt(): net-balance correction (mandatory, same PR)
-- ============================================================
-- Identical signature/shape to the existing function (20260807120000). Only
-- the remaining-balance and status-flip formulas change, to account for
-- posted credit notes. A receipt must never allow
-- amount_paid + posted_credit_total > invoice.total.
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
  _inv RECORD; _remaining NUMERIC; _credited NUMERIC;
  _cash UUID; _ar UUID; _lines JSONB;
  _entry UUID;
  _new_paid NUMERIC; _new_status ar_status;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant','front_desk']::app_role[], _property_id) THEN
    RAISE EXCEPTION 'Not permitted to record an AR receipt';
  END IF;

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

  IF (SELECT COUNT(DISTINCT value->>'invoice_id') FROM jsonb_array_elements(_allocations)) <>
     jsonb_array_length(_allocations) THEN
    RAISE EXCEPTION 'Each invoice may only appear once per receipt';
  END IF;

  _receipt_code := public.short_code('RCT');

  -- Pass 2: lock and validate every allocated invoice, in a deterministic
  -- order (by invoice_id) so two concurrent receipts touching overlapping
  -- invoices can't deadlock each other. This is also the lock
  -- post_ar_credit_note() itself takes on the invoice, so a receipt and a
  -- concurrent credit-note post against the same invoice serialize safely.
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

    -- Net balance: total minus prior receipts minus posted credit notes.
    -- amount_paid + posted_credit_total must never exceed invoice.total.
    _credited := public.ar_invoice_credited_total(_inv.id);
    _remaining := _inv.total - _inv.amount_paid - _credited;
    IF _alloc_amount > _remaining THEN
      RAISE EXCEPTION 'Allocation % for invoice % exceeds its remaining net balance %', _alloc_amount, _inv.code, _remaining;
    END IF;
  END LOOP;

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
  -- The invoice row lock acquired in pass 2 is still held here (locks
  -- persist for the whole transaction), so credited_total cannot have
  -- changed between passes.
  FOR _alloc IN SELECT * FROM jsonb_array_elements(_allocations) LOOP
    _invoice_id := (_alloc->>'invoice_id')::UUID;
    _alloc_amount := (_alloc->>'amount')::NUMERIC;

    INSERT INTO public.ar_receipt_allocations(property_id, receipt_id, invoice_id, amount)
    VALUES (_property_id, _receipt_id, _invoice_id, _alloc_amount);

    SELECT * INTO _inv FROM public.ar_invoices WHERE id=_invoice_id FOR UPDATE;
    _credited := public.ar_invoice_credited_total(_inv.id);
    _new_paid := _inv.amount_paid + _alloc_amount;
    -- Status flips to 'paid' when the net balance reaches zero, i.e. once
    -- posted credits are also accounted for — not merely amount_paid >= total.
    _new_status := CASE WHEN (_inv.total - _new_paid - _credited) <= 0 THEN 'paid'::ar_status ELSE _inv.status END;
    UPDATE public.ar_invoices SET amount_paid = _new_paid, status = _new_status WHERE id = _invoice_id;
  END LOOP;

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

REVOKE EXECUTE ON FUNCTION public.post_ar_receipt(uuid, date, payment_method, text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_ar_receipt(uuid, date, payment_method, text, text, text, jsonb) TO authenticated;

-- ============================================================
-- PART H — reverse_ar_invoice(): posted credit-note guard (mandatory,
-- shipped atomically with post_ar_credit_note(), not deferred)
-- ============================================================
-- reverse_ar_invoice() (20260818090000) predates credit notes and knows
-- nothing about them. Its existing eligibility guards (status='sent',
-- amount_paid=0, zero ar_receipt_allocations rows) do not cover a sent,
-- unpaid invoice that has a POSTED credit note against it — that invoice
-- would sail through every existing check and get reversed while the
-- credit note's own journal entry (which reduced revenue/tax/AR computed
-- against THIS invoice's lines) remains posted and economically active.
-- That leaves a permanently unreconciled journal: the credit note's DR
-- revenue/DR tax/CR AR lines have no corresponding invoice revenue left to
-- offset once the original invoice posting is reversed out from under it.
--
-- This is identical in shape to the amount_paid/ar_receipt_allocations
-- guards already in reverse_ar_invoice() — same function, same invoice
-- row lock, same "reject outright rather than attempt a combined
-- reversal" posture (a combined invoice+credit-note reversal is out of
-- scope for this version, same as receipt-aware reversal already is).
--
-- Implemented as a full CREATE OR REPLACE FUNCTION here (not an ALTER) —
-- this migration only adds new objects and never edits a historical
-- migration file in place, so the corrected body is redeclared under the
-- same signature, exactly as post_ar_receipt() is redeclared above. The
-- later migration timestamp means this definition is what actually runs;
-- the original file's text (and its own test file, which reads that
-- file's text) is left untouched and still describes the original,
-- still-true behavior for every guard other than this new one.
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

  -- New guard (this migration): a posted credit note against this invoice
  -- blocks reversal outright, the same posture as the amount_paid/
  -- ar_receipt_allocations guards immediately above. Draft and void credit
  -- notes never reach this far (they carry no journal entry and never
  -- affected the invoice), so they do not block reversal.
  IF EXISTS (
    SELECT 1 FROM public.ar_credit_notes WHERE invoice_id = inv.id AND status = 'posted'
  ) THEN
    RAISE EXCEPTION 'Invoice % has posted credit notes and cannot be reversed in this version', inv.code;
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

  -- Direct insert, not the admin_log() RPC — see the original migration's
  -- header comment (point 7) for why: admin_log()'s own role check
  -- excludes 'accountant'.
  INSERT INTO public.admin_action_logs(
    property_id, actor_id, entity_type, entity_id, action, before_snapshot, after_snapshot, memo
  ) VALUES (
    inv.property_id, auth.uid(), 'ar_invoice', inv.id::text, 'update',
    jsonb_build_object('status', inv.status, 'code', inv.code, 'postedEntryId', inv.posted_entry_id),
    jsonb_build_object('status', 'void', 'code', inv.code, 'postedEntryId', inv.posted_entry_id, 'reversalEntryId', _reversal_entry, 'reason', _trimmed_reason),
    'AR invoice '||inv.code||' reversed: '||_trimmed_reason
  );

  RETURN _reversal_entry;
END; $$;

REVOKE EXECUTE ON FUNCTION public.reverse_ar_invoice(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_ar_invoice(uuid, text) TO authenticated;
