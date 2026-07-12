-- Public booking searches run before authentication. Function replacement can
-- reset explicit grants, so keep the intended anon/authenticated access here.
GRANT EXECUTE ON FUNCTION public.booking_search_availability(uuid, date, date, integer)
TO anon, authenticated;
