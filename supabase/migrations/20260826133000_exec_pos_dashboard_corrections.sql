-- ============================================================
-- Unified POS Executive Dashboard — PR-A1: forward corrections to the
-- exec_pos_* analytical RPCs added by 20260826090000.
--
-- 20260826090000 is already applied to production and is immutable history.
-- Nothing here edits, renames, reverts or re-runs it. This migration moves
-- FORWARD over the definitions currently running, replacing each function
-- in place.
--
-- Return shapes change, and PostgreSQL cannot CREATE OR REPLACE a function
-- whose RETURNS TABLE signature differs. Each function is therefore dropped
-- by its exact 20260826090000 signature and recreated in the same
-- transaction. Dropping a function is not a data operation: no table,
-- column, index, policy, trigger or row is touched anywhere in this file.
--
-- WHAT WAS WRONG, AND WHY IT MATTERED
--
-- 1. FOLIO SETTLEMENTS WERE COUNTED AS TILL MONEY.
--    pos_payments.folio_charge_id IS NOT NULL means the settlement was
--    POSTED TO A GUEST FOLIO, not taken at the till. Including those rows
--    in the cash/card/mobile_money/... buckets overstates the drawer and
--    would not reconcile against a physical count. Folio activity is not
--    discarded -- it is reported separately as folio_posted_count /
--    folio_posted_amount so nothing goes missing.
--
-- 2. LIVE ORDER VALUE CAME FROM pos_orders.total.
--    total is only maintained when an order is priced/closed; open orders
--    routinely carry total = 0 while holding real items, so the previous
--    open_order_value reported zero against genuinely outstanding tickets.
--    Live value is now derived from the item lines themselves
--    (SUM(price_snapshot * quantity)) and is named open_order_line_value
--    so the number cannot be mistaken for a settled total.
--
-- 3. THE LIVE SNAPSHOT HAD NO UPPER BOUND.
--    It was described as point-in-time but was not bounded by the report
--    window at all, so an order opened AFTER _to still appeared in a
--    historical report. Live orders are now bounded by
--    opened_at::date <= _to, with deliberately NO lower bound: an order
--    opened before _from that is still open IS still outstanding at _to
--    and must be included.
--
-- Everything else the original migration got right is preserved verbatim:
-- SECURITY INVOKER, STABLE, SET search_path = public, a mandatory
-- _property_id present in every predicate, the Executive role gate, no
-- dynamic SQL, no writes, PUBLIC/anon revoked and authenticated granted,
-- separate aggregation domains so joins cannot multiply, bare numerics
-- with no currency formatting, and no fabricated refund/discount figures
-- (neither concept exists in this schema).
--
-- NULL _property_id now returns NO ROWS from every function rather than a
-- synthetic all-zero report, which would otherwise read as "this property
-- genuinely did no business".
-- ============================================================

DROP FUNCTION IF EXISTS public.exec_pos_summary(uuid, date, date);
DROP FUNCTION IF EXISTS public.exec_pos_by_department(uuid, date, date);
DROP FUNCTION IF EXISTS public.exec_pos_by_user(uuid, date, date);
DROP FUNCTION IF EXISTS public.exec_pos_top_items(uuid, date, date, integer);
DROP FUNCTION IF EXISTS public.exec_pos_sales_by_period(uuid, date, date, text);

