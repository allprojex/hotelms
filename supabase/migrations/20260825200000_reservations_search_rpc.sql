-- ============================================================
-- Reservations reporting (Reporting Improvements PR2): a searchable,
-- paginated read RPC for the Reservations list/report.
--
-- Why an RPC instead of the client's existing PostgREST embedded-select
-- (reservations.select("...,guests(...)")): Search must now match guest
-- name/email, which live on a JOINED table, not reservations itself.
-- PostgREST's .or() filter cannot search across an embedded resource in a
-- single request the way the existing accounting reference-data pattern
-- searches columns on ONE table (see reference-data.functions.ts). A plain
-- SQL join expresses that search directly and correctly.
--
-- SECURITY INVOKER (the default -- no SECURITY DEFINER here on purpose):
-- reservations/guests/room_types/rooms all already carry the identical
-- "can_access_property" read policy. Running as the caller means Postgres
-- RLS enforces that same, already-existing boundary automatically -- this
-- function reuses that boundary rather than reimplementing a role/property
-- check, and can never be broader than what the existing RLS already
-- allows the caller to read directly.
--
-- Row-returning (RETURNS TABLE), so the client chains this exactly like a
-- normal table query: supabase.rpc("search_reservations", {...})
-- .range(from, to) with { count: "exact" } for an accurate total alongside
-- the current page, in one request -- the same convention as every other
-- paginated list in this codebase (see src/lib/query-state.ts's
-- pageRange()/totalPages()).
--
-- Purely additive: one new function, no table/column/RLS changes, no data
-- backfill. The existing client-side query this replaces already filtered
-- by the exact same columns (property_id, status, check_in range) --
-- this only adds guest-name/email/full-name search, done safely server-side.
-- ============================================================

CREATE OR REPLACE FUNCTION public.search_reservations(
  _property_id UUID,
  _search TEXT DEFAULT NULL,
  _status TEXT DEFAULT NULL,
  _check_in_from DATE DEFAULT NULL,
  _check_in_to DATE DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  code TEXT,
  check_in DATE,
  check_out DATE,
  adults INT,
  children INT,
  status TEXT,
  rate_total NUMERIC,
  guest_first_name TEXT,
  guest_last_name TEXT,
  guest_email TEXT,
  room_type_name TEXT,
  room_number TEXT
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    r.id, r.code, r.check_in, r.check_out, r.adults, r.children,
    r.status::TEXT, r.rate_total,
    g.first_name, g.last_name, g.email,
    rt.name, rm.number
  FROM public.reservations r
  JOIN public.guests g ON g.id = r.guest_id
  JOIN public.room_types rt ON rt.id = r.room_type_id
  LEFT JOIN public.rooms rm ON rm.id = r.room_id
  WHERE r.property_id = _property_id
    AND (_status IS NULL OR _status = 'all' OR r.status::TEXT = _status)
    AND (_check_in_from IS NULL OR r.check_in >= _check_in_from)
    AND (_check_in_to IS NULL OR r.check_in <= _check_in_to)
    AND (
      _search IS NULL OR btrim(_search) = '' OR
      r.code ILIKE '%' || _search || '%' OR
      g.first_name ILIKE '%' || _search || '%' OR
      g.last_name ILIKE '%' || _search || '%' OR
      g.email ILIKE '%' || _search || '%' OR
      (g.first_name || ' ' || g.last_name) ILIKE '%' || _search || '%'
    )
  ORDER BY r.check_in DESC, r.id;
$$;

REVOKE ALL ON FUNCTION public.search_reservations(UUID, TEXT, TEXT, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_reservations(UUID, TEXT, TEXT, DATE, DATE) TO authenticated;
