-- Phase 6A: accounting & expense-management foundation.
-- Additive only. Extends the existing lightweight accounting module
-- (accounting_periods, suppliers) rather than duplicating it, and adds the
-- new expense workflow tables. Nothing existing is dropped, renamed or
-- altered destructively. No general ledger, invoicing, receivables, cash
-- drawers, bank integrations or tax filing are implemented here.

-- ============ FINANCIAL PERIODS (extend existing accounting_periods) ============
ALTER TABLE public.accounting_periods
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS code text,
  ADD COLUMN IF NOT EXISTS opened_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reopened_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reopened_at timestamptz,
  ADD COLUMN IF NOT EXISTS reopen_reason text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$ BEGIN
  ALTER TABLE public.accounting_periods ADD CONSTRAINT accounting_periods_date_order
    CHECK (end_date >= start_date);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.accounting_periods ADD CONSTRAINT accounting_periods_property_id_uniq UNIQUE (property_id, id);
EXCEPTION WHEN duplicate_table THEN NULL; END $$;

CREATE TRIGGER trg_accounting_periods_updated BEFORE UPDATE ON public.accounting_periods
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- Only 'open' periods are considered active for overlap purposes; a
-- property may have historical closed/locked periods that predate this rule.
CREATE OR REPLACE FUNCTION public.accounting_periods_prevent_overlap()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.status = 'open' AND EXISTS (
    SELECT 1 FROM public.accounting_periods p
    WHERE p.property_id = NEW.property_id
      AND p.id <> NEW.id
      AND p.status = 'open'
      AND daterange(p.start_date, p.end_date, '[]') && daterange(NEW.start_date, NEW.end_date, '[]')
  ) THEN
    RAISE EXCEPTION 'An open financial period already exists for an overlapping date range';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_accounting_periods_overlap ON public.accounting_periods;
CREATE TRIGGER trg_accounting_periods_overlap BEFORE INSERT OR UPDATE ON public.accounting_periods
  FOR EACH ROW EXECUTE FUNCTION public.accounting_periods_prevent_overlap();

-- Additional permission-based access alongside the existing hardcoded-role policy
-- (RLS policies are OR'd; nothing existing is removed).
CREATE POLICY financial_periods_write_by_permission ON public.accounting_periods FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), property_id, 'financial_periods', 'manage'))
  WITH CHECK (public.has_permission(auth.uid(), property_id, 'financial_periods', 'manage'));

-- ============ VENDORS (extend existing suppliers) ============
ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS vendor_code text,
  ADD COLUMN IF NOT EXISTS vendor_type text,
  ADD COLUMN IF NOT EXISTS tax_reference text,
  ADD COLUMN IF NOT EXISTS preferred_payment_method text,
  ADD COLUMN IF NOT EXISTS bank_detail_reference text,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archive_reason text;
COMMENT ON COLUMN public.suppliers.bank_detail_reference IS
  'Reference/pointer only (e.g. an external safe-storage id). Never store raw bank account numbers here.';

DO $$ BEGIN
  ALTER TABLE public.suppliers ADD CONSTRAINT suppliers_property_id_uniq UNIQUE (property_id, id);
EXCEPTION WHEN duplicate_table THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_vendor_code_property_uidx
  ON public.suppliers(property_id, vendor_code) WHERE vendor_code IS NOT NULL;

CREATE POLICY vendors_write_by_permission ON public.suppliers FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), property_id, 'vendors', 'manage'))
  WITH CHECK (public.has_permission(auth.uid(), property_id, 'vendors', 'manage'));

-- ============ COST CENTRES ============
CREATE TABLE public.cost_centres (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 160),
  code text NOT NULL CHECK (char_length(trim(code)) BETWEEN 1 AND 40),
  description text,
  parent_cost_centre_id uuid REFERENCES public.cost_centres(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.hr_departments(id) ON DELETE SET NULL,
  manager_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  archived_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  archive_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, code),
  UNIQUE (property_id, id)
);
CREATE INDEX cost_centres_property_idx ON public.cost_centres(property_id, active);
GRANT SELECT, INSERT, UPDATE ON public.cost_centres TO authenticated;
GRANT ALL ON public.cost_centres TO service_role;
ALTER TABLE public.cost_centres ENABLE ROW LEVEL SECURITY;
CREATE POLICY cost_centres_read ON public.cost_centres FOR SELECT TO authenticated
  USING (public.can_access_property(auth.uid(), property_id));
CREATE POLICY cost_centres_write ON public.cost_centres FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), property_id, 'cost_centres', 'manage'))
  WITH CHECK (public.has_permission(auth.uid(), property_id, 'cost_centres', 'manage'));
CREATE TRIGGER trg_cost_centres_updated BEFORE UPDATE ON public.cost_centres
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE OR REPLACE FUNCTION public.cost_centres_prevent_cycle()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE current_id uuid; depth int := 0;
BEGIN
  IF NEW.parent_cost_centre_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.parent_cost_centre_id = NEW.id THEN
    RAISE EXCEPTION 'A cost centre cannot be its own parent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.cost_centres WHERE id = NEW.parent_cost_centre_id AND property_id = NEW.property_id
  ) THEN
    RAISE EXCEPTION 'Parent cost centre must belong to the same property';
  END IF;
  current_id := NEW.parent_cost_centre_id;
  WHILE current_id IS NOT NULL AND depth < 50 LOOP
    IF current_id = NEW.id THEN
      RAISE EXCEPTION 'Cost centre hierarchy cannot contain a cycle';
    END IF;
    SELECT parent_cost_centre_id INTO current_id FROM public.cost_centres WHERE id = current_id;
    depth := depth + 1;
  END LOOP;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_cost_centres_cycle BEFORE INSERT OR UPDATE ON public.cost_centres
  FOR EACH ROW EXECUTE FUNCTION public.cost_centres_prevent_cycle();

