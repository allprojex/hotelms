-- AP supplier statement foundation.
--
-- Architecture audit finding (see PR description): unlike ar_invoices before
-- the AR customer-account work, ap_bills.supplier_id and public.suppliers
-- have existed since the very first AP migration (20260705040642) — the
-- identity infrastructure is not missing. What is missing is that the only
-- bill-creation code path (accounting.ap.tsx's "New bill" dialog) has never
-- actually written supplier_id: its supplier <Select> sets supplier_name to
-- the chosen supplier's NAME string, not its id, so every ap_bills row ever
-- created carries supplier_id = NULL. Confirmed by grepping the whole
-- application: no INSERT into ap_bills, anywhere, sets supplier_id.
--
-- This is exactly the AR "historical unlinked invoice" problem, applied to
-- 100% of bills rather than a subset — so, per the brief's stop condition,
-- it is treated the same way AR's was: (1) the UI bug that leaves new bills
-- unlinked is fixed in this same PR (a one-line fix to accounting.ap.tsx,
-- not a schema change), and (2) a manual, atomic, one-at-a-time mapping path
-- is added for bills that already exist unlinked — assign_ap_bill_supplier()
-- below, directly mirroring assign_ar_invoice_customer() (20260813180000).
-- No fuzzy/automatic supplier inference is added anywhere; every assignment
-- is a deliberate, explicit user action naming one bill and one supplier.
--
-- No new table and no new column are needed — suppliers and
-- ap_bills.supplier_id already exist — so this migration is limited to the
-- one assignment RPC plus the two indexes the statement's own queries need
-- (neither existed before: ap_bills had no index reaching supplier_id, and
-- ap_payments had no index reaching bill_id at all despite ap_payments
-- being queried by bill_id on every statement/aging lookdown).

CREATE INDEX ap_bills_property_supplier ON public.ap_bills(property_id, supplier_id);
CREATE INDEX ap_payments_property_bill ON public.ap_payments(property_id, bill_id);

-- Historical AP supplier mapping: the ONLY entry point for setting
-- ap_bills.supplier_id on an existing bill (supplier_id IS NULL). Mirrors
-- assign_ar_invoice_customer() exactly: SECURITY DEFINER, row-locks the
-- bill first so a concurrent assignment attempt serializes rather than
-- races, validates the target supplier belongs to the same property and is
-- active, and only ever assigns — never reassigns an already-mapped bill.
-- The caller is responsible for presenting candidates for manual review;
-- this function only ever performs the exact assignment a user explicitly
-- confirmed. No name/email/text matching of any kind happens here.
CREATE OR REPLACE FUNCTION public.assign_ap_bill_supplier(
  _property_id UUID,
  _bill_id UUID,
  _supplier_id UUID
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  _supplier RECORD;
  _updated_id UUID;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id) THEN
    RAISE EXCEPTION 'Not permitted to assign AP suppliers';
  END IF;

  -- Lock the bill row first so a concurrent assignment attempt on the same
  -- bill serializes behind this one instead of racing it; the second caller
  -- then sees the up-to-date supplier_id at the final UPDATE below and
  -- fails cleanly rather than silently overwriting.
  PERFORM 1 FROM public.ap_bills WHERE id = _bill_id AND property_id = _property_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bill not found for this property';
  END IF;

  SELECT * INTO _supplier FROM public.suppliers WHERE id = _supplier_id AND property_id = _property_id;
  IF _supplier.id IS NULL THEN
    RAISE EXCEPTION 'Supplier not found for this property';
  END IF;
  IF NOT _supplier.active THEN
    RAISE EXCEPTION 'Inactive suppliers cannot be assigned to bills';
  END IF;

  -- supplier_id IS NULL here is the actual safety gate: combined with the
  -- row lock above, this makes the whole operation "assign only if still
  -- unmapped". No other column is touched: not supplier_name, not totals,
  -- not status.
  UPDATE public.ap_bills
    SET supplier_id = _supplier_id
    WHERE id = _bill_id AND property_id = _property_id AND supplier_id IS NULL
    RETURNING id INTO _updated_id;

  IF _updated_id IS NULL THEN
    RAISE EXCEPTION 'Bill already has an assigned supplier';
  END IF;

  RETURN _updated_id;
END; $$;

-- Supabase grants EXECUTE directly to PUBLIC and to the anon/authenticated
-- API roles on function creation, so both must be revoked explicitly (same
-- convention as 20260812130000 / 20260813180000 / 20260818090000).
REVOKE EXECUTE ON FUNCTION public.assign_ap_bill_supplier(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_ap_bill_supplier(uuid, uuid, uuid) TO authenticated;
