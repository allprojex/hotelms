-- ============================================================
-- Reservation Item Distribution — record consumable items (soap, towels,
-- water, etc.) issued to a checked-in reservation's room, with returns and
-- corrections, backed by the existing inventory stock model.
--
-- DESIGN NOTES (from the pre-implementation audit):
--
-- * One reservation = one room (reservations.room_id is a single nullable
--   FK, no reservation_rooms junction exists in this schema) — every
--   ledger row is scoped to one reservation and captures room_id/guest_id
--   AT THE TIME OF THE EVENT (not a live join to reservations), so history
--   stays accurate even if the reservation's room is reassigned later.
--
-- * Event-ledger model, not a mutable running-total row: every issue,
--   return, and adjustment is its own immutable INSERT-only row. A return
--   or adjustment always references the original 'issue' row via
--   related_distribution_id — the issue row itself is never edited or
--   deleted to represent a return, matching every other financial-history
--   table in this schema (payments/reservation_charges are never edited
--   either, only ever appended to or marked void).
--
-- * Stock mutation reuses apply_stock_delta() exclusively, exactly like
--   receive_purchase_order/execute_transfer/apply_adjustment/
--   import_inventory_item — no new stock-mutation mechanism invented here.
--
-- * property_id is NEVER accepted as a parameter from the client — every
--   RPC derives it server-side from the reservation (for issue) or from
--   the original issue row (for return/adjustment), and independently
--   verifies the chosen item/location belong to that same property before
--   doing anything else.
--
-- * Batches (inventory_stock_batches) are NOT consumed here. Confirmed via
--   audit: nothing in this schema depletes batches on issue today (POS
--   close_pos_order, transfers, adjustments, and now this feature all
--   deduct only the aggregate item_stock quantity via apply_stock_delta).
--   FEFO/batch-aware issuing would be a new stock-costing system and is
--   deliberately out of scope — flagged as a follow-up, not silently
--   implemented here.
--
-- * No accounting/financial link: confirmed via audit that nothing in the
--   existing schema treats "stock issued" as inherently billable (no
--   chargeable flag on inventory_items, no existing precedent auto-posting
--   a charge from a stock deduction). This migration creates ZERO
--   reservation_charges/payments/journal_entries/pos_orders rows. If a
--   future business decision requires billing certain items, that is a
--   separate, explicit design task — not assumed here.
--
-- * Concurrency: every mutating RPC takes a `SELECT ... FOR UPDATE` row
--   lock (same pattern already used in payroll_begin_calculation and
--   esl_pairing_codes) — on item_stock for issues/deducting-adjustments,
--   and on the original issue row for returns/adjustments — so the
--   database, not the client's displayed "available stock" number, is
--   what actually prevents two concurrent requests from over-issuing or
--   over-returning.
--
-- * Idempotency: a `FOR UPDATE` lock alone stops two concurrent requests
--   from over-issuing/over-returning past the true available/outstanding
--   amount, but it does NOT stop two requests that both represent the
--   SAME user action (a network retry, a double click that beats the
--   client's own busy-state, a replay from two tabs) from each
--   legitimately succeeding in sequence — that is a valid concurrency
--   outcome but a wrong business outcome: it deducts/restores stock twice
--   for what was really one action. Every mutating RPC therefore takes a
--   caller-supplied `_request_id UUID`, persisted on the resulting row
--   under `UNIQUE(property_id, request_id)`. Each RPC opens with
--   `pg_advisory_xact_lock` keyed on that request_id (auto-released at
--   transaction end, commit or rollback) so that even two truly
--   concurrent calls carrying the same request_id serialize against each
--   other — the second one always finds the first's already-committed row
--   and returns its id, rather than racing to also mutate stock. A caller
--   that already has a committed row for its request_id gets that row's
--   id back immediately, before any other validation re-runs — a clean,
--   safe answer instead of a confusing constraint-violation error. A
--   genuinely new action (fresh dialog submission, fresh request_id) is
--   never blocked by this.
-- ============================================================

CREATE TABLE public.reservation_item_distributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  reservation_id UUID NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  room_id UUID REFERENCES public.rooms(id) ON DELETE SET NULL,
  guest_id UUID REFERENCES public.guests(id) ON DELETE SET NULL,
  inventory_item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  location_id UUID NOT NULL REFERENCES public.stock_locations(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('issue', 'return', 'adjustment')),
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  -- NULL for 'issue' rows; required for 'return'/'adjustment' rows, always
  -- pointing back at the original 'issue' row being returned/corrected.
  related_distribution_id UUID REFERENCES public.reservation_item_distributions(id) ON DELETE RESTRICT,
  -- Only meaningful for action='adjustment': how this correction affects
  -- item_stock. 'restore' = stock was never actually taken (correction
  -- downward, same stock effect as a return). 'deduct' = more was actually
  -- issued than originally recorded (same stock effect as an extra issue).
  -- 'none' = a write-off (damaged/lost) — the outstanding amount is
  -- reduced but nothing physically comes back to stock. NULL for
  -- issue/return rows, where the stock direction is implied by the action.
  stock_direction TEXT CHECK (stock_direction IN ('restore', 'deduct', 'none')),
  -- Free-text notes on any row; mandatory (enforced by the RPC, not this
  -- CHECK, so the exact "reason required" error message stays friendly)
  -- for adjustments specifically.
  reason TEXT,
  actor_id UUID NOT NULL REFERENCES auth.users(id),
  -- Client-generated per-submission-attempt idempotency key (see the
  -- design note above). Required on every row -- issue, return, and
  -- adjustment are all replay-protected identically.
  request_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (action = 'issue' AND related_distribution_id IS NULL AND stock_direction IS NULL)
    OR (action = 'return' AND related_distribution_id IS NOT NULL AND stock_direction IS NULL)
    OR (action = 'adjustment' AND related_distribution_id IS NOT NULL AND stock_direction IS NOT NULL)
  ),
  UNIQUE (property_id, request_id)
);

