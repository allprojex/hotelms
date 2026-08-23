-- Inventory expiration-date support (client request: "Theskwoff bar & Hotel
-- should have product Expiration date for the inventory setup template").
--
-- DESIGN DECISION (see PR description for full reasoning): no batch/lot
-- table exists today. Stock quantity is a single running total per
-- (item, location) in item_stock, maintained exclusively through
-- apply_stock_delta(). The client's own example (one batch of bottled
-- water expiring in October, another receipt of the same item expiring in
-- December) rules out a single expiry_date column on inventory_items —
-- that would silently collapse to one date per item.
--
-- This migration adds a purely ADDITIVE inventory_stock_batches table that
-- records each receipt-with-expiry-visibility separately. It is
-- deliberately NOT wired into apply_stock_delta, close_pos_order,
-- execute_transfer, or apply_adjustment — item_stock.quantity remains the
-- ONE authoritative source of truth for "how much stock exists right now".
-- inventory_stock_batches.received_quantity is a historical record of how
-- much a specific dated receipt contained, not a second live balance — so
-- there is no duplicate source of truth for quantity, and no existing
-- quantity-mutating code path changes behavior.
--
-- Mutation is RPC-only (no direct GRANT INSERT/UPDATE/DELETE to
-- authenticated), mirroring the payments/reservation_charges hardening
-- pattern already established in this codebase: receive_purchase_order()
-- is extended (backward compatibly — new parameter defaults to NULL) to
-- optionally record a batch per received line, and a new, narrowly-scoped
-- update_batch_expiry() RPC is the only way to edit an existing batch —
-- it touches expiry_date and updated_at only, never quantity, cost, or
-- item_stock, and never creates any accounting/journal entry (inventory
-- has zero accounting linkage in this schema today, confirmed by audit).

CREATE TABLE public.inventory_stock_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES public.stock_locations(id) ON DELETE RESTRICT,
  received_quantity NUMERIC(14,3) NOT NULL CHECK (received_quantity > 0),
  received_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expiry_date DATE,
  source_po_id UUID REFERENCES public.purchase_orders(id) ON DELETE SET NULL,
  source_po_line_id UUID REFERENCES public.purchase_order_lines(id) ON DELETE SET NULL,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  -- Deliberately NO constraint requiring expiry_date >= received_date:
  -- receiving an already-expired product (legacy/historical stock, a
  -- supplier error, etc.) must be recordable, not blocked — confirmed via
  -- live testing that the naive version of this constraint incorrectly
  -- rejected exactly that case. The UI is responsible for surfacing an
  -- explicit warning when expiry_date is in the past, per the documented
  -- "allow + warn" decision (see PR description Phase 5).
);

CREATE INDEX inventory_stock_batches_item_idx ON public.inventory_stock_batches(item_id);
CREATE INDEX inventory_stock_batches_property_expiry_idx ON public.inventory_stock_batches(property_id, expiry_date);

-- Read-only to authenticated: every write goes through the two RPCs below.
GRANT SELECT ON public.inventory_stock_batches TO authenticated;
GRANT ALL ON public.inventory_stock_batches TO service_role;
ALTER TABLE public.inventory_stock_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY inv_stock_batches_read ON public.inventory_stock_batches FOR SELECT TO authenticated
  USING (public.can_access_property(auth.uid(), property_id));

CREATE TRIGGER trg_inv_stock_batches_updated BEFORE UPDATE ON public.inventory_stock_batches
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- Configurable "expiring soon" threshold. No existing inventory-settings or
-- property-settings table exists for this — a single nullable-with-default
-- column on the already-property-scoped properties table is the smallest
-- safe extension (no new table, no new RLS surface).
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS inventory_expiry_warning_days INTEGER NOT NULL DEFAULT 30
    CHECK (inventory_expiry_warning_days > 0);

