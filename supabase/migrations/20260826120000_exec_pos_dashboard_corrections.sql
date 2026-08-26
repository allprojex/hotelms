-- ============================================================
-- POS Executive Dashboard — PR-A1: correctness reconciliation.
--
-- Follows 20260826090000_exec_pos_dashboard_rpcs.sql (PR #82), which stays
-- untouched as history. That migration shipped the right security posture —
-- SECURITY INVOKER, STABLE, pinned search_path, a mandatory _property_id and
-- the four-role Executive gate — and this migration keeps every bit of it.
-- What it corrects is three semantic defects found by an independent
-- implementation of the same brief, plus the output contract, which is
-- settled here because no UI consumes these functions yet.
--
-- 1. FOLIO SETTLEMENTS WERE COUNTED AS TILL TAKINGS.
--    close_pos_order() writes the chosen payment method onto a pos_payments
--    row even when the settlement is pushed to a guest folio (it sets
--    folio_charge_id and inserts a reservation_charges row). The previous
--    definitions never looked at folio_charge_id, so a room-charged sale was
--    reported as cash in hand. Folio rows are now excluded from every
--    payment-method bucket and from the till totals, and surfaced separately
--    as folio_posted_count / folio_posted_amount. The closed order itself
--    still counts as an operational sale — charging a sale to a room does
--    not make the sale disappear.
--
-- 2. LIVE ORDER VALUE WAS STRUCTURALLY ZERO.
--    pos_orders.subtotal/tax/total default to 0 and are only written by
--    close_pos_order() at settle time; the order screen computes running
--    totals client-side. SUM(pos_orders.total) over open/sent/served orders
--    therefore always returned 0. Live value is now derived from the order
--    lines (SUM(price_snapshot * quantity)) and named open_order_line_value
--    so it is never mistaken for a tax-inclusive final bill — tax does not
--    exist on an unsettled order.
--
-- 3. THE LIVE SNAPSHOT IGNORED THE REPORT WINDOW ENTIRELY.
--    Live orders were selected by status alone, so a historical report
--    showed orders opened after its end date. The snapshot is now bounded at
--    the top only: opened_at::date <= _to, with deliberately NO lower bound,
--    so an order opened before _from that is still live remains visible
--    while one opened after _to does not leak into a past report.
--
-- Unchanged and deliberately re-asserted: only closed orders are operational
-- sales (keyed on closed_at); void orders contribute no value anywhere;
-- payments key on received_at; orders, items and payments are aggregated in
-- separate CTEs so a multi-line or multi-payment order cannot multiply its
-- own value; nothing aggregates across properties; and the functions return
-- raw numerics, leaving currency to execCurrency()/execMoney() over the
-- property's base_currency.
--
-- WHY DROP + CREATE RATHER THAN CREATE OR REPLACE: every function below
-- gains output columns, and CREATE OR REPLACE cannot change a RETURNS TABLE
-- row type. Each DROP names the exact existing signature and is immediately
-- followed by its recreation with the SAME callable signature and argument
-- names, so no caller's call shape changes. This mirrors the established
-- pattern in 20260820120000_property_branding.sql's get_brand_settings().
-- DROP also discards the previous grants, so each function re-issues its own
-- REVOKE/GRANT below.
--
-- SCOPE NOTE: these are OPERATIONAL POS SALES read from the POS tables. They
-- are not accounting revenue and do not reconcile to the general ledger. POS
-- journal posting has known pre-existing defects (hardcoded USD, always
-- debiting cash, no reversal when an order is voided or deleted) and POS
-- orders can be hard-deleted by the super-admin trial-data purge, so
-- operational reporting reflects SURVIVING POS rows while historical journal
-- entries may outlive them. None of that is compensated for here; it is
-- separate financial-integrity work.
-- ============================================================

-- ------------------------------------------------------------
-- 1. exec_pos_summary
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.exec_pos_summary(uuid, date, date);

CREATE FUNCTION public.exec_pos_summary(
  _property_id uuid, _from date, _to date
) RETURNS TABLE (
  operational_sales numeric,
  operational_sales_net numeric,
  operational_tax numeric,
  closed_order_count bigint,
  void_order_count bigint,
  open_order_count bigint,
  open_order_line_value numeric,
  till_payment_count bigint,
  till_payment_amount numeric,
  cash_amount numeric,
  card_amount numeric,
  mobile_money_amount numeric,
  bank_transfer_amount numeric,
  wallet_amount numeric,
  other_amount numeric,
  folio_posted_count bigint,
  folio_posted_amount numeric
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
BEGIN
  -- A NULL property yields no report at all, rather than a synthetic
  -- all-zero row that a caller could mistake for a real quiet day.
  IF _property_id IS NULL THEN RETURN; END IF;
  IF NOT public.has_any_role(auth.uid(),
      ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  -- One RLS-filtered pass over pos_orders: the row-level policy calls
  -- can_access_property() per candidate row, so every extra scan of this
  -- table repeats that per-row cost.
  WITH scoped AS MATERIALIZED (
    SELECT o.id, o.total, o.subtotal, o.tax,
           (o.status = 'closed' AND o.closed_at IS NOT NULL
              AND o.closed_at::date BETWEEN _from AND _to) AS is_closed_in_range,
           (o.status = 'void' AND o.closed_at IS NOT NULL
              AND o.closed_at::date BETWEEN _from AND _to) AS is_void_in_range,
           (o.status IN ('open','sent','served') AND o.opened_at::date <= _to) AS is_live
    FROM pos_orders o
    WHERE o.property_id = _property_id
      AND (
        (o.status IN ('closed','void') AND o.closed_at IS NOT NULL
           AND o.closed_at::date BETWEEN _from AND _to)
        -- Live snapshot: bounded above by _to, never below by _from.
        OR (o.status IN ('open','sent','served') AND o.opened_at::date <= _to)
      )
  ),
  orders AS (
    SELECT
      COALESCE(SUM(total) FILTER (WHERE is_closed_in_range), 0)::numeric AS gross,
      COALESCE(SUM(subtotal) FILTER (WHERE is_closed_in_range), 0)::numeric AS net,
      COALESCE(SUM(tax) FILTER (WHERE is_closed_in_range), 0)::numeric AS tax,
      COUNT(*) FILTER (WHERE is_closed_in_range)::bigint AS closed_cnt,
      COUNT(*) FILTER (WHERE is_void_in_range)::bigint AS void_cnt,
      COUNT(*) FILTER (WHERE is_live)::bigint AS live_cnt
    FROM scoped
  ),
  -- Lines are summed per order first; the per-order values are only then
  -- totalled, so a multi-line order cannot multiply anything.
  live_lines AS (
    SELECT i.order_id, SUM(i.price_snapshot * i.quantity) AS line_value
    FROM pos_order_items i
    JOIN scoped s ON s.id = i.order_id AND s.is_live
    GROUP BY i.order_id
  ),
  live_value AS (
    SELECT COALESCE(SUM(line_value), 0)::numeric AS amt FROM live_lines
  ),
  -- Payments are their own domain: keyed on received_at, never joined back
  -- to an order total.
  pay AS (
    SELECT p.method, p.amount, p.folio_charge_id
    FROM pos_payments p
    JOIN pos_orders o ON o.id = p.order_id
    WHERE o.property_id = _property_id
      AND o.status <> 'void'
      AND p.received_at::date BETWEEN _from AND _to
  ),
  till AS (
    SELECT
      COUNT(*) FILTER (WHERE folio_charge_id IS NULL)::bigint AS cnt,
      COALESCE(SUM(amount) FILTER (WHERE folio_charge_id IS NULL), 0)::numeric AS amt,
      COALESCE(SUM(amount) FILTER (WHERE folio_charge_id IS NULL AND method = 'cash'), 0)::numeric AS cash,
      COALESCE(SUM(amount) FILTER (WHERE folio_charge_id IS NULL AND method = 'card'), 0)::numeric AS card,
      COALESCE(SUM(amount) FILTER (WHERE folio_charge_id IS NULL AND method = 'mobile_money'), 0)::numeric AS momo,
      COALESCE(SUM(amount) FILTER (WHERE folio_charge_id IS NULL AND method = 'bank_transfer'), 0)::numeric AS bank,
      COALESCE(SUM(amount) FILTER (WHERE folio_charge_id IS NULL AND method = 'wallet'), 0)::numeric AS wallet,
      COALESCE(SUM(amount) FILTER (WHERE folio_charge_id IS NULL AND method = 'other'), 0)::numeric AS other,
      COUNT(*) FILTER (WHERE folio_charge_id IS NOT NULL)::bigint AS folio_cnt,
      COALESCE(SUM(amount) FILTER (WHERE folio_charge_id IS NOT NULL), 0)::numeric AS folio_amt
    FROM pay
  )
  SELECT
    orders.gross, orders.net, orders.tax,
    orders.closed_cnt, orders.void_cnt,
    orders.live_cnt, live_value.amt,
    till.cnt, till.amt,
    till.cash, till.card, till.momo, till.bank, till.wallet, till.other,
    till.folio_cnt, till.folio_amt
  FROM orders, live_value, till;
END;
$$;

REVOKE ALL ON FUNCTION public.exec_pos_summary(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exec_pos_summary(uuid, date, date) TO authenticated;

-- ------------------------------------------------------------
-- 2. exec_pos_by_department — outlets INSIDE the selected property.
-- Separate property rows are never treated as departments of one another:
-- no schema relationship establishes that, and their base currencies
-- already differ in production.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.exec_pos_by_department(uuid, date, date);

CREATE FUNCTION public.exec_pos_by_department(
  _property_id uuid, _from date, _to date
) RETURNS TABLE (
  outlet_id uuid,
  outlet_name text,
  outlet_kind text,
  operational_sales numeric,
  closed_order_count bigint,
  live_order_count bigint,
  open_order_line_value numeric
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF _property_id IS NULL THEN RETURN; END IF;
  IF NOT public.has_any_role(auth.uid(),
      ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH scoped AS MATERIALIZED (
    SELECT o.id, o.outlet_id AS oid, o.total,
           (o.status = 'closed' AND o.closed_at IS NOT NULL
              AND o.closed_at::date BETWEEN _from AND _to) AS is_closed_in_range,
           (o.status IN ('open','sent','served') AND o.opened_at::date <= _to) AS is_live
    FROM pos_orders o
    WHERE o.property_id = _property_id
      AND (
        (o.status = 'closed' AND o.closed_at IS NOT NULL
           AND o.closed_at::date BETWEEN _from AND _to)
        OR (o.status IN ('open','sent','served') AND o.opened_at::date <= _to)
      )
  ),
  closed AS (
    SELECT oid, COUNT(*)::bigint AS cnt, COALESCE(SUM(total), 0)::numeric AS gross
    FROM scoped WHERE is_closed_in_range GROUP BY oid
  ),
  -- Per order first, then per outlet.
  live_per_order AS (
    SELECT i.order_id, SUM(i.price_snapshot * i.quantity) AS line_value
    FROM pos_order_items i
    JOIN scoped s ON s.id = i.order_id AND s.is_live
    GROUP BY i.order_id
  ),
  live AS (
    SELECT s.oid,
           COUNT(*)::bigint AS cnt,
           COALESCE(SUM(v.line_value), 0)::numeric AS line_value
    FROM scoped s
    LEFT JOIN live_per_order v ON v.order_id = s.id
    WHERE s.is_live
    GROUP BY s.oid
  )
  -- LEFT JOIN from the outlets so an outlet with no activity still appears.
  SELECT
    ou.id, ou.name, ou.kind::text,
    COALESCE(closed.gross, 0)::numeric,
    COALESCE(closed.cnt, 0)::bigint,
    COALESCE(live.cnt, 0)::bigint,
    COALESCE(live.line_value, 0)::numeric
  FROM pos_outlets ou
  LEFT JOIN closed ON closed.oid = ou.id
  LEFT JOIN live ON live.oid = ou.id
  WHERE ou.property_id = _property_id
  ORDER BY COALESCE(closed.gross, 0) DESC, ou.name;
END;
$$;

REVOKE ALL ON FUNCTION public.exec_pos_by_department(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exec_pos_by_department(uuid, date, date) TO authenticated;

-- ------------------------------------------------------------
-- 3. exec_pos_by_user — two distinct facts, kept apart.
-- pos_orders.created_by opened the order; pos_payments.received_by took the
-- money. Neither column establishes a "salesperson" relationship, so neither
-- is presented as one. A user who only received payments still appears.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.exec_pos_by_user(uuid, date, date);

CREATE FUNCTION public.exec_pos_by_user(
  _property_id uuid, _from date, _to date
) RETURNS TABLE (
  user_id uuid,
  full_name text,
  orders_created_count bigint,
  orders_created_value numeric,
  payments_received_count bigint,
  payments_received_value numeric
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF _property_id IS NULL THEN RETURN; END IF;
  IF NOT public.has_any_role(auth.uid(),
      ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH creators AS (
    SELECT o.created_by AS uid,
           COUNT(*)::bigint AS cnt,
           COALESCE(SUM(o.total), 0)::numeric AS amt
    FROM pos_orders o
    WHERE o.property_id = _property_id
      AND o.status = 'closed'
      AND o.closed_at IS NOT NULL
      AND o.closed_at::date BETWEEN _from AND _to
      AND o.created_by IS NOT NULL
    GROUP BY o.created_by
  ),
  -- Folio settlements are excluded here too: the receiver took no money.
  receivers AS (
    SELECT p.received_by AS uid,
           COUNT(*)::bigint AS cnt,
           COALESCE(SUM(p.amount), 0)::numeric AS amt
    FROM pos_payments p
    JOIN pos_orders o ON o.id = p.order_id
    WHERE o.property_id = _property_id
      AND o.status <> 'void'
      AND p.folio_charge_id IS NULL
      AND p.received_at::date BETWEEN _from AND _to
      AND p.received_by IS NOT NULL
    GROUP BY p.received_by
  ),
  -- Both sides are already aggregated per user, so this key union cannot
  -- multiply either side.
  ids AS (
    SELECT uid FROM creators UNION SELECT uid FROM receivers
  )
  SELECT
    ids.uid,
    pr.full_name,
    COALESCE(c.cnt, 0)::bigint,
    COALESCE(c.amt, 0)::numeric,
    COALESCE(r.cnt, 0)::bigint,
    COALESCE(r.amt, 0)::numeric
  FROM ids
  LEFT JOIN creators c ON c.uid = ids.uid
  LEFT JOIN receivers r ON r.uid = ids.uid
  -- profiles is read under the caller's own RLS, exactly like every other
  -- table here, so joining it widens no boundary.
  LEFT JOIN profiles pr ON pr.id = ids.uid
  ORDER BY COALESCE(c.amt, 0) DESC, COALESCE(r.amt, 0) DESC, ids.uid;
END;
$$;

REVOKE ALL ON FUNCTION public.exec_pos_by_user(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exec_pos_by_user(uuid, date, date) TO authenticated;

-- ------------------------------------------------------------
-- 4. exec_pos_top_items
-- Grouped by (menu_item_id, name_snapshot) rather than the name alone: two
-- distinct menu items may legitimately share a display name, and collapsing
-- them would invent a single seller that never existed. Historical lines
-- whose menu_item_id is NULL (the menu item was deleted) are preserved as
-- their own group rather than dropped, and the reported name is always the
-- snapshot taken at sale time.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.exec_pos_top_items(uuid, date, date, integer);

CREATE FUNCTION public.exec_pos_top_items(
  _property_id uuid, _from date, _to date, _limit integer DEFAULT 10
) RETURNS TABLE (
  menu_item_id uuid,
  item_name text,
  total_quantity numeric,
  total_amount numeric,
  order_count bigint
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF _property_id IS NULL THEN RETURN; END IF;
  IF NOT public.has_any_role(auth.uid(),
      ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH scoped_orders AS (
    SELECT o.id
    FROM pos_orders o
    WHERE o.property_id = _property_id
      AND o.status = 'closed'
      AND o.closed_at IS NOT NULL
      AND o.closed_at::date BETWEEN _from AND _to
  )
  -- Items are the grain, so several lines per order is what is being
  -- counted; no order-level amount is summed in this query.
  SELECT
    i.menu_item_id,
    i.name_snapshot,
    COALESCE(SUM(i.quantity), 0)::numeric,
    COALESCE(SUM(i.price_snapshot * i.quantity), 0)::numeric,
    COUNT(DISTINCT i.order_id)::bigint
  FROM pos_order_items i
  JOIN scoped_orders s ON s.id = i.order_id
  GROUP BY i.menu_item_id, i.name_snapshot
  ORDER BY 3 DESC, 4 DESC, 2
  LIMIT GREATEST(1, LEAST(COALESCE(_limit, 10), 100));
END;
$$;

REVOKE ALL ON FUNCTION public.exec_pos_top_items(uuid, date, date, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exec_pos_top_items(uuid, date, date, integer) TO authenticated;

-- ------------------------------------------------------------
-- 5. exec_pos_sales_by_period
-- Operational sales and till payments are returned as separate columns and
-- must never be read as one figure: a folio-settled sale contributes to
-- operational sales on its closing day while contributing nothing to till
-- payments, and a payment can legitimately land on a different day from the
-- sale it settles.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.exec_pos_sales_by_period(uuid, date, date, text);

CREATE FUNCTION public.exec_pos_sales_by_period(
  _property_id uuid, _from date, _to date, _granularity text DEFAULT 'day'
) RETURNS TABLE (
  period_start date,
  operational_sales numeric,
  closed_order_count bigint,
  payments_received_amount numeric
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  _g text := lower(coalesce(_granularity, 'day'));
  _step interval;
BEGIN
  IF _g NOT IN ('day','month') THEN
    RAISE EXCEPTION 'exec_pos_sales_by_period: _granularity must be day or month, got %', _granularity;
  END IF;
  IF _property_id IS NULL THEN RETURN; END IF;
  IF NOT public.has_any_role(auth.uid(),
      ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id) THEN
    RETURN;
  END IF;

  _step := CASE WHEN _g = 'month' THEN interval '1 month' ELSE interval '1 day' END;

  RETURN QUERY
  -- Dense series so a quiet day or month still appears as a zero row.
  WITH series AS (
    SELECT generate_series(date_trunc(_g, _from::timestamp), _to::timestamp, _step)::date AS p
  ),
  closed AS (
    SELECT date_trunc(_g, o.closed_at)::date AS p,
           COALESCE(SUM(o.total), 0)::numeric AS gross,
           COUNT(*)::bigint AS cnt
    FROM pos_orders o
    WHERE o.property_id = _property_id
      AND o.status = 'closed'
      AND o.closed_at IS NOT NULL
      AND o.closed_at::date BETWEEN _from AND _to
    GROUP BY 1
  ),
  -- Independent aggregate, joined on the period key only. Void orders and
  -- folio settlements are both excluded: neither is money over the counter.
  paid AS (
    SELECT date_trunc(_g, p.received_at)::date AS p,
           COALESCE(SUM(p.amount), 0)::numeric AS amt
    FROM pos_payments p
    JOIN pos_orders o ON o.id = p.order_id
    WHERE o.property_id = _property_id
      AND o.status <> 'void'
      AND p.folio_charge_id IS NULL
      AND p.received_at::date BETWEEN _from AND _to
    GROUP BY 1
  )
  SELECT
    series.p,
    COALESCE(closed.gross, 0)::numeric,
    COALESCE(closed.cnt, 0)::bigint,
    COALESCE(paid.amt, 0)::numeric
  FROM series
  LEFT JOIN closed ON closed.p = series.p
  LEFT JOIN paid ON paid.p = series.p
  ORDER BY series.p;
END;
$$;

REVOKE ALL ON FUNCTION public.exec_pos_sales_by_period(uuid, date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exec_pos_sales_by_period(uuid, date, date, text) TO authenticated;