CREATE INDEX idx_res_item_dist_reservation ON public.reservation_item_distributions(reservation_id, created_at);
CREATE INDEX idx_res_item_dist_related ON public.reservation_item_distributions(related_distribution_id) WHERE related_distribution_id IS NOT NULL;
CREATE INDEX idx_res_item_dist_property ON public.reservation_item_distributions(property_id);

-- Read-only to authenticated: every write goes through the three guarded
-- RPCs below (mirrors the inventory_stock_batches hardening pattern).
GRANT SELECT ON public.reservation_item_distributions TO authenticated;
GRANT ALL ON public.reservation_item_distributions TO service_role;
ALTER TABLE public.reservation_item_distributions ENABLE ROW LEVEL SECURITY;
CREATE POLICY rid_read ON public.reservation_item_distributions FOR SELECT TO authenticated
  USING (public.can_access_property(auth.uid(), property_id));

-- Roles that may issue/return room items. Front desk and housekeeping
-- (both tiers) are the operational staff who actually hand out or collect
-- consumables; storekeeper controls the physical stock being drawn from;
-- the admin tier is included everywhere in this schema by convention.
-- Mirrors item_stock_write's own broader-than-inventory-admin role set
-- (front_desk/cashier/housekeeping_supervisor already have direct
-- item_stock access today) rather than inventing a stricter bar than the
-- rest of the inventory module already allows.
--
-- Adjustments use a narrower set — deliberately identical to
-- stock_adjustments/apply_adjustment's own established role list
-- (super_admin, hotel_owner, general_manager, housekeeping_supervisor) —
-- adjustments are a supervisory correction action in this codebase's own
-- existing convention, not a front-line action.

