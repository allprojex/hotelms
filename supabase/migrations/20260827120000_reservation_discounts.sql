-- ============================================================
-- Reservation Discounts — Phase 1.
--
-- SCOPE: the ROOM ACCOMMODATION charge only. POS-to-room postings,
-- incidental folio charges, payments and taxes are never discounted
-- independently.
--
-- WHY reservations.rate_total IS THE ELIGIBLE BASIS: rate_total is written
-- in exactly one place in the product -- reservation creation, as
-- base_rate * nights -- and is never incremented by a POS posting or an
-- incidental charge (those only ever land in reservation_charges). It is
-- therefore room-accommodation-only BY CONSTRUCTION, and using it as the
-- basis excludes everything decision 1 requires excluded, without needing
-- a charge-type column that this schema does not have.
--
-- THE INVARIANT this migration maintains, per reservation:
--     original eligible room value
--   - SUM(calculated_amount) of ACTIVE discounts
--   = reservations.rate_total
-- and each active discount appears in the folio exactly once, as one
-- negative reservation_charges line.
--
-- TAX: tax is INCLUSIVE in this system -- post_reservation_checkout derives
-- room := rate_total / (1 + tax_rate/100). Reducing the tax-inclusive gross
-- therefore reduces room revenue and tax proportionally and correctly. No
-- discount is ever applied to tax separately; there is no pre-tax discount
-- concept here because nothing in this product ever adds tax on top.
--
-- ATOMICITY: applying a discount writes three things -- the discount row,
-- the negative folio line, and the reduced rate_total. They are written by
-- one SECURITY DEFINER function inside one transaction, so no partial state
-- can exist. The product must not do this as separate browser writes: every
-- reservation money write today goes straight from the client, which cannot
-- be atomic, cannot be authorised server-side, and cannot be made
-- idempotent.
--
-- PHASE 1 DELIBERATELY EXCLUDES post-checkout discounts. post_reservation_
-- checkout() is idempotent (it returns early when a journal already exists
-- for the reservation), so a discount applied after checkout would never be
-- journalled -- the folio would silently disagree with the ledger. That
-- needs a discount_allowed contra-revenue account and adjusting entries,
-- which is a later phase.
-- ============================================================

CREATE TYPE public.reservation_discount_type AS ENUM ('amount', 'percentage');
CREATE TYPE public.reservation_discount_status AS ENUM ('active', 'reversed');

CREATE TABLE public.reservation_discounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id UUID NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  -- Denormalised for RLS and property-scoped reporting, exactly as the other
  -- reservation-child tables do.
  property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,

  discount_type public.reservation_discount_type NOT NULL,
  -- What the operator typed: currency for 'amount', percent for 'percentage'.
  entered_value NUMERIC(12,2) NOT NULL,
  -- The eligible room value the discount was taken against, FROZEN at apply
  -- time. Without it a percentage discount is unauditable after the fact.
  basis_amount NUMERIC(12,2) NOT NULL,
  -- The money result, FROZEN at apply time. A percentage must never float
  -- when charges change later: that would retroactively re-price a bill the
  -- guest has already seen.
  calculated_amount NUMERIC(12,2) NOT NULL,

  reason TEXT NOT NULL,
  -- The negative folio line this discount produced. ON DELETE RESTRICT: the
  -- evidence may not be orphaned.
  charge_id UUID REFERENCES public.reservation_charges(id) ON DELETE RESTRICT,

  applied_by UUID REFERENCES auth.users(id),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  status public.reservation_discount_status NOT NULL DEFAULT 'active',
  reversed_by UUID REFERENCES auth.users(id),
  reversed_at TIMESTAMPTZ,
  reversal_reason TEXT,
  reversal_charge_id UUID REFERENCES public.reservation_charges(id) ON DELETE RESTRICT,

  -- Idempotency key, same convention as refund_reservation_payment: a
  -- double-submitted dialog must apply the discount once, not twice.
  request_id UUID NOT NULL UNIQUE,
  -- Separate idempotency key for the reversal, so retrying a reversal cannot
  -- post a second compensating charge.
  reversal_request_id UUID UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT reservation_discounts_entered_value_positive CHECK (entered_value > 0),
  CONSTRAINT reservation_discounts_calculated_positive CHECK (calculated_amount > 0),
  CONSTRAINT reservation_discounts_basis_non_negative CHECK (basis_amount >= 0),
  CONSTRAINT reservation_discounts_not_exceeding_basis CHECK (calculated_amount <= basis_amount),
  CONSTRAINT reservation_discounts_percentage_range CHECK (
    discount_type <> 'percentage' OR (entered_value > 0 AND entered_value <= 100)
  ),
  CONSTRAINT reservation_discounts_reason_present CHECK (btrim(reason) <> ''),
  -- A reversed row must carry its full reversal evidence; an active row must
  -- carry none of it.
  CONSTRAINT reservation_discounts_reversal_complete CHECK (
    (status = 'active'
      AND reversed_by IS NULL AND reversed_at IS NULL
      AND reversal_reason IS NULL AND reversal_charge_id IS NULL)
    OR
    (status = 'reversed'
      AND reversed_at IS NOT NULL
      AND reversal_reason IS NOT NULL AND btrim(reversal_reason) <> '')
  )
);

