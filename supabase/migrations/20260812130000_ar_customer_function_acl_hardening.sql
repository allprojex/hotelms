-- Supabase default function privileges grant EXECUTE directly to API roles.
-- Remove anonymous access explicitly instead of relying on the PUBLIC revoke.

REVOKE EXECUTE ON FUNCTION public.create_ar_invoice(
  uuid, uuid, date, date, text, text, jsonb
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_ar_invoice(
  uuid, uuid, date, date, text, text, jsonb
) TO authenticated;

-- This function is invoked only by trg_ar_customer_code. Direct API-role
-- execution is unnecessary; existing trigger execution is unaffected.
REVOKE EXECUTE ON FUNCTION public.gen_ar_customer_code()
  FROM PUBLIC, anon, authenticated;