CREATE OR REPLACE FUNCTION public.issue_reservation_item(
  _reservation_id UUID,
  _inventory_item_id UUID,
  _location_id UUID,
  _quantity NUMERIC,
  _request_id UUID,
  _notes TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  res RECORD;
  _current_qty NUMERIC(14,3);
  _existing_id UUID;
  _new_id UUID;
BEGIN
  IF _request_id IS NULL THEN
    RAISE EXCEPTION 'A request id is required';
  END IF;
  -- Serializes every call carrying this exact request_id, including two
  -- truly concurrent ones -- whichever loses the race waits here until the
  -- winner's transaction has fully committed (or rolled back), so the
  -- existing-row check just below always sees the winner's real outcome.
  PERFORM pg_advisory_xact_lock(hashtextextended(_request_id::text, 0));

  SELECT * INTO res FROM public.reservations WHERE id = _reservation_id;
  IF res IS NULL THEN
    RAISE EXCEPTION 'Reservation not found';
  END IF;

  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','hotel_owner','general_manager','front_desk','housekeeping_supervisor','housekeeping','storekeeper']::app_role[],
    res.property_id
  ) THEN
    RAISE EXCEPTION 'Not permitted to issue items for this reservation';
  END IF;

  -- Idempotent replay: this exact request already succeeded (or a
  -- concurrent call just finished it while we waited on the lock above) --
  -- return the same result, re-running nothing.
  SELECT id INTO _existing_id FROM public.reservation_item_distributions
    WHERE property_id = res.property_id AND request_id = _request_id;
  IF _existing_id IS NOT NULL THEN
    RETURN _existing_id;
  END IF;

  IF res.status <> 'checked_in' THEN
    RAISE EXCEPTION 'Items can only be issued to a checked-in reservation (current status: %)', res.status;
  END IF;

  IF _quantity IS NULL OR _quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.inventory_items WHERE id = _inventory_item_id AND property_id = res.property_id AND active
  ) THEN
    RAISE EXCEPTION 'Item does not belong to this property, or is not active';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.stock_locations WHERE id = _location_id AND property_id = res.property_id
  ) THEN
    RAISE EXCEPTION 'Location does not belong to this property';
  END IF;

  -- Row lock: serializes concurrent issues of the SAME item+location so
  -- the availability check below is authoritative, not a race against the
  -- client's last-fetched "available stock" display.
  SELECT quantity INTO _current_qty
    FROM public.item_stock
    WHERE item_id = _inventory_item_id AND location_id = _location_id
    FOR UPDATE;

  IF COALESCE(_current_qty, 0) < _quantity THEN
    RAISE EXCEPTION 'Insufficient stock: % available, % requested', COALESCE(_current_qty, 0), _quantity;
  END IF;

  PERFORM public.apply_stock_delta(res.property_id, _inventory_item_id, _location_id, -_quantity);

  INSERT INTO public.reservation_item_distributions(
    property_id, reservation_id, room_id, guest_id, inventory_item_id, location_id,
    action, quantity, reason, actor_id, request_id
  ) VALUES (
    res.property_id, _reservation_id, res.room_id, res.guest_id, _inventory_item_id, _location_id,
    'issue', _quantity, _notes, auth.uid(), _request_id
  ) RETURNING id INTO _new_id;

  PERFORM public.audit_capture(
    res.property_id, 'reservation_item_distribution', _new_id::text, 'issue',
    NULL, jsonb_build_object('reservationId', _reservation_id, 'itemId', _inventory_item_id, 'locationId', _location_id, 'quantity', _quantity),
    'Issued ' || _quantity || ' unit(s) to reservation ' || res.code,
    NULL, NULL, NULL, NULL, NULL, NULL, true, NULL
  );

  RETURN _new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.issue_reservation_item(UUID, UUID, UUID, NUMERIC, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.issue_reservation_item(UUID, UUID, UUID, NUMERIC, UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.return_reservation_item(
  _distribution_id UUID,
  _quantity NUMERIC,
  _request_id UUID,
  _notes TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  orig RECORD;
  _outstanding NUMERIC(14,3);
  _existing_id UUID;
  _new_id UUID;
BEGIN
  IF _request_id IS NULL THEN
    RAISE EXCEPTION 'A request id is required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_request_id::text, 0));

  -- Row lock on the original issue row: every return/adjustment against
  -- this same issue must acquire this lock first, so two concurrent
  -- returns against the same issue serialize instead of racing.
  SELECT * INTO orig FROM public.reservation_item_distributions
    WHERE id = _distribution_id AND action = 'issue' FOR UPDATE;
  IF orig IS NULL THEN
    RAISE EXCEPTION 'Original issue record not found';
  END IF;

  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','hotel_owner','general_manager','front_desk','housekeeping_supervisor','housekeeping','storekeeper']::app_role[],
    orig.property_id
  ) THEN
    RAISE EXCEPTION 'Not permitted to return items for this reservation';
  END IF;

  SELECT id INTO _existing_id FROM public.reservation_item_distributions
    WHERE property_id = orig.property_id AND request_id = _request_id;
  IF _existing_id IS NOT NULL THEN
    RETURN _existing_id;
  END IF;

  IF _quantity IS NULL OR _quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero';
  END IF;

  SELECT
    orig.quantity
    + COALESCE((SELECT SUM(d.quantity) FROM public.reservation_item_distributions d WHERE d.related_distribution_id = orig.id AND d.action = 'adjustment' AND d.stock_direction = 'deduct'), 0)
    - COALESCE((SELECT SUM(d.quantity) FROM public.reservation_item_distributions d WHERE d.related_distribution_id = orig.id AND d.action = 'return'), 0)
    - COALESCE((SELECT SUM(d.quantity) FROM public.reservation_item_distributions d WHERE d.related_distribution_id = orig.id AND d.action = 'adjustment' AND d.stock_direction IN ('restore','none')), 0)
  INTO _outstanding;

  IF _quantity > _outstanding THEN
    RAISE EXCEPTION 'Return exceeds outstanding quantity: % outstanding, % requested', _outstanding, _quantity;
  END IF;

  PERFORM public.apply_stock_delta(orig.property_id, orig.inventory_item_id, orig.location_id, _quantity);

  INSERT INTO public.reservation_item_distributions(
    property_id, reservation_id, room_id, guest_id, inventory_item_id, location_id,
    action, quantity, related_distribution_id, reason, actor_id, request_id
  ) VALUES (
    orig.property_id, orig.reservation_id, orig.room_id, orig.guest_id, orig.inventory_item_id, orig.location_id,
    'return', _quantity, orig.id, _notes, auth.uid(), _request_id
  ) RETURNING id INTO _new_id;

  PERFORM public.audit_capture(
    orig.property_id, 'reservation_item_distribution', _new_id::text, 'return',
    NULL, jsonb_build_object('originalDistributionId', orig.id, 'reservationId', orig.reservation_id, 'quantity', _quantity),
    'Returned ' || _quantity || ' unit(s) against issue ' || orig.id,
    NULL, NULL, NULL, NULL, NULL, NULL, true, NULL
  );

  RETURN _new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.return_reservation_item(UUID, NUMERIC, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.return_reservation_item(UUID, NUMERIC, UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.adjust_reservation_item_distribution(
  _distribution_id UUID,
  _quantity NUMERIC,
  _stock_direction TEXT,
  _reason TEXT,
  _request_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  orig RECORD;
  _outstanding NUMERIC(14,3);
  _current_qty NUMERIC(14,3);
  _existing_id UUID;
  _new_id UUID;
BEGIN
  IF _request_id IS NULL THEN
    RAISE EXCEPTION 'A request id is required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_request_id::text, 0));

  SELECT * INTO orig FROM public.reservation_item_distributions
    WHERE id = _distribution_id AND action = 'issue' FOR UPDATE;
  IF orig IS NULL THEN
    RAISE EXCEPTION 'Original issue record not found';
  END IF;

  -- Narrower, supervisory role set -- deliberately identical to
  -- stock_adjustments/apply_adjustment's own precedent, not the broader
  -- issue/return role list above.
  IF NOT public.has_any_role(
    auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','housekeeping_supervisor']::app_role[], orig.property_id
  ) THEN
    RAISE EXCEPTION 'Not permitted to adjust this distribution';
  END IF;

  SELECT id INTO _existing_id FROM public.reservation_item_distributions
    WHERE property_id = orig.property_id AND request_id = _request_id;
  IF _existing_id IS NOT NULL THEN
    RETURN _existing_id;
  END IF;

  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required for an adjustment';
  END IF;
  IF _quantity IS NULL OR _quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero';
  END IF;
  IF _stock_direction NOT IN ('restore', 'deduct', 'none') THEN
    RAISE EXCEPTION 'Invalid stock direction: %', _stock_direction;
  END IF;

  IF _stock_direction IN ('restore', 'none') THEN
    SELECT
      orig.quantity
      + COALESCE((SELECT SUM(d.quantity) FROM public.reservation_item_distributions d WHERE d.related_distribution_id = orig.id AND d.action = 'adjustment' AND d.stock_direction = 'deduct'), 0)
      - COALESCE((SELECT SUM(d.quantity) FROM public.reservation_item_distributions d WHERE d.related_distribution_id = orig.id AND d.action = 'return'), 0)
      - COALESCE((SELECT SUM(d.quantity) FROM public.reservation_item_distributions d WHERE d.related_distribution_id = orig.id AND d.action = 'adjustment' AND d.stock_direction IN ('restore','none')), 0)
    INTO _outstanding;

    IF _quantity > _outstanding THEN
      RAISE EXCEPTION 'Adjustment exceeds outstanding quantity: % outstanding, % requested', _outstanding, _quantity;
    END IF;
  END IF;

  IF _stock_direction = 'restore' THEN
    PERFORM public.apply_stock_delta(orig.property_id, orig.inventory_item_id, orig.location_id, _quantity);
  ELSIF _stock_direction = 'deduct' THEN
    SELECT quantity INTO _current_qty FROM public.item_stock
      WHERE item_id = orig.inventory_item_id AND location_id = orig.location_id FOR UPDATE;
    IF COALESCE(_current_qty, 0) < _quantity THEN
      RAISE EXCEPTION 'Insufficient stock for this adjustment: % available, % requested', COALESCE(_current_qty, 0), _quantity;
    END IF;
    PERFORM public.apply_stock_delta(orig.property_id, orig.inventory_item_id, orig.location_id, -_quantity);
  END IF;
  -- 'none' (write-off): no stock movement at all.

  INSERT INTO public.reservation_item_distributions(
    property_id, reservation_id, room_id, guest_id, inventory_item_id, location_id,
    action, quantity, related_distribution_id, stock_direction, reason, actor_id, request_id
  ) VALUES (
    orig.property_id, orig.reservation_id, orig.room_id, orig.guest_id, orig.inventory_item_id, orig.location_id,
    'adjustment', _quantity, orig.id, _stock_direction, _reason, auth.uid(), _request_id
  ) RETURNING id INTO _new_id;

  PERFORM public.audit_capture(
    orig.property_id, 'reservation_item_distribution', _new_id::text, 'adjustment',
    NULL, jsonb_build_object('originalDistributionId', orig.id, 'reservationId', orig.reservation_id, 'quantity', _quantity, 'stockDirection', _stock_direction, 'reason', _reason),
    'Adjusted (' || _stock_direction || ') ' || _quantity || ' unit(s) against issue ' || orig.id,
    NULL, NULL, NULL, NULL, NULL, NULL, true, NULL
  );

  RETURN _new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.adjust_reservation_item_distribution(UUID, NUMERIC, TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.adjust_reservation_item_distribution(UUID, NUMERIC, TEXT, TEXT, UUID) TO authenticated;