-- ============ EXPENSE CATEGORIES ============
CREATE TABLE public.expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 160),
  code text NOT NULL CHECK (char_length(trim(code)) BETWEEN 1 AND 40),
  description text,
  default_cost_centre_id uuid REFERENCES public.cost_centres(id) ON DELETE SET NULL,
  accounting_mapping_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  approval_threshold numeric(18,4) CHECK (approval_threshold IS NULL OR approval_threshold >= 0),
  receipt_required boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  archived_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  archive_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, code),
  UNIQUE (property_id, id),
  FOREIGN KEY (property_id, default_cost_centre_id) REFERENCES public.cost_centres(property_id, id)
);
CREATE INDEX expense_categories_property_idx ON public.expense_categories(property_id, active);
GRANT SELECT, INSERT, UPDATE ON public.expense_categories TO authenticated;
GRANT ALL ON public.expense_categories TO service_role;
ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY expense_categories_read ON public.expense_categories FOR SELECT TO authenticated
  USING (public.can_access_property(auth.uid(), property_id));
CREATE POLICY expense_categories_write ON public.expense_categories FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), property_id, 'expense_categories', 'manage'))
  WITH CHECK (public.has_permission(auth.uid(), property_id, 'expense_categories', 'manage'));
CREATE TRIGGER trg_expense_categories_updated BEFORE UPDATE ON public.expense_categories
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- ============ EXPENSES ============
CREATE TYPE public.expense_status AS ENUM
  ('draft','submitted','approved','rejected','returned','cancelled','reversed');

CREATE TABLE public.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  financial_period_id uuid REFERENCES public.accounting_periods(id) ON DELETE SET NULL,
  expense_number text NOT NULL,
  expense_date date NOT NULL DEFAULT CURRENT_DATE,
  vendor_id uuid REFERENCES public.suppliers(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL REFERENCES public.expense_categories(id) ON DELETE RESTRICT,
  cost_centre_id uuid REFERENCES public.cost_centres(id) ON DELETE RESTRICT,
  department_id uuid REFERENCES public.hr_departments(id) ON DELETE SET NULL,
  currency text NOT NULL REFERENCES public.currencies(code),
  -- Ordinary expenses must be non-negative; only an explicit reversal-evidence row
  -- (reversal_of_expense_id set) may carry negative amounts.
  amount_before_tax numeric(18,4) NOT NULL
    CHECK (reversal_of_expense_id IS NOT NULL OR amount_before_tax >= 0),
  tax_amount numeric(18,4) NOT NULL DEFAULT 0
    CHECK (reversal_of_expense_id IS NOT NULL OR tax_amount >= 0),
  total_amount numeric(18,4) GENERATED ALWAYS AS (amount_before_tax + tax_amount) STORED,
  description text,
  business_purpose text,
  payment_method text,
  payment_reference text,
  status public.expense_status NOT NULL DEFAULT 'draft',
  receipt_status text NOT NULL DEFAULT 'missing' CHECK (receipt_status IN ('missing','attached')),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  submitted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  submitted_at timestamptz,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  rejected_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  rejected_at timestamptz,
  rejection_reason text,
  returned_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  returned_at timestamptz,
  return_reason text,
  cancelled_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  cancellation_reason text,
  reversal_of_expense_id uuid REFERENCES public.expenses(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, expense_number),
  UNIQUE (property_id, id),
  FOREIGN KEY (property_id, financial_period_id) REFERENCES public.accounting_periods(property_id, id),
  FOREIGN KEY (property_id, vendor_id) REFERENCES public.suppliers(property_id, id),
  FOREIGN KEY (property_id, category_id) REFERENCES public.expense_categories(property_id, id),
  FOREIGN KEY (property_id, cost_centre_id) REFERENCES public.cost_centres(property_id, id)
);
CREATE INDEX expenses_property_status_idx ON public.expenses(property_id, status);
CREATE INDEX expenses_property_date_idx ON public.expenses(property_id, expense_date DESC);
CREATE INDEX expenses_vendor_idx ON public.expenses(property_id, vendor_id);
CREATE INDEX expenses_category_idx ON public.expenses(property_id, category_id);
CREATE INDEX expenses_cost_centre_idx ON public.expenses(property_id, cost_centre_id);
CREATE INDEX expenses_created_by_idx ON public.expenses(property_id, created_by);
COMMENT ON COLUMN public.expenses.total_amount IS
  'Always server-calculated (generated column). Clients cannot set or influence this value directly.';

-- All mutation happens through SECURITY DEFINER RPCs below; authenticated clients get
-- read-only, ownership/permission-scoped SELECT and nothing else.
REVOKE ALL ON public.expenses FROM authenticated;
GRANT SELECT ON public.expenses TO authenticated;
GRANT ALL ON public.expenses TO service_role;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY expenses_read ON public.expenses FOR SELECT TO authenticated
  USING (
    public.can_access_property(auth.uid(), property_id)
    AND (created_by = auth.uid() OR public.has_permission(auth.uid(), property_id, 'expenses', 'read'))
  );
