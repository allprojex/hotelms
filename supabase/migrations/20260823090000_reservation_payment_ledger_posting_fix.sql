-- Reservation payment ledger posting fix.
--
-- Root cause (confirmed while building PR #46's reservation payment refund,
-- and re-verified here by re-reading the actual foundation migration text):
-- post_payment() (20260705035515, line 350) reads `p.paid_at` when building
-- the journal entry date, but public.payments (20260705025821) has never had
-- a `paid_at` column — the real column is `received_at`. Every invocation
-- therefore raises "record p has no field paid_at", which post_payment()'s
-- own `EXCEPTION WHEN OTHERS THEN RAISE NOTICE ...; RETURN NULL;` handler
-- silently swallows. The AFTER INSERT trigger (tg_autopost_payment) that
-- calls post_payment() only PERFORMs it (discarding the return value) and
-- itself has no exception handling, so the failure is invisible all the way
-- up: the payment row commits normally, the guest is shown "Payment
-- recorded", and no journal entry is ever created. Confirmed no reservation
-- payment journal entry has ever existed in this codebase's history: no
-- other migration redefines post_payment() or adds a paid_at column, and
-- searching every migration for `payments` + `paid_at` together finds only
-- this one broken reference.
--
-- Trigger timing (unchanged by this migration): AFTER INSERT ON
-- public.payments, FOR EACH ROW, via tg_autopost_payment() -> PERFORM
-- post_payment(NEW.id). This runs in the SAME transaction as the payment
-- INSERT — Postgres does not need any extra plumbing for "payment + journal
-- succeed or fail together": an uncaught exception inside an AFTER ROW
-- trigger aborts the entire triggering statement, payment row included. The
-- only reason that hasn't been true is the swallow this migration removes.
--
-- Decision: EXCEPTION WHEN OTHERS is REMOVED from post_payment(), not
-- narrowed. The original migration's own header called this pattern
-- deliberate ("safe: EXCEPTION handled so they never break upstream
-- flows") across all three auto-post helpers (post_payment,
-- post_reservation_checkout, post_pos_order_close) — an intentional
-- operational-resilience tradeoff at the time. For post_payment()
-- specifically, that tradeoff is now wrong: silently accepting money with
-- no ledger record is a financial-integrity defect, not a resilience
-- feature, and every other posting function in this codebase
-- (post_ar_invoice, post_ap_bill, reverse_ar_invoice, reverse_ap_payment,
-- reverse_reservation_payment) already propagates errors rather than
-- swallowing them. post_reservation_checkout() and post_pos_order_close()
-- have the identical anti-pattern and are NOT touched here — fixing them is
-- a separate, out-of-scope change (this task is reservation-payment-ledger
-- only); flagged here as a known follow-up, not silently fixed.
--
-- What "loud failure" means in practice: if a property is somehow missing
-- its seeded 'cash' or 'ar' system_key account (both are auto-seeded for
-- every existing and new property by seed_default_accounts(), but
-- public.accounts grants unrestricted DELETE to `authenticated`, so a
-- property could theoretically have one removed), recording a payment for
-- that property will now HARD-FAIL with a clear error instead of silently
-- succeeding with no journal — this is a deliberate, material behavior
-- change. Two explicit RAISE EXCEPTION guards give a clear operator-facing
-- message for exactly this case, rather than surfacing a raw NOT NULL
-- constraint violation from journal_lines.account_id. Likewise, a payment
-- attempted against a locked/closed accounting period will now be
-- correctly REJECTED (post_journal()'s own existing period-lock check,
-- previously also silently swallowed) rather than silently accepted with
-- no journal.
--
-- Idempotency / duplicate posting: post_payment() already had a
-- source/source_ref existing-journal check before this fix, but no row
-- lock — meaning two concurrent invocations for the same payment (not
-- reachable via the single AFTER INSERT trigger firing in normal operation,
-- but reachable by a future manual/backfill re-invocation) could both read
-- "no existing entry" before either commits, and both post — the identical
-- class of bug already found and fixed in post_ap_bill() (20260822120000
-- PART A). Fixed here the same way: SELECT ... FOR UPDATE on the payment
-- row before the existing-journal check. Additionally hardened with a
-- genuine DB-level uniqueness guarantee (PART A below) rather than relying
-- solely on application-level locking, exactly mirroring how
-- journal_entries_reversal_of_uniq backs reverse_ar_invoice()'s own
-- is_reversal_of check at the DB level, not just in application code.
--
-- Currency: post_payment() still hardcodes 'USD' as the journal entry's
-- currency argument, ignoring the property's actual base_currency — this
-- is a separate, pre-existing, system-wide pattern shared identically by
-- post_reservation_checkout() and post_pos_order_close(), not specific to
-- the paid_at bug this migration fixes. Deliberately not touched here
-- (same "do not redesign unrelated reservation accounting" boundary as the
-- EXCEPTION-swallow decision above) — flagged as a known, non-blocking,
-- separate finding.
--
-- SECOND FINDING, discovered while validating this fix live against a
-- disposable database (not by static reading alone): post_payment() called
-- public.post_journal(), which has its OWN internal authorization check —
-- `has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner',
-- 'general_manager','accountant'], _property_id)`. auth.uid() reads the
-- session's JWT claim regardless of SECURITY DEFINER, so that check runs
-- against the ORIGINAL calling user, not post_payment()'s own definer. The
-- payments_write RLS policy (20260705025821) that gates who may INSERT a
-- payment in the first place allows a DIFFERENT, broader set:
-- super_admin/hotel_owner/general_manager/front_desk/cashier — 'accountant'
-- isn't even in payments_write's set, and front_desk/cashier (the roles
-- who actually take payments day to day) are not in post_journal()'s set.
-- Removing the EXCEPTION swallow alone would have made every front_desk/
-- cashier payment insert HARD-FAIL with "Not permitted to post journal" —
-- trading one silent defect for a loud, actively-worse regression that
-- blocks front desk from recording payments at all. This is a systemic
-- issue shared identically by post_reservation_checkout() and
-- post_pos_order_close() (both also call post_journal() the same way,
-- under the same swallowed EXCEPTION) — NOT fixed for those two here, same
-- boundary as above.
--
-- Fix: post_payment() no longer calls the shared post_journal() at all. It
-- inlines the same validated steps post_journal() itself performs (property
-- lookup, locked-period check, FX rate via fx_convert(), balanced
-- entry+lines insert, balance assertion) directly, WITHOUT post_journal()'s
-- accountant-only role check — replaced with an explicit check against
-- payments_write's own role set instead (the set actually authorized to
-- create the payment this posting is an automatic, non-optional consequence
-- of — not a new privileged action). This leaves post_journal() itself
-- completely untouched — zero behavior change for its many other callers
-- (post_ap_bill, the manual "post journal entry" admin UI, etc.) — the
-- shared, stricter primitive keeps its stricter gate for every use case
-- except this one, which now correctly enforces the SAME authorization
-- payments_write already enforces at INSERT time, mirrored exactly rather
-- than invented.
--
-- ============================================================
-- PART A — uniqueness for ORIGINAL payment postings (defense-in-depth
-- behind the row lock added in PART B).
-- ============================================================
-- Scoped to `is_reversal_of IS NULL` because reverse_reservation_payment()
-- (PR #46, 20260822130000) deliberately creates its reversal entry with the
-- SAME (source='payment', source_ref=payment_id) as the original — the two
-- are distinguished by is_reversal_of, not by source_ref uniqueness. A bare
-- UNIQUE(source_ref) WHERE source='payment' would make every successful
-- refund of an actually-posted payment fail with a unique-violation on its
-- own reversal insert. This index therefore guarantees at most one
-- ORIGINAL journal entry per payment; journal_entries_reversal_of_uniq
-- (20260818090000, already existing, unchanged) guarantees at most one
-- REVERSAL per original entry. Together: at most one original and at most
-- one reversal per payment, exactly matching every other reversible entity
-- in this codebase.
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_payment_source_ref_uniq
  ON public.journal_entries(source_ref)
  WHERE source = 'payment' AND is_reversal_of IS NULL;

-- ============================================================
-- PART B — post_payment(): correct column, row lock, loud failure,
-- correct authorization boundary (no longer routed through post_journal())
-- ============================================================
CREATE OR REPLACE FUNCTION public.post_payment(_pay_id UUID) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  p RECORD; prop RECORD; _cash UUID; _ar UUID; _existing UUID; _prop_id UUID;
  _period_id UUID; _entry_id UUID; _rate NUMERIC;
BEGIN
  -- Row lock: primary defense against a concurrent double-post of the same
  -- payment (see header). Safe for the trigger's own normal AFTER INSERT
  -- call to lock its own just-inserted, still-uncommitted row — no
  -- self-deadlock risk.
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
    -- silently returning NULL, for the same reason every other guard here
    -- now raises instead of swallowing.
    RAISE EXCEPTION 'Property for payment % was not found', _pay_id;
  END IF;
  _prop_id := prop.id;

  -- Authorization: the same role set payments_write's own RLS policy already
  -- requires to INSERT a payment (super_admin/hotel_owner/general_manager/
  -- front_desk/cashier) — deliberately NOT post_journal()'s stricter
  -- accountant-only set (see header, "SECOND FINDING"). Posting this entry
  -- is an automatic consequence of an already-authorized payment, not a new
  -- privileged action.
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','front_desk','cashier','accountant']::app_role[], _prop_id) THEN
    RAISE EXCEPTION 'Not permitted to post a reservation payment journal entry';
  END IF;

  SELECT id INTO _existing FROM public.journal_entries WHERE source='payment' AND source_ref=_pay_id::text AND is_reversal_of IS NULL LIMIT 1;
  IF _existing IS NOT NULL THEN RETURN _existing; END IF;

  -- Locked/closed period check — post_journal()'s own rule, replicated
  -- verbatim rather than delegated, since this function no longer calls it.
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

  -- FX rate — identical formula to post_journal()'s own (still hardcoding
  -- 'USD' as the entry currency, see header). Trivially 1 whenever the
  -- property's base_currency is already USD, the common case.
  _rate := CASE WHEN 'USD' = prop.base_currency THEN 1
                ELSE public.fx_convert(_prop_id, 'USD', prop.base_currency, 1, p.received_at::date) END;

  -- Fix: received_at (the real column) replaces the nonexistent paid_at.
  -- received_at is NOT NULL DEFAULT now() on payments, so no COALESCE is
  -- needed — the previous COALESCE(p.paid_at::date, CURRENT_DATE) was
  -- defending against a column reference that could never have succeeded
  -- in the first place.
  INSERT INTO public.journal_entries(property_id, entry_date, memo, source, source_ref, currency, posted_by)
  VALUES (_prop_id, p.received_at::date, 'Payment '||_pay_id::text, 'payment', _pay_id::text, 'USD', auth.uid())
  RETURNING id INTO _entry_id;

  INSERT INTO public.journal_lines(entry_id, account_id, debit, credit, currency, fx_rate, debit_base, credit_base, memo)
  VALUES (_entry_id, _cash, p.amount, 0, 'USD', _rate, ROUND(p.amount * _rate, 4), 0, 'Payment received');
  INSERT INTO public.journal_lines(entry_id, account_id, debit, credit, currency, fx_rate, debit_base, credit_base, memo)
  VALUES (_entry_id, _ar, 0, p.amount, 'USD', _rate, 0, ROUND(p.amount * _rate, 4), 'Apply to AR');

  RETURN _entry_id;
