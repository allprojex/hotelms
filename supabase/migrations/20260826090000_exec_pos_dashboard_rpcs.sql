-- ============================================================
-- Unified POS Executive Dashboard — PR-A: server-side analytical RPCs.
--
-- Purely additive: five new read-only functions. No table, column, index,
-- RLS policy, trigger or data change of any kind.
--
-- SECURITY INVOKER (explicitly NOT security definer):
-- every table these functions read already carries a correct
-- can_access_property RLS SELECT policy --
--   pos_orders.porders_read, pos_outlets.poutlet_read,
--   pos_order_items.poit_read and pos_payments.ppay_read
--   (the latter two via EXISTS-on-parent against pos_orders)
-- -- so running as the caller lets Postgres enforce that existing,
-- already-shipped property boundary automatically. These functions can
-- therefore never return a row the caller could not already read directly.
-- This deviates deliberately from the older exec_analytics_* functions
-- (20260705094017), which are SECURITY DEFINER with an internal role
-- guard; that escalation is not needed here and is not used.
--
-- The role guard below is kept as defence in depth, matching the SAME
-- access boundary the existing Executive Analytics surface uses
-- (EXEC_ROLES / ACCOUNTING_ADMIN_ROLES = super_admin, hotel_owner,
-- general_manager, accountant). Because these are SECURITY INVOKER, the
-- guard narrows access; RLS -- not the guard -- is what guarantees
-- property isolation. Returning empty (rather than raising) matches the
-- established exec_analytics_* convention.
--
-- SCOPE — every function is single-property by construction:
-- _property_id is a required parameter and appears in the WHERE clause of
-- every aggregate. Nothing here aggregates across properties, and no
-- function returns a currency: all money is returned as a bare numeric
-- fact for the caller to format with the property's own base_currency via
-- the established execMoney/execCurrency helpers.
--
-- DATE SEMANTICS (documented per function below). All ranges are
-- INCLUSIVE of both _from and _to. Following the existing
-- exec_analytics_* convention, a TIMESTAMPTZ is narrowed with
-- `<ts>::date BETWEEN _from AND _to`, which resolves in the session time
-- zone exactly as the shipped analytics RPCs already do. Per-property
-- timezone conversion is deliberately NOT introduced here -- doing so
-- would silently diverge from the numbers Executive Analytics already
-- reports.
--
-- AGGREGATION DOMAINS ARE KEPT SEPARATE to avoid join multiplication:
--   order revenue      -> pos_orders only
--   payment methods    -> pos_payments only (parent order joined solely
--                         for property/void scoping, never summed)
--   item quantities    -> pos_order_items only (ditto)
-- An order with 3 payments and 5 items is counted once for revenue, its
-- payments summed once, and its items summed once -- never multiplied.
--
-- OUT OF SCOPE (audited, confirmed absent from the schema): refunds and
-- discounts are not represented anywhere in the POS model, so no function
-- here reports, approximates or places a stand-in for them.
--
-- These figures are OPERATIONAL POS SALES. They are intentionally derived
-- from the POS tables, not the accounting journals: journals record every
-- closed order against the cash account regardless of payment method, so
-- a payment-method breakdown is only derivable here. These numbers are
-- not represented as ledger-reconciled accounting revenue.
-- ============================================================

-- ------------------------------------------------------------
-- 1. exec_pos_summary
--
-- DATES: completed-sales figures cover orders CLOSED in [_from,_to] via
-- closed_at (the completion timestamp). Payment figures cover payments
-- RECEIVED in [_from,_to] via received_at.
--
-- The open/live figures are deliberately a POINT-IN-TIME SNAPSHOT and are
-- NOT filtered by [_from,_to]: an order opened weeks ago that is still
-- open is still outstanding today, and a date filter would silently drop
-- exactly the stale orders an operator most needs to see.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exec_pos_summary(
  _property_id uuid, _from date, _to date
) RETURNS TABLE (
  gross_sales numeric,
  closed_order_count bigint,
  open_order_value numeric,
  open_order_count bigint,
  payments_total numeric,
  payments_count bigint,
  cash_amount numeric,
  card_amount numeric,
  mobile_money_amount numeric,
  bank_transfer_amount numeric,
  wallet_amount numeric,
  other_amount numeric
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF NOT public.has_any_role(auth.uid(),
      ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id) THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH closed AS (
    SELECT COALESCE(SUM(o.total), 0)::numeric AS amt, COUNT(*)::bigint AS cnt
    FROM pos_orders o
    WHERE o.property_id = _property_id
      AND o.status = 'closed'
      AND o.closed_at IS NOT NULL
      AND o.closed_at::date BETWEEN _from AND _to
  ),
  live AS (
    SELECT COALESCE(SUM(o.total), 0)::numeric AS amt, COUNT(*)::bigint AS cnt
    FROM pos_orders o
    WHERE o.property_id = _property_id
      AND o.status IN ('open','sent','served')
  ),
  pay AS (
    SELECT
      COALESCE(SUM(p.amount), 0)::numeric AS amt,
      COUNT(*)::bigint AS cnt,
      COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'cash'), 0)::numeric AS cash,
      COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'card'), 0)::numeric AS card,
      COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'mobile_money'), 0)::numeric AS momo,
      COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'bank_transfer'), 0)::numeric AS bank,
      COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'wallet'), 0)::numeric AS wallet,
      COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'other'), 0)::numeric AS other
    FROM pos_payments p
    JOIN pos_orders o ON o.id = p.order_id
    WHERE o.property_id = _property_id
      AND o.status <> 'void'
      AND p.received_at::date BETWEEN _from AND _to
  )
  SELECT closed.amt, closed.cnt, live.amt, live.cnt,
         pay.amt, pay.cnt, pay.cash, pay.card, pay.momo, pay.bank, pay.wallet, pay.other
  FROM closed, live, pay;