CREATE INDEX reservation_discounts_reservation_idx
  ON public.reservation_discounts (reservation_id, status);
CREATE INDEX reservation_discounts_property_idx
  ON public.reservation_discounts (property_id, applied_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.reservation_discounts TO authenticated;
GRANT ALL ON public.reservation_discounts TO service_role;
ALTER TABLE public.reservation_discounts ENABLE ROW LEVEL SECURITY;

-- Read: the same property boundary every reservation child table uses.
CREATE POLICY reservation_discounts_read ON public.reservation_discounts
  FOR SELECT TO authenticated
  USING (public.can_access_property(auth.uid(), property_id));

-- Write: DELIBERATELY NARROWER than reservations' own res_write, which lets
-- front_desk and reservations edit bookings freely. Reducing revenue is a
-- separate authority and is not inherited. There is no DELETE policy at all:
-- an applied financial discount is never physically deleted, only reversed.
CREATE POLICY reservation_discounts_write ON public.reservation_discounts
  FOR ALL TO authenticated
  USING (public.has_any_role(auth.uid(),
    ARRAY['super_admin','hotel_owner','general_manager']::app_role[], property_id))
  WITH CHECK (public.has_any_role(auth.uid(),
    ARRAY['super_admin','hotel_owner','general_manager']::app_role[], property_id));

-- ------------------------------------------------------------
-- Helper: the outstanding folio balance, computed the same way the
-- reservation screen computes it -- signed charges minus payments net of
-- their own refunds. Kept as one definition so the guard below cannot drift
-- from what the operator is looking at.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reservation_outstanding_balance(_reservation_id UUID)
RETURNS NUMERIC LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT
    COALESCE((SELECT SUM(c.amount) FROM public.reservation_charges c
              WHERE c.reservation_id = _reservation_id), 0)
    -
    COALESCE((
      SELECT SUM(GREATEST(
        p.amount - COALESCE((
          SELECT SUM(rf.amount) FROM public.reservation_payment_refunds rf
          WHERE rf.payment_id = p.id
        ), 0), 0))
      FROM public.payments p
      WHERE p.reservation_id = _reservation_id
    ), 0)
$fn$;

REVOKE ALL ON FUNCTION public.reservation_outstanding_balance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reservation_outstanding_balance(uuid) TO authenticated;

-- ------------------------------------------------------------
-- apply_reservation_discount
--
-- Returns the discount id. Idempotent on _request_id: a retry of the same
-- submission returns the original discount without applying it twice.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_reservation_discount(
  _reservation_id UUID,
  _discount_type TEXT,
  _entered_value NUMERIC,
  _reason TEXT,
  _request_id UUID
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  res            RECORD;
  _existing      UUID;
  _type          public.reservation_discount_type;
  _basis         NUMERIC(12,2);
  _calculated    NUMERIC(12,2);
  _outstanding   NUMERIC(12,2);
  _charge_id     UUID;
  _discount_id   UUID;
  _label         TEXT;
BEGIN
  IF _request_id IS NULL THEN
    RAISE EXCEPTION 'A request id is required';
  END IF;
  IF _reservation_id IS NULL THEN
    RAISE EXCEPTION 'A reservation is required';
  END IF;
  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required for a discount';
  END IF;

  -- Serialise concurrent submissions of the SAME request before any read, so
  -- a double-click cannot race two identical discounts through the guards.
  PERFORM pg_advisory_xact_lock(hashtextextended(_request_id::text, 0));

  SELECT id INTO _existing FROM public.reservation_discounts WHERE request_id = _request_id;
  IF _existing IS NOT NULL THEN
    RETURN _existing;
  END IF;

  -- Lock the reservation row for the rest of the transaction: two DIFFERENT
  -- requests discounting the same reservation must not both read the same
  -- rate_total and both pass the basis guard.
  SELECT * INTO res FROM public.reservations WHERE id = _reservation_id FOR UPDATE;
  IF res IS NULL THEN
    RAISE EXCEPTION 'Reservation not found';
  END IF;

  IF NOT public.has_any_role(auth.uid(),
      ARRAY['super_admin','hotel_owner','general_manager']::app_role[], res.property_id) THEN
    RAISE EXCEPTION 'Not authorised to apply a discount on this reservation';
  END IF;

  -- Status gate. checked_out is excluded because the checkout journal is
  -- already posted and is idempotent, so accounting could never follow.
  IF res.status NOT IN ('confirmed', 'checked_in') THEN
    RAISE EXCEPTION 'A discount cannot be applied to a % reservation', res.status;
  END IF;

  BEGIN
    _type := lower(btrim(_discount_type))::public.reservation_discount_type;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Discount type must be amount or percentage, got %', _discount_type;
  END;

  IF _entered_value IS NULL OR _entered_value <= 0 THEN
    RAISE EXCEPTION 'Discount value must be greater than zero';
  END IF;

  -- The eligible basis is the room accommodation value still standing:
  -- rate_total, already net of any previously applied active discount.
  _basis := ROUND(COALESCE(res.rate_total, 0), 2);
  IF _basis <= 0 THEN
    RAISE EXCEPTION 'This reservation has no remaining room value to discount';
  END IF;

  IF _type = 'percentage' THEN
    IF _entered_value > 100 THEN
      RAISE EXCEPTION 'A percentage discount cannot exceed 100%%';
    END IF;
    _calculated := ROUND(_basis * _entered_value / 100, 2);
  ELSE
    _calculated := ROUND(_entered_value, 2);
  END IF;

  IF _calculated <= 0 THEN
    RAISE EXCEPTION 'The calculated discount rounds to zero';
  END IF;
  IF _calculated > _basis THEN
    RAISE EXCEPTION 'Discount of % exceeds the eligible room amount of %', _calculated, _basis;
  END IF;

  -- Must not turn the folio into a credit: a discount never returns money.
  -- On a fully paid reservation the outstanding balance is zero, so this is
  -- also what makes "fully paid" a rejection rather than a special case.
  _outstanding := ROUND(public.reservation_outstanding_balance(_reservation_id), 2);
  IF _calculated > _outstanding THEN
    RAISE EXCEPTION
      'Discount of % exceeds the outstanding balance of %. Use a refund to return money already collected.',
      _calculated, _outstanding;
  END IF;

  _label := CASE
    WHEN _type = 'percentage'
      THEN 'Discount · ' || trim(trailing '.' from trim(trailing '0' from to_char(_entered_value, 'FM999999990.00'))) || '% · ' || btrim(_reason)
    ELSE 'Discount · ' || btrim(_reason)
  END;

  INSERT INTO public.reservation_charges (reservation_id, description, amount, posted_by)
  VALUES (_reservation_id, _label, -_calculated, auth.uid())
  RETURNING id INTO _charge_id;

  INSERT INTO public.reservation_discounts (
    reservation_id, property_id, discount_type, entered_value,
    basis_amount, calculated_amount, reason, charge_id,
    applied_by, request_id
  ) VALUES (
    _reservation_id, res.property_id, _type, ROUND(_entered_value, 2),
    _basis, _calculated, btrim(_reason), _charge_id,
    auth.uid(), _request_id
  ) RETURNING id INTO _discount_id;

  -- Keep the invariant: rate_total is the room value net of active discounts.
  UPDATE public.reservations
     SET rate_total = ROUND(_basis - _calculated, 2), updated_at = now()
   WHERE id = _reservation_id;

  PERFORM public.audit_capture(
    res.property_id, 'reservation_discount', _discount_id::text, 'create',
    jsonb_build_object('rate_total', _basis),
    jsonb_build_object(
      'discount_type', _type, 'entered_value', _entered_value,
      'basis_amount', _basis, 'calculated_amount', _calculated,
      'reason', btrim(_reason), 'charge_id', _charge_id,
      'rate_total_after', ROUND(_basis - _calculated, 2)
    ),
    'Discount applied to reservation ' || res.code,
    NULL, NULL, NULL, NULL, NULL, NULL, TRUE, NULL
  );

  RETURN _discount_id;
END; $$;

REVOKE ALL ON FUNCTION public.apply_reservation_discount(uuid, text, numeric, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_reservation_discount(uuid, text, numeric, text, uuid) TO authenticated;

-- ------------------------------------------------------------
-- reverse_reservation_discount
--
-- Preserves the original row and its negative folio line as historical
-- evidence, marks it reversed, posts a COMPENSATING POSITIVE charge, and
-- restores rate_total. Nothing is deleted or overwritten.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_reservation_discount(
  _discount_id UUID,
  _reason TEXT,
  _request_id UUID
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d          RECORD;
  res        RECORD;
  _existing  UUID;
  _charge_id UUID;
BEGIN
  IF _request_id IS NULL THEN
    RAISE EXCEPTION 'A request id is required';
  END IF;
  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to reverse a discount';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_request_id::text, 0));

  -- Idempotent: a retried reversal returns the already-reversed discount
  -- rather than posting a second compensating charge.
  SELECT id INTO _existing FROM public.reservation_discounts
   WHERE id = _discount_id AND status = 'reversed' AND reversal_request_id = _request_id;
  IF _existing IS NOT NULL THEN
    RETURN _existing;
  END IF;

  SELECT * INTO d FROM public.reservation_discounts WHERE id = _discount_id FOR UPDATE;
  IF d IS NULL THEN
    RAISE EXCEPTION 'Discount not found';
  END IF;

  SELECT * INTO res FROM public.reservations WHERE id = d.reservation_id FOR UPDATE;
  IF res IS NULL THEN
    RAISE EXCEPTION 'Reservation for this discount was not found';
  END IF;

  IF NOT public.has_any_role(auth.uid(),
      ARRAY['super_admin','hotel_owner','general_manager']::app_role[], d.property_id) THEN
    RAISE EXCEPTION 'Not authorised to reverse a discount on this reservation';
  END IF;

  IF d.status = 'reversed' THEN
    RAISE EXCEPTION 'This discount has already been reversed';
  END IF;

  -- Restoring rate_total is only financially valid while the reservation has
  -- not been journalled. After checkout the ledger is already posted and
  -- idempotent, so the correction belongs in the later accounting phase.
  IF res.status NOT IN ('confirmed', 'checked_in') THEN
    RAISE EXCEPTION 'A discount cannot be reversed on a % reservation', res.status;
  END IF;

  INSERT INTO public.reservation_charges (reservation_id, description, amount, posted_by)
  VALUES (
    d.reservation_id,
    'Discount reversed · ' || btrim(_reason),
    d.calculated_amount,
    auth.uid()
  ) RETURNING id INTO _charge_id;

  UPDATE public.reservation_discounts
     SET status = 'reversed',
         reversed_by = auth.uid(),
         reversed_at = now(),
         reversal_reason = btrim(_reason),
         reversal_charge_id = _charge_id,
         reversal_request_id = _request_id
   WHERE id = _discount_id;

  UPDATE public.reservations
     SET rate_total = ROUND(COALESCE(res.rate_total, 0) + d.calculated_amount, 2),
         updated_at = now()
   WHERE id = d.reservation_id;

  PERFORM public.audit_capture(
    d.property_id, 'reservation_discount', _discount_id::text, 'delete',
    jsonb_build_object(
      'status', 'active', 'calculated_amount', d.calculated_amount,
      'rate_total', COALESCE(res.rate_total, 0)
    ),
    jsonb_build_object(
      'status', 'reversed', 'reversal_reason', btrim(_reason),
      'reversal_charge_id', _charge_id,
      'rate_total_after', ROUND(COALESCE(res.rate_total, 0) + d.calculated_amount, 2)
    ),
    'Discount reversed on reservation ' || res.code,
    NULL, NULL, NULL, NULL, NULL, NULL, TRUE, NULL
  );

  RETURN _discount_id;
END; $$;

REVOKE ALL ON FUNCTION public.reverse_reservation_discount(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_reservation_discount(uuid, text, uuid) TO authenticated;