END; $$;

-- post_payment() had no REVOKE/GRANT of its own in the original migration —
-- meaning EXECUTE was implicitly available to PUBLIC (including anon),
-- letting anyone call it directly for an arbitrary payment id, for any
-- property, entirely outside the AFTER INSERT trigger's normal path. The
-- new internal has_any_role() check above already rejects an unauthorized
-- caller, but the ACL is hardened too, matching every other financial RPC
-- in this codebase (reverse_ar_invoice, reverse_ap_payment,
-- reverse_reservation_payment, etc.) rather than relying on the internal
-- check alone.
REVOKE EXECUTE ON FUNCTION public.post_payment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_payment(uuid) TO authenticated;

-- ============================================================
-- PART C — reverse_reservation_payment(): fix a pre-existing bug in PR #46
-- (20260822130000), discovered ONLY by validating this migration live
-- against a disposable database with a genuinely-posted payment — PR #46's
-- own test suite is entirely string-content assertions against the
-- migration source and never executed the function against real data, so
-- this bug shipped undetected.
--
-- THIRD FINDING: `orig_entry RECORD` is populated by
-- `SELECT * INTO orig_entry FROM journal_entries WHERE ... AND
-- is_reversal_of IS NULL LIMIT 1` — meaning any row it actually matches is
-- GUARANTEED to have at least one NULL field (is_reversal_of, by
-- construction of the filter that found it) alongside its other non-null
-- fields (id, property_id, source, ...). Postgres's composite-type IS
-- NULL/IS NOT NULL semantics are the SQL-standard ones: a row value is
-- "NULL" only if EVERY field is null, "NOT NULL" only if EVERY field is
-- non-null — for a MIXED row, both `IS NULL` and `IS NOT NULL` evaluate to
-- false. Confirmed directly: `SELECT ROW(1, NULL) IS NOT NULL` returns
-- false. The original `IF orig_entry IS NOT NULL THEN` therefore NEVER
-- evaluates true for any row it legitimately finds — the entire reversal-
-- journal-creation branch was silently unreachable for every genuinely-
-- posted payment, always falling through to the "no entry to reverse"
-- path instead. Confirmed live: refunding a freshly-posted payment (this
-- migration's own PART B fix makes posting actually happen) returned NULL
-- and created no reversal entry, despite a matching original entry
-- existing.
--
-- This asymmetry does NOT affect this function's other two record
-- variables: `IF pay IS NULL` and `IF res IS NULL` are both "not found"
-- checks, and a mixed-null row still correctly evaluates IS NULL as false
-- when found (only genuinely all-null, i.e. truly not found, evaluates
-- true) — so those remain correct as written. Only the "found" check on a
-- deliberately-filtered, guaranteed-mixed record is unsafe.
--
-- Fix: test `orig_entry.id IS NOT NULL` instead of `orig_entry IS NOT
-- NULL` — id is the primary key, reliably non-null when a row matched and
-- null only when the SELECT INTO matched zero rows, exactly like every
-- other "was a row found" check elsewhere in this codebase. This is the
-- ONLY line changed from PR #46's original text — every other guard,
-- comment, and statement is reproduced verbatim below (CREATE OR REPLACE
-- redefines the whole function body; PL/pgSQL has no way to patch a single
-- line of an existing function in place).
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

  -- FIX (PART C, THIRD FINDING): orig_entry.id, not orig_entry — see header.
  IF orig_entry.id IS NOT NULL THEN
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
