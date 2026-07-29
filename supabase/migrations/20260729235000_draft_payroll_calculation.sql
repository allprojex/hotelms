-- Phase 4B: deterministic draft payroll calculation and review only.
-- No approval, finalization, payslips, payments, submissions, or accounting journals.

ALTER TABLE public.payroll_settings
  ADD COLUMN block_unverified_statutory_rules boolean NOT NULL DEFAULT true,
  ADD COLUMN incomplete_attendance_policy text NOT NULL DEFAULT 'warn'
    CHECK(incomplete_attendance_policy IN('warn','block')),
  ADD COLUMN variance_warning_percentage numeric(9,4) NOT NULL DEFAULT 25
    CHECK(variance_warning_percentage>0 AND variance_warning_percentage<=1000);

CREATE TABLE public.payroll_component_calculation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL, pay_component_id uuid NOT NULL,
  calculation_method text NOT NULL CHECK(calculation_method IN(
    'fixed_amount','percentage_base','percentage_gross','percentage_component',
    'attendance_day','worked_hour','unpaid_day_deduction','fixed_one_time',
    'manual_amount','statutory_rule','informational_overtime'
  )),
  amount numeric(20,8), percentage numeric(12,8), basis_component_id uuid,
  minimum_amount numeric(20,8), maximum_amount numeric(20,8),
  parameters jsonb NOT NULL DEFAULT '{}',
  effective_from date NOT NULL, effective_to date,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id), UNIQUE(property_id,pay_component_id,effective_from),
  FOREIGN KEY(property_id,pay_component_id)
    REFERENCES public.payroll_pay_components(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,basis_component_id)
    REFERENCES public.payroll_pay_components(property_id,id) ON DELETE RESTRICT,
  CHECK(effective_to IS NULL OR effective_to>=effective_from),
  CHECK(maximum_amount IS NULL OR minimum_amount IS NULL OR maximum_amount>=minimum_amount),
  CHECK(jsonb_typeof(parameters)='object'),
  CHECK(lower(parameters::text) !~ '("script"|"executable"|"eval"|"javascript"|"formula")'),
  CHECK(
    (calculation_method IN('fixed_amount','attendance_day','worked_hour','unpaid_day_deduction','fixed_one_time')
      AND amount IS NOT NULL AND percentage IS NULL)
    OR (calculation_method IN('percentage_base','percentage_gross')
      AND percentage IS NOT NULL AND amount IS NULL)
    OR (calculation_method='percentage_component' AND percentage IS NOT NULL
      AND amount IS NULL AND basis_component_id IS NOT NULL)
    OR calculation_method IN('manual_amount','statutory_rule','informational_overtime')
  )
);
ALTER TABLE public.payroll_component_calculation_rules
  ADD CONSTRAINT payroll_component_rules_no_overlap
  EXCLUDE USING gist(property_id WITH =,pay_component_id WITH =,
    daterange(effective_from,COALESCE(effective_to,'infinity'::date),'[]') WITH &&)
  WHERE(active);
CREATE INDEX payroll_component_rules_lookup_idx
  ON public.payroll_component_calculation_rules(property_id,pay_component_id,effective_from DESC);

INSERT INTO public.payroll_component_calculation_rules(
  property_id,pay_component_id,calculation_method,amount,percentage,parameters,
  effective_from,effective_to,active,created_by,updated_by
)
SELECT property_id,id,
  CASE
    WHEN calculation_method='fixed_amount' THEN 'fixed_amount'
    WHEN calculation_method='manual_input' THEN 'manual_amount'
    WHEN calculation_method='percentage' AND upper(COALESCE(percentage_basis_code,''))='BASE'
      THEN 'percentage_base'
    WHEN calculation_method='percentage' AND upper(COALESCE(percentage_basis_code,''))='GROSS'
      THEN 'percentage_gross'
    ELSE 'manual_amount'
  END,
  CASE WHEN calculation_method='fixed_amount' THEN default_amount END,
  CASE WHEN calculation_method='percentage' THEN default_percentage END,
  jsonb_build_object('migratedFromPhase4A',true,'basisCode',percentage_basis_code),
  effective_from,effective_to,active,created_by,updated_by
FROM public.payroll_pay_components
WHERE calculation_method IN('fixed_amount','manual_input')
   OR (calculation_method='percentage'
     AND upper(COALESCE(percentage_basis_code,'')) IN('BASE','GROSS'));

CREATE TABLE public.payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  calendar_period_id uuid NOT NULL,
  run_code text NOT NULL,
  run_type text NOT NULL DEFAULT 'regular'
    CHECK(run_type IN('regular','off_cycle','correction_draft')),
  calculation_engine_version text NOT NULL DEFAULT 'phase-4b-v1',
  status text NOT NULL DEFAULT 'draft'
    CHECK(status IN('draft','calculating','calculated','calculation_failed','locked_for_review','reopened','archived')),
  currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),
  payroll_settings_id uuid NOT NULL,
  current_calculation_version integer NOT NULL DEFAULT 0 CHECK(current_calculation_version>=0),
  calculation_started_at timestamptz, calculation_completed_at timestamptz,
  employee_count integer NOT NULL DEFAULT 0 CHECK(employee_count>=0),
  gross_total numeric(20,4) NOT NULL DEFAULT 0,
  deduction_total numeric(20,4) NOT NULL DEFAULT 0,
  net_total numeric(20,4) NOT NULL DEFAULT 0,
  employer_cost_total numeric(20,4) NOT NULL DEFAULT 0,
  warning_count integer NOT NULL DEFAULT 0 CHECK(warning_count>=0),
  error_count integer NOT NULL DEFAULT 0 CHECK(error_count>=0),
  review_locked_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  review_locked_at timestamptz, reopened_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reopened_at timestamptz, reopen_reason text,
  archived_at timestamptz, archived_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id), UNIQUE(property_id,run_code),
  FOREIGN KEY(property_id,calendar_period_id)
    REFERENCES public.payroll_calendar_periods(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,payroll_settings_id)
    REFERENCES public.payroll_settings(property_id,id) ON DELETE RESTRICT,
  CHECK((status='locked_for_review')=(review_locked_at IS NOT NULL)),
  CHECK(reopen_reason IS NULL OR char_length(trim(reopen_reason))>=5)
);
CREATE UNIQUE INDEX payroll_runs_active_period_uniq
  ON public.payroll_runs(property_id,calendar_period_id,run_type)
  WHERE archived_at IS NULL;