CREATE TRIGGER trg_expenses_updated BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- ============ EXPENSE STATUS HISTORY (immutable, append-only) ============
CREATE TABLE public.expense_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  expense_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  action text NOT NULL,
  reason text,
  actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (property_id, expense_id) REFERENCES public.expenses(property_id, id) ON DELETE CASCADE
);
CREATE INDEX expense_status_history_lookup_idx ON public.expense_status_history(property_id, expense_id, created_at DESC);
REVOKE ALL ON public.expense_status_history FROM authenticated;
GRANT SELECT ON public.expense_status_history TO authenticated;
GRANT ALL ON public.expense_status_history TO service_role;
ALTER TABLE public.expense_status_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY expense_status_history_read ON public.expense_status_history FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses e WHERE e.id = expense_id AND e.property_id = expense_status_history.property_id
        AND (e.created_by = auth.uid() OR public.has_permission(auth.uid(), e.property_id, 'expenses', 'read'))
    )
  );

-- ============ EXPENSE RECEIPTS ============
CREATE TABLE public.expense_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  expense_id uuid NOT NULL,
  file_name text NOT NULL CHECK (char_length(trim(file_name)) BETWEEN 1 AND 200),
  mime_type text NOT NULL CHECK (mime_type IN ('application/pdf','image/jpeg','image/png','image/webp')),
  file_size bigint NOT NULL CHECK (file_size > 0 AND file_size <= 10485760),
  storage_path text NOT NULL,
  uploaded_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  receipt_type text NOT NULL DEFAULT 'receipt',
  archived_at timestamptz,
  archived_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  archive_reason text,
  UNIQUE (storage_path),
  UNIQUE (property_id, id),
  FOREIGN KEY (property_id, expense_id) REFERENCES public.expenses(property_id, id) ON DELETE CASCADE
);
CREATE INDEX expense_receipts_expense_idx ON public.expense_receipts(property_id, expense_id);
COMMENT ON TABLE public.expense_receipts IS
  'Receipt file metadata only. Contents live in private storage; never inlined here or in audit logs.';
REVOKE ALL ON public.expense_receipts FROM authenticated;
GRANT SELECT ON public.expense_receipts TO authenticated;
GRANT ALL ON public.expense_receipts TO service_role;
ALTER TABLE public.expense_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY expense_receipts_read ON public.expense_receipts FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses e WHERE e.id = expense_id AND e.property_id = expense_receipts.property_id
        AND (e.created_by = auth.uid() OR public.has_permission(auth.uid(), e.property_id, 'expense_receipts', 'read'))
    )
  );

-- ============ EXPENSE CORRECTIONS & REVERSAL FOUNDATION ============
CREATE TABLE public.expense_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  expense_id uuid NOT NULL,
  reason text NOT NULL CHECK (char_length(trim(reason)) >= 5),
  requested_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_notes text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  financial_impact_amount numeric(18,4),
  replacement_expense_id uuid REFERENCES public.expenses(id) ON DELETE SET NULL,
  reversal_expense_id uuid REFERENCES public.expenses(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, id),
  FOREIGN KEY (property_id, expense_id) REFERENCES public.expenses(property_id, id) ON DELETE RESTRICT
);
CREATE INDEX expense_corrections_expense_idx ON public.expense_corrections(property_id, expense_id);
REVOKE ALL ON public.expense_corrections FROM authenticated;
GRANT SELECT ON public.expense_corrections TO authenticated;
GRANT ALL ON public.expense_corrections TO service_role;
ALTER TABLE public.expense_corrections ENABLE ROW LEVEL SECURITY;
CREATE POLICY expense_corrections_read ON public.expense_corrections FOR SELECT TO authenticated
  USING (
    public.can_access_property(auth.uid(), property_id)
    AND (requested_by = auth.uid() OR public.has_permission(auth.uid(), property_id, 'expense_corrections', 'read'))
  );
CREATE TRIGGER trg_expense_corrections_updated BEFORE UPDATE ON public.expense_corrections
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- ============ FINANCIAL PERIOD RPCs ============
CREATE OR REPLACE FUNCTION public.financial_period_open(
  _property_id uuid, _name text, _code text, _start_date date, _end_date date
) RETURNS public.accounting_periods
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid := auth.uid(); row public.accounting_periods%ROWTYPE;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT public.has_permission(actor, _property_id, 'financial_periods', 'manage') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _end_date < _start_date THEN RAISE EXCEPTION 'End date must not be before start date'; END IF;

  INSERT INTO public.accounting_periods(
    property_id, name, code, start_date, end_date, status, opened_by, opened_at
  ) VALUES (
    _property_id, NULLIF(trim(_name), ''), NULLIF(trim(_code), ''), _start_date, _end_date,
    'open', actor, now()
  ) RETURNING * INTO row;
  RETURN row;
