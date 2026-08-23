-- ============================================================
-- Inventory CSV/XLSX import hardening: a single guarded RPC that lets the
-- bulk importer create one catalog item, its opening item_stock quantity,
-- and its opening inventory_stock_batches record atomically per uploaded
-- row -- instead of the several unrelated client-driven inserts the
-- generic /admin/uploads importer used before this migration.
--
-- Purely ADDITIVE: one new function, no table/column changes, no data
-- backfill. Mirrors the already-shipped receive_purchase_order() pattern
-- (same role check, same apply_stock_delta() call, same
-- inventory_stock_batches insert shape) so imported opening stock behaves
-- identically to stock received through a purchase order.
--
-- Expiry belongs to inventory_stock_batches only -- inventory_items is
-- never touched for expiry, and item_stock remains the sole running-total
-- quantity source of truth (apply_stock_delta() is the only thing that
-- ever changes it here, exactly as everywhere else in this schema).
-- ============================================================

-- Widen data_uploads.status to add 'processing' -- used as a same-request
-- atomic claim (UPDATE ... WHERE status='pending' RETURNING *) so two
-- concurrent Approve clicks on the same upload can't both process it: the
-- first request's UPDATE flips pending->processing and returns the row,
-- the second's UPDATE affects zero rows and is rejected before it can call
-- import_inventory_item at all. Purely additive to the existing CHECK.
ALTER TABLE public.data_uploads DROP CONSTRAINT data_uploads_status_check;
ALTER TABLE public.data_uploads ADD CONSTRAINT data_uploads_status_check
  CHECK (status IN ('pending','processing','approved','rejected','imported'));

CREATE OR REPLACE FUNCTION public.import_inventory_item(
  _property_id UUID,
  _name TEXT,
  _sku TEXT,
  _category TEXT DEFAULT NULL,
  _unit TEXT DEFAULT NULL,
  _cost NUMERIC DEFAULT 0,
  _sale_price NUMERIC DEFAULT 0,
  _reorder_level NUMERIC DEFAULT 0,
  _location_name TEXT DEFAULT NULL,
  _opening_quantity NUMERIC DEFAULT NULL,
  _expiry_date DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _item_id UUID;
  _location_id UUID;
  _batch_id UUID;
  _category_id UUID;
  _existing_id UUID;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager']::app_role[], _property_id) THEN
    RAISE EXCEPTION 'Not permitted to import inventory for this property';
  END IF;

  IF _name IS NULL OR btrim(_name) = '' THEN
    RAISE EXCEPTION 'Item name is required';
  END IF;
  IF _sku IS NULL OR btrim(_sku) = '' THEN
    RAISE EXCEPTION 'SKU is required';
  END IF;
  IF _cost IS NULL OR _cost < 0 THEN
    RAISE EXCEPTION 'Cost cannot be negative';
  END IF;
  IF _sale_price IS NULL OR _sale_price < 0 THEN
    RAISE EXCEPTION 'Selling price cannot be negative';
  END IF;
  IF _reorder_level IS NULL OR _reorder_level < 0 THEN
    RAISE EXCEPTION 'Reorder level cannot be negative';
  END IF;
  IF _opening_quantity IS NOT NULL AND _opening_quantity < 0 THEN
    RAISE EXCEPTION 'Opening quantity cannot be negative';
  END IF;

  -- Duplicate check -- the authoritative, race-safe backstop behind any
  -- client-side/JS pre-check. Never overwrites an existing item: a
  -- duplicate SKU within this property is reported back, not merged into.
  SELECT id INTO _existing_id FROM public.inventory_items
    WHERE property_id = _property_id AND sku = btrim(_sku);
  IF _existing_id IS NOT NULL THEN
    RETURN jsonb_build_object('created', false, 'skipped', true, 'reason', 'duplicate_sku', 'item_id', _existing_id);
  END IF;

  -- Locations are never auto-created from spreadsheet text -- they are a
  -- physical/operational concept the property must already have set up.
  -- An unrecognized (or cross-property) location name is a hard failure,
  -- not a silent no-op.
  IF _location_name IS NOT NULL AND btrim(_location_name) <> '' THEN
    SELECT id INTO _location_id FROM public.stock_locations
      WHERE property_id = _property_id AND lower(name) = lower(btrim(_location_name));
    IF _location_id IS NULL THEN
      RAISE EXCEPTION 'Unknown stock location: %', _location_name;
    END IF;
  END IF;

  IF _opening_quantity IS NOT NULL AND _opening_quantity > 0 AND _location_id IS NULL THEN
    RAISE EXCEPTION 'Opening quantity requires a valid stock location';
  END IF;
  IF _expiry_date IS NOT NULL AND (_opening_quantity IS NULL OR _opening_quantity <= 0 OR _location_id IS NULL) THEN
    RAISE EXCEPTION 'Expiry date requires an opening quantity and a stock location';
  END IF;

  -- Category: create-if-missing by name, mirroring the ensureCategory
  -- pattern already used for POS-menu imports in this same uploads flow.
  IF _category IS NOT NULL AND btrim(_category) <> '' THEN
    SELECT id INTO _category_id FROM public.item_categories
      WHERE property_id = _property_id AND lower(name) = lower(btrim(_category));
    IF _category_id IS NULL THEN
      INSERT INTO public.item_categories(property_id, name)
        VALUES (_property_id, btrim(_category))
        RETURNING id INTO _category_id;
    END IF;
  END IF;

  INSERT INTO public.inventory_items(property_id, sku, name, category_id, unit, cost, sale_price, reorder_level)
    VALUES (
      _property_id, btrim(_sku), btrim(_name), _category_id,
      coalesce(nullif(btrim(_unit), ''), 'each'), _cost, _sale_price, _reorder_level
    )
    RETURNING id INTO _item_id;

  IF _opening_quantity IS NOT NULL AND _opening_quantity > 0 AND _location_id IS NOT NULL THEN
    PERFORM public.apply_stock_delta(_property_id, _item_id, _location_id, _opening_quantity);

    INSERT INTO public.inventory_stock_batches(
      property_id, item_id, location_id, received_quantity, expiry_date, notes, created_by
    ) VALUES (
      _property_id, _item_id, _location_id, _opening_quantity, _expiry_date,
      'Opening stock — inventory import', auth.uid()
    )
    RETURNING id INTO _batch_id;
  END IF;

  RETURN jsonb_build_object('created', true, 'skipped', false, 'item_id', _item_id, 'batch_id', _batch_id);
END;
$$;

REVOKE ALL ON FUNCTION public.import_inventory_item(UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, NUMERIC, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.import_inventory_item(UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, NUMERIC, DATE) TO authenticated;