CREATE INDEX payroll_runs_status_idx
  ON public.payroll_runs(property_id,status,created_at DESC);

CREATE TABLE public.payroll_run_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL, payroll_run_id uuid NOT NULL,
  calculation_version integer NOT NULL CHECK(calculation_version>0),
  idempotency_key uuid NOT NULL,
  status text NOT NULL DEFAULT 'calculating'
    CHECK(status IN('calculating','calculated','failed','superseded')),
  calculation_engine_version text NOT NULL,
  payroll_settings_id uuid NOT NULL,
  statutory_rule_versions jsonb NOT NULL DEFAULT '[]',
  calculation_options jsonb NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  employee_count integer NOT NULL DEFAULT 0,
  gross_total numeric(20,4) NOT NULL DEFAULT 0,
  deduction_total numeric(20,4) NOT NULL DEFAULT 0,
  net_total numeric(20,4) NOT NULL DEFAULT 0,
  employer_cost_total numeric(20,4) NOT NULL DEFAULT 0,
  warning_count integer NOT NULL DEFAULT 0, error_count integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id), UNIQUE(property_id,payroll_run_id,calculation_version),
  UNIQUE(property_id,payroll_run_id,idempotency_key),
  FOREIGN KEY(property_id,payroll_run_id) REFERENCES public.payroll_runs(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,payroll_settings_id) REFERENCES public.payroll_settings(property_id,id) ON DELETE RESTRICT,
  CHECK(jsonb_typeof(statutory_rule_versions)='array'),
  CHECK(jsonb_typeof(calculation_options)='object')
);
CREATE INDEX payroll_run_versions_lookup_idx
  ON public.payroll_run_versions(property_id,payroll_run_id,calculation_version DESC);

CREATE TABLE public.payroll_run_employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL, payroll_run_id uuid NOT NULL, run_version_id uuid NOT NULL,
  employee_id uuid NOT NULL, compensation_id uuid,
  calculation_version integer NOT NULL CHECK(calculation_version>0),
  status text NOT NULL CHECK(status IN('pending','calculated','warning','blocked','failed','excluded')),
  exclusion_reason text, currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),
  base_salary numeric(20,4) NOT NULL, prorated_base_salary numeric(20,4) NOT NULL,
  gross_pay numeric(20,4) NOT NULL DEFAULT 0,
  employee_deductions numeric(20,4) NOT NULL DEFAULT 0,
  employer_contributions numeric(20,4) NOT NULL DEFAULT 0,
  net_pay numeric(20,4) NOT NULL DEFAULT 0,
  employer_cost numeric(20,4) NOT NULL DEFAULT 0,
  attendance_input_summary jsonb NOT NULL DEFAULT '{}',
  leave_input_summary jsonb NOT NULL DEFAULT '{}',
  calculation_trace jsonb NOT NULL DEFAULT '{}',
  source_references jsonb NOT NULL DEFAULT '[]',
  warning_count integer NOT NULL DEFAULT 0, error_count integer NOT NULL DEFAULT 0,
  calculated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  UNIQUE(property_id,payroll_run_id,calculation_version,employee_id),
  FOREIGN KEY(property_id,payroll_run_id) REFERENCES public.payroll_runs(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,run_version_id) REFERENCES public.payroll_run_versions(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,employee_id) REFERENCES public.hr_employees(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,compensation_id)
    REFERENCES public.payroll_employee_compensations(property_id,id) ON DELETE RESTRICT,
  CHECK(exclusion_reason IS NULL OR char_length(trim(exclusion_reason))>=5),
  CHECK(jsonb_typeof(attendance_input_summary)='object' AND jsonb_typeof(leave_input_summary)='object'),
  CHECK(jsonb_typeof(calculation_trace)='object' AND jsonb_typeof(source_references)='array')
);
CREATE INDEX payroll_run_employees_run_idx
  ON public.payroll_run_employees(property_id,payroll_run_id,calculation_version,status,employee_id);

