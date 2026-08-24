-- Reservation payment PARTIAL refund.
--
-- Client request: extend the existing full-refund-only reservation payment
-- refund (20260822130000, PR #46) to support partial and repeated-partial
-- refunds of a single payment, with a server-authoritative remaining-
-- refundable balance, matching the client's own broader Reservation Refund
-- workflow request.
--
-- Phase 1 investigation findings (repository evidence, not assumption):
--
-- 1. 20260822130000's own header explicitly scoped ITSELF to full refund
--    only and explicitly deferred partial refund: "Partial refund
--    (refunding less than a payment's full amount) is NOT implemented...
--    explicitly deferred to a later PR if ever requested." This is that PR.
--
-- 2. reverse_reservation_payment(_id, _reason) is unconditional: every
--    successful call sets payments.status='void' and reverses the ENTIRE
--    original journal entry, with no amount parameter. Its own 391-line
--    test suite (tests/reservation-payment-refund.test.ts) asserts exact
--    byte-level content of its migration file and function body. This
--    migration deliberately does NOT modify that function, its migration
--    file, or its table columns — that test suite is left fully intact
--    and passing, unchanged.
--
-- 3. CRITICAL CONSTRAINT FINDING: journal_entries_reversal_of_uniq
--    (20260818090000) is `UNIQUE(is_reversal_of)` — enforcing AT MOST ONE
--    reversal entry per original entry, globally. This is the correct
--    invariant for a single full reversal (AR/AP/the existing full
--    reservation-payment refund) but is structurally incompatible with
--    MULTIPLE partial refunds against the SAME original payment entry: a
--    second partial refund's journal entry cannot also set
--    is_reversal_of = <the same original entry id> without violating that
--    unique index. Weakening or dropping that index was considered and
--    rejected — it is a load-bearing invariant shared by AR/AP reversal,
--    protecting against an actual double-reversal bug class elsewhere in
--    this codebase; touching it for this feature would risk correctness
--    everywhere else it is relied on.
--
--    Resolution: each partial refund's journal entry (when one is created
--    at all — see finding 6) uses its OWN new source tag,
--    source='payment_refund', source_ref=<this refund event's own row id>,
--    and never sets is_reversal_of. Traceability back to the original
--    payment is via reservation_payment_refunds.payment_id (the new table
--    below), not via journal_entries.is_reversal_of. This does not touch,
--    weaken, or reinterpret is_reversal_of's existing one-reversal-per-
--    entry meaning anywhere else in the schema.
--
-- 4. Event-ledger model, not a mutable running total: mirrors
--    reservation_item_distributions (20260823170000) exactly — every
--    refund is its own immutable INSERT-only row referencing the payment
--    it refunds, never a mutation of the payment row's own amount. The
--    "remaining refundable amount" is ALWAYS computed as
--    payment.amount - SUM(reservation_payment_refunds.amount WHERE
--    payment_id = payment.id), both server-side (authoritative, under a
--    row lock) and client-side (display only, never trusted) — exactly
--    reservation_item_distributions' own established "outstanding" pattern
--    (see outstandingFor() in reservations.$id.tsx), not a new concept.
--    This also matches 20260822130000's own explicit precedent AGAINST
--    introducing a stored running-total column on payments/reservations
--    ("There is no reservations.amount_paid column to keep in sync...").
--    No new column is added to payments for this purpose.
--
-- 5. Idempotency: identical pattern to reservation_item_distributions'
--    three RPCs — a caller-supplied `_request_id UUID`, a
--    `pg_advisory_xact_lock` keyed on it (serializing even two genuinely
--    concurrent identical calls), and `UNIQUE(property_id, request_id)` on
--    the new table, checked immediately after the lock and before any
--    other validation — a replayed request returns the SAME already-
--    committed refund id, never a second financial effect. Not a new
--    pattern invented for this feature.
--
-- 6. Original journal entry may not exist: unchanged from 20260822130000's
--    own finding 3 — historical payments recorded before 20260823090000's
--    ledger-posting fix have no journal_entries row at all (post_payment()
--    silently failed). The refund RPC below remains correct in both
--    states: the reversal-journal-entry branch is skipped entirely when no
--    original entry is found (the refund event and payments.status
--    transition still happen), and runs correctly once a real posted entry
--    exists.
--
-- 7. Original entry shape assumption, made explicit and GUARDED rather
--    than assumed: post_payment() (both versions, 20260823090000 and
--    20260823100000) always creates EXACTLY 2 journal_lines for a payment
--    entry — one full-amount debit (cash) and one full-amount credit (AR),
--    both equal to the payment's own amount, 1:1, no split, no ratio.
--    Given that fixed, verified shape, an EXACT partial reversal of `n`
--    lines each needs no scaling/division (which would risk a rounding
--    residue on NUMERIC division for a non-evenly-divisible partial
--    amount) — each reversed line simply substitutes the SAME account,
--    swapped debit/credit side, valued at the requested `_amount` exactly
--    (algebraically exact, not derived via a fraction). This function
--    explicitly VERIFIES the assumed 2-line/full-amount shape before
--    relying on it and RAISEs rather than silently mis-computing if a
--    future post_payment() variant ever produces a different shape —
--    matching this codebase's established "guard rather than assume"
--    convention (see 20260823090000's own header on the same point).
--
-- 8. Roles/eligibility/period-lock: reused verbatim from
--    reverse_reservation_payment — ACCOUNTING_ADMIN_ROLES
--    (super_admin/hotel_owner/general_manager/accountant), property
--    derived from the locked payment row (never client-supplied), no
--    reservation.status gate, accounting-period-lock check unconditional.
--    Not redesigned; reused because the audit confirmed it already fits.
--
-- 9. Cross-path double-refund risk: with reverse_reservation_payment()
--    (whole-payment, blind to any partial refunds already recorded here)
--    and this new function (partial-aware) both live, an actor could in
--    principle call the OLD function directly and blindly void a payment
--    that already has partial refunds recorded against it, or vice versa.
--    Resolved by retiring the OLD function's application-reachability —
--    REVOKE EXECUTE ... FROM authenticated below — WITHOUT touching its
--    body, its migration file, or its own test suite (all remain
--    byte-identical and passing). This function's own defensive
--    `pay.status = 'void'` check additionally catches the case where a
--    payment was already fully voided via the old path before this
--    migration's REVOKE ever took effect (a payment in that state has
--    zero real remaining balance regardless of what this new table's own
--    SUM shows).
--
-- 10. Reporting correction: dashboard "today's revenue", the daily revenue
--     report, the 7-day insights trend, and a printed folio's payment list
--     all filter payments.status='posted' to exclude a FULLY refunded
--     (void) payment — unchanged and still correct. None of them yet
--     account for a PARTIALLY refunded payment's reduced net amount (it
--     stays 'posted', so it is correctly still included, but at its full
--     original amount, overstating actual retained revenue by the
--     refunded portion). This migration's own scope is schema + RPC only;
--     the four call sites are corrected in the accompanying application
--     code change in this same PR (not deferred) since accurate revenue
--     reporting is a direct, required consequence of allowing partial
--     refunds to exist at all — not a separate, optional concern.
--
-- ------------------------------------------------------------
-- Financial-integrity review pass (same PR, pre-merge) — findings 11-15:
-- ------------------------------------------------------------
--
-- 11. Fractional-cent rejection: the original draft validated only
--     `_amount > 0`, at the RPC layer alone. A caller (or a future bug
--     in a client that does its own proration) could submit a
--     sub-cent amount, e.g. 12.005, which NUMERIC's exact decimal
--     arithmetic would then carry silently into journal_lines and the
--     refund ledger. Hardened at TWO layers: the RPC now RAISEs before
--     any write if `ROUND(_amount,2) <> _amount`, AND
--     reservation_payment_refunds gets its own
--     CHECK (amount = ROUND(amount, 2)) so a fractional-cent value can
--     never be persisted even by a future code path that bypasses the
--     RPC (there is none today, but the CHECK is the actual DB-layer
--     guarantee, not just an RPC-layer courtesy check).
--
-- 12. No more 0.005 tolerance on over-refund / already-refunded checks:
--     the original draft used `_remaining <= 0.005` and
--     `_amount > _remaining + 0.005`, presumably defending against
--     float-style rounding drift. NUMERIC in Postgres is exact decimal
--     arithmetic, not float — that tolerance band was dead weight that
--     could, in principle, let a MULTI-CENT amount slip past the
--     boundary undetected (e.g. a hypothetical accumulation of several
--     0.005-sized errors). Replaced with an exact, ROUND(...,2)-only
--     comparison: `_remaining <= 0` and `ROUND(_amount,2) >
--     _remaining` (both sides already forced to 2dp). No amount can
--     ever cross the true remaining balance, not even by half a cent.
--
-- 13. Exact full-refund detection: same issue as #12, mirrored in the
--     payments.status → 'void' transition. Was
--     `(_already_refunded + _amount) >= pay.amount - 0.005`; now
--     `ROUND(_already_refunded + _amount, 2) >= ROUND(pay.amount, 2)`
--     — status flips to void only at the exact cent, never half a
--     cent early or late.
--
-- 14. Idempotency key widened from (property_id, request_id) alone to
--     the full payload — (property_id, request_id, payment_id, amount,
--     normalized reason). The original draft returned the prior
--     refund's id for ANY replay of a known request_id, even one
--     submitted with a different payment_id/amount/reason — e.g. a
--     client bug that reused a UUID, or a copy-pasted request_id
--     across two genuinely different refund actions, would have
--     silently returned the WRONG refund id while creating no new
--     financial effect for the real request, an outcome indistinguishable
--     from success at the call site. Reason normalization is
--     `regexp_replace(btrim(coalesce(_reason,'')), '\s+', ' ', 'g')` —
--     computed once, used identically for the stored value, the
--     length-validation, and the replay comparison, so a request
--     differing only in incidental whitespace still counts as the same
--     payload.
--
-- 15. Explicit conflict on payload mismatch: a request_id reused with a
--     DIFFERENT payment_id/amount/reason now RAISEs a named error
--     ("...was already used for a different refund...") instead of
--     either silently returning the old id (the bug in #14) or
--     silently proceeding to create a second, differently-valued
--     refund under a request_id that was supposed to make it
--     retry-safe. This makes a client-side id-generation bug loud and
--     debuggable rather than a silent wrong-money-moved incident.
--
-- ------------------------------------------------------------
-- Replay authorization / validation ordering fix (same PR, pre-merge) —
-- findings 16-18:
-- ------------------------------------------------------------
--
-- 16. Authorization now runs BEFORE the idempotent-replay lookup, and
--     therefore before any possible early RETURN of an existing refund
--     id. The prior ordering checked for a matching existing row (and
--     could RETURN on a match) before calling has_any_role() at all —
--     an actor who merely knew payment_id + request_id + a payload that
--     happened to match a prior successful refund could receive that
--     refund's id back without ever being authorized to refund anything
--     on that property. Idempotency is a retry-safety property of an
--     authorized call, not a bypass of authorization — a replay must be
--     rejected exactly as a fresh request would be for an unauthorized
--     or wrong-property actor. Property/reservation are still derived
--     solely from the locked payment row (never client input); UUID
--     knowledge is never treated as authorization.
--
-- 17. Reason and amount are now fully normalized AND validated (length
--     5-500, amount > 0, no fractional cents) BEFORE the payload is
--     compared against an existing row for replay. The prior ordering
--     compared `ROUND(existing.amount, 2) = ROUND(_amount, 2)` before
--     `_amount` had been checked for fractional cents at all — a retry
--     of 12.004 against an existing valid 12.00 refund would ROUND-equal
--     it and be accepted as the same replay instead of being rejected as
--     malformed. A malformed retry must fail its OWN validation
--     regardless of how closely its rounded value resembles a prior
--     valid request. With `_amount` now confirmed exact-cent before the
--     comparison is reached, the replay match uses plain NUMERIC equality
--     (`existing.amount = _amount`), not ROUND on either side.
--
-- 18. The `pay.status = 'void'` rejection now runs strictly AFTER the
--     replay lookup, not before it — it applies only to a genuinely NEW
--     refund event (the replay lookup found no match). An exact,
--     authorized, validly-shaped replay of the very refund call that
--     itself completed a payment's full refund must still return the
--     SAME existing id (that is what "idempotent" means for a refund
--     that happened to be the closing one), not be blocked by the
--     void-status guard that exists to stop a genuinely NEW refund
--     attempt against an already-fully-refunded payment.
--
-- Reporting-date semantics (reviewed, not changed): reports.tsx's daily
-- revenue series and insights.functions.ts's 7-day trend bucket a
-- payment's (net-of-refund) contribution under its ORIGINAL received_at
-- day, using the CURRENT total refunded against it — not the date any
-- refund itself was processed. A refund recorded today against a payment
-- from last week retroactively lowers last week's already-reported
-- revenue the next time that report is generated. This is NOT a new
-- behavior introduced by partial refunds: the pre-existing full-refund
-- path already does this today via the `status = 'posted'` filter (a
-- payment fully voided today already disappears entirely from a past
-- day's revenue on next render). This migration's reporting fix
-- (finding 10) extends the SAME established restatement semantics to
-- partial refunds for consistency — a payment's net contribution to its
-- own original day, continuously restated as of "now" — rather than
-- inventing point-in-time-frozen historical reporting, which this
-- codebase has never had and which is out of scope here. dashboard.tsx's
-- "today" figure and the folio PDF are unaffected by this distinction:
-- both always reflect current state, not a stored historical snapshot.
--
-- ============================================================
-- PART 0 — journal_source enum: 'payment_refund' is a new source tag (see
-- finding 3), not one of the values journal_source (20260705035515) already
-- defines. ALTER TYPE ... ADD VALUE must commit before the new value is
-- read back by any statement (Postgres restriction on using an added enum
-- value in the same transaction that added it); it is safe here because
-- PART B only stores the literal inside a function body (parsed, not
-- evaluated against the enum until the function actually runs in some
-- later, separate transaction), never inserts it directly in this
-- migration's own transaction.
-- ============================================================
ALTER TYPE public.journal_source ADD VALUE IF NOT EXISTS 'payment_refund';

-- ============================================================
-- PART A — reservation_payment_refunds: one immutable row per refund event
-- ============================================================
CREATE TABLE public.reservation_payment_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  -- Finding 11: fractional cents are rejected by the RPC before this row is
  -- ever reached, but this CHECK is the actual database-layer guarantee —
  -- no future write path, RPC or otherwise, can persist a sub-cent amount.
  CONSTRAINT reservation_payment_refunds_amount_no_fractional_cents CHECK (amount = ROUND(amount, 2)),
  reason TEXT NOT NULL,
  reversal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  refunded_by UUID NOT NULL REFERENCES auth.users(id),
  request_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, request_id)
);

