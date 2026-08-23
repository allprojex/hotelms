-- ============================================================
-- Whole-file inventory-import atomicity fix.
--
-- import_inventory_item() (20260823150000) is atomic PER ROW only: each
-- call is its own PostgREST/RPC round-trip, so it's its own transaction.
-- The importer's approveUpload() JS handler called it once per row in a
-- loop, so if row 138 of a 200-row file hit an unexpected DB error, rows
-- 1-137 remained fully committed (proven live: two rows survived a third
-- row's numeric-overflow failure in three separate top-level calls) --
-- and the loop didn't even stop there, it kept going through the rest of
-- the file. That is a real partial-import bug against the "rollback on
-- failure" requirement.
--
-- import_inventory_items() below is the fix: ONE call takes the whole
-- validated row set as JSONB and processes it in a single PL/pgSQL
-- function invocation. A PL/pgSQL function body runs inside one implicit
-- transaction unless a nested block establishes its own EXCEPTION-handler
-- savepoint -- this function deliberately never does that per row, so an
-- uncaught RAISE EXCEPTION from ANY row aborts the whole call and rolls
-- back every row already processed in it, exactly like a single manual
-- multi-statement transaction would. It calls import_inventory_item()
-- internally (shared logic, not duplicated) for each row -- a known
-- duplicate SKU is still a normal (non-exception) skip, so skip-mode rows
-- commit together with the rest of the accepted set without aborting
-- anything, while reject-mode is checked as a separate pre-pass BEFORE the
-- loop, so it can truthfully "mutate zero rows" on rejection.
-- ============================================================

CREATE OR REPLACE FUNCTION public.import_inventory_items(
  _property_id UUID,
  _rows JSONB,
  _duplicate_mode TEXT DEFAULT 'skip'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row JSONB;
  _result JSONB;
  _results JSONB := '[]'::jsonb;
  _created_count INT := 0;
  _skipped_count INT := 0;
  _requested_skus TEXT[];
  _existing_skus TEXT[];
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager']::app_role[], _property_id) THEN
    RAISE EXCEPTION 'Not permitted to import inventory for this property';
  END IF;

  IF _duplicate_mode NOT IN ('skip', 'reject') THEN
    RAISE EXCEPTION 'Invalid duplicate mode: %', _duplicate_mode;
  END IF;

  IF _rows IS NULL OR jsonb_typeof(_rows) <> 'array' OR jsonb_array_length(_rows) = 0 THEN
    RAISE EXCEPTION 'No rows to import';
  END IF;

  -- REJECT mode: check every requested SKU against this property's
  -- existing inventory FIRST, before anything below can mutate a single
  -- row. If any collide, the whole call raises here and nothing commits.
  IF _duplicate_mode = 'reject' THEN
    SELECT array_agg(DISTINCT btrim(r ->> 'sku'))
      INTO _requested_skus
      FROM jsonb_array_elements(_rows) r
      WHERE r ->> 'sku' IS NOT NULL AND btrim(r ->> 'sku') <> '';

    IF _requested_skus IS NOT NULL THEN
      SELECT array_agg(sku) INTO _existing_skus
        FROM public.inventory_items
        WHERE property_id = _property_id AND sku = ANY(_requested_skus);
      IF _existing_skus IS NOT NULL AND array_length(_existing_skus, 1) > 0 THEN
        RAISE EXCEPTION 'Import rejected: duplicate SKU(s) already exist in this property: %',
          array_to_string(_existing_skus, ', ');
      END IF;
    END IF;
  END IF;

  -- Whole-batch mutation loop. No per-row BEGIN/EXCEPTION savepoint here
  -- on purpose: an unhandled exception from import_inventory_item() (bad
  -- location, negative value, numeric overflow, anything unexpected)
  -- propagates straight out of this loop and this whole function, which
  -- rolls back every row already processed by this call -- including
  -- ones that individually "succeeded" moments earlier.
  FOR _row IN SELECT * FROM jsonb_array_elements(_rows)
  LOOP
    _result := public.import_inventory_item(
      _property_id,
      _row ->> 'name',
      _row ->> 'sku',
      _row ->> 'category',
      _row ->> 'unit',
      COALESCE((_row ->> 'cost')::numeric, 0),
      COALESCE((_row ->> 'sale_price')::numeric, 0),
      COALESCE((_row ->> 'reorder_level')::numeric, 0),
      _row ->> 'location',
      NULLIF(_row ->> 'opening_quantity', '')::numeric,
      NULLIF(_row ->> 'expiry_date', '')::date
    );
    IF (_result ->> 'skipped')::boolean THEN
      _skipped_count := _skipped_count + 1;
    ELSE
      _created_count := _created_count + 1;
    END IF;
    _results := _results || jsonb_build_array(_result);
  END LOOP;

  RETURN jsonb_build_object('created', _created_count, 'skipped', _skipped_count, 'results', _results);
END;
$$;

REVOKE ALL ON FUNCTION public.import_inventory_items(UUID, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.import_inventory_items(UUID, JSONB, TEXT) TO authenticated;
