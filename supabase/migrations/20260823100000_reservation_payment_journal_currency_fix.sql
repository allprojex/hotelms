-- Reservation payment journal currency fix.
--
-- Root cause (confirmed by a live, read-only production audit — see the
-- "HOTEL PMS — RESERVATION PAYMENT PRE-RELEASE AUDIT REPORT" this migration
-- follows from, not repeated in full here): post_payment()
-- (20260823090000, PART B) still hardcoded 'USD' as every new journal
-- entry's currency. Production's actual currency for every real property
-- with reservation activity is GHS (Theskwoff hotel: currency='GHS',
-- base_currency='GHS') — never USD. Deploying the 20260823090000 fix as-is
-- would have posted every new reservation payment's journal entry tagged
-- 'USD' while representing real GHS cash movements, and — because
-- 'USD' <> prop.base_currency('GHS') — routed through post_journal()'s own
-- FX-rate branch (now inlined here) using whatever GHS/USD rate happens to
-- exist in fx_rates, rather than posting the true GHS amount 1:1. A correct
-- fix was required before that migration's fix could safely ship.
--
-- Phase 1 — authoritative currency source, confirmed from repository
-- evidence, not assumed:
--
--   - public.payments and public.reservation_charges have no currency
--     column at all (confirmed again here — unchanged since 20260822130000's
--     own investigation). There is no "transaction currency" distinct from
--     the property's own currency anywhere in this schema for reservation
--     payments — payments.amount has only ever meant "this many units of
--     whatever currency this reservation's property uses."
--
--   - properties has TWO currency-shaped columns: `currency` (foundation,
--     20260705025821, NOT NULL DEFAULT 'USD' — used for UI display only:
--     reservations.$id.tsx, book.index.tsx, book.results.tsx,
--     book.checkout.$roomTypeId.tsx all read this one, defaulting to
--     "GHS" client-side) and `base_currency` (accounting phase 1,
--     20260705035515, NOT NULL DEFAULT 'USD', REFERENCES currencies(code)
--     — used by post_journal()'s own FX-rate comparison, by
--     pdf.functions.ts's folio PDF, and by fx_convert()). These are
--     usually equal but are NOT guaranteed to be — the production audit
--     itself found one property (ThesKwoff Bar) where they differ
--     (currency='GHS', base_currency='AUD'; see PART C below). For
--     *accounting* purposes specifically, base_currency is the
--     unambiguous authoritative field: it is the one every other
--     accounting-side function already treats as ground truth
--     (post_journal()'s `_rate := CASE WHEN _currency=_prop.base_currency
--     THEN 1 ELSE fx_convert(...)`), and `currency` is never referenced
--     anywhere in accounts/journal_entries/journal_lines/accounting_periods
--     code — only in UI display components.
--
--   - post_reservation_checkout() and post_pos_order_close()
--     (20260705035515) both have the identical hardcoded-'USD' pattern.
--     Confirmed unchanged, deliberately not fixed here — same
--     "reservation-payment-specific, not a general accounting redesign"
--     boundary already documented in 20260823090000's own header. Both
--     would benefit from the identical fix in a future, separate PR.
--
-- Conclusion: post_payment() should post directly in
-- properties.base_currency, at rate 1 — not "preserve a transaction
-- currency separately", because no such separate currency exists anywhere
-- in the schema to preserve. This is not a new design decision so much as
-- removing a hardcoded literal that never had any basis in the data model
-- to begin with.
--
-- ============================================================
-- post_payment(): journal currency derived from the payment's own
-- reservation's property.base_currency, not a hardcoded literal.
-- ============================================================
CREATE OR REPLACE FUNCTION public.post_payment(_pay_id UUID) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  p RECORD; prop RECORD; _cash UUID; _ar UUID; _existing UUID; _prop_id UUID;
  _period_id UUID; _entry_id UUID; _currency TEXT;
BEGIN
  -- Row lock: primary defense against a concurrent double-post of the same
  -- payment. Safe for the trigger's own normal AFTER INSERT call to lock
  -- its own just-inserted, still-uncommitted row — no self-deadlock risk.
  SELECT * INTO p FROM public.payments WHERE id=_pay_id FOR UPDATE;
  IF p IS NULL THEN
    RAISE EXCEPTION 'Payment % not found', _pay_id;
  END IF;

  SELECT * INTO prop FROM public.properties pr
    WHERE pr.id = (SELECT property_id FROM public.reservations WHERE id = p.reservation_id);
  IF prop IS NULL THEN
    -- Structurally unreachable: payments.reservation_id is NOT NULL
    -- REFERENCES reservations(id), and reservations.property_id is NOT NULL
    -- REFERENCES properties(id) — kept as an explicit guard rather than
    -- silently returning NULL.
    RAISE EXCEPTION 'Property for payment % was not found', _pay_id;
  END IF;
  _prop_id := prop.id;

  -- Currency: properties.base_currency, the same authoritative field
  -- post_journal()'s own FX-rate comparison, the folio PDF, and every
  -- other accounting-side consumer already treat as ground truth — never a
  -- hardcoded literal. base_currency is NOT NULL at the schema level
  -- (properties.base_currency ... NOT NULL DEFAULT 'USD', 20260705035515)
  -- and FK-constrained to an existing currencies.code (RESTRICT — a
  -- referenced currency row cannot be deleted while any property still
  -- points at it), so both branches below are structurally unreachable for
  -- any correctly-inserted property row — kept explicit anyway, matching
  -- this function's own established "guard rather than assume" pattern
  -- (see the `prop IS NULL` check above, same rationale).
  _currency := prop.base_currency;
  IF _currency IS NULL OR btrim(_currency) = '' THEN
    RAISE EXCEPTION 'Property % has no valid base currency configured — cannot post a payment journal entry', _prop_id;
  END IF;

  -- Authorization: the same role set payments_write's own RLS policy already
  -- requires to INSERT a payment (super_admin/hotel_owner/general_manager/
  -- front_desk/cashier) — deliberately NOT post_journal()'s stricter
  -- accountant-only set. Unchanged from 20260823090000.
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','front_desk','cashier','accountant']::app_role[], _prop_id) THEN
    RAISE EXCEPTION 'Not permitted to post a reservation payment journal entry';
  END IF;

  SELECT id INTO _existing FROM public.journal_entries WHERE source='payment' AND source_ref=_pay_id::text AND is_reversal_of IS NULL LIMIT 1;
  IF _existing IS NOT NULL THEN RETURN _existing; END IF;

  -- Locked/closed period check — unchanged from 20260823090000.
  SELECT id INTO _period_id FROM public.accounting_periods
    WHERE property_id = _prop_id AND p.received_at::date BETWEEN start_date AND end_date AND status IN ('locked','closed')
    LIMIT 1;
  IF _period_id IS NOT NULL THEN RAISE EXCEPTION 'Accounting period is locked'; END IF;

  SELECT id INTO _cash FROM public.accounts WHERE property_id=_prop_id AND system_key='cash';
  SELECT id INTO _ar FROM public.accounts WHERE property_id=_prop_id AND system_key='ar';
  IF _cash IS NULL THEN
    RAISE EXCEPTION 'No cash account configured for this property (system_key=cash) — accounting setup is incomplete';
  END IF;
  IF _ar IS NULL THEN
    RAISE EXCEPTION 'No AR account configured for this property (system_key=ar) — accounting setup is incomplete';
  END IF;

  -- No FX conversion: the entry's currency IS the property's own
  -- base_currency by construction (see above) — there is no other
  -- "transaction currency" in this schema for it to ever differ from, so
  -- fx_rate is always exactly 1 and debit_base/credit_base always equal
  -- debit/credit exactly. This is not "the common case of a 1:1 rate" the
  -- way the previous 'USD' hardcode's comment claimed — it is now the ONLY
  -- case, unconditionally, so no CASE/fx_convert() branch exists at all
  -- (removing one instead of leaving an unreachable ELSE branch around).
  INSERT INTO public.journal_entries(property_id, entry_date, memo, source, source_ref, currency, posted_by)
  VALUES (_prop_id, p.received_at::date, 'Payment '||_pay_id::text, 'payment', _pay_id::text, _currency, auth.uid())
  RETURNING id INTO _entry_id;

  INSERT INTO public.journal_lines(entry_id, account_id, debit, credit, currency, fx_rate, debit_base, credit_base, memo)
  VALUES (_entry_id, _cash, p.amount, 0, _currency, 1, p.amount, 0, 'Payment received');
  INSERT INTO public.journal_lines(entry_id, account_id, debit, credit, currency, fx_rate, debit_base, credit_base, memo)
  VALUES (_entry_id, _ar, 0, p.amount, _currency, 1, 0, p.amount, 'Apply to AR');

  RETURN _entry_id;
END; $$;

-- Grants unchanged from 20260823090000 (CREATE OR REPLACE preserves
-- existing grants on an unchanged function signature) — no REVOKE/GRANT
-- needed here.

-- ============================================================
-- reverse_reservation_payment() — reviewed, NOT changed. It already builds
-- its reversal entry using `orig_entry.currency` (copied directly from
-- whatever currency the original entry was actually posted in — see
-- 20260822130000's INSERT INTO journal_entries(...) VALUES (...,
-- orig_entry.currency, ...)), never a hardcoded literal. It was already
-- currency-agnostic by construction: refunding a payment newly posted
-- under this fix (currency = the property's base_currency, e.g. 'GHS')
-- correctly creates a 'GHS' reversal with no code change required. Every
-- journal_lines row it copies also carries its own currency/fx_rate
-- verbatim from the original, so a mixed-currency history (e.g. a
-- property whose base_currency changes between two payments) would still
-- reverse each entry in its own original currency, exactly.
-- ============================================================