CREATE TABLE public.payroll_run_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL, payroll_run_id uuid NOT NULL, run_version_id uuid NOT NULL,
  run_employee_id uuid NOT NULL, pay_component_id uuid, statutory_rule_id uuid,
  statutory_rule_version text,
  line_type text NOT NULL CHECK(line_type IN(
    'base_earning','earning','reimbursement','pre_tax_deduction','employee_statutory',
    'employer_statutory','tax','post_tax_deduction','informational'
  )),
  line_code text NOT NULL, line_name text NOT NULL,
  quantity numeric(20,8) NOT NULL DEFAULT 1, rate numeric(20,8) NOT NULL DEFAULT 0,
  unrounded_amount numeric(24,8) NOT NULL, rounded_amount numeric(20,4) NOT NULL,
  taxable_amount numeric(20,4) NOT NULL DEFAULT 0,
  contribution_basis numeric(20,4) NOT NULL DEFAULT 0,
  display_order integer NOT NULL DEFAULT 0,
  source_type text NOT NULL, source_identifier text NOT NULL,
  calculation_explanation jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  UNIQUE(property_id,run_employee_id,line_code,source_type,source_identifier),
  FOREIGN KEY(property_id,payroll_run_id) REFERENCES public.payroll_runs(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,run_version_id) REFERENCES public.payroll_run_versions(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,run_employee_id) REFERENCES public.payroll_run_employees(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,pay_component_id) REFERENCES public.payroll_pay_components(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,statutory_rule_id) REFERENCES public.payroll_statutory_rule_sets(property_id,id) ON DELETE RESTRICT,
  CHECK(pay_component_id IS NOT NULL OR statutory_rule_id IS NOT NULL OR line_type='base_earning'),
  CHECK(jsonb_typeof(calculation_explanation)='object')
);
CREATE INDEX payroll_line_items_employee_idx
  ON public.payroll_run_line_items(property_id,run_employee_id,display_order,line_code);

CREATE TABLE public.payroll_calculation_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL, payroll_run_id uuid NOT NULL, run_version_id uuid NOT NULL,
  run_employee_id uuid,
  calculation_version integer NOT NULL CHECK(calculation_version>0),
  severity text NOT NULL CHECK(severity IN('informational','warning','blocking')),
  finding_code text NOT NULL, message text NOT NULL,
  source_type text, source_identifier text, details jsonb NOT NULL DEFAULT '{}',
  acknowledged_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  acknowledged_at timestamptz, acknowledgement_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  FOREIGN KEY(property_id,payroll_run_id) REFERENCES public.payroll_runs(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,run_version_id) REFERENCES public.payroll_run_versions(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,run_employee_id) REFERENCES public.payroll_run_employees(property_id,id) ON DELETE RESTRICT,
  CHECK((acknowledged_at IS NULL AND acknowledged_by IS NULL AND acknowledgement_reason IS NULL)
    OR (acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL
      AND char_length(trim(acknowledgement_reason))>=5))
);
CREATE INDEX payroll_findings_run_idx
  ON public.payroll_calculation_findings(property_id,payroll_run_id,calculation_version,severity,acknowledged_at);

CREATE TABLE public.payroll_manual_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL, calendar_period_id uuid NOT NULL, employee_id uuid NOT NULL,
  pay_component_id uuid NOT NULL, amount numeric(20,4), quantity numeric(20,8),
  reason text NOT NULL CHECK(char_length(trim(reason))>=5),
  source_reference text NOT NULL CHECK(char_length(trim(source_reference))>=2),
  effective_date date NOT NULL,
  approval_status text NOT NULL DEFAULT 'draft' CHECK(approval_status IN('draft','reviewed','rejected')),
  supersedes_id uuid, archived_at timestamptz, archived_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  FOREIGN KEY(property_id,calendar_period_id)
    REFERENCES public.payroll_calendar_periods(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,employee_id) REFERENCES public.hr_employees(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,pay_component_id) REFERENCES public.payroll_pay_components(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,supersedes_id) REFERENCES public.payroll_manual_inputs(property_id,id) ON DELETE RESTRICT,
  CHECK((amount IS NOT NULL)::integer+(quantity IS NOT NULL)::integer=1)
);
CREATE UNIQUE INDEX payroll_manual_inputs_active_uniq
  ON public.payroll_manual_inputs(property_id,calendar_period_id,employee_id,pay_component_id)
  WHERE archived_at IS NULL;
CREATE INDEX payroll_manual_inputs_period_idx
  ON public.payroll_manual_inputs(property_id,calendar_period_id,effective_date,employee_id);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'payroll_component_calculation_rules',
    'payroll_runs','payroll_run_versions','payroll_run_employees','payroll_run_line_items',
    'payroll_calculation_findings','payroll_manual_inputs'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
  END LOOP;
END $$;

CREATE POLICY payroll_component_rules_read ON public.payroll_component_calculation_rules FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'pay_components','read'));
CREATE POLICY payroll_component_rules_manage ON public.payroll_component_calculation_rules FOR ALL TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'pay_components','manage'))
  WITH CHECK(public.has_hrm_permission(auth.uid(),property_id,'pay_components','manage'));
CREATE POLICY payroll_runs_read ON public.payroll_runs FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payroll_runs','read'));
CREATE POLICY payroll_versions_read ON public.payroll_run_versions FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payroll_runs','read'));
CREATE POLICY payroll_run_employees_read ON public.payroll_run_employees FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payroll_employee_results','read'));
CREATE POLICY payroll_lines_read ON public.payroll_run_line_items FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payroll_calculation_details','read'));
CREATE POLICY payroll_findings_read ON public.payroll_calculation_findings FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payroll_validations','read'));
CREATE POLICY payroll_manual_inputs_read ON public.payroll_manual_inputs FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payroll_manual_inputs','read'));

GRANT SELECT ON
  public.payroll_runs,public.payroll_run_versions,public.payroll_run_employees,
  public.payroll_run_line_items,public.payroll_calculation_findings,public.payroll_manual_inputs
  TO authenticated;
GRANT SELECT,INSERT,UPDATE ON public.payroll_component_calculation_rules TO authenticated;
GRANT ALL ON
  public.payroll_component_calculation_rules,
  public.payroll_runs,public.payroll_run_versions,public.payroll_run_employees,
  public.payroll_run_line_items,public.payroll_calculation_findings,public.payroll_manual_inputs
  TO service_role;