-- ------------------------------------------------------------
-- 1. exec_pos_summary
--
-- Three conceptually separate domains, never mixed:
--   operational sales -> pos_orders closed in [_from,_to] (closed_at)
--   till receipts     -> pos_payments received in [_from,_to] (received_at),
--                        folio settlements excluded, void parents excluded
--   live orders       -> point-in-time snapshot at _to (opened_at <= _to)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exec_pos_summary(
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
  IF _property_id IS NULL THEN
    RETURN;
  END IF;
  IF NOT public.has_any_role(auth.uid(),
      ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id) THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH closed AS (
    SELECT
      COALESCE(SUM(o.total), 0)::numeric    AS amt,
      COALESCE(SUM(o.subtotal), 0)::numeric AS net,
      COALESCE(SUM(o.tax), 0)::numeric      AS tax,
      COUNT(*)::bigint                      AS cnt
    FROM pos_orders o
    WHERE o.property_id = _property_id
      AND o.status = 'closed'
      AND o.closed_at IS NOT NULL
      AND o.closed_at::date BETWEEN _from AND _to
  ),
  voided AS (
    SELECT COUNT(*)::bigint AS cnt
    FROM pos_orders o
    WHERE o.property_id = _property_id
      AND o.status = 'void'
      AND o.opened_at::date BETWEEN _from AND _to
  ),
  live_orders AS (
    SELECT o.id
    FROM pos_orders o
    WHERE o.property_id = _property_id
      AND o.status IN ('open','sent','served')
      AND o.opened_at::date <= _to
  ),
  live AS (
    SELECT
      (SELECT COUNT(*)::bigint FROM live_orders) AS cnt,
      COALESCE((
        SELECT SUM(i.price_snapshot * i.quantity)
        FROM pos_order_items i
        WHERE i.order_id IN (SELECT id FROM live_orders)
      ), 0)::numeric AS line_value
  ),
  till AS (
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
      AND p.folio_charge_id IS NULL
      AND p.received_at::date BETWEEN _from AND _to
  ),
  folio AS (
    SELECT
      COUNT(*)::bigint AS cnt,
      COALESCE(SUM(p.amount), 0)::numeric AS amt
    FROM pos_payments p
    JOIN pos_orders o ON o.id = p.order_id
    WHERE o.property_id = _property_id
      AND o.status <> 'void'
      AND p.folio_charge_id IS NOT NULL
      AND p.received_at::date BETWEEN _from AND _to
  )
  SELECT closed.amt, closed.net, closed.tax, closed.cnt,
         voided.cnt,
         live.cnt, live.line_value,
         till.cnt, till.amt,
         till.cash, till.card, till.momo, till.bank, till.wallet, till.other,
         folio.cnt, folio.amt
  FROM closed, voided, live, till, folio;
END;
$$;

-- ------------------------------------------------------------
-- 2. exec_pos_by_department
--
-- Outlet-level view. Completed sales use closed_at in [_from,_to]; live
-- metrics use the same point-in-time snapshot as the summary
-- (opened_at::date <= _to, no lower bound). Every outlet of the property
-- is returned, including quiet ones, so a zero is visible rather than
-- missing. Sales and live figures are aggregated in separate scalar
-- subqueries so an outlet's order rows can never multiply its item rows.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exec_pos_by_department(
  _property_id uuid, _from date, _to date
) RETURNS TABLE (
  outlet_id uuid,
  outlet_name text,
  outlet_kind text,
  operational_sales numeric,
  order_count bigint,
  live_order_count bigint,
  open_order_line_value numeric
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF _property_id IS NULL THEN
    RETURN;
  END IF;
  IF NOT public.has_any_role(auth.uid(),
      ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT
    ou.id,
    ou.name,
    ou.kind::text,
    COALESCE((
      SELECT SUM(o.total) FROM pos_orders o
      WHERE o.outlet_id = ou.id
        AND o.property_id = _property_id
        AND o.status = 'closed'
        AND o.closed_at IS NOT NULL
        AND o.closed_at::date BETWEEN _from AND _to
    ), 0)::numeric,
    COALESCE((
      SELECT COUNT(*) FROM pos_orders o
      WHERE o.outlet_id = ou.id
        AND o.property_id = _property_id
        AND o.status = 'closed'
        AND o.closed_at IS NOT NULL
        AND o.closed_at::date BETWEEN _from AND _to
    ), 0)::bigint,
    COALESCE((
      SELECT COUNT(*) FROM pos_orders o
      WHERE o.outlet_id = ou.id
        AND o.property_id = _property_id
        AND o.status IN ('open','sent','served')
        AND o.opened_at::date <= _to
    ), 0)::bigint,
    COALESCE((
      SELECT SUM(i.price_snapshot * i.quantity)
      FROM pos_order_items i
      JOIN pos_orders o ON o.id = i.order_id
      WHERE o.outlet_id = ou.id
        AND o.property_id = _property_id
        AND o.status IN ('open','sent','served')
        AND o.opened_at::date <= _to
    ), 0)::numeric
  FROM pos_outlets ou
  WHERE ou.property_id = _property_id
  ORDER BY 4 DESC, ou.name;
END;
$$;

-- ------------------------------------------------------------
-- 3. exec_pos_by_user
--
-- Two genuinely different meanings, reported side by side and never
-- collapsed. Neither is called "salesperson" -- the schema cannot prove
-- that meaning for either column:
--   pos_orders.created_by    -> who OPENED the order
--   pos_payments.received_by -> who RECEIVED a TILL payment
-- Folio settlements are excluded from the receiver side for the same
-- reason as the summary: they are not till money.
--
-- full_name comes from profiles via a LEFT JOIN, so the security boundary
-- is unchanged: profiles' own RLS decides whether a name is visible, and a
-- caller who cannot see a profile row simply gets NULL instead of losing
-- the metrics row. (profiles_admin_select covers super_admin/hotel_owner/
-- general_manager; an accountant therefore sees ids with NULL names, which
-- is correct rather than a leak.)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exec_pos_by_user(
  _property_id uuid, _from date, _to date
) RETURNS TABLE (
  user_id uuid,
  full_name text,
  orders_created_count bigint,
  orders_created_value numeric,
  till_payments_received_count bigint,
  till_payments_received_value numeric
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF _property_id IS NULL THEN
    RETURN;
  END IF;
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
      AND p.folio_charge_id IS NULL
      AND p.received_at::date BETWEEN _from AND _to
      AND p.received_by IS NOT NULL
    GROUP BY p.received_by
  ),
  merged AS (
    SELECT
      COALESCE(c.uid, r.uid) AS uid,
      COALESCE(c.cnt, 0)::bigint AS c_cnt,
      COALESCE(c.amt, 0)::numeric AS c_amt,
      COALESCE(r.cnt, 0)::bigint AS r_cnt,
      COALESCE(r.amt, 0)::numeric AS r_amt
    FROM creators c
    FULL OUTER JOIN receivers r ON r.uid = c.uid
  )
  SELECT m.uid, pr.full_name, m.c_cnt, m.c_amt, m.r_cnt, m.r_amt
  FROM merged m
  LEFT JOIN profiles pr ON pr.id = m.uid
  ORDER BY (m.c_amt + m.r_amt) DESC, m.uid;
END;
$$;

-- ------------------------------------------------------------
-- 4. exec_pos_top_items
--
-- Grouped by (menu_item_id, name_snapshot) rather than name alone: two
-- distinct products can legitimately share a name, and collapsing them
-- would invent a single bestseller that never existed. name_snapshot is
-- kept in the key so historical rows whose menu_item_id was nulled by
-- product deletion (ON DELETE SET NULL) still report under the name they
-- were actually sold as, instead of bucketing every deleted product into
-- one anonymous row.
--
-- Value stays price_snapshot * quantity -- the historically accurate
-- amount, not today's menu price. Closed, non-void orders only, in the
-- same closed_at window as operational sales so items reconcile to sales.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exec_pos_top_items(
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
  IF _property_id IS NULL THEN
    RETURN;
  END IF;
  IF NOT public.has_any_role(auth.uid(),
      ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT
    i.menu_item_id,
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
  GROUP BY i.menu_item_id, i.name_snapshot
  ORDER BY COALESCE(SUM(i.quantity), 0) DESC, i.name_snapshot, i.menu_item_id
  LIMIT GREATEST(1, LEAST(COALESCE(_limit, 10), 100));
END;
$$;

-- ------------------------------------------------------------
-- 5. exec_pos_sales_by_period
--
-- Unchanged in shape apart from an added till-receipts column. 'day' and
-- 'month' only, validated against a fixed allow-list and interpolated
-- nowhere -- there is no dynamic SQL in this file. Every period in the
-- range is emitted (generate_series + LEFT JOIN) so an empty day/month is
-- an explicit zero rather than a gap a chart would interpolate across;
-- the monthly series is anchored to date_trunc('month', _from) so a range
-- starting mid-month still returns that whole month.
--
-- operational_sales stays closed-order based (closed_at).
-- payments_received_amount is TILL money only: received_at in the bucket,
-- parent order not void, folio settlements excluded. Sales and receipts
-- are aggregated in separate scalar subqueries, so an order with several
-- payments cannot multiply its own sales figure.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exec_pos_sales_by_period(
  _property_id uuid, _from date, _to date, _granularity text DEFAULT 'day'
) RETURNS TABLE (
  period_start date,
  operational_sales numeric,
  order_count bigint,
  payments_received_amount numeric
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  _g text := lower(coalesce(_granularity, 'day'));
  -- For 'month', the bucket IS a whole month and is labelled with that
  -- month's first day, so it must contain that whole month. Filtering the
  -- rows by the raw _from/_to while labelling the bucket "June" produced a
  -- row that said June but held only 15--30 June: a silent under-report
  -- against its own label. The effective month range is therefore widened
  -- to whole months. ('day' is unaffected -- a day bucket is exactly its
  -- own date.)
  _m_from date := date_trunc('month', _from::timestamp)::date;
  _m_to   date := (date_trunc('month', _to::timestamp) + interval '1 month' - interval '1 day')::date;
BEGIN
  IF _g NOT IN ('day','month') THEN
    RAISE EXCEPTION 'exec_pos_sales_by_period: _granularity must be day or month, got %', _granularity;
  END IF;
  IF _property_id IS NULL THEN
    RETURN;
  END IF;
  IF NOT public.has_any_role(auth.uid(),
      ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id) THEN
    RETURN;
  END IF;

  IF _g = 'day' THEN
    RETURN QUERY
    WITH series AS (
      SELECT generate_series(_from, _to, interval '1 day')::date AS p
    ),
    sales AS (
      SELECT o.closed_at::date AS p,
             SUM(o.total)::numeric AS amt,
             COUNT(*)::bigint AS cnt
      FROM pos_orders o
      WHERE o.property_id = _property_id
        AND o.status = 'closed'
        AND o.closed_at IS NOT NULL
        AND o.closed_at::date BETWEEN _from AND _to
      GROUP BY o.closed_at::date
    ),
    receipts AS (
      SELECT p2.received_at::date AS p,
             SUM(p2.amount)::numeric AS amt
      FROM pos_payments p2
      JOIN pos_orders o2 ON o2.id = p2.order_id
      WHERE o2.property_id = _property_id
        AND o2.status <> 'void'
        AND p2.folio_charge_id IS NULL
        AND p2.received_at::date BETWEEN _from AND _to
      GROUP BY p2.received_at::date
    )
    SELECT s.p,
           COALESCE(sales.amt, 0)::numeric,
           COALESCE(sales.cnt, 0)::bigint,
           COALESCE(receipts.amt, 0)::numeric
    FROM series s
    LEFT JOIN sales ON sales.p = s.p
    LEFT JOIN receipts ON receipts.p = s.p
    ORDER BY s.p;
  ELSE
    RETURN QUERY
    WITH series AS (
      SELECT generate_series(
               date_trunc('month', _from::timestamp),
               date_trunc('month', _to::timestamp),
               interval '1 month')::date AS p
    ),
    sales AS (
      SELECT date_trunc('month', o.closed_at::date)::date AS p,
             SUM(o.total)::numeric AS amt,
             COUNT(*)::bigint AS cnt
      FROM pos_orders o
      WHERE o.property_id = _property_id
        AND o.status = 'closed'
        AND o.closed_at IS NOT NULL
        AND o.closed_at::date BETWEEN _m_from AND _m_to
      GROUP BY date_trunc('month', o.closed_at::date)::date
    ),
    receipts AS (
      SELECT date_trunc('month', p2.received_at::date)::date AS p,
             SUM(p2.amount)::numeric AS amt
      FROM pos_payments p2
      JOIN pos_orders o2 ON o2.id = p2.order_id
      WHERE o2.property_id = _property_id
        AND o2.status <> 'void'
        AND p2.folio_charge_id IS NULL
        AND p2.received_at::date BETWEEN _m_from AND _m_to
      GROUP BY date_trunc('month', p2.received_at::date)::date
    )
    SELECT s.p,
           COALESCE(sales.amt, 0)::numeric,
           COALESCE(sales.cnt, 0)::bigint,
           COALESCE(receipts.amt, 0)::numeric
    FROM series s
    LEFT JOIN sales ON sales.p = s.p
    LEFT JOIN receipts ON receipts.p = s.p
    ORDER BY s.p;
  END IF;
END;
$$;

-- ------------------------------------------------------------
-- Grants: authenticated only, re-applied because DROP discarded the ACLs
-- the previous definitions carried. PUBLIC and anon are explicitly
-- revoked. RLS -- not these grants -- is what decides which rows an
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
