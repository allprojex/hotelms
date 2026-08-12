-- Stable, property-scoped customer accounts for Accounts Receivable.
-- Historical invoice bill-to fields remain immutable snapshots and existing
-- invoices are deliberately left with customer_id = NULL.

CREATE TABLE public.ar_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  account_code TEXT NOT NULL,
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  email TEXT,
  phone TEXT,
  address TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ar_customers_property_id_uniq UNIQUE (property_id, id),
  CONSTRAINT ar_customers_property_account_code_uniq UNIQUE (property_id, account_code)
);

CREATE OR REPLACE FUNCTION public.gen_ar_customer_code()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.account_code IS NULL OR btrim(NEW.account_code) = '' THEN
    NEW.account_code := 'AR-' || upper(substr(replace(NEW.id::text, '-', ''), 1, 10));
  ELSE
    NEW.account_code := upper(btrim(NEW.account_code));
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER trg_ar_customer_code
  BEFORE INSERT OR UPDATE OF account_code ON public.ar_customers
  FOR EACH ROW EXECUTE FUNCTION public.gen_ar_customer_code();
CREATE TRIGGER trg_ar_customers_updated
  BEFORE UPDATE ON public.ar_customers
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE INDEX ar_customers_property_active_name
  ON public.ar_customers(property_id, active, name);

GRANT SELECT, INSERT, UPDATE ON public.ar_customers TO authenticated;
GRANT ALL ON public.ar_customers TO service_role;
ALTER TABLE public.ar_customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ar_customers read" ON public.ar_customers FOR SELECT TO authenticated
  USING (public.can_access_property(auth.uid(), property_id));
CREATE POLICY "ar_customers write" ON public.ar_customers FOR ALL TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant','front_desk']::app_role[], property_id))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant','front_desk']::app_role[], property_id));

ALTER TABLE public.ar_invoices ADD COLUMN customer_id UUID;
ALTER TABLE public.ar_invoices
  ADD CONSTRAINT ar_invoices_customer_fkey
  FOREIGN KEY (property_id, customer_id)
  REFERENCES public.ar_customers(property_id, id)
  ON DELETE RESTRICT;
CREATE INDEX ar_invoices_property_customer
  ON public.ar_invoices(property_id, customer_id);

-- New invoices use this atomic entry point. It validates the stable customer
-- identity and copies the current master data into the historical bill-to
-- snapshot. Existing invoices remain valid with customer_id = NULL.
CREATE OR REPLACE FUNCTION public.create_ar_invoice(
  _property_id UUID,
  _customer_id UUID,
  _issue_date DATE,
  _due_date DATE,
  _currency TEXT,
  _notes TEXT,
  _lines JSONB
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  _customer public.ar_customers%ROWTYPE;
  _invoice_id UUID;
  _line JSONB;
  _quantity NUMERIC;
  _unit_price NUMERIC;
  _tax_rate NUMERIC;
  _subtotal NUMERIC := 0;
  _tax NUMERIC := 0;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant','front_desk']::app_role[], _property_id) THEN
    RAISE EXCEPTION 'Not permitted to create AR invoices';
  END IF;

  SELECT * INTO _customer
    FROM public.ar_customers
    WHERE id = _customer_id AND property_id = _property_id;
  IF _customer.id IS NULL THEN RAISE EXCEPTION 'AR customer not found for this property'; END IF;
  IF NOT _customer.active THEN RAISE EXCEPTION 'Inactive AR customers cannot be used for new invoices'; END IF;
  IF _issue_date IS NULL OR _due_date IS NULL OR _due_date < _issue_date THEN
    RAISE EXCEPTION 'Invoice dates are invalid';
  END IF;
  IF _currency IS NULL OR upper(btrim(_currency)) !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Currency must be a valid 3-letter code';
  END IF;
  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'At least one invoice line is required';
  END IF;

  INSERT INTO public.ar_invoices(
    property_id, customer_id, code, bill_to_name, bill_to_email,
    bill_to_address, issue_date, due_date, currency, notes, created_by
  ) VALUES (
    _property_id, _customer.id, '', _customer.name, _customer.email,
    _customer.address, _issue_date, _due_date, upper(btrim(_currency)), nullif(btrim(_notes), ''), auth.uid()
  ) RETURNING id INTO _invoice_id;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    _quantity := COALESCE((_line->>'quantity')::NUMERIC, 0);
    _unit_price := COALESCE((_line->>'unit_price')::NUMERIC, 0);
    _tax_rate := COALESCE((_line->>'tax_rate')::NUMERIC, 0);
    IF btrim(COALESCE(_line->>'description', '')) = '' THEN
      RAISE EXCEPTION 'Invoice line description is required';
    END IF;
    IF _quantity <= 0 OR _unit_price < 0 OR _tax_rate < 0 OR _tax_rate > 100 THEN
      RAISE EXCEPTION 'Invoice line values are invalid';
    END IF;
    _subtotal := _subtotal + (_quantity * _unit_price);
    _tax := _tax + ROUND((_quantity * _unit_price) * _tax_rate / 100, 4);
    INSERT INTO public.ar_invoice_lines(invoice_id, description, quantity, unit_price, tax_rate)
    VALUES (
      _invoice_id, btrim(_line->>'description'), _quantity, _unit_price, _tax_rate
    );
  END LOOP;

  UPDATE public.ar_invoices
    SET subtotal = _subtotal, tax = _tax, total = _subtotal + _tax
    WHERE id = _invoice_id;

  RETURN _invoice_id;
END; $$;

GRANT EXECUTE ON FUNCTION public.create_ar_invoice(uuid, uuid, date, date, text, text, jsonb) TO authenticated;