CREATE OR REPLACE FUNCTION public.payroll_create_draft_run(
  _property_id uuid,_calendar_period_id uuid,_run_type text,_idempotency_key uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE period_row public.payroll_calendar_periods%ROWTYPE;
  settings_row public.payroll_settings%ROWTYPE; existing_id uuid; new_id uuid; code_value text;
BEGIN
  IF NOT public.has_hrm_permission(auth.uid(),_property_id,'payroll_runs','create')
    THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT * INTO period_row FROM public.payroll_calendar_periods
  WHERE property_id=_property_id AND id=_calendar_period_id AND status IN('planned','open');
  IF period_row.id IS NULL THEN RAISE EXCEPTION 'Eligible payroll calendar period not found'; END IF;
  SELECT * INTO settings_row FROM public.payroll_settings
  WHERE property_id=_property_id AND effective_from<=period_row.end_date
    AND COALESCE(effective_to,'infinity'::date)>=period_row.start_date
  ORDER BY effective_from DESC LIMIT 1;
  IF settings_row.id IS NULL OR NOT settings_row.payroll_enabled
    THEN RAISE EXCEPTION 'Effective payroll settings are unavailable or disabled'; END IF;
  SELECT id INTO existing_id FROM public.payroll_runs
  WHERE property_id=_property_id AND calendar_period_id=_calendar_period_id
    AND run_type=_run_type AND archived_at IS NULL;
  IF existing_id IS NOT NULL THEN RETURN existing_id; END IF;
  code_value:='DRAFT-'||period_row.payroll_year||'-'||lpad(period_row.period_number::text,2,'0')
    ||'-'||upper(substr(replace(_idempotency_key::text,'-',''),1,6));
  INSERT INTO public.payroll_runs(
    property_id,calendar_period_id,run_code,run_type,currency,payroll_settings_id,created_by,updated_by
  ) VALUES(
    _property_id,_calendar_period_id,code_value,_run_type,settings_row.currency,settings_row.id,auth.uid(),auth.uid()
  ) RETURNING id INTO new_id;
  PERFORM public.audit_capture(_property_id,'payroll_run',new_id::text,'create',NULL,
    jsonb_build_object('status','draft','calendarPeriodId',_calendar_period_id),
    'Created draft payroll run',NULL,NULL,NULL,NULL,NULL,NULL,true,NULL);
  RETURN new_id;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_begin_calculation(
  _property_id uuid,_run_id uuid,_idempotency_key uuid,_selected_employee_ids uuid[] DEFAULT NULL
) RETURNS TABLE(run_version_id uuid,calculation_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE run_row public.payroll_runs%ROWTYPE; existing public.payroll_run_versions%ROWTYPE;
  new_version integer; new_version_id uuid; required_action text;
BEGIN
  SELECT * INTO run_row FROM public.payroll_runs
  WHERE property_id=_property_id AND id=_run_id FOR UPDATE;
  IF run_row.id IS NULL THEN RAISE EXCEPTION 'Payroll run not found'; END IF;
  required_action:=CASE WHEN run_row.current_calculation_version=0 THEN 'create' ELSE 'manage' END;
  IF NOT public.has_hrm_permission(auth.uid(),_property_id,
      CASE WHEN required_action='create' THEN 'payroll_run_calculate' ELSE 'payroll_run_recalculate' END,
      required_action)
    THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT * INTO existing FROM public.payroll_run_versions
  WHERE property_id=_property_id AND payroll_run_id=_run_id AND idempotency_key=_idempotency_key;
  IF existing.id IS NOT NULL THEN
    RETURN QUERY SELECT existing.id,existing.calculation_version; RETURN;
  END IF;
  IF run_row.status IN('calculating','locked_for_review','archived')
    THEN RAISE EXCEPTION 'Payroll run cannot be calculated in its current state'; END IF;
  new_version:=run_row.current_calculation_version+1;
  INSERT INTO public.payroll_run_versions(
    property_id,payroll_run_id,calculation_version,idempotency_key,status,
    calculation_engine_version,payroll_settings_id,calculation_options,created_by
  ) VALUES(
    _property_id,_run_id,new_version,_idempotency_key,'calculating',
    run_row.calculation_engine_version,run_row.payroll_settings_id,
    jsonb_build_object('selectedEmployeeIds',COALESCE(to_jsonb(_selected_employee_ids),'null'::jsonb)),
    auth.uid()
  ) RETURNING id INTO new_version_id;
  UPDATE public.payroll_runs SET status='calculating',current_calculation_version=new_version,
    calculation_started_at=now(),calculation_completed_at=NULL,updated_by=auth.uid()
  WHERE id=_run_id;
  RETURN QUERY SELECT new_version_id,new_version;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_store_calculation_results(
  _property_id uuid,_run_id uuid,_run_version_id uuid,_results jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE run_row public.payroll_runs%ROWTYPE; version_row public.payroll_run_versions%ROWTYPE;
  employee_json jsonb; line_json jsonb; finding_json jsonb; employee_result_id uuid;
  computed_gross numeric; computed_deductions numeric; computed_employer numeric;
  total_employees integer; total_gross numeric; total_deductions numeric;
  total_net numeric; total_employer_cost numeric; warning_total integer; error_total integer;
BEGIN
  IF jsonb_typeof(_results)<>'array' THEN RAISE EXCEPTION 'Calculation results must be an array'; END IF;
  SELECT * INTO run_row FROM public.payroll_runs
  WHERE property_id=_property_id AND id=_run_id FOR UPDATE;
  SELECT * INTO version_row FROM public.payroll_run_versions
  WHERE property_id=_property_id AND id=_run_version_id AND payroll_run_id=_run_id FOR UPDATE;
  IF version_row.status='calculated' THEN
    RETURN jsonb_build_object('version',version_row.calculation_version,'idempotent',true);
  END IF;
  IF run_row.status<>'calculating' OR version_row.status<>'calculating'
    OR run_row.current_calculation_version<>version_row.calculation_version
    THEN RAISE EXCEPTION 'Calculation lease is no longer active'; END IF;
  IF NOT (
    public.has_hrm_permission(auth.uid(),_property_id,'payroll_run_calculate','create')
    OR public.has_hrm_permission(auth.uid(),_property_id,'payroll_run_recalculate','manage')
  ) THEN RAISE EXCEPTION 'Not authorized'; END IF;

  FOR employee_json IN SELECT value FROM jsonb_array_elements(_results) LOOP
    IF (employee_json->>'propertyId')::uuid<>_property_id
      THEN RAISE EXCEPTION 'Cross-property calculation result rejected'; END IF;
    SELECT COALESCE(sum((item->>'roundedAmount')::numeric),0) INTO computed_gross
    FROM jsonb_array_elements(employee_json->'lines') item
    WHERE item->>'lineType' IN('base_earning','earning');
    SELECT COALESCE(sum((item->>'roundedAmount')::numeric),0) INTO computed_deductions
    FROM jsonb_array_elements(employee_json->'lines') item
    WHERE item->>'lineType' IN('pre_tax_deduction','employee_statutory','tax','post_tax_deduction');
    SELECT COALESCE(sum((item->>'roundedAmount')::numeric),0) INTO computed_employer
    FROM jsonb_array_elements(employee_json->'lines') item
    WHERE item->>'lineType'='employer_statutory';
    IF computed_gross<>(employee_json#>>'{totals,gross}')::numeric
      OR computed_deductions<>(employee_json#>>'{totals,deductions}')::numeric
      OR computed_employer<>(employee_json#>>'{totals,employerContributions}')::numeric
      THEN RAISE EXCEPTION 'Employee line-item totals are inconsistent'; END IF;
    IF (employee_json#>>'{totals,net}')::numeric<>
      computed_gross+COALESCE((SELECT sum((item->>'roundedAmount')::numeric)
        FROM jsonb_array_elements(employee_json->'lines') item
        WHERE item->>'lineType'='reimbursement'),0)-computed_deductions
      THEN RAISE EXCEPTION 'Employee net-pay total is inconsistent'; END IF;

    INSERT INTO public.payroll_run_employees(
      property_id,payroll_run_id,run_version_id,employee_id,compensation_id,calculation_version,
      status,currency,base_salary,prorated_base_salary,gross_pay,employee_deductions,
      employer_contributions,net_pay,employer_cost,attendance_input_summary,leave_input_summary,
      calculation_trace,source_references,warning_count,error_count,calculated_at
    ) VALUES(
      _property_id,_run_id,_run_version_id,(employee_json->>'employeeId')::uuid,
      NULLIF(employee_json->>'compensationId','')::uuid,version_row.calculation_version,
      employee_json->>'status',employee_json->>'currency',
      (employee_json->>'baseSalary')::numeric,(employee_json#>>'{totals,base}')::numeric,
      computed_gross,computed_deductions,computed_employer,
      (employee_json#>>'{totals,net}')::numeric,(employee_json#>>'{totals,employerCost}')::numeric,
      COALESCE(employee_json->'attendance','{}'),COALESCE(employee_json->'leave','{}'),
      COALESCE(employee_json->'trace','{}'),COALESCE(employee_json->'sourceReferences','[]'),
      (SELECT count(*) FROM jsonb_array_elements(COALESCE(employee_json->'findings','[]')) f
        WHERE f->>'severity'='warning'),
      (SELECT count(*) FROM jsonb_array_elements(COALESCE(employee_json->'findings','[]')) f
        WHERE f->>'severity'='blocking'),now()
    ) RETURNING id INTO employee_result_id;
    FOR line_json IN SELECT value FROM jsonb_array_elements(employee_json->'lines') LOOP
      INSERT INTO public.payroll_run_line_items(
        property_id,payroll_run_id,run_version_id,run_employee_id,pay_component_id,statutory_rule_id,
        statutory_rule_version,line_type,line_code,line_name,quantity,rate,unrounded_amount,
        rounded_amount,taxable_amount,contribution_basis,display_order,source_type,
        source_identifier,calculation_explanation
      ) VALUES(
        _property_id,_run_id,_run_version_id,employee_result_id,
        NULLIF(line_json->>'componentId','')::uuid,NULLIF(line_json->>'statutoryRuleId','')::uuid,
        line_json->>'statutoryRuleVersion',line_json->>'lineType',line_json->>'code',
        line_json->>'name',(line_json->>'quantity')::numeric,(line_json->>'rate')::numeric,
        (line_json->>'unroundedAmount')::numeric,(line_json->>'roundedAmount')::numeric,
        (line_json->>'taxableAmount')::numeric,(line_json->>'contributionBasis')::numeric,
        (line_json->>'displayOrder')::integer,line_json->>'sourceType',line_json->>'sourceId',
        COALESCE(line_json->'explanation','{}')
      );
    END LOOP;
    FOR finding_json IN SELECT value FROM jsonb_array_elements(COALESCE(employee_json->'findings','[]')) LOOP
      INSERT INTO public.payroll_calculation_findings(
        property_id,payroll_run_id,run_version_id,run_employee_id,calculation_version,severity,
        finding_code,message,source_type,source_identifier,details
      ) VALUES(
        _property_id,_run_id,_run_version_id,employee_result_id,version_row.calculation_version,
        finding_json->>'severity',finding_json->>'code',finding_json->>'message',
        finding_json->>'sourceType',finding_json->>'sourceId',COALESCE(finding_json->'details','{}')
      );
    END LOOP;
  END LOOP;

  SELECT count(*),COALESCE(sum(gross_pay),0),COALESCE(sum(employee_deductions),0),
    COALESCE(sum(net_pay),0),COALESCE(sum(employer_cost),0)
  INTO total_employees,total_gross,total_deductions,total_net,total_employer_cost
  FROM public.payroll_run_employees
  WHERE property_id=_property_id AND run_version_id=_run_version_id;
  SELECT count(*) FILTER(WHERE severity='warning'),
    count(*) FILTER(WHERE severity='blocking') INTO warning_total,error_total
  FROM public.payroll_calculation_findings WHERE property_id=_property_id AND run_version_id=_run_version_id;
  UPDATE public.payroll_run_versions SET status='calculated',completed_at=now(),
    statutory_rule_versions=COALESCE((
      SELECT jsonb_agg(DISTINCT jsonb_build_object(
        'id',line->>'statutoryRuleId','version',line->>'statutoryRuleVersion'))
      FROM jsonb_array_elements(_results) employee
      CROSS JOIN jsonb_array_elements(employee->'lines') line
      WHERE NULLIF(line->>'statutoryRuleId','') IS NOT NULL
    ),'[]'::jsonb),
    employee_count=total_employees,gross_total=total_gross,
    deduction_total=total_deductions,net_total=total_net,
    employer_cost_total=total_employer_cost,warning_count=warning_total,error_count=error_total
  WHERE id=_run_version_id;
  UPDATE public.payroll_run_versions SET status='superseded'
  WHERE property_id=_property_id AND payroll_run_id=_run_id AND id<>_run_version_id AND status='calculated';
  UPDATE public.payroll_runs SET status='calculated',calculation_completed_at=now(),
    employee_count=total_employees,gross_total=total_gross,
    deduction_total=total_deductions,net_total=total_net,
    employer_cost_total=total_employer_cost,warning_count=warning_total,error_count=error_total,
    updated_by=auth.uid()
  WHERE id=_run_id;
  PERFORM public.audit_capture(_property_id,'payroll_run',_run_id::text,'calculate',NULL,
    jsonb_build_object('calculationVersion',version_row.calculation_version,
      'employeeCount',total_employees,'warningCount',warning_total,'errorCount',error_total),
    'Calculated draft payroll run',NULL,NULL,NULL,NULL,NULL,NULL,true,NULL);
  RETURN jsonb_build_object('version',version_row.calculation_version,'employeeCount',total_employees,
    'warningCount',warning_total,'errorCount',error_total,'idempotent',false);
END $$;

CREATE OR REPLACE FUNCTION public.payroll_fail_calculation(
  _property_id uuid,_run_id uuid,_run_version_id uuid,_message text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE version_row public.payroll_run_versions%ROWTYPE;
BEGIN
  SELECT * INTO version_row FROM public.payroll_run_versions
  WHERE property_id=_property_id AND id=_run_version_id AND payroll_run_id=_run_id FOR UPDATE;
  IF version_row.id IS NULL OR version_row.status<>'calculating' THEN RETURN; END IF;
  IF NOT (
    public.has_hrm_permission(auth.uid(),_property_id,'payroll_run_calculate','create')
    OR public.has_hrm_permission(auth.uid(),_property_id,'payroll_run_recalculate','manage')
  ) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  UPDATE public.payroll_run_versions SET status='failed',completed_at=now(),
    calculation_options=calculation_options||jsonb_build_object('failure',left(COALESCE(_message,'Calculation failed'),500))
  WHERE id=_run_version_id;
  UPDATE public.payroll_runs SET status='calculation_failed',calculation_completed_at=now(),
    updated_by=auth.uid() WHERE property_id=_property_id AND id=_run_id
    AND current_calculation_version=version_row.calculation_version;
  PERFORM public.audit_capture(_property_id,'payroll_run',_run_id::text,'calculate_failed',NULL,
    jsonb_build_object('calculationVersion',version_row.calculation_version,
      'message',left(COALESCE(_message,'Calculation failed'),500)),
    'Draft payroll calculation failed',NULL,NULL,NULL,NULL,NULL,NULL,true,NULL);
END $$;

CREATE OR REPLACE FUNCTION public.payroll_transition_review(
  _property_id uuid,_run_id uuid,_action text,_reason text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE run_row public.payroll_runs%ROWTYPE; blocking_count integer; warning_count integer;
BEGIN
  SELECT * INTO run_row FROM public.payroll_runs
  WHERE property_id=_property_id AND id=_run_id FOR UPDATE;
  IF run_row.id IS NULL THEN RAISE EXCEPTION 'Payroll run not found'; END IF;
  IF _action='lock' THEN
    IF NOT public.has_hrm_permission(auth.uid(),_property_id,'payroll_run_lock','approve')
      THEN RAISE EXCEPTION 'Not authorized'; END IF;
    IF run_row.status<>'calculated' THEN RAISE EXCEPTION 'Only calculated runs can be locked'; END IF;
    SELECT count(*) FILTER(WHERE severity='blocking'),
      count(*) FILTER(WHERE severity='warning' AND acknowledged_at IS NULL)
    INTO blocking_count,warning_count FROM public.payroll_calculation_findings
    WHERE property_id=_property_id AND payroll_run_id=_run_id
      AND calculation_version=run_row.current_calculation_version;
    IF blocking_count>0 THEN RAISE EXCEPTION 'Blocking payroll validations prevent review lock'; END IF;
    IF warning_count>0 THEN RAISE EXCEPTION 'Unacknowledged payroll warnings prevent review lock'; END IF;
    UPDATE public.payroll_runs SET status='locked_for_review',review_locked_by=auth.uid(),
      review_locked_at=now(),updated_by=auth.uid() WHERE id=_run_id;
  ELSIF _action='reopen' THEN
    IF NOT public.has_hrm_permission(auth.uid(),_property_id,'payroll_run_reopen','manage')
      THEN RAISE EXCEPTION 'Not authorized'; END IF;
    IF run_row.status<>'locked_for_review' OR char_length(trim(COALESCE(_reason,'')))<5
      THEN RAISE EXCEPTION 'Locked run and reopen reason required'; END IF;
    UPDATE public.payroll_runs SET status='reopened',review_locked_by=NULL,review_locked_at=NULL,
      reopened_by=auth.uid(),reopened_at=now(),reopen_reason=trim(_reason),updated_by=auth.uid()
    WHERE id=_run_id;
  ELSIF _action='archive' THEN
    IF NOT public.has_hrm_permission(auth.uid(),_property_id,'payroll_run_archive','delete')
      THEN RAISE EXCEPTION 'Not authorized'; END IF;
    IF run_row.status NOT IN('draft','calculation_failed','reopened')
      THEN RAISE EXCEPTION 'Only abandoned draft runs can be archived'; END IF;
    UPDATE public.payroll_runs SET status='archived',archived_at=now(),archived_by=auth.uid(),
      updated_by=auth.uid() WHERE id=_run_id;
  ELSE RAISE EXCEPTION 'Unsupported review transition'; END IF;
  PERFORM public.audit_capture(_property_id,'payroll_run',_run_id::text,_action,
    jsonb_build_object('status',run_row.status),
    jsonb_build_object('action',_action,'reason',NULLIF(trim(COALESCE(_reason,'')),'')),
    'Draft payroll review transition',NULL,NULL,NULL,NULL,NULL,NULL,true,NULL);
END $$;

CREATE OR REPLACE FUNCTION public.payroll_acknowledge_warning(
  _property_id uuid,_finding_id uuid,_reason text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE finding_row public.payroll_calculation_findings%ROWTYPE;
BEGIN
  IF NOT public.has_hrm_permission(auth.uid(),_property_id,'payroll_warnings','approve')
    THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF char_length(trim(COALESCE(_reason,'')))<5 THEN RAISE EXCEPTION 'Acknowledgement reason required'; END IF;
  SELECT * INTO finding_row FROM public.payroll_calculation_findings
  WHERE property_id=_property_id AND id=_finding_id FOR UPDATE;
  IF finding_row.id IS NULL OR finding_row.severity<>'warning'
    THEN RAISE EXCEPTION 'Acknowledgable warning not found'; END IF;
  UPDATE public.payroll_calculation_findings SET acknowledged_by=auth.uid(),
    acknowledged_at=now(),acknowledgement_reason=trim(_reason) WHERE id=_finding_id;
  PERFORM public.audit_capture(_property_id,'payroll_warning',_finding_id::text,'approve',NULL,
    jsonb_build_object('reason',trim(_reason)),'Acknowledged draft payroll warning',
    NULL,NULL,NULL,NULL,NULL,NULL,true,NULL);
END $$;

CREATE OR REPLACE FUNCTION public.payroll_save_manual_input(
  _property_id uuid,_calendar_period_id uuid,_employee_id uuid,_component_id uuid,
  _amount numeric,_quantity numeric,_reason text,_source_reference text,_effective_date date,
  _supersedes_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE new_id uuid; component_row public.payroll_pay_components%ROWTYPE;
  period_row public.payroll_calendar_periods%ROWTYPE; rule_method text; rule_amount numeric;
BEGIN
  IF NOT public.has_hrm_permission(auth.uid(),_property_id,'payroll_manual_inputs','manage')
    THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF char_length(trim(COALESCE(_reason,'')))<5 OR char_length(trim(COALESCE(_source_reference,'')))<2
    THEN RAISE EXCEPTION 'Manual input reason and source reference required'; END IF;
  IF ((_amount IS NOT NULL)::integer+(_quantity IS NOT NULL)::integer)<>1
    THEN RAISE EXCEPTION 'Provide either amount or quantity'; END IF;
  IF COALESCE(_amount,_quantity)<=0 THEN RAISE EXCEPTION 'Manual input must be greater than zero'; END IF;
  SELECT * INTO period_row FROM public.payroll_calendar_periods
  WHERE property_id=_property_id AND id=_calendar_period_id;
  IF period_row.id IS NULL OR _effective_date<period_row.start_date OR _effective_date>period_row.end_date
    THEN RAISE EXCEPTION 'Manual input date must be within the selected payroll period'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.hr_employees WHERE property_id=_property_id AND id=_employee_id
  ) THEN RAISE EXCEPTION 'Employee not found for property'; END IF;
  SELECT * INTO component_row FROM public.payroll_pay_components
  WHERE property_id=_property_id AND id=_component_id AND active AND archived_at IS NULL;
  SELECT calculation_method,amount INTO rule_method,rule_amount
  FROM public.payroll_component_calculation_rules
  WHERE property_id=_property_id AND pay_component_id=_component_id AND active
    AND effective_from<=_effective_date AND COALESCE(effective_to,'infinity'::date)>=_effective_date
  ORDER BY effective_from DESC LIMIT 1;
  IF component_row.id IS NULL OR rule_method NOT IN(
      'fixed_amount','manual_amount','attendance_day','worked_hour','fixed_one_time'
    )
    THEN RAISE EXCEPTION 'Manual input component is invalid'; END IF;
  IF _quantity IS NOT NULL AND rule_amount IS NULL
    THEN RAISE EXCEPTION 'Quantity input requires a configured component rate'; END IF;
  IF _supersedes_id IS NOT NULL THEN
    UPDATE public.payroll_manual_inputs SET archived_at=now(),archived_by=auth.uid(),updated_by=auth.uid()
    WHERE property_id=_property_id AND id=_supersedes_id AND archived_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Manual input to supersede not found'; END IF;
  END IF;
  INSERT INTO public.payroll_manual_inputs(
    property_id,calendar_period_id,employee_id,pay_component_id,amount,quantity,reason,
    source_reference,effective_date,supersedes_id,created_by,updated_by
  ) VALUES(
    _property_id,_calendar_period_id,_employee_id,_component_id,_amount,_quantity,trim(_reason),
    trim(_source_reference),_effective_date,_supersedes_id,auth.uid(),auth.uid()
  ) RETURNING id INTO new_id;
  PERFORM public.audit_capture(_property_id,'payroll_manual_input',new_id::text,'create',NULL,
    jsonb_build_object('employeeId',_employee_id,'componentId',_component_id,
      'reason',trim(_reason),'sourceReference',trim(_source_reference),'supersedesId',_supersedes_id),
    'Saved draft manual payroll input',NULL,NULL,NULL,NULL,NULL,NULL,true,NULL);
  RETURN new_id;
END $$;

REVOKE ALL ON FUNCTION public.payroll_create_draft_run(uuid,uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_begin_calculation(uuid,uuid,uuid,uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_store_calculation_results(uuid,uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_fail_calculation(uuid,uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_transition_review(uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_acknowledge_warning(uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_save_manual_input(uuid,uuid,uuid,uuid,numeric,numeric,text,text,date,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_create_draft_run(uuid,uuid,text,uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.payroll_begin_calculation(uuid,uuid,uuid,uuid[]) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.payroll_store_calculation_results(uuid,uuid,uuid,jsonb) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.payroll_fail_calculation(uuid,uuid,uuid,text) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.payroll_transition_review(uuid,uuid,text,text) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.payroll_acknowledge_warning(uuid,uuid,text) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.payroll_save_manual_input(uuid,uuid,uuid,uuid,numeric,numeric,text,text,date,uuid)
  TO authenticated,service_role;

CREATE TRIGGER trg_payroll_runs_updated BEFORE UPDATE ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER trg_payroll_run_employees_updated BEFORE UPDATE ON public.payroll_run_employees
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER trg_payroll_manual_inputs_updated BEFORE UPDATE ON public.payroll_manual_inputs
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER trg_payroll_component_rules_updated
  BEFORE UPDATE ON public.payroll_component_calculation_rules
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE OR REPLACE FUNCTION public.payroll_close_prior_component_rule()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  UPDATE public.payroll_component_calculation_rules
  SET effective_to=NEW.effective_from-1,updated_by=NEW.created_by
  WHERE property_id=NEW.property_id AND pay_component_id=NEW.pay_component_id
    AND active AND effective_from<NEW.effective_from
    AND COALESCE(effective_to,'infinity'::date)>=NEW.effective_from;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payroll_component_rules_close_prior
  BEFORE INSERT ON public.payroll_component_calculation_rules
  FOR EACH ROW EXECUTE FUNCTION public.payroll_close_prior_component_rule();

CREATE OR REPLACE FUNCTION public.seed_payroll_run_permissions(_property_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  INSERT INTO public.role_permissions(property_id,role,module,action,allowed)
  SELECT _property_id,r::public.app_role,m,a,true FROM (VALUES
    ('payroll_runs','read'),('payroll_runs','create'),
    ('payroll_run_calculate','create'),('payroll_run_recalculate','manage'),
    ('payroll_run_lock','approve'),('payroll_run_reopen','manage'),('payroll_run_archive','delete'),
    ('payroll_employee_results','read'),('payroll_calculation_details','read'),
    ('payroll_manual_inputs','read'),('payroll_manual_inputs','manage'),
    ('payroll_validations','read'),('payroll_warnings','approve'),
    ('payroll_draft_reports','export'),('payroll_draft_reports','print')
  ) p(m,a) CROSS JOIN (VALUES('super_admin'),('hotel_owner'),('hr')) roles(r)
  ON CONFLICT DO NOTHING;
END $$;
SELECT public.seed_payroll_run_permissions(id) FROM public.properties;
REVOKE ALL ON FUNCTION public.seed_payroll_run_permissions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_payroll_run_permissions(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.seed_payroll_run_permissions_for_property()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN PERFORM public.seed_payroll_run_permissions(NEW.id); RETURN NEW; END $$;
CREATE TRIGGER properties_seed_payroll_run_permissions
AFTER INSERT ON public.properties FOR EACH ROW
EXECUTE FUNCTION public.seed_payroll_run_permissions_for_property();

COMMENT ON TABLE public.payroll_runs IS
  'Phase 4B draft calculation records only; not approved, finalized, paid, posted, or submitted.';
COMMENT ON TABLE public.payroll_run_line_items IS
  'Traceable calculation outputs only; contains no executable expressions.';