CREATE INDEX idx_reservation_payment_refunds_payment ON public.reservation_payment_refunds(payment_id);
CREATE INDEX idx_reservation_payment_refunds_property ON public.reservation_payment_refunds(property_id);

-- Read-only to authenticated: every write goes through
-- refund_reservation_payment() below, mirroring
-- reservation_item_distributions' identical "no direct client write" posture
-- (stricter than payments itself, which still allows a raw client INSERT for
-- Add Payment).
GRANT SELECT ON public.reservation_payment_refunds TO authenticated;
GRANT ALL ON public.reservation_payment_refunds TO service_role;
ALTER TABLE public.reservation_payment_refunds ENABLE ROW LEVEL SECURITY;
CREATE POLICY reservation_payment_refunds_read ON public.reservation_payment_refunds FOR SELECT TO authenticated
  USING (public.can_access_property(auth.uid(), property_id));

-- ============================================================
-- PART B — refund_reservation_payment(): partial/full refund RPC
-- ============================================================
CREATE OR REPLACE FUNCTION public.refund_reservation_payment(
  _payment_id UUID, _amount NUMERIC, _reason TEXT, _request_id UUID
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  pay RECORD; res RECORD; jl RECORD; orig_entry RECORD; existing RECORD;
  _refund_id UUID; _entry_id UUID;
  _period_id UUID; _trimmed_reason TEXT;
  _already_refunded NUMERIC; _remaining NUMERIC;
  _orig_debit_total NUMERIC; _orig_credit_total NUMERIC; _orig_line_count INT;
  _dr NUMERIC; _cr NUMERIC;
BEGIN
  IF _request_id IS NULL THEN
    RAISE EXCEPTION 'A request id is required';
  END IF;
  -- Serializes every call carrying this exact request_id, including two
  -- truly concurrent ones — the loser waits here until the winner's
  -- transaction fully commits or rolls back, so the existing-row check just
  -- below always sees the winner's real outcome. Identical pattern to
  -- issue_reservation_item()/return_reservation_item().
  PERFORM pg_advisory_xact_lock(hashtextextended(_request_id::text, 0));

  -- Primary defense against a concurrent double refund of the SAME payment,
  -- and the anchor for every downstream read in this function.
  SELECT * INTO pay FROM public.payments WHERE id = _payment_id FOR UPDATE;
  IF pay IS NULL THEN RAISE EXCEPTION 'Payment not found'; END IF;

  -- Reservation (and therefore property) is derived from the locked payment
  -- row, never a client-supplied parameter — cross-property refund is
  -- impossible by construction.
  SELECT * INTO res FROM public.reservations WHERE id = pay.reservation_id;
  IF res IS NULL THEN RAISE EXCEPTION 'Reservation for this payment was not found'; END IF;

  -- Finding 16: authorization runs BEFORE any replay lookup, and therefore
  -- before any possible early RETURN of an existing refund id. An
  -- idempotent retry is still a call to a protected financial operation —
  -- an actor without refund permission on this payment's property must be
  -- rejected exactly as a fresh request would be, never handed a prior
  -- refund's id merely for knowing payment_id/request_id/payload. UUID
  -- knowledge is never treated as authorization.
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], res.property_id) THEN
    RAISE EXCEPTION 'Not permitted to refund a reservation payment';
  END IF;

  -- Finding 17: reason/amount are normalized and FULLY validated before
  -- the payload is ever compared against an existing row for idempotent
  -- replay. A malformed retry (fractional cents, non-positive, too-short
  -- reason) must fail its OWN validation — it must never slip through by
  -- rounding or truncating into apparent equality with a prior valid
  -- request (e.g. a 12.004 retry against an existing 12.00 refund must
  -- raise the fractional-cent error, not be accepted as the same replay).
  _trimmed_reason := regexp_replace(btrim(COALESCE(_reason, '')), '\s+', ' ', 'g');
  IF char_length(_trimmed_reason) < 5 THEN
    RAISE EXCEPTION 'A refund reason of at least 5 characters is required';
  END IF;
  IF char_length(_trimmed_reason) > 500 THEN
    RAISE EXCEPTION 'Refund reason must be 500 characters or fewer';
  END IF;

  IF _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'Refund amount must be greater than zero';
  END IF;
  -- Rejected here, before any comparison against a possibly-matching
  -- existing row; also enforced as a hard DB-layer CHECK on
  -- reservation_payment_refunds itself.
  IF ROUND(_amount, 2) <> _amount THEN
    RAISE EXCEPTION 'Refund amount cannot have fractional cents';
  END IF;

  -- Idempotent replay: only reachable once the caller is authorized
  -- (finding 16) AND the payload is independently valid on its own terms
  -- (finding 17) — never before either. Idempotency key is the FULL
  -- payload (property_id, request_id, payment_id, amount, normalized
  -- reason), not request_id alone. Compared with exact NUMERIC equality —
  -- `_amount` is already confirmed exact-cent above, so no ROUND is
  -- needed (or wanted) in this comparison. A request_id reused with a
  -- DIFFERENT payment/amount/reason is a client bug, surfaced loudly as a
  -- named conflict rather than silently returning an unrelated prior
  -- refund's id or silently creating a second refund under an id meant to
  -- make retries safe.
  SELECT * INTO existing FROM public.reservation_payment_refunds
    WHERE property_id = res.property_id AND request_id = _request_id;
  IF existing.id IS NOT NULL THEN
    IF existing.payment_id = _payment_id
       AND existing.amount = _amount
       AND existing.reason = _trimmed_reason THEN
      RETURN existing.id;
    ELSE
      RAISE EXCEPTION 'Request id % was already used for a different refund (payment %, amount %) — reuse a request id only to retry the exact same refund', _request_id, existing.payment_id, existing.amount;
    END IF;
  END IF;

  -- Finding 18: pay.status = 'void' is rejected ONLY once we know this is
  -- a genuinely NEW refund event (no matching existing row was found
  -- above) — an exact, authorized, validly-shaped replay of the refund
  -- that itself completed the payment's full refund must still return the
  -- SAME existing id via the replay branch above, not be blocked here.
  -- Also still catches the cross-path scenario (finding 9): a payment
  -- already fully voided via the retired reverse_reservation_payment()
  -- path has zero real remaining balance regardless of what this table's
  -- own SUM shows.
  IF pay.status = 'void' THEN
    RAISE EXCEPTION 'Payment has already been fully refunded';
  END IF;

  -- Server-authoritative remaining refundable balance — computed fresh
  -- under the payment row's own lock above, never trusted from the client.
  SELECT COALESCE(SUM(amount), 0) INTO _already_refunded
    FROM public.reservation_payment_refunds WHERE payment_id = pay.id;
  _remaining := ROUND(pay.amount - _already_refunded, 2);

  -- Exact-cent comparison, no tolerance band. NUMERIC is exact decimal
  -- arithmetic in Postgres, not float — a 0.005-style slack here would buy
  -- no real protection and could in principle let an amount slip past the
  -- true remaining balance by up to half a cent.
  IF _remaining <= 0 THEN
    RAISE EXCEPTION 'Payment has already been fully refunded';
  END IF;
  IF _amount > _remaining THEN
    RAISE EXCEPTION 'Refund amount exceeds remaining refundable balance: % remaining, % requested', _remaining, _amount;
  END IF;

  SELECT id INTO _period_id FROM public.accounting_periods
    WHERE property_id = res.property_id AND CURRENT_DATE BETWEEN start_date AND end_date AND status IN ('locked','closed')
    LIMIT 1;
  IF _period_id IS NOT NULL THEN RAISE EXCEPTION 'Current accounting period is locked'; END IF;

  -- See finding 6: no original entry usually exists yet for historical
  -- payments. `is_reversal_of IS NULL` selects the ORIGINAL posting only,
  -- matching reverse_reservation_payment()'s own defensive lookup.
  -- `.id IS NOT NULL`, not the bare-record check — see 20260823090000 PART
  -- C for why the bare-record form is unsafe on a deliberately-filtered,
  -- guaranteed-mixed-null RECORD.
  SELECT * INTO orig_entry FROM public.journal_entries
    WHERE source = 'payment' AND source_ref = pay.id::text AND is_reversal_of IS NULL
    LIMIT 1;

  _refund_id := gen_random_uuid();

  IF orig_entry.id IS NOT NULL THEN
    -- Guard (see finding 7): verify the known, fixed 2-line/full-amount
    -- shape before relying on it for an exact (non-prorated) partial
    -- reversal. Any other shape is refused rather than silently
    -- mis-computed.
    SELECT count(*), COALESCE(SUM(debit),0), COALESCE(SUM(credit),0)
      INTO _orig_line_count, _orig_debit_total, _orig_credit_total
      FROM public.journal_lines WHERE entry_id = orig_entry.id;
    IF _orig_line_count <> 2 OR ROUND(_orig_debit_total,2) <> ROUND(pay.amount,2) OR ROUND(_orig_credit_total,2) <> ROUND(pay.amount,2) THEN
      RAISE EXCEPTION 'Cannot partially refund this payment: its original journal entry does not have the expected two-line, full-amount shape';
    END IF;

    INSERT INTO public.journal_entries(property_id, entry_date, memo, source, source_ref, currency, posted_by)
    VALUES (res.property_id, CURRENT_DATE, 'Refund of reservation payment — '||_trimmed_reason, 'payment_refund', _refund_id::text, orig_entry.currency, auth.uid())
    RETURNING id INTO _entry_id;

    -- Each new line swaps the ORIGINAL line's debit/credit side (same
    -- account, same currency/fx_rate) but is valued at the requested
    -- `_amount` directly — exact, not a ratio/division of the original
    -- line's own value (see finding 7: safe only because the shape guard
    -- above just confirmed both original lines equal pay.amount in full).
    FOR jl IN SELECT * FROM public.journal_lines WHERE entry_id = orig_entry.id ORDER BY created_at LOOP
      INSERT INTO public.journal_lines(entry_id, account_id, debit, credit, currency, fx_rate, debit_base, credit_base, memo)
      VALUES (
        _entry_id, jl.account_id,
        CASE WHEN jl.credit > 0 THEN _amount ELSE 0 END,
        CASE WHEN jl.debit > 0 THEN _amount ELSE 0 END,
        jl.currency, jl.fx_rate,
        CASE WHEN jl.credit > 0 THEN ROUND(_amount * jl.fx_rate, 2) ELSE 0 END,
        CASE WHEN jl.debit > 0 THEN ROUND(_amount * jl.fx_rate, 2) ELSE 0 END,
        'Refund of '||COALESCE(jl.memo, 'reservation payment')
      );
    END LOOP;

    IF NOT EXISTS (SELECT 1 FROM public.journal_lines WHERE entry_id = _entry_id) THEN
      RAISE EXCEPTION 'Reversal journal entry ended up with no lines';
    END IF;

    SELECT COALESCE(SUM(debit_base),0), COALESCE(SUM(credit_base),0) INTO _dr, _cr
      FROM public.journal_lines WHERE entry_id = _entry_id;
    IF ROUND(_dr,2) <> ROUND(_cr,2) THEN
      RAISE EXCEPTION 'Reversal journal is not balanced (DR %, CR %)', _dr, _cr;
    END IF;
  END IF;
  -- _entry_id stays NULL when orig_entry was not found — expected and safe
  -- (finding 6), not a failure.

  INSERT INTO public.reservation_payment_refunds(
    id, property_id, payment_id, amount, reason, reversal_entry_id, refunded_by, request_id
  ) VALUES (
    _refund_id, res.property_id, pay.id, _amount, _trimmed_reason, _entry_id, auth.uid(), _request_id
  );

  -- Status flips to 'void' only once the running total reaches the full
  -- original amount AT THE EXACT CENT (finding 13, no tolerance band) —
  -- otherwise the payment stays 'posted' (see finding 4/10: no
  -- 'partially_refunded' status is introduced; the real remaining balance
  -- always comes from this table's own SUM, never from the status column
  -- alone). Original amount, method, reference, received_by, received_at
  -- are never touched — only status.
  UPDATE public.payments
    SET status = CASE WHEN ROUND(_already_refunded + _amount, 2) >= ROUND(pay.amount, 2) THEN 'void'::public.reservation_payment_status ELSE pay.status END
    WHERE id = pay.id;

  INSERT INTO public.admin_action_logs(
    property_id, actor_id, entity_type, entity_id, action, before_snapshot, after_snapshot, memo
  ) VALUES (
    res.property_id, auth.uid(), 'reservation_payment_refund', _refund_id::text, 'insert',
    jsonb_build_object('paymentId', pay.id, 'reservationId', pay.reservation_id, 'paymentAmount', pay.amount, 'alreadyRefundedBefore', _already_refunded),
    jsonb_build_object('refundId', _refund_id, 'amount', _amount, 'reversalEntryId', _entry_id, 'reason', _trimmed_reason, 'requestId', _request_id),
    'Reservation payment partially refunded: '||_trimmed_reason
  );

  RETURN _refund_id;
END; $$;

REVOKE EXECUTE ON FUNCTION public.refund_reservation_payment(uuid, numeric, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refund_reservation_payment(uuid, numeric, text, uuid) TO authenticated;

-- ============================================================
-- PART C — retire the old, partial-refund-unaware entrypoint from
-- application reachability (finding 9). Body, migration file, columns,
-- and test suite are all untouched — this is a grant-only change.
-- ============================================================
REVOKE EXECUTE ON FUNCTION public.reverse_reservation_payment(uuid, text) FROM authenticated;
