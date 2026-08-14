-- Historical AR customer mapping: a single, atomic, concurrency-safe
-- assignment path for setting ar_invoices.customer_id on a historical
-- invoice that was created before AR customer accounts existed
-- (customer_id IS NULL). This is deliberately the ONLY entry point for
-- setting customer_id on an existing invoice — no other table/column
-- changes, no reassignment of an already-mapped invoice, no automatic
-- inference. The caller (application code) is responsible for presenting
-- candidates for manual review; this function only ever performs the
-- exact assignment a user explicitly confirmed.

CREATE OR REPLACE FUNCTION public.assign_ar_invoice_customer(
  _property_id UUID,
  _invoice_id UUID,
  _customer_id UUID
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  _customer RECORD;
  _updated_id UUID;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant','front_desk']::app_role[], _property_id) THEN
    RAISE EXCEPTION 'Not permitted to assign AR customers';
  END IF;

  -- Lock the invoice row first so a concurrent assignment attempt on the
  -- same invoice serializes behind this one instead of racing it; the
  -- second caller then sees the up-to-date customer_id at the final
  -- UPDATE below and fails cleanly rather than silently overwriting.
  PERFORM 1 FROM public.ar_invoices WHERE id = _invoice_id AND property_id = _property_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found for this property';
  END IF;

  SELECT * INTO _customer FROM public.ar_customers WHERE id = _customer_id AND property_id = _property_id;
  IF _customer.id IS NULL THEN
    RAISE EXCEPTION 'AR customer not found for this property';
  END IF;
  IF NOT _customer.active THEN
    RAISE EXCEPTION 'Inactive AR customers cannot be assigned to invoices';
  END IF;

  -- customer_id IS NULL here is the actual safety gate: combined with the
  -- row lock above, this makes the whole operation "assign only if still
  -- unmapped" — both for a genuine concurrent race and for the simpler
  -- case where the invoice was already mapped before this call began.
  -- No other column is touched: not bill_to_*, not totals, not status.
  UPDATE public.ar_invoices
    SET customer_id = _customer_id
    WHERE id = _invoice_id AND property_id = _property_id AND customer_id IS NULL
    RETURNING id INTO _updated_id;

  IF _updated_id IS NULL THEN
    RAISE EXCEPTION 'Invoice already has an assigned customer';
  END IF;

  RETURN _updated_id;
END; $$;

-- Match the ACL hardening convention from 20260812130000: Supabase grants
-- EXECUTE directly to PUBLIC and to the anon/authenticated API roles on
-- function creation, so both must be revoked explicitly.
REVOKE EXECUTE ON FUNCTION public.assign_ar_invoice_customer(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_ar_invoice_customer(uuid, uuid, uuid) TO authenticated;