-- ============================================================
-- receive_purchase_order: extended, backward-compatible.
-- ============================================================
-- Existing callers (receive_purchase_order(poId)) are unaffected — the new
-- parameter defaults to NULL, in which case every received line still gets
-- a batch row (received_date = today, expiry_date = NULL, i.e. "No
-- Expiry") so the batch table stays a complete receiving history even
-- when no one is tracking expiry for a given delivery.  When the caller
-- provides expiry dates, they are used per line.  Line-quantity/item_stock
-- logic is byte-for-byte the same as before this migration.
--
-- DROP first: CREATE OR REPLACE cannot change a function's parameter list
-- in place — with a different signature it creates a second, overloaded
-- function instead of replacing the original, which would make a
-- single-argument call ambiguous (Postgres can't tell whether it should
-- resolve to the old exact 1-arg overload or the new 2-arg-with-default
-- one). Dropping the old 1-arg overload first guarantees exactly one
-- receive_purchase_order function exists after this migration.
DROP FUNCTION IF EXISTS public.receive_purchase_order(UUID);

CREATE OR REPLACE FUNCTION public.receive_purchase_order(_po_id UUID, _line_expiry JSONB DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  p RECORD;
  _received NUMERIC(14,3);
  _expiry DATE;
BEGIN
  SELECT * INTO p FROM public.purchase_orders WHERE id = _po_id;
  IF p IS NULL THEN
    RAISE EXCEPTION 'PO not found';
  END IF;
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager']::app_role[], p.property_id) THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  IF p.location_id IS NULL THEN
    RAISE EXCEPTION 'PO has no destination location';
  END IF;

  FOR r IN SELECT * FROM public.purchase_order_lines WHERE po_id = _po_id LOOP
    _received := r.quantity - r.received_qty;
    IF _received > 0 THEN
      PERFORM public.apply_stock_delta(p.property_id, r.item_id, p.location_id, _received);
      UPDATE public.purchase_order_lines SET received_qty = r.quantity WHERE id = r.id;

      _expiry := NULL;
      IF _line_expiry IS NOT NULL AND _line_expiry ? r.id::text THEN
        BEGIN
          _expiry := (_line_expiry ->> r.id::text)::DATE;
        EXCEPTION WHEN OTHERS THEN
          RAISE EXCEPTION 'Invalid expiry date for purchase order line %: %', r.id, _line_expiry ->> r.id::text;
        END;
      END IF;

      INSERT INTO public.inventory_stock_batches(
        property_id, item_id, location_id, received_quantity, received_date, expiry_date,
        source_po_id, source_po_line_id, created_by
      ) VALUES (
        p.property_id, r.item_id, p.location_id, _received, CURRENT_DATE, _expiry,
        p.id, r.id, auth.uid()
      );
    END IF;
  END LOOP;

  UPDATE public.purchase_orders SET status = 'received', received_at = now() WHERE id = _po_id;
END;
$$;

-- ============================================================
-- update_batch_expiry: the ONLY way to edit an existing batch's expiry.
-- ============================================================
-- Expiry-only by construction: the UPDATE statement never references
-- received_quantity, item_id, location_id, source_po_id, or any other
-- column. Never touches item_stock. Never creates a journal entry
-- (inventory has no accounting linkage in this schema at all). Pass NULL
-- to clear an expiry date back to "No Expiry".
CREATE OR REPLACE FUNCTION public.update_batch_expiry(_batch_id UUID, _expiry_date DATE)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  b RECORD;
BEGIN
  SELECT * INTO b FROM public.inventory_stock_batches WHERE id = _batch_id;
  IF b IS NULL THEN
    RAISE EXCEPTION 'Batch not found';
  END IF;
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','hotel_owner','general_manager','front_desk','cashier','housekeeping_supervisor']::app_role[],
    b.property_id
  ) THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  -- No "expiry >= received_date" restriction here either, for the same
  -- reason as the table itself: correcting a batch to reflect it was
  -- already expired on arrival must be allowed, not blocked.

  UPDATE public.inventory_stock_batches
    SET expiry_date = _expiry_date, updated_at = now()
    WHERE id = _batch_id;
END;
$$;

REVOKE ALL ON FUNCTION public.receive_purchase_order(UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.receive_purchase_order(UUID, JSONB) TO authenticated;
REVOKE ALL ON FUNCTION public.update_batch_expiry(UUID, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_batch_expiry(UUID, DATE) TO authenticated;