END; $$;
REVOKE ALL ON FUNCTION public.financial_period_open(uuid, text, text, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.financial_period_open(uuid, text, text, date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.financial_period_close(_period_id uuid)
RETURNS public.accounting_periods
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid := auth.uid(); row public.accounting_periods%ROWTYPE;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO row FROM public.accounting_periods WHERE id = _period_id FOR UPDATE;
  IF row.id IS NULL THEN RAISE EXCEPTION 'Financial period not found'; END IF;
  IF NOT public.has_permission(actor, row.property_id, 'financial_periods', 'manage') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF row.status = 'closed' THEN RETURN row; END IF; -- idempotent no-op
  IF row.status <> 'open' THEN RAISE EXCEPTION 'Only an open period can be closed'; END IF;

  UPDATE public.accounting_periods SET status = 'closed', closed_by = actor, closed_at = now()
    WHERE id = _period_id RETURNING * INTO row;
  RETURN row;
END; $$;
REVOKE ALL ON FUNCTION public.financial_period_close(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.financial_period_close(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.financial_period_reopen(_period_id uuid, _reason text)
RETURNS public.accounting_periods
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid := auth.uid(); row public.accounting_periods%ROWTYPE;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF char_length(trim(COALESCE(_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'A reason of at least 5 characters is required to reopen a financial period';
  END IF;
  SELECT * INTO row FROM public.accounting_periods WHERE id = _period_id FOR UPDATE;
  IF row.id IS NULL THEN RAISE EXCEPTION 'Financial period not found'; END IF;
  IF NOT public.has_permission(actor, row.property_id, 'financial_periods', 'manage') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF row.status <> 'closed' THEN RAISE EXCEPTION 'Only a closed period can be reopened'; END IF;

  UPDATE public.accounting_periods SET
    status = 'open', reopened_by = actor, reopened_at = now(), reopen_reason = _reason
    WHERE id = _period_id RETURNING * INTO row;
  RETURN row;
END; $$;
REVOKE ALL ON FUNCTION public.financial_period_reopen(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.financial_period_reopen(uuid, text) TO authenticated;

-- ============ EXPENSE HELPERS ============
CREATE OR REPLACE FUNCTION public.expense_resolve_period(_property_id uuid, _expense_date date)
RETURNS public.accounting_periods
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM public.accounting_periods
  WHERE property_id = _property_id AND _expense_date BETWEEN start_date AND end_date
  ORDER BY (status = 'open') DESC, created_at DESC
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.expense_resolve_period(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_resolve_period(uuid, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.expense_assert_period_open(_property_id uuid, _expense_date date, _actor uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE period public.accounting_periods%ROWTYPE;
BEGIN
  period := public.expense_resolve_period(_property_id, _expense_date);
  IF period.id IS NOT NULL AND period.status IN ('closed', 'locked')
     AND NOT public.has_permission(_actor, _property_id, 'financial_periods', 'manage') THEN
    RAISE EXCEPTION 'The financial period covering this date is closed';
  END IF;
  RETURN period.id;
END; $$;
REVOKE ALL ON FUNCTION public.expense_assert_period_open(uuid, date, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_assert_period_open(uuid, date, uuid) TO authenticated, service_role;

-- ============ EXPENSE CREATE / UPDATE (draft only) ============
CREATE OR REPLACE FUNCTION public.expense_create(
  _property_id uuid, _expense_date date, _vendor_id uuid, _category_id uuid, _cost_centre_id uuid,
  _department_id uuid, _currency text, _amount_before_tax numeric, _tax_amount numeric,
  _description text, _business_purpose text, _payment_method text, _payment_reference text
) RETURNS public.expenses
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid := auth.uid(); prop public.properties%ROWTYPE; period_id uuid; row public.expenses%ROWTYPE;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT public.has_permission(actor, _property_id, 'expenses', 'create') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _amount_before_tax IS NULL OR _amount_before_tax < 0 THEN RAISE EXCEPTION 'Amount before tax must be zero or greater'; END IF;
  IF _tax_amount IS NULL OR _tax_amount < 0 THEN RAISE EXCEPTION 'Tax amount must be zero or greater'; END IF;

  SELECT * INTO prop FROM public.properties WHERE id = _property_id;
  IF prop.id IS NULL THEN RAISE EXCEPTION 'Property not found'; END IF;
  IF _currency IS DISTINCT FROM prop.base_currency THEN
    RAISE EXCEPTION 'Expense currency must match the property base currency (%)', prop.base_currency;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.expense_categories WHERE id = _category_id AND property_id = _property_id) THEN
    RAISE EXCEPTION 'Expense category not found for this property';
  END IF;
  IF _cost_centre_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.cost_centres WHERE id = _cost_centre_id AND property_id = _property_id
  ) THEN RAISE EXCEPTION 'Cost centre not found for this property'; END IF;
  IF _vendor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.suppliers WHERE id = _vendor_id AND property_id = _property_id
  ) THEN RAISE EXCEPTION 'Vendor not found for this property'; END IF;
  IF _department_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.hr_departments WHERE id = _department_id AND property_id = _property_id
  ) THEN RAISE EXCEPTION 'Department not found for this property'; END IF;

  period_id := public.expense_assert_period_open(_property_id, _expense_date, actor);

  INSERT INTO public.expenses(
    property_id, financial_period_id, expense_number, expense_date, vendor_id, category_id, cost_centre_id,
    department_id, currency, amount_before_tax, tax_amount, description, business_purpose,
    payment_method, payment_reference, status, created_by
  ) VALUES (
    _property_id, period_id, public.short_code('EXP'), _expense_date, _vendor_id, _category_id, _cost_centre_id,
    _department_id, _currency, _amount_before_tax, _tax_amount, NULLIF(trim(_description), ''),
    NULLIF(trim(_business_purpose), ''), NULLIF(trim(_payment_method), ''), NULLIF(trim(_payment_reference), ''),
    'draft', actor
  ) RETURNING * INTO row;

  INSERT INTO public.expense_status_history(property_id, expense_id, from_status, to_status, action, actor_id)
    VALUES (_property_id, row.id, NULL, 'draft', 'created', actor);
  RETURN row;
END; $$;
REVOKE ALL ON FUNCTION public.expense_create(
  uuid, date, uuid, uuid, uuid, uuid, text, numeric, numeric, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_create(
  uuid, date, uuid, uuid, uuid, uuid, text, numeric, numeric, text, text, text, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.expense_update_draft(
  _expense_id uuid, _expense_date date, _vendor_id uuid, _category_id uuid, _cost_centre_id uuid,
  _department_id uuid, _amount_before_tax numeric, _tax_amount numeric,
  _description text, _business_purpose text, _payment_method text, _payment_reference text
) RETURNS public.expenses
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid := auth.uid(); row public.expenses%ROWTYPE; period_id uuid;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO row FROM public.expenses WHERE id = _expense_id FOR UPDATE;
  IF row.id IS NULL THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF row.status NOT IN ('draft', 'returned') THEN
    RAISE EXCEPTION 'Only draft or returned expenses can be edited';
  END IF;
  IF NOT (row.created_by = actor OR public.has_permission(actor, row.property_id, 'expenses', 'update')) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _amount_before_tax IS NULL OR _amount_before_tax < 0 THEN RAISE EXCEPTION 'Amount before tax must be zero or greater'; END IF;
  IF _tax_amount IS NULL OR _tax_amount < 0 THEN RAISE EXCEPTION 'Tax amount must be zero or greater'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.expense_categories WHERE id = _category_id AND property_id = row.property_id) THEN
    RAISE EXCEPTION 'Expense category not found for this property';
  END IF;
  IF _cost_centre_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.cost_centres WHERE id = _cost_centre_id AND property_id = row.property_id
  ) THEN RAISE EXCEPTION 'Cost centre not found for this property'; END IF;
  IF _vendor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.suppliers WHERE id = _vendor_id AND property_id = row.property_id
  ) THEN RAISE EXCEPTION 'Vendor not found for this property'; END IF;

  period_id := public.expense_assert_period_open(row.property_id, _expense_date, actor);

  UPDATE public.expenses SET
    expense_date = _expense_date, financial_period_id = period_id, vendor_id = _vendor_id,
    category_id = _category_id, cost_centre_id = _cost_centre_id, department_id = _department_id,
    amount_before_tax = _amount_before_tax, tax_amount = _tax_amount,
    description = NULLIF(trim(_description), ''), business_purpose = NULLIF(trim(_business_purpose), ''),
    payment_method = NULLIF(trim(_payment_method), ''), payment_reference = NULLIF(trim(_payment_reference), '')
    WHERE id = _expense_id RETURNING * INTO row;
  RETURN row;
END; $$;
REVOKE ALL ON FUNCTION public.expense_update_draft(
  uuid, date, uuid, uuid, uuid, uuid, numeric, numeric, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_update_draft(
  uuid, date, uuid, uuid, uuid, uuid, numeric, numeric, text, text, text, text
) TO authenticated;

-- ============ EXPENSE SUBMIT ============
CREATE OR REPLACE FUNCTION public.expense_submit(_expense_id uuid)
RETURNS public.expenses
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid := auth.uid(); row public.expenses%ROWTYPE; cat public.expense_categories%ROWTYPE;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO row FROM public.expenses WHERE id = _expense_id FOR UPDATE;
  IF row.id IS NULL THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF row.status = 'submitted' THEN RETURN row; END IF; -- idempotent no-op
  IF row.status NOT IN ('draft', 'returned') THEN
    RAISE EXCEPTION 'Only a draft or returned expense can be submitted';
  END IF;
  IF NOT (
    public.has_permission(actor, row.property_id, 'expense_submission', 'create')
    AND (row.created_by = actor OR public.has_permission(actor, row.property_id, 'expenses', 'update'))
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.expense_assert_period_open(row.property_id, row.expense_date, actor);

  SELECT * INTO cat FROM public.expense_categories WHERE id = row.category_id;
  IF cat.receipt_required AND NOT EXISTS (
    SELECT 1 FROM public.expense_receipts WHERE expense_id = row.id AND archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'A receipt is required before this expense can be submitted';
  END IF;

  UPDATE public.expenses SET status = 'submitted', submitted_by = actor, submitted_at = now()
    WHERE id = _expense_id RETURNING * INTO row;
  INSERT INTO public.expense_status_history(property_id, expense_id, from_status, to_status, action, actor_id)
    VALUES (row.property_id, row.id, 'draft', 'submitted', 'submitted', actor);

  PERFORM public.notify(row.property_id, NULL, 'accounting', 'normal',
    'Expense submitted for approval',
    'Expense ' || row.expense_number || ' (' || row.total_amount || ' ' || row.currency || ') is awaiting approval.',
    '/accounting/approvals', jsonb_build_object('expenseId', row.id));
  RETURN row;
END; $$;
REVOKE ALL ON FUNCTION public.expense_submit(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_submit(uuid) TO authenticated;

-- ============ EXPENSE APPROVAL DECISION ============
CREATE OR REPLACE FUNCTION public.expense_decide(_expense_id uuid, _decision text, _reason text)
RETURNS public.expenses
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid := auth.uid(); row public.expenses%ROWTYPE; requester uuid;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF _decision NOT IN ('approved','rejected','returned','cancelled') THEN
    RAISE EXCEPTION 'Unsupported expense decision';
  END IF;

  SELECT * INTO row FROM public.expenses WHERE id = _expense_id FOR UPDATE;
  IF row.id IS NULL THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF row.status::text = _decision THEN RETURN row; END IF; -- idempotent no-op

  IF _decision = 'cancelled' THEN
    IF row.status NOT IN ('draft','submitted','returned') THEN
      RAISE EXCEPTION 'Only draft, submitted or returned expenses can be cancelled; use a correction or reversal for approved expenses';
    END IF;
    IF NOT (
      (row.created_by = actor AND row.status = 'draft')
      OR public.has_permission(actor, row.property_id, 'expense_cancellation', 'manage')
    ) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  ELSE
    IF row.status <> 'submitted' THEN
      RAISE EXCEPTION 'Expense is not in a state that allows this action';
    END IF;
    IF _decision = 'approved' THEN
      IF actor = row.created_by THEN RAISE EXCEPTION 'Cannot approve your own expense'; END IF;
      IF NOT public.has_permission(actor, row.property_id, 'expense_approval', 'approve') THEN
        RAISE EXCEPTION 'Not authorized';
      END IF;
    ELSIF _decision = 'rejected' THEN
      IF NOT public.has_permission(actor, row.property_id, 'expense_rejection', 'approve') THEN
        RAISE EXCEPTION 'Not authorized';
      END IF;
    ELSE -- returned
      IF NOT public.has_permission(actor, row.property_id, 'expense_rejection', 'approve') THEN
        RAISE EXCEPTION 'Not authorized';
      END IF;
    END IF;
  END IF;

  IF _decision IN ('rejected','returned','cancelled') AND char_length(trim(COALESCE(_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'A reason of at least 5 characters is required';
  END IF;

  IF _decision = 'approved' THEN
    UPDATE public.expenses SET status = 'approved', approved_by = actor, approved_at = now()
      WHERE id = _expense_id RETURNING * INTO row;
  ELSIF _decision = 'rejected' THEN
    UPDATE public.expenses SET status = 'rejected', rejected_by = actor, rejected_at = now(), rejection_reason = _reason
      WHERE id = _expense_id RETURNING * INTO row;
  ELSIF _decision = 'returned' THEN
    UPDATE public.expenses SET status = 'returned', returned_by = actor, returned_at = now(), return_reason = _reason
      WHERE id = _expense_id RETURNING * INTO row;
  ELSE
    UPDATE public.expenses SET status = 'cancelled', cancelled_by = actor, cancelled_at = now(), cancellation_reason = _reason
      WHERE id = _expense_id RETURNING * INTO row;
  END IF;

  INSERT INTO public.expense_status_history(property_id, expense_id, from_status, to_status, action, reason, actor_id)
    VALUES (row.property_id, row.id, row.status::text, _decision, _decision, _reason, actor);

  requester := COALESCE(row.submitted_by, row.created_by);
  PERFORM public.notify(row.property_id, requester, 'accounting',
    CASE WHEN _decision = 'approved' THEN 'normal' ELSE 'high' END,
    'Expense ' || _decision,
    'Expense ' || row.expense_number || ' was ' || _decision || '.',
    '/accounting/expenses/' || row.id, jsonb_build_object('decision', _decision));
  RETURN row;
END; $$;
REVOKE ALL ON FUNCTION public.expense_decide(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_decide(uuid, text, text) TO authenticated;

-- ============ EXPENSE CORRECTIONS & REVERSAL ============
CREATE OR REPLACE FUNCTION public.expense_correction_request(_expense_id uuid, _reason text)
RETURNS public.expense_corrections
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid := auth.uid(); expense public.expenses%ROWTYPE; row public.expense_corrections%ROWTYPE;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF char_length(trim(COALESCE(_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'A reason of at least 5 characters is required';
  END IF;
  SELECT * INTO expense FROM public.expenses WHERE id = _expense_id;
  IF expense.id IS NULL THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF NOT public.has_permission(actor, expense.property_id, 'expense_corrections', 'create') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF expense.status <> 'approved' THEN
    RAISE EXCEPTION 'Corrections may only be requested for approved expenses';
  END IF;

  INSERT INTO public.expense_corrections(property_id, expense_id, reason, requested_by)
    VALUES (expense.property_id, expense.id, _reason, actor) RETURNING * INTO row;

  PERFORM public.notify(expense.property_id, NULL, 'accounting', 'normal',
    'Expense correction requested',
    'A correction was requested for expense ' || expense.expense_number || '.',
    '/accounting/corrections', jsonb_build_object('correctionId', row.id));
  RETURN row;
END; $$;
REVOKE ALL ON FUNCTION public.expense_correction_request(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_correction_request(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.expense_correction_review(_correction_id uuid, _decision text, _review_notes text)
RETURNS public.expense_corrections
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid := auth.uid(); row public.expense_corrections%ROWTYPE;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF _decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'Unsupported correction decision'; END IF;
  IF char_length(trim(COALESCE(_review_notes, ''))) < 5 THEN
    RAISE EXCEPTION 'Review notes of at least 5 characters are required';
  END IF;

  SELECT * INTO row FROM public.expense_corrections WHERE id = _correction_id FOR UPDATE;
  IF row.id IS NULL THEN RAISE EXCEPTION 'Correction request not found'; END IF;
  IF NOT public.has_permission(actor, row.property_id, 'expense_corrections', 'approve') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF row.status::text = _decision THEN RETURN row; END IF; -- idempotent no-op
  IF row.status <> 'pending' THEN RAISE EXCEPTION 'Correction request has already been reviewed'; END IF;

  UPDATE public.expense_corrections SET
    status = _decision, reviewed_by = actor, reviewed_at = now(), review_notes = _review_notes
    WHERE id = _correction_id RETURNING * INTO row;

  PERFORM public.notify(row.property_id, row.requested_by, 'accounting', 'normal',
    'Expense correction ' || _decision,
    'Your expense correction request was ' || _decision || '.',
    '/accounting/corrections', jsonb_build_object('correctionId', row.id));
  RETURN row;
END; $$;
REVOKE ALL ON FUNCTION public.expense_correction_review(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_correction_review(uuid, text, text) TO authenticated;

-- Explicit reversal evidence: creates a new negative-amount expense row linked back to the
-- original and marks the original 'reversed'. Never claims a bank/cash payment was reversed.
CREATE OR REPLACE FUNCTION public.expense_reverse(_expense_id uuid, _reason text, _correction_id uuid DEFAULT NULL)
RETURNS public.expenses
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid := auth.uid(); original public.expenses%ROWTYPE; correction public.expense_corrections%ROWTYPE;
  reversal public.expenses%ROWTYPE; period_id uuid;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF char_length(trim(COALESCE(_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'A reason of at least 5 characters is required';
  END IF;

  SELECT * INTO original FROM public.expenses WHERE id = _expense_id FOR UPDATE;
  IF original.id IS NULL THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF NOT public.has_permission(actor, original.property_id, 'expense_reversals', 'manage') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO reversal FROM public.expenses WHERE reversal_of_expense_id = original.id LIMIT 1;
  IF reversal.id IS NOT NULL THEN RETURN reversal; END IF; -- idempotent: already reversed

  IF original.status <> 'approved' THEN
    RAISE EXCEPTION 'Only an approved expense can be reversed';
  END IF;

  IF _correction_id IS NOT NULL THEN
    SELECT * INTO correction FROM public.expense_corrections WHERE id = _correction_id;
    IF correction.id IS NULL OR correction.expense_id <> original.id OR correction.status <> 'approved' THEN
      RAISE EXCEPTION 'An approved correction for this expense is required';
    END IF;
  END IF;

  period_id := (public.expense_resolve_period(original.property_id, CURRENT_DATE)).id;

  INSERT INTO public.expenses(
    property_id, financial_period_id, expense_number, expense_date, vendor_id, category_id, cost_centre_id,
    department_id, currency, amount_before_tax, tax_amount, description, status, created_by, approved_by,
    approved_at, reversal_of_expense_id
  ) VALUES (
    original.property_id, period_id, public.short_code('REV'), CURRENT_DATE, original.vendor_id,
    original.category_id, original.cost_centre_id, original.department_id, original.currency,
    -original.amount_before_tax, -original.tax_amount,
    'Reversal of ' || original.expense_number || ': ' || _reason,
    'approved', actor, actor, now(), original.id
  ) RETURNING * INTO reversal;

  UPDATE public.expenses SET status = 'reversed' WHERE id = original.id;
  INSERT INTO public.expense_status_history(property_id, expense_id, from_status, to_status, action, reason, actor_id)
    VALUES (original.property_id, original.id, 'approved', 'reversed', 'reversed', _reason, actor);
  INSERT INTO public.expense_status_history(property_id, expense_id, from_status, to_status, action, reason, actor_id)
    VALUES (reversal.property_id, reversal.id, NULL, 'approved', 'reversal_created', _reason, actor);

  IF _correction_id IS NOT NULL THEN
    UPDATE public.expense_corrections SET reversal_expense_id = reversal.id WHERE id = _correction_id;
  END IF;

  PERFORM public.notify(original.property_id, COALESCE(original.submitted_by, original.created_by), 'accounting', 'high',
    'Expense reversed',
    'Expense ' || original.expense_number || ' was reversed. See ' || reversal.expense_number || ' for evidence.',
    '/accounting/expenses/' || reversal.id, jsonb_build_object('originalExpenseId', original.id));
  RETURN reversal;
END; $$;
REVOKE ALL ON FUNCTION public.expense_reverse(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_reverse(uuid, text, uuid) TO authenticated;

-- ============ EXPENSE RECEIPTS RPCs ============
CREATE OR REPLACE FUNCTION public.expense_receipt_register(
  _expense_id uuid, _file_name text, _mime_type text, _file_size bigint, _storage_path text, _receipt_type text
) RETURNS public.expense_receipts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid := auth.uid(); expense public.expenses%ROWTYPE; row public.expense_receipts%ROWTYPE;
  expected_prefix text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO expense FROM public.expenses WHERE id = _expense_id;
  IF expense.id IS NULL THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF NOT (expense.created_by = actor OR public.has_permission(actor, expense.property_id, 'expense_receipts', 'create')) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _mime_type NOT IN ('application/pdf','image/jpeg','image/png','image/webp') THEN
    RAISE EXCEPTION 'Unsupported receipt file type';
  END IF;
  IF _file_size IS NULL OR _file_size <= 0 OR _file_size > 10485760 THEN
    RAISE EXCEPTION 'Receipt must be between 1 byte and 10 MB';
  END IF;
  expected_prefix := expense.property_id::text || '/expenses/' || expense.id::text || '/';
  IF _storage_path !~ ('^' || expected_prefix) OR _storage_path LIKE '%..%' THEN
    RAISE EXCEPTION 'Invalid receipt storage path';
  END IF;

  INSERT INTO public.expense_receipts(
    property_id, expense_id, file_name, mime_type, file_size, storage_path, uploaded_by, receipt_type
  ) VALUES (
    expense.property_id, expense.id, left(trim(_file_name), 200), _mime_type, _file_size, _storage_path, actor,
    COALESCE(NULLIF(trim(_receipt_type), ''), 'receipt')
  ) RETURNING * INTO row;

  UPDATE public.expenses SET receipt_status = 'attached' WHERE id = expense.id AND receipt_status <> 'attached';
  RETURN row;
END; $$;
REVOKE ALL ON FUNCTION public.expense_receipt_register(uuid, text, text, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_receipt_register(uuid, text, text, bigint, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.expense_receipt_archive(_receipt_id uuid, _reason text)
RETURNS public.expense_receipts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid := auth.uid(); row public.expense_receipts%ROWTYPE;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF char_length(trim(COALESCE(_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'A reason of at least 5 characters is required';
  END IF;
  SELECT * INTO row FROM public.expense_receipts WHERE id = _receipt_id FOR UPDATE;
  IF row.id IS NULL THEN RAISE EXCEPTION 'Receipt not found'; END IF;
  IF NOT public.has_permission(actor, row.property_id, 'expense_receipts', 'delete') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF row.archived_at IS NOT NULL THEN RETURN row; END IF; -- idempotent

  UPDATE public.expense_receipts SET archived_at = now(), archived_by = actor, archive_reason = _reason
    WHERE id = _receipt_id RETURNING * INTO row;

  IF NOT EXISTS (SELECT 1 FROM public.expense_receipts WHERE expense_id = row.expense_id AND archived_at IS NULL) THEN
    UPDATE public.expenses SET receipt_status = 'missing' WHERE id = row.expense_id;
  END IF;
  RETURN row;
END; $$;
REVOKE ALL ON FUNCTION public.expense_receipt_archive(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_receipt_archive(uuid, text) TO authenticated;

-- ============ PERMISSION SEEDING ============
CREATE OR REPLACE FUNCTION public.seed_expense_permissions(_property_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Broad "own expense" access: any operational role may draft, submit and track their own expenses.
  INSERT INTO public.role_permissions(property_id, role, module, action, allowed)
  SELECT _property_id, role_name::public.app_role, module_name, action_name, true
  FROM (VALUES
    ('financial_periods','read'),
    ('expense_categories','read'), ('vendors','read'), ('cost_centres','read'),
    ('expenses','read'), ('expenses','create'), ('expenses','update'),
    ('expense_submission','create'),
    ('expense_receipts','read'), ('expense_receipts','create')
  ) permission(module_name, action_name)
  CROSS JOIN (VALUES
    ('super_admin'),('hotel_owner'),('general_manager'),('manager'),('accountant'),
    ('front_desk'),('reservations'),('cashier'),('housekeeping_supervisor'),('housekeeping'),
    ('restaurant_manager'),('waiter'),('kitchen'),('storekeeper'),('maintenance'),
    ('hr'),('security'),('guest_relations'),('auditor')
  ) role(role_name)
  ON CONFLICT DO NOTHING;

  -- Accounting-admin defaults: super_admin, hotel_owner, general_manager, accountant.
  INSERT INTO public.role_permissions(property_id, role, module, action, allowed)
  SELECT _property_id, role_name::public.app_role, module_name, action_name, true
  FROM (VALUES
    ('accounting_overview','read'),
    ('financial_periods','manage'),
    ('expense_categories','manage'),
    ('vendors','manage'),
    ('cost_centres','manage'),
    ('expenses','read'),
    ('expense_approval','approve'),
    ('expense_rejection','approve'),
    ('expense_cancellation','manage'),
    ('expenses_sensitive','read'),
    ('expense_receipts','delete'),
    ('expense_corrections','read'), ('expense_corrections','create'), ('expense_corrections','approve'),
    ('expense_reversals','manage'),
    ('expense_reports','read'), ('expense_reports','export'), ('expense_reports','print')
  ) permission(module_name, action_name)
  CROSS JOIN (VALUES ('super_admin'),('hotel_owner'),('general_manager'),('accountant')) role(role_name)
  ON CONFLICT DO NOTHING;
END; $$;
SELECT public.seed_expense_permissions(id) FROM public.properties;
REVOKE ALL ON FUNCTION public.seed_expense_permissions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_expense_permissions(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.seed_expense_permissions_for_property()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN PERFORM public.seed_expense_permissions(NEW.id); RETURN NEW; END $$;
CREATE TRIGGER properties_seed_expense_permissions AFTER INSERT ON public.properties
FOR EACH ROW EXECUTE FUNCTION public.seed_expense_permissions_for_property();
REVOKE ALL ON FUNCTION public.seed_expense_permissions_for_property() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_expense_permissions_for_property() TO service_role;

-- ============ RECEIPT STORAGE BUCKET ============
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'expense-receipts', 'expense-receipts', false, 10485760,
  ARRAY['application/pdf','image/jpeg','image/png','image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = false, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE POLICY expense_receipts_storage_insert ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'expense-receipts'
  AND public.has_permission(auth.uid(), ((storage.foldername(name))[1])::uuid, 'expense_receipts', 'create')
);

CREATE POLICY expense_receipts_storage_read ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'expense-receipts'
  AND EXISTS (
    SELECT 1 FROM public.expense_receipts r
    JOIN public.expenses e ON e.id = r.expense_id AND e.property_id = r.property_id
    WHERE r.storage_path = name
      AND (e.created_by = auth.uid() OR public.has_permission(auth.uid(), r.property_id, 'expense_receipts', 'read'))
  )
);
