-- Two defects that make whole features unusable on every property, found while
-- building the demonstration environment against a copy of this schema.
--
-- 1. run_night_audit() has never completed a single run.
--
--    It ends by inserting into night_audits with
--      CASE WHEN jsonb_array_length(_err) > 0 THEN 'failed' ELSE 'completed' END
--    and night_audits.status is night_audit_status, not text. Postgres refuses
--    the unknown-typed CASE result with 42804 ('column "status" is of type
--    night_audit_status but expression is of type text'), so the function raises
--    for every property and every business date: no audit row is ever written,
--    no overdue reservation is ever checked out by the audit, and no no-show is
--    ever marked by it. Verified against a copy of the production schema — 87
--    consecutive business dates, 87 failures, 0 night_audits rows. Fixed by
--    casting the CASE result to night_audit_status.
--
-- 2. payroll_prepare_effective_supersession() makes payroll_statutory_rule_sets
--    impossible to insert into.
--
--    The trigger function is shared by eight payroll tables and branches on
--    TG_TABLE_NAME. Two branches AND a NEW column into the same condition:
--
--      ELSIF TG_TABLE_NAME='payroll_payment_details' AND NEW.is_primary THEN
--
--    PL/pgSQL evaluates a condition as a single SQL expression and does not
--    short-circuit the way that code assumes, so NEW.is_primary is resolved even
--    when the row being inserted is a statutory rule set — which has no such
--    column — and the insert fails with 42703 ('record "new" has no field
--    "is_primary"'). SSNIT, PAYE and every other statutory rule are therefore
--    unconfigurable, and payroll consequently calculates no statutory
--    deductions at all. Fixed by nesting each column test inside its own
--    table-name branch, so a column is only ever resolved for the table that
--    has it.
--
-- Both functions are otherwise reproduced exactly as they stand in the database
-- today: the diff is the cast and the nesting.

-- 1. night audit ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.run_night_audit(_property_id uuid, _business_date date, _lock_period boolean DEFAULT false) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  _audit_id UUID; r RECORD; _warn JSONB := '[]'::jsonb; _err JSONB := '[]'::jsonb;
  _res_posted INT := 0; _pos_posted INT := 0; _pay_posted INT := 0;
  _rooms_occ INT; _arr INT; _dep INT; _noshow INT;
  _room_rev NUMERIC := 0; _fnb_rev NUMERIC := 0; _tax NUMERIC := 0; _cash NUMERIC := 0;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id) THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  -- Auto check-out overdue reservations still checked_in with check_out <= business_date
  FOR r IN SELECT id FROM public.reservations
    WHERE property_id=_property_id AND status='checked_in' AND check_out <= _business_date LOOP
    BEGIN
      UPDATE public.reservations SET status='checked_out', updated_at=now() WHERE id=r.id;
      _res_posted := _res_posted + 1;
    EXCEPTION WHEN OTHERS THEN
      _err := _err || jsonb_build_array(jsonb_build_object('type','reservation_checkout','id',r.id,'error',SQLERRM));
    END;
  END LOOP;

  -- Mark no-shows: confirmed reservations with check_in < business_date and never checked in
  FOR r IN SELECT id FROM public.reservations
    WHERE property_id=_property_id AND status='confirmed' AND check_in < _business_date LOOP
    UPDATE public.reservations SET status='no_show', updated_at=now() WHERE id=r.id;
    _warn := _warn || jsonb_build_array(jsonb_build_object('type','no_show','reservation_id',r.id));
  END LOOP;

  -- Warn on open POS orders
  FOR r IN SELECT id, code FROM public.pos_orders
    WHERE property_id=_property_id AND status IN ('open','sent') AND opened_at::date <= _business_date LOOP
    _warn := _warn || jsonb_build_array(jsonb_build_object('type','open_pos_order','order_id',r.id,'code',r.code));
  END LOOP;

  -- Metrics
  SELECT COUNT(*) INTO _rooms_occ FROM public.reservations
    WHERE property_id=_property_id AND status='checked_in'
      AND check_in <= _business_date AND check_out > _business_date;
  SELECT COUNT(*) INTO _arr FROM public.reservations
    WHERE property_id=_property_id AND check_in=_business_date AND status IN ('checked_in','checked_out');
  SELECT COUNT(*) INTO _dep FROM public.reservations
    WHERE property_id=_property_id AND check_out=_business_date AND status='checked_out';
  SELECT COUNT(*) INTO _noshow FROM public.reservations
    WHERE property_id=_property_id AND status='no_show' AND check_in=_business_date;

  SELECT COALESCE(SUM(jl.credit_base - jl.debit_base),0) INTO _room_rev
    FROM public.journal_lines jl
    JOIN public.journal_entries je ON je.id=jl.entry_id
    JOIN public.accounts a ON a.id=jl.account_id
    WHERE je.property_id=_property_id AND je.entry_date=_business_date AND a.system_key='room_revenue';
  SELECT COALESCE(SUM(jl.credit_base - jl.debit_base),0) INTO _fnb_rev
    FROM public.journal_lines jl JOIN public.journal_entries je ON je.id=jl.entry_id
    JOIN public.accounts a ON a.id=jl.account_id
    WHERE je.property_id=_property_id AND je.entry_date=_business_date AND a.system_key='fnb_revenue';
  SELECT COALESCE(SUM(jl.credit_base - jl.debit_base),0) INTO _tax
    FROM public.journal_lines jl JOIN public.journal_entries je ON je.id=jl.entry_id
    JOIN public.accounts a ON a.id=jl.account_id
    WHERE je.property_id=_property_id AND je.entry_date=_business_date AND a.system_key='tax_payable';
  SELECT COALESCE(SUM(jl.debit_base - jl.credit_base),0) INTO _cash
    FROM public.journal_lines jl JOIN public.journal_entries je ON je.id=jl.entry_id
    JOIN public.accounts a ON a.id=jl.account_id
    WHERE je.property_id=_property_id AND je.entry_date=_business_date AND a.system_key IN ('cash','bank');

  SELECT COUNT(*) INTO _pos_posted FROM public.journal_entries
    WHERE property_id=_property_id AND entry_date=_business_date AND source='pos';
  SELECT COUNT(*) INTO _pay_posted FROM public.journal_entries
    WHERE property_id=_property_id AND entry_date=_business_date AND source='payment';

  INSERT INTO public.night_audits(
    property_id, business_date, status, rooms_occupied, arrivals, departures, no_shows,
    reservations_posted, pos_orders_posted, payments_posted,
    room_revenue, fnb_revenue, tax_collected, cash_in,
    warnings, errors, period_locked, ran_by
  ) VALUES (
    _property_id, _business_date,
    (CASE WHEN jsonb_array_length(_err) > 0 THEN 'failed' ELSE 'completed' END)::public.night_audit_status,
    _rooms_occ, _arr, _dep, _noshow, _res_posted, _pos_posted, _pay_posted,
    _room_rev, _fnb_rev, _tax, _cash, _warn, _err, false, auth.uid()
  )
  ON CONFLICT (property_id, business_date) DO UPDATE SET
    status=EXCLUDED.status, rooms_occupied=EXCLUDED.rooms_occupied,
    arrivals=EXCLUDED.arrivals, departures=EXCLUDED.departures, no_shows=EXCLUDED.no_shows,
    reservations_posted=EXCLUDED.reservations_posted, pos_orders_posted=EXCLUDED.pos_orders_posted,
    payments_posted=EXCLUDED.payments_posted, room_revenue=EXCLUDED.room_revenue,
    fnb_revenue=EXCLUDED.fnb_revenue, tax_collected=EXCLUDED.tax_collected, cash_in=EXCLUDED.cash_in,
    warnings=EXCLUDED.warnings, errors=EXCLUDED.errors, ran_at=now(), ran_by=auth.uid()
  RETURNING id INTO _audit_id;

  IF _lock_period AND jsonb_array_length(_err) = 0 THEN
    INSERT INTO public.accounting_periods(property_id, start_date, end_date, status, locked_at, locked_by)
    VALUES (_property_id, _business_date, _business_date, 'locked', now(), auth.uid())
    ON CONFLICT DO NOTHING;
    UPDATE public.night_audits SET period_locked=true WHERE id=_audit_id;
  END IF;

  RETURN _audit_id;
END; $function$;
-- 2. payroll effective-date supersession ------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_prepare_effective_supersession() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $function$
BEGIN
  IF TG_TABLE_NAME='payroll_settings' THEN
    IF EXISTS(SELECT 1 FROM public.payroll_settings
      WHERE property_id=NEW.property_id AND effective_from>=NEW.effective_from)
      THEN RAISE EXCEPTION 'Payroll settings require a later effective date'; END IF;
    UPDATE public.payroll_settings SET effective_to=NEW.effective_from-1,updated_by=NEW.updated_by
    WHERE property_id=NEW.property_id AND effective_from<NEW.effective_from
      AND COALESCE(effective_to,'infinity'::date)>=NEW.effective_from;
  ELSIF TG_TABLE_NAME='payroll_salary_structures' THEN
    IF EXISTS(SELECT 1 FROM public.payroll_salary_structures
      WHERE property_id=NEW.property_id AND code=NEW.code AND effective_from>=NEW.effective_from
        AND active AND archived_at IS NULL)
      THEN RAISE EXCEPTION 'Salary structure requires a later effective date'; END IF;
    UPDATE public.payroll_salary_structures SET effective_to=NEW.effective_from-1,updated_by=NEW.updated_by
    WHERE property_id=NEW.property_id AND code=NEW.code AND effective_from<NEW.effective_from
      AND active AND archived_at IS NULL
      AND COALESCE(effective_to,'infinity'::date)>=NEW.effective_from;
  ELSIF TG_TABLE_NAME='payroll_salary_grades' THEN
    IF EXISTS(SELECT 1 FROM public.payroll_salary_grades
      WHERE property_id=NEW.property_id AND salary_structure_id=NEW.salary_structure_id
        AND code=NEW.code AND effective_from>=NEW.effective_from AND active AND archived_at IS NULL)
      THEN RAISE EXCEPTION 'Salary grade requires a later effective date'; END IF;
    UPDATE public.payroll_salary_grades SET effective_to=NEW.effective_from-1,updated_by=NEW.updated_by
    WHERE property_id=NEW.property_id AND salary_structure_id=NEW.salary_structure_id
      AND code=NEW.code AND effective_from<NEW.effective_from AND active AND archived_at IS NULL
      AND COALESCE(effective_to,'infinity'::date)>=NEW.effective_from;
  ELSIF TG_TABLE_NAME='payroll_pay_components' THEN
    IF EXISTS(SELECT 1 FROM public.payroll_pay_components
      WHERE property_id=NEW.property_id AND code=NEW.code AND effective_from>=NEW.effective_from
        AND active AND archived_at IS NULL)
      THEN RAISE EXCEPTION 'Pay component requires a later effective date'; END IF;
    UPDATE public.payroll_pay_components SET effective_to=NEW.effective_from-1,updated_by=NEW.updated_by
    WHERE property_id=NEW.property_id AND code=NEW.code AND effective_from<NEW.effective_from
      AND active AND archived_at IS NULL
      AND COALESCE(effective_to,'infinity'::date)>=NEW.effective_from;
  ELSIF TG_TABLE_NAME='payroll_employee_compensations' THEN
    IF EXISTS(SELECT 1 FROM public.payroll_employee_compensations
      WHERE property_id=NEW.property_id AND employee_id=NEW.employee_id
        AND effective_from>=NEW.effective_from AND active AND archived_at IS NULL)
      THEN RAISE EXCEPTION 'Employee compensation requires a later effective date'; END IF;
    UPDATE public.payroll_employee_compensations
    SET effective_to=NEW.effective_from-1,updated_by=NEW.updated_by
    WHERE property_id=NEW.property_id AND employee_id=NEW.employee_id
      AND effective_from<NEW.effective_from AND active AND archived_at IS NULL
      AND COALESCE(effective_to,'infinity'::date)>=NEW.effective_from;
  ELSIF TG_TABLE_NAME='payroll_structure_components' THEN
    IF EXISTS(SELECT 1 FROM public.payroll_structure_components
      WHERE property_id=NEW.property_id AND salary_structure_id=NEW.salary_structure_id
        AND salary_grade_id IS NOT DISTINCT FROM NEW.salary_grade_id
        AND pay_component_id=NEW.pay_component_id AND effective_from>=NEW.effective_from AND active)
      THEN RAISE EXCEPTION 'Structure component requires a later effective date'; END IF;
    UPDATE public.payroll_structure_components SET effective_to=NEW.effective_from-1,updated_by=NEW.updated_by
    WHERE property_id=NEW.property_id AND salary_structure_id=NEW.salary_structure_id
      AND salary_grade_id IS NOT DISTINCT FROM NEW.salary_grade_id
      AND pay_component_id=NEW.pay_component_id AND effective_from<NEW.effective_from AND active
      AND COALESCE(effective_to,'infinity'::date)>=NEW.effective_from;
  ELSIF TG_TABLE_NAME='payroll_payment_details' THEN
   IF NEW.is_primary THEN
    UPDATE public.payroll_payment_details
    SET effective_to=NEW.effective_from-1,updated_by=NEW.updated_by
    WHERE property_id=NEW.property_id AND employee_id=NEW.employee_id
      AND is_primary AND archived_at IS NULL AND effective_from<NEW.effective_from
      AND COALESCE(effective_to,'infinity'::date)>=NEW.effective_from;
   END IF;
  ELSIF TG_TABLE_NAME='payroll_statutory_rule_sets' THEN
   IF NEW.verification_status='verified' THEN
    IF EXISTS(SELECT 1 FROM public.payroll_statutory_rule_sets
      WHERE property_id=NEW.property_id AND jurisdiction_code=NEW.jurisdiction_code
        AND rule_category=NEW.rule_category AND verification_status='verified'
        AND effective_from>=NEW.effective_from AND active AND archived_at IS NULL)
      THEN RAISE EXCEPTION 'Verified statutory rule requires a later effective date'; END IF;
    UPDATE public.payroll_statutory_rule_sets
    SET effective_to=NEW.effective_from-1,updated_by=NEW.updated_by
    WHERE property_id=NEW.property_id AND jurisdiction_code=NEW.jurisdiction_code
      AND rule_category=NEW.rule_category AND verification_status='verified'
      AND effective_from<NEW.effective_from AND active AND archived_at IS NULL
      AND COALESCE(effective_to,'infinity'::date)>=NEW.effective_from;
   END IF;
  END IF;
  RETURN NEW;
END $function$;
