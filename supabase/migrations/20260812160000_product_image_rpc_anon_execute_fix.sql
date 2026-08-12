-- Fix: 20260812150000_product_image_generation.sql's three SECURITY
-- DEFINER functions each did `REVOKE ALL ... FROM PUBLIC` intending to lock
-- them down to specific roles, but Supabase grants EXECUTE directly to the
-- anon and authenticated roles on function creation, independent of the
-- PUBLIC pseudo-role — REVOKE ALL FROM PUBLIC never touches those direct
-- grants. This is the exact gotcha 20260812130000_ar_customer_function_acl_hardening.sql
-- was written to close for other functions ("Supabase default function
-- privileges grant EXECUTE directly to API roles. Remove anonymous access
-- explicitly instead of relying on the PUBLIC revoke.") — apply the same
-- fix here.
--
-- Practical exposure before this fix was low (count_recent_product_image_generations
-- keys off auth.uid(), which is NULL for an unauthenticated anon caller, so
-- it only ever returned 0; the two seed_* functions are idempotent and
-- FK-constrained to real properties), but anon/authenticated should never
-- have been able to invoke these at all.

REVOKE EXECUTE ON FUNCTION public.count_recent_product_image_generations() FROM anon;

REVOKE EXECUTE ON FUNCTION public.seed_product_image_permissions(uuid) FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.seed_product_image_permissions_for_property() FROM anon, authenticated;