END;
$$;

-- ------------------------------------------------------------
-- 2. exec_pos_by_department
--
-- "Department" is the POS OUTLET (pos_outlets), which is how this schema
-- actually represents Restaurant / Bar / Room service / Other within one
-- property (outlet_kind enum). Outlets of OTHER properties are excluded
-- by the property predicate; nothing is aggregated across properties.
--
-- DATES: orders CLOSED in [_from,_to] (closed_at), inclusive.
-- Every outlet belonging to the property is returned, including ones with
-- no sales in the window (LEFT JOIN + zero), so a quiet department is
-- visibly zero rather than silently missing.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exec_pos_by_department(
  _property_id uuid, _from date, _to date
) RETURNS TABLE (
  outlet_id uuid,
  outlet_name text,
  outlet_kind text,
  gross_sales numeric,
  order_count bigint
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF NOT public.has_any_role(auth.uid(),
      ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT
    ou.id,
    ou.name,
    ou.kind::text,
    COALESCE(SUM(o.total), 0)::numeric,
    COUNT(o.id)::bigint
  FROM pos_outlets ou
  LEFT JOIN pos_orders o
    ON o.outlet_id = ou.id
   AND o.property_id = _property_id
   AND o.status = 'closed'
   AND o.closed_at IS NOT NULL
   AND o.closed_at::date BETWEEN _from AND _to
  WHERE ou.property_id = _property_id
  GROUP BY ou.id, ou.name, ou.kind
  ORDER BY COALESCE(SUM(o.total), 0) DESC, ou.name;
END;
$$;

-- ------------------------------------------------------------
-- 3. exec_pos_by_user
--
-- The schema supports TWO genuinely different per-user meanings and this
-- function reports BOTH, side by side, without collapsing them:
--   pos_orders.created_by   -> who OPENED/created the order
--   pos_payments.received_by-> who RECEIVED the payment
-- Neither column is documented as "salesperson" and the schema cannot
-- prove that meaning, so no column here is named or presented as one.
-- A user may appear with activity in only one domain (FULL OUTER JOIN).
--
-- DATES: orders created_by-side use closed_at (completed sales);
-- payments received_by-side use received_at. Both inclusive.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exec_pos_by_user(
  _property_id uuid, _from date, _to date
) RETURNS TABLE (
  user_id uuid,
  orders_created_count bigint,
  orders_created_value numeric,
  payments_received_count bigint,
  payments_received_value numeric
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
BEGIN
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
  receivers AS (
    SELECT p.received_by AS uid,
           COUNT(*)::bigint AS cnt,
           COALESCE(SUM(p.amount), 0)::numeric AS amt
    FROM pos_payments p
    JOIN pos_orders o ON o.id = p.order_id
    WHERE o.property_id = _property_id
      AND o.status <> 'void'
      AND p.received_at::date BETWEEN _from AND _to
      AND p.received_by IS NOT NULL
    GROUP BY p.received_by
  )
  SELECT
    COALESCE(c.uid, r.uid),
    COALESCE(c.cnt, 0)::bigint,
    COALESCE(c.amt, 0)::numeric,
    COALESCE(r.cnt, 0)::bigint,
    COALESCE(r.amt, 0)::numeric
  FROM creators c
  FULL OUTER JOIN receivers r ON r.uid = c.uid
  ORDER BY COALESCE(c.amt, 0) + COALESCE(r.amt, 0) DESC, COALESCE(c.uid, r.uid);
END;
$$;

-- ------------------------------------------------------------
-- 4. exec_pos_top_items
--
-- Item facts come from pos_order_items, reached through their parent
-- order for property/status scoping. Grouped by name_snapshot (NOT NULL,
-- and the historically accurate name at the time of sale) rather than
-- menu_item_id, which is nullable -- pos_menu_items deletion sets it NULL
-- (ON DELETE SET NULL), so grouping by id would silently bucket every
-- deleted product together as one anonymous row.
--
-- Excludes voided orders. line_amount = price_snapshot * quantity, the
-- historically accurate value, not today's menu price.
--
-- DATES: parent order CLOSED in [_from,_to] (closed_at), inclusive --
-- the same window as gross sales, so items reconcile to revenue.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exec_pos_top_items(
  _property_id uuid, _from date, _to date, _limit integer DEFAULT 10
) RETURNS TABLE (
  item_name text,
  total_quantity numeric,
  total_amount numeric,
  order_count bigint
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF NOT public.has_any_role(auth.uid(),
      ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT
    i.name_snapshot,
    COALESCE(SUM(i.quantity), 0)::numeric,
    COALESCE(SUM(i.price_snapshot * i.quantity), 0)::numeric,
    COUNT(DISTINCT i.order_id)::bigint
  FROM pos_order_items i
  JOIN pos_orders o ON o.id = i.order_id
  WHERE o.property_id = _property_id
    AND o.status = 'closed'
    AND o.closed_at IS NOT NULL
    AND o.closed_at::date BETWEEN _from AND _to
  GROUP BY i.name_snapshot
  ORDER BY COALESCE(SUM(i.quantity), 0) DESC, i.name_snapshot
  LIMIT GREATEST(1, LEAST(COALESCE(_limit, 10), 100));
END;
$$;

-- ------------------------------------------------------------
-- 5. exec_pos_sales_by_period
--
-- Server-side daily/monthly trend so the browser never downloads every
-- transaction to aggregate it client-side.
--
-- _granularity: 'day' (default) or 'month'. Any other value raises --
-- it is validated against a fixed allow-list and interpolated nowhere;
-- there is no dynamic SQL in this function or any other in this file.
--
-- Gap-filling: every period in the range is emitted (generate_series +
-- LEFT JOIN), so a day/month with no sales returns an explicit zero
-- rather than a missing point that a chart would silently interpolate
-- across. For 'month', period_start is the first day of the month, and
-- the series is anchored to date_trunc('month', _from) so a range
-- starting mid-month still returns that whole month's bucket.
--
-- DATES: orders CLOSED in [_from,_to] (closed_at), inclusive.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exec_pos_sales_by_period(
  _property_id uuid, _from date, _to date, _granularity text DEFAULT 'day'
) RETURNS TABLE (
  period_start date,
  gross_sales numeric,
  order_count bigint
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  _g text := lower(coalesce(_granularity, 'day'));
BEGIN
  IF _g NOT IN ('day','month') THEN
    RAISE EXCEPTION 'exec_pos_sales_by_period: _granularity must be day or month, got %', _granularity;
  END IF;
  IF NOT public.has_any_role(auth.uid(),
      ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id) THEN
    RETURN;
  END IF;

  IF _g = 'day' THEN
    RETURN QUERY
    WITH series AS (
      SELECT generate_series(_from, _to, interval '1 day')::date AS p
    )
    SELECT s.p,
           COALESCE(SUM(o.total), 0)::numeric,
           COUNT(o.id)::bigint
    FROM series s
    LEFT JOIN pos_orders o
      ON o.property_id = _property_id
     AND o.status = 'closed'
     AND o.closed_at IS NOT NULL
     AND o.closed_at::date = s.p
    GROUP BY s.p
    ORDER BY s.p;
  ELSE
    RETURN QUERY
    WITH series AS (
      SELECT generate_series(
               date_trunc('month', _from::timestamp),
               date_trunc('month', _to::timestamp),
               interval '1 month')::date AS p
    )
    SELECT s.p,
           COALESCE(SUM(o.total), 0)::numeric,
           COUNT(o.id)::bigint
    FROM series s
    LEFT JOIN pos_orders o
      ON o.property_id = _property_id
     AND o.status = 'closed'
     AND o.closed_at IS NOT NULL
     AND o.closed_at::date BETWEEN _from AND _to
     AND date_trunc('month', o.closed_at::date)::date = s.p
    GROUP BY s.p
    ORDER BY s.p;
  END IF;
END;
$$;

-- ------------------------------------------------------------
-- Grants: authenticated only. PUBLIC and anon are explicitly revoked,
-- matching the access-control pattern used by every recently added RPC
-- in this repo. RLS (not these grants) is what enforces which rows an
-- authenticated caller can actually see.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.exec_pos_summary(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exec_pos_summary(uuid, date, date) TO authenticated;

REVOKE ALL ON FUNCTION public.exec_pos_by_department(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exec_pos_by_department(uuid, date, date) TO authenticated;

REVOKE ALL ON FUNCTION public.exec_pos_by_user(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exec_pos_by_user(uuid, date, date) TO authenticated;

REVOKE ALL ON FUNCTION public.exec_pos_top_items(uuid, date, date, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exec_pos_top_items(uuid, date, date, integer) TO authenticated;

REVOKE ALL ON FUNCTION public.exec_pos_sales_by_period(uuid, date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exec_pos_sales_by_period(uuid, date, date, text) TO authenticated;
