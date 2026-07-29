-- Phase 4A: payroll configuration and compensation foundations only.
-- No payroll calculations, runs, payslips, payment files, journals, or statutory submissions.

CREATE TABLE public.payroll_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  effective_from date NOT NULL,
  effective_to date,
  payroll_enabled boolean NOT NULL DEFAULT false,
  display_name text NOT NULL DEFAULT 'Payroll',
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  jurisdiction_code text NOT NULL CHECK(jurisdiction_code ~ '^[A-Z0-9-]{2,12}$'),
  default_pay_frequency_id uuid,
  timezone text NOT NULL,
  rounding_method text NOT NULL DEFAULT 'half_up'
    CHECK(rounding_method IN('half_up','half_even','down','up')),
  monetary_precision smallint NOT NULL DEFAULT 2 CHECK(monetary_precision BETWEEN 0 AND 4),
  default_payment_method text NOT NULL DEFAULT 'bank_transfer'
    CHECK(default_payment_method IN('bank_transfer','mobile_money','cash','cheque','other')),
  salary_proration_method text NOT NULL DEFAULT 'working_days'
    CHECK(salary_proration_method IN('working_days','calendar_days','fixed_days','none')),
  unpaid_day_method text NOT NULL DEFAULT 'working_days'
    CHECK(unpaid_day_method IN('working_days','calendar_days','fixed_days','none')),
  working_days_basis smallint NOT NULL DEFAULT 260 CHECK(working_days_basis BETWEEN 1 AND 366),
  calendar_days_basis smallint NOT NULL DEFAULT 365 CHECK(calendar_days_basis BETWEEN 1 AND 366),
  approval_required boolean NOT NULL DEFAULT true,
  finalization_requires_approval boolean NOT NULL DEFAULT true,
  allow_negative_net_pay boolean NOT NULL DEFAULT false,
  allow_retroactive_adjustments boolean NOT NULL DEFAULT true,
  require_employee_bank_details boolean NOT NULL DEFAULT false,
  payslip_visibility_placeholder text NOT NULL DEFAULT 'after_finalization'
    CHECK(payslip_visibility_placeholder IN('after_finalization','manual_release','disabled')),
  payroll_year_start_month smallint NOT NULL DEFAULT 1 CHECK(payroll_year_start_month BETWEEN 1 AND 12),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  CHECK(effective_to IS NULL OR effective_to>=effective_from),
  CHECK(NOT payroll_enabled OR approval_required OR NOT finalization_requires_approval)
);

CREATE TABLE public.payroll_pay_frequencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  name text NOT NULL, code text NOT NULL, frequency_type text NOT NULL,
  periods_per_year smallint NOT NULL CHECK(periods_per_year BETWEEN 1 AND 366),
  interval_definition jsonb NOT NULL DEFAULT '{}',
  first_period_start date NOT NULL,
  cutoff_rule jsonb NOT NULL DEFAULT '{}',
  payment_day_rule jsonb NOT NULL DEFAULT '{}',
  weekend_adjustment text NOT NULL DEFAULT 'previous_working_day'
    CHECK(weekend_adjustment IN('none','previous_working_day','next_working_day')),
  holiday_adjustment text NOT NULL DEFAULT 'previous_working_day'
    CHECK(holiday_adjustment IN('none','previous_working_day','next_working_day')),
  continuous_periods boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz, archived_by uuid REFERENCES public.profiles(id),
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  updated_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id), UNIQUE(property_id,code),
  CHECK(jsonb_typeof(interval_definition)='object'),
  CHECK(jsonb_typeof(cutoff_rule)='object'),
  CHECK(jsonb_typeof(payment_day_rule)='object')
);
CREATE UNIQUE INDEX payroll_pay_frequencies_code_ci_uniq
  ON public.payroll_pay_frequencies(property_id,lower(code));

ALTER TABLE public.payroll_settings ADD CONSTRAINT payroll_settings_default_frequency_fk
  FOREIGN KEY(property_id,default_pay_frequency_id)
  REFERENCES public.payroll_pay_frequencies(property_id,id) ON DELETE RESTRICT;
ALTER TABLE public.payroll_settings ADD CONSTRAINT payroll_settings_no_overlap
  EXCLUDE USING gist(property_id WITH =,daterange(effective_from,COALESCE(effective_to,'infinity'::date),'[]') WITH &&);

CREATE TABLE public.payroll_calendar_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL,
  pay_frequency_id uuid NOT NULL, payroll_year integer NOT NULL CHECK(payroll_year BETWEEN 1900 AND 2200),
  period_number smallint NOT NULL CHECK(period_number>0), period_label text NOT NULL,
  start_date date NOT NULL, end_date date NOT NULL, cutoff_date date NOT NULL,
  expected_payment_date date NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK(status IN('planned','open','locked','archived')),
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id), UNIQUE(property_id,pay_frequency_id,payroll_year,period_number),
  FOREIGN KEY(property_id,pay_frequency_id)
    REFERENCES public.payroll_pay_frequencies(property_id,id) ON DELETE RESTRICT,
  CHECK(end_date>=start_date), CHECK(cutoff_date<=expected_payment_date)
);
ALTER TABLE public.payroll_calendar_periods ADD CONSTRAINT payroll_calendar_periods_no_overlap
  EXCLUDE USING gist(property_id WITH =,pay_frequency_id WITH =,daterange(start_date,end_date,'[]') WITH &&)
  WHERE(status<>'archived');
CREATE INDEX payroll_calendar_periods_lookup_idx
  ON public.payroll_calendar_periods(property_id,pay_frequency_id,payroll_year,status,start_date);

CREATE TABLE public.payroll_salary_structures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL,
  name text NOT NULL, code text NOT NULL, description text, currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),
  pay_frequency_id uuid NOT NULL, effective_from date NOT NULL, effective_to date,
  active boolean NOT NULL DEFAULT true, archived_at timestamptz, archived_by uuid REFERENCES public.profiles(id),
  created_by uuid NOT NULL REFERENCES public.profiles(id), updated_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id), UNIQUE(property_id,code,effective_from),
  FOREIGN KEY(property_id,pay_frequency_id)
    REFERENCES public.payroll_pay_frequencies(property_id,id) ON DELETE RESTRICT,
  CHECK(effective_to IS NULL OR effective_to>=effective_from)
);
ALTER TABLE public.payroll_salary_structures ADD CONSTRAINT payroll_salary_structures_no_overlap
  EXCLUDE USING gist(property_id WITH =,code WITH =,
    daterange(effective_from,COALESCE(effective_to,'infinity'::date),'[]') WITH &&)
  WHERE(active AND archived_at IS NULL);

CREATE TABLE public.payroll_salary_grades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL,
  salary_structure_id uuid NOT NULL, name text NOT NULL, code text NOT NULL,
  rank_order integer NOT NULL DEFAULT 0, minimum_base_salary numeric(18,4) NOT NULL,
  midpoint_salary numeric(18,4), maximum_base_salary numeric(18,4) NOT NULL,
  step_progression jsonb NOT NULL DEFAULT '{}', effective_from date NOT NULL, effective_to date,
  active boolean NOT NULL DEFAULT true, archived_at timestamptz, archived_by uuid REFERENCES public.profiles(id),
  created_by uuid NOT NULL REFERENCES public.profiles(id), updated_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id), UNIQUE(property_id,salary_structure_id,code,effective_from),
  FOREIGN KEY(property_id,salary_structure_id)
    REFERENCES public.payroll_salary_structures(property_id,id) ON DELETE RESTRICT,
  CHECK(minimum_base_salary>=0 AND maximum_base_salary>=minimum_base_salary),
  CHECK(midpoint_salary IS NULL OR midpoint_salary BETWEEN minimum_base_salary AND maximum_base_salary),
  CHECK(effective_to IS NULL OR effective_to>=effective_from),
  CHECK(jsonb_typeof(step_progression)='object')
);
ALTER TABLE public.payroll_salary_grades ADD CONSTRAINT payroll_salary_grades_no_overlap
  EXCLUDE USING gist(property_id WITH =,salary_structure_id WITH =,code WITH =,
    daterange(effective_from,COALESCE(effective_to,'infinity'::date),'[]') WITH &&)
  WHERE(active AND archived_at IS NULL);

CREATE TABLE public.payroll_pay_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES public.properties(id),
  name text NOT NULL, code text NOT NULL,
  component_type text NOT NULL CHECK(component_type IN(
    'earning','deduction','employer_contribution','employee_contribution','reimbursement','informational'
  )),
  description text, taxable_classification text, statutory_classification text,
  pensionable_classification text, value_type text NOT NULL DEFAULT 'fixed'
    CHECK(value_type IN('fixed','variable')),
  calculation_method text NOT NULL DEFAULT 'fixed_amount'
    CHECK(calculation_method IN('fixed_amount','percentage','manual_input','none')),
  default_amount numeric(18,4), default_percentage numeric(9,6),
  percentage_basis_code text, minimum_amount numeric(18,4), maximum_amount numeric(18,4),
  currency text CHECK(currency IS NULL OR currency~'^[A-Z]{3}$'),
  recurrence text NOT NULL DEFAULT 'recurring' CHECK(recurrence IN('recurring','one_time')),
  proration_enabled boolean NOT NULL DEFAULT false,
  attendance_sensitive boolean NOT NULL DEFAULT false, leave_sensitive boolean NOT NULL DEFAULT false,
  overtime_sensitive boolean NOT NULL DEFAULT false, display_order integer NOT NULL DEFAULT 0,
  payslip_visible boolean NOT NULL DEFAULT true, effective_from date NOT NULL, effective_to date,
  active boolean NOT NULL DEFAULT true, archived_at timestamptz, archived_by uuid REFERENCES public.profiles(id),
  created_by uuid NOT NULL REFERENCES public.profiles(id), updated_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id), UNIQUE(property_id,code,effective_from),
  CHECK(effective_to IS NULL OR effective_to>=effective_from),
  CHECK(default_amount IS NULL OR default_amount>=0),
  CHECK(default_percentage IS NULL OR default_percentage BETWEEN 0 AND 100),
  CHECK(minimum_amount IS NULL OR maximum_amount IS NULL OR maximum_amount>=minimum_amount),
  CHECK((calculation_method='fixed_amount' AND default_percentage IS NULL)
    OR (calculation_method='percentage' AND default_amount IS NULL AND percentage_basis_code IS NOT NULL)
    OR calculation_method IN('manual_input','none'))
);
ALTER TABLE public.payroll_pay_components ADD CONSTRAINT payroll_pay_components_no_overlap
  EXCLUDE USING gist(property_id WITH =,code WITH =,
    daterange(effective_from,COALESCE(effective_to,'infinity'::date),'[]') WITH &&)
  WHERE(active AND archived_at IS NULL);

CREATE TABLE public.payroll_structure_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL,
  salary_structure_id uuid NOT NULL, salary_grade_id uuid, pay_component_id uuid NOT NULL,
  default_amount_override numeric(18,4), default_percentage_override numeric(9,6),
  required boolean NOT NULL DEFAULT false, effective_from date NOT NULL, effective_to date,
  display_order integer NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES public.profiles(id), updated_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  FOREIGN KEY(property_id,salary_structure_id)
    REFERENCES public.payroll_salary_structures(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,salary_grade_id)
    REFERENCES public.payroll_salary_grades(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,pay_component_id)
    REFERENCES public.payroll_pay_components(property_id,id) ON DELETE RESTRICT,
  CHECK(effective_to IS NULL OR effective_to>=effective_from),
  CHECK(default_percentage_override IS NULL OR default_percentage_override BETWEEN 0 AND 100)
);
ALTER TABLE public.payroll_structure_components ADD CONSTRAINT payroll_structure_components_no_overlap
  EXCLUDE USING gist(property_id WITH =,salary_structure_id WITH =,
    (COALESCE(salary_grade_id,'00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    pay_component_id WITH =,
    daterange(effective_from,COALESCE(effective_to,'infinity'::date),'[]') WITH &&)
  WHERE(active);

CREATE TABLE public.payroll_employee_compensations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, employee_id uuid NOT NULL,
  salary_structure_id uuid NOT NULL, salary_grade_id uuid, base_salary numeric(18,4) NOT NULL CHECK(base_salary>=0),
  currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'), pay_frequency_id uuid NOT NULL,
  effective_from date NOT NULL, effective_to date,
  employment_percentage numeric(7,4) NOT NULL DEFAULT 100 CHECK(employment_percentage>0 AND employment_percentage<=100),
  payment_method text NOT NULL CHECK(payment_method IN('bank_transfer','mobile_money','cash','cheque','other')),
  reason_for_change text NOT NULL CHECK(char_length(trim(reason_for_change))>=5),
  grade_band_override boolean NOT NULL DEFAULT false, grade_band_override_reason text,
  approval_status text NOT NULL DEFAULT 'draft' CHECK(approval_status IN('draft','approved','rejected')),
  notes text, active boolean NOT NULL DEFAULT true, archived_at timestamptz, archived_by uuid REFERENCES public.profiles(id),
  created_by uuid NOT NULL REFERENCES public.profiles(id), updated_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  FOREIGN KEY(property_id,employee_id) REFERENCES public.hr_employees(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,salary_structure_id)
    REFERENCES public.payroll_salary_structures(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,salary_grade_id)
    REFERENCES public.payroll_salary_grades(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,pay_frequency_id)
    REFERENCES public.payroll_pay_frequencies(property_id,id) ON DELETE RESTRICT,
  CHECK(effective_to IS NULL OR effective_to>=effective_from),
  CHECK(NOT grade_band_override OR char_length(trim(COALESCE(grade_band_override_reason,'')))>=5)
);
ALTER TABLE public.payroll_employee_compensations ADD CONSTRAINT payroll_employee_compensations_no_overlap
  EXCLUDE USING gist(property_id WITH =,employee_id WITH =,
    daterange(effective_from,COALESCE(effective_to,'infinity'::date),'[]') WITH &&)
  WHERE(active AND archived_at IS NULL);
CREATE INDEX payroll_employee_compensations_lookup_idx
  ON public.payroll_employee_compensations(property_id,employee_id,effective_from DESC);

CREATE TABLE public.payroll_employee_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL,
  compensation_id uuid NOT NULL, pay_component_id uuid NOT NULL,
  fixed_amount_override numeric(18,4), percentage_override numeric(9,6),
  recurrence text NOT NULL CHECK(recurrence IN('recurring','one_time')),
  start_date date NOT NULL, end_date date, reason text NOT NULL CHECK(char_length(trim(reason))>=5),
  active boolean NOT NULL DEFAULT true, created_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  FOREIGN KEY(property_id,compensation_id)
    REFERENCES public.payroll_employee_compensations(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,pay_component_id)
    REFERENCES public.payroll_pay_components(property_id,id) ON DELETE RESTRICT,
  CHECK(end_date IS NULL OR end_date>=start_date),
  CHECK(NOT(fixed_amount_override IS NOT NULL AND percentage_override IS NOT NULL)),
  CHECK(percentage_override IS NULL OR percentage_override BETWEEN 0 AND 100)
);
ALTER TABLE public.payroll_employee_components ADD CONSTRAINT payroll_employee_components_no_overlap
  EXCLUDE USING gist(property_id WITH =,compensation_id WITH =,pay_component_id WITH =,
    daterange(start_date,COALESCE(end_date,'infinity'::date),'[]') WITH &&)
  WHERE(active);

CREATE TABLE public.payroll_payment_details (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, employee_id uuid NOT NULL,
  payment_method text NOT NULL CHECK(payment_method IN('bank_transfer','mobile_money','cash','cheque','other')),
  account_name text, bank_name text, branch_name text,
  account_number_ciphertext text, account_number_iv text, account_number_last4 text,
  routing_code_ciphertext text, routing_code_iv text, routing_code_last4 text,
  mobile_provider text, mobile_number_ciphertext text, mobile_number_iv text, mobile_number_last4 text,
  payment_reference text, is_primary boolean NOT NULL DEFAULT false,
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK(verification_status IN('unverified','pending','verified','rejected')),
  verified_by uuid REFERENCES public.profiles(id), verified_at timestamptz,
  effective_from date NOT NULL, effective_to date,
  archived_at timestamptz, archived_by uuid REFERENCES public.profiles(id),
  created_by uuid NOT NULL REFERENCES public.profiles(id), updated_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  FOREIGN KEY(property_id,employee_id) REFERENCES public.hr_employees(property_id,id) ON DELETE RESTRICT,
  CHECK(effective_to IS NULL OR effective_to>=effective_from),
  CHECK((verification_status='verified' AND verified_by IS NOT NULL AND verified_at IS NOT NULL)
    OR verification_status<>'verified'),
  CHECK(account_number_ciphertext IS NULL OR account_number_iv IS NOT NULL),
  CHECK(mobile_number_ciphertext IS NULL OR mobile_number_iv IS NOT NULL)
);
CREATE UNIQUE INDEX payroll_payment_details_primary_uniq
  ON public.payroll_payment_details(property_id,employee_id)
  WHERE is_primary AND archived_at IS NULL AND effective_to IS NULL;
CREATE INDEX payroll_payment_details_employee_idx
  ON public.payroll_payment_details(property_id,employee_id,effective_from DESC);

CREATE TABLE public.payroll_statutory_rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES public.properties(id),
  jurisdiction_code text NOT NULL, name text NOT NULL, rule_category text NOT NULL,
  effective_from date NOT NULL, effective_to date, version text NOT NULL,
  source_reference jsonb NOT NULL DEFAULT '{}',
  verification_status text NOT NULL DEFAULT 'draft'
    CHECK(verification_status IN('draft','unverified','verified','rejected')),
  reviewed_by uuid REFERENCES public.profiles(id), reviewed_at timestamptz,
  parameters jsonb NOT NULL DEFAULT '{}', calculation_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true, archived_at timestamptz, archived_by uuid REFERENCES public.profiles(id),
  created_by uuid NOT NULL REFERENCES public.profiles(id), updated_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id), UNIQUE(property_id,jurisdiction_code,rule_category,version),
  CHECK(effective_to IS NULL OR effective_to>=effective_from),
  CHECK(jsonb_typeof(parameters)='object' AND jsonb_typeof(source_reference)='object'),
  CHECK(lower(parameters::text) !~ '("script"|"executable"|"eval"|"javascript")'),
  CHECK((verification_status='verified' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    OR verification_status<>'verified')
);
ALTER TABLE public.payroll_statutory_rule_sets ADD CONSTRAINT payroll_statutory_rules_no_overlap
  EXCLUDE USING gist(property_id WITH =,jurisdiction_code WITH =,rule_category WITH =,
    daterange(effective_from,COALESCE(effective_to,'infinity'::date),'[]') WITH &&)
  WHERE(active AND verification_status='verified' AND archived_at IS NULL);

CREATE TABLE public.payroll_opening_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES public.properties(id),
  source_system text NOT NULL, source_reference text, as_of_date date NOT NULL,
  status text NOT NULL DEFAULT 'staged' CHECK(status IN('staged','validated','rejected','superseded')),
  evidence_metadata jsonb NOT NULL DEFAULT '{}', imported_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id), CHECK(jsonb_typeof(evidence_metadata)='object')
);
CREATE TABLE public.payroll_opening_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, import_batch_id uuid NOT NULL,
  employee_id uuid NOT NULL, category text NOT NULL CHECK(category IN(
    'gross','taxable_earnings','statutory_deduction','pension','employee_contribution',
    'employer_contribution','net_pay','leave_without_pay','year_to_date_other'
  )),
  amount numeric(18,4) NOT NULL, currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),
  as_of_date date NOT NULL, source_reference text,
  validation_status text NOT NULL DEFAULT 'pending'
    CHECK(validation_status IN('pending','valid','invalid','superseded')),
  validation_message text, supersedes_id uuid, superseded_at timestamptz,
  created_by uuid NOT NULL REFERENCES public.profiles(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  FOREIGN KEY(property_id,import_batch_id)
    REFERENCES public.payroll_opening_import_batches(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,employee_id) REFERENCES public.hr_employees(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,supersedes_id)
    REFERENCES public.payroll_opening_balances(property_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX payroll_opening_balances_current_uniq
  ON public.payroll_opening_balances(property_id,employee_id,category,as_of_date)
  WHERE validation_status<>'superseded';
CREATE INDEX payroll_opening_balances_batch_idx
  ON public.payroll_opening_balances(property_id,import_batch_id,validation_status);

CREATE OR REPLACE FUNCTION public.payroll_validate_configuration()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF TG_TABLE_NAME='payroll_settings' THEN
    IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=NEW.timezone)
      THEN RAISE EXCEPTION 'Invalid IANA timezone'; END IF;
    IF NEW.currency<>(SELECT base_currency FROM public.properties WHERE id=NEW.property_id)
      THEN RAISE EXCEPTION 'Payroll currency must match the configured property currency'; END IF;
  ELSIF TG_TABLE_NAME='payroll_employee_compensations' THEN
    IF NEW.salary_grade_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM public.payroll_salary_grades g
      WHERE g.property_id=NEW.property_id AND g.id=NEW.salary_grade_id
        AND g.salary_structure_id=NEW.salary_structure_id
        AND (NEW.base_salary BETWEEN g.minimum_base_salary AND g.maximum_base_salary
          OR (NEW.grade_band_override AND char_length(trim(COALESCE(NEW.grade_band_override_reason,'')))>=5))
    ) THEN RAISE EXCEPTION 'Base salary is outside the grade band or grade scope'; END IF;
  ELSIF TG_TABLE_NAME='payroll_structure_components' THEN
    IF NEW.salary_grade_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM public.payroll_salary_grades g
      WHERE g.property_id=NEW.property_id AND g.id=NEW.salary_grade_id
        AND g.salary_structure_id=NEW.salary_structure_id
    ) THEN RAISE EXCEPTION 'Grade does not belong to salary structure'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_settings_validate BEFORE INSERT OR UPDATE ON public.payroll_settings
  FOR EACH ROW EXECUTE FUNCTION public.payroll_validate_configuration();
CREATE TRIGGER payroll_compensation_validate BEFORE INSERT OR UPDATE ON public.payroll_employee_compensations
  FOR EACH ROW EXECUTE FUNCTION public.payroll_validate_configuration();
CREATE TRIGGER payroll_structure_components_validate BEFORE INSERT OR UPDATE ON public.payroll_structure_components
  FOR EACH ROW EXECUTE FUNCTION public.payroll_validate_configuration();

CREATE OR REPLACE FUNCTION public.payroll_prepare_effective_supersession()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
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
  ELSIF TG_TABLE_NAME='payroll_payment_details' AND NEW.is_primary THEN
    UPDATE public.payroll_payment_details
    SET effective_to=NEW.effective_from-1,updated_by=NEW.updated_by
    WHERE property_id=NEW.property_id AND employee_id=NEW.employee_id
      AND is_primary AND archived_at IS NULL AND effective_from<NEW.effective_from
      AND COALESCE(effective_to,'infinity'::date)>=NEW.effective_from;
  ELSIF TG_TABLE_NAME='payroll_statutory_rule_sets' AND NEW.verification_status='verified' THEN
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
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_settings_supersede BEFORE INSERT ON public.payroll_settings
  FOR EACH ROW EXECUTE FUNCTION public.payroll_prepare_effective_supersession();
CREATE TRIGGER payroll_salary_structure_supersede BEFORE INSERT ON public.payroll_salary_structures
  FOR EACH ROW EXECUTE FUNCTION public.payroll_prepare_effective_supersession();
CREATE TRIGGER payroll_salary_grade_supersede BEFORE INSERT ON public.payroll_salary_grades
  FOR EACH ROW EXECUTE FUNCTION public.payroll_prepare_effective_supersession();
CREATE TRIGGER payroll_pay_component_supersede BEFORE INSERT ON public.payroll_pay_components
  FOR EACH ROW EXECUTE FUNCTION public.payroll_prepare_effective_supersession();
CREATE TRIGGER payroll_structure_component_supersede BEFORE INSERT ON public.payroll_structure_components
  FOR EACH ROW EXECUTE FUNCTION public.payroll_prepare_effective_supersession();
CREATE TRIGGER payroll_compensation_supersede BEFORE INSERT ON public.payroll_employee_compensations
  FOR EACH ROW EXECUTE FUNCTION public.payroll_prepare_effective_supersession();
CREATE TRIGGER payroll_payment_details_supersede BEFORE INSERT ON public.payroll_payment_details
  FOR EACH ROW EXECUTE FUNCTION public.payroll_prepare_effective_supersession();
CREATE TRIGGER payroll_statutory_rule_supersede BEFORE INSERT ON public.payroll_statutory_rule_sets
  FOR EACH ROW EXECUTE FUNCTION public.payroll_prepare_effective_supersession();

CREATE OR REPLACE FUNCTION public.payroll_protect_effective_history()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF (OLD.effective_from<current_date OR TG_TABLE_NAME IN(
      'payroll_employee_compensations','payroll_payment_details'
    )) AND
    (to_jsonb(NEW)-ARRAY[
      'updated_at','updated_by','effective_to','active','archived_at','archived_by',
      'verification_status','verified_by','verified_at','reviewed_by','reviewed_at','approval_status'
    ])
      IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY[
      'updated_at','updated_by','effective_to','active','archived_at','archived_by',
      'verification_status','verified_by','verified_at','reviewed_by','reviewed_at','approval_status'
    ])
  THEN RAISE EXCEPTION 'Historical payroll configuration must be superseded, not overwritten'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_compensation_history BEFORE UPDATE ON public.payroll_employee_compensations
  FOR EACH ROW EXECUTE FUNCTION public.payroll_protect_effective_history();
CREATE TRIGGER payroll_settings_history BEFORE UPDATE ON public.payroll_settings
  FOR EACH ROW EXECUTE FUNCTION public.payroll_protect_effective_history();
CREATE TRIGGER payroll_salary_structure_history BEFORE UPDATE ON public.payroll_salary_structures
  FOR EACH ROW EXECUTE FUNCTION public.payroll_protect_effective_history();
CREATE TRIGGER payroll_salary_grade_history BEFORE UPDATE ON public.payroll_salary_grades
  FOR EACH ROW EXECUTE FUNCTION public.payroll_protect_effective_history();
CREATE TRIGGER payroll_pay_component_history BEFORE UPDATE ON public.payroll_pay_components
  FOR EACH ROW EXECUTE FUNCTION public.payroll_protect_effective_history();
CREATE TRIGGER payroll_structure_component_history BEFORE UPDATE ON public.payroll_structure_components
  FOR EACH ROW EXECUTE FUNCTION public.payroll_protect_effective_history();
CREATE TRIGGER payroll_payment_details_history BEFORE UPDATE ON public.payroll_payment_details
  FOR EACH ROW EXECUTE FUNCTION public.payroll_protect_effective_history();
CREATE TRIGGER payroll_statutory_rule_history BEFORE UPDATE ON public.payroll_statutory_rule_sets
  FOR EACH ROW EXECUTE FUNCTION public.payroll_protect_effective_history();

CREATE OR REPLACE FUNCTION public.payroll_protect_calendar_history()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF OLD.status<>'planned' AND
    (NEW.start_date,NEW.end_date,NEW.cutoff_date,NEW.expected_payment_date,NEW.pay_frequency_id)
      IS DISTINCT FROM
    (OLD.start_date,OLD.end_date,OLD.cutoff_date,OLD.expected_payment_date,OLD.pay_frequency_id)
  THEN RAISE EXCEPTION 'Referenced payroll calendar periods cannot be destructively edited'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_calendar_history BEFORE UPDATE ON public.payroll_calendar_periods
  FOR EACH ROW EXECUTE FUNCTION public.payroll_protect_calendar_history();

CREATE OR REPLACE FUNCTION public.payroll_validate_continuous_calendar()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE previous_end date; next_start date; requires_continuity boolean;
BEGIN
  SELECT continuous_periods INTO requires_continuity
  FROM public.payroll_pay_frequencies
  WHERE property_id=NEW.property_id AND id=NEW.pay_frequency_id;
  IF NOT COALESCE(requires_continuity,false) OR NEW.status='archived' THEN RETURN NEW; END IF;
  SELECT max(end_date) INTO previous_end
  FROM public.payroll_calendar_periods
  WHERE property_id=NEW.property_id AND pay_frequency_id=NEW.pay_frequency_id
    AND payroll_year=NEW.payroll_year AND period_number<NEW.period_number
    AND status<>'archived' AND id<>NEW.id;
  SELECT min(start_date) INTO next_start
  FROM public.payroll_calendar_periods
  WHERE property_id=NEW.property_id AND pay_frequency_id=NEW.pay_frequency_id
    AND payroll_year=NEW.payroll_year AND period_number>NEW.period_number
    AND status<>'archived' AND id<>NEW.id;
  IF previous_end IS NOT NULL AND previous_end+1<>NEW.start_date
    THEN RAISE EXCEPTION 'Continuous pay calendar contains a gap before this period'; END IF;
  IF next_start IS NOT NULL AND NEW.end_date+1<>next_start
    THEN RAISE EXCEPTION 'Continuous pay calendar contains a gap after this period'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_calendar_continuity
  BEFORE INSERT OR UPDATE ON public.payroll_calendar_periods
  FOR EACH ROW EXECUTE FUNCTION public.payroll_validate_continuous_calendar();

CREATE OR REPLACE FUNCTION public.payroll_protect_frequency_history()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF EXISTS(
    SELECT 1 FROM public.payroll_calendar_periods
    WHERE property_id=OLD.property_id AND pay_frequency_id=OLD.id
  ) AND
    (NEW.periods_per_year,NEW.interval_definition,NEW.first_period_start,
     NEW.cutoff_rule,NEW.payment_day_rule,NEW.continuous_periods)
      IS DISTINCT FROM
    (OLD.periods_per_year,OLD.interval_definition,OLD.first_period_start,
     OLD.cutoff_rule,OLD.payment_day_rule,OLD.continuous_periods)
  THEN RAISE EXCEPTION 'A pay frequency with calendar periods cannot be structurally edited'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_frequency_history BEFORE UPDATE ON public.payroll_pay_frequencies
  FOR EACH ROW EXECUTE FUNCTION public.payroll_protect_frequency_history();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'payroll_settings','payroll_pay_frequencies','payroll_calendar_periods',
    'payroll_salary_structures','payroll_salary_grades','payroll_pay_components',
    'payroll_structure_components','payroll_employee_compensations','payroll_employee_components',
    'payroll_payment_details','payroll_statutory_rule_sets','payroll_opening_import_batches'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()',
      'trg_' || table_name || '_updated', table_name
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_supersede_opening_balance(
  _property_id uuid,_balance_id uuid,_amount numeric,_source_reference text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE old_row public.payroll_opening_balances%ROWTYPE; new_id uuid;
BEGIN
  IF NOT public.has_hrm_permission(auth.uid(),_property_id,'opening_balances','manage')
    THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT * INTO old_row FROM public.payroll_opening_balances
  WHERE property_id=_property_id AND id=_balance_id AND validation_status<>'superseded'
  FOR UPDATE;
  IF old_row.id IS NULL THEN RAISE EXCEPTION 'Opening balance not found'; END IF;
  UPDATE public.payroll_opening_balances SET
    validation_status='superseded',superseded_at=now()
  WHERE id=old_row.id;
  INSERT INTO public.payroll_opening_balances(
    property_id,import_batch_id,employee_id,category,amount,currency,as_of_date,
    source_reference,validation_status,supersedes_id,created_by
  ) VALUES(
    _property_id,old_row.import_batch_id,old_row.employee_id,old_row.category,_amount,
    old_row.currency,old_row.as_of_date,NULLIF(trim(_source_reference),''),
    'valid',old_row.id,auth.uid()
  ) RETURNING id INTO new_id;
  RETURN new_id;
END $$;
REVOKE ALL ON FUNCTION public.payroll_supersede_opening_balance(uuid,uuid,numeric,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_supersede_opening_balance(uuid,uuid,numeric,text)
  TO authenticated,service_role;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'payroll_settings','payroll_pay_frequencies','payroll_calendar_periods',
    'payroll_salary_structures','payroll_salary_grades','payroll_pay_components',
    'payroll_structure_components','payroll_employee_compensations','payroll_employee_components',
    'payroll_payment_details','payroll_statutory_rule_sets','payroll_opening_import_batches',
    'payroll_opening_balances'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
  END LOOP;
END $$;

CREATE POLICY payroll_settings_read ON public.payroll_settings FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payroll_settings','read'));
CREATE POLICY payroll_settings_manage ON public.payroll_settings FOR ALL TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payroll_settings','manage'))
  WITH CHECK(public.has_hrm_permission(auth.uid(),property_id,'payroll_settings','manage'));
CREATE POLICY payroll_frequencies_read ON public.payroll_pay_frequencies FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'pay_calendars','read'));
CREATE POLICY payroll_frequencies_manage ON public.payroll_pay_frequencies FOR ALL TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'pay_calendars','manage'))
  WITH CHECK(public.has_hrm_permission(auth.uid(),property_id,'pay_calendars','manage'));
CREATE POLICY payroll_periods_read ON public.payroll_calendar_periods FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'pay_calendars','read'));
CREATE POLICY payroll_periods_manage ON public.payroll_calendar_periods FOR ALL TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'pay_calendars','manage'))
  WITH CHECK(public.has_hrm_permission(auth.uid(),property_id,'pay_calendars','manage'));
CREATE POLICY payroll_structures_read ON public.payroll_salary_structures FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'salary_structures','read'));
CREATE POLICY payroll_structures_manage ON public.payroll_salary_structures FOR ALL TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'salary_structures','manage'))
  WITH CHECK(public.has_hrm_permission(auth.uid(),property_id,'salary_structures','manage'));
CREATE POLICY payroll_grades_read ON public.payroll_salary_grades FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'salary_structures','read'));
CREATE POLICY payroll_grades_manage ON public.payroll_salary_grades FOR ALL TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'salary_structures','manage'))
  WITH CHECK(public.has_hrm_permission(auth.uid(),property_id,'salary_structures','manage'));
CREATE POLICY payroll_components_read ON public.payroll_pay_components FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'pay_components','read'));
CREATE POLICY payroll_components_manage ON public.payroll_pay_components FOR ALL TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'pay_components','manage'))
  WITH CHECK(public.has_hrm_permission(auth.uid(),property_id,'pay_components','manage'));
CREATE POLICY payroll_structure_components_read ON public.payroll_structure_components FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'salary_structures','read'));
CREATE POLICY payroll_structure_components_manage ON public.payroll_structure_components FOR ALL TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'salary_structures','manage'))
  WITH CHECK(public.has_hrm_permission(auth.uid(),property_id,'salary_structures','manage'));
CREATE POLICY payroll_compensation_read ON public.payroll_employee_compensations FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'employee_compensation_sensitive','read'));
CREATE POLICY payroll_compensation_manage ON public.payroll_employee_compensations FOR ALL TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'employee_compensation','manage'))
  WITH CHECK(public.has_hrm_permission(auth.uid(),property_id,'employee_compensation','manage'));
CREATE POLICY payroll_employee_components_access ON public.payroll_employee_components FOR ALL TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'employee_compensation','read'))
  WITH CHECK(public.has_hrm_permission(auth.uid(),property_id,'employee_compensation','manage'));
CREATE POLICY payroll_payment_details_read ON public.payroll_payment_details FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payment_details','read'));
CREATE POLICY payroll_payment_details_manage ON public.payroll_payment_details FOR ALL TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payment_details','manage'))
  WITH CHECK(public.has_hrm_permission(auth.uid(),property_id,'payment_details','manage'));
CREATE POLICY payroll_statutory_rules_read ON public.payroll_statutory_rule_sets FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'statutory_rules','read'));
CREATE POLICY payroll_statutory_rules_manage ON public.payroll_statutory_rule_sets FOR ALL TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'statutory_rules','manage'))
  WITH CHECK(public.has_hrm_permission(auth.uid(),property_id,'statutory_rules','manage'));
CREATE POLICY payroll_opening_batches_read ON public.payroll_opening_import_batches FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'opening_balances','read'));
CREATE POLICY payroll_opening_batches_create ON public.payroll_opening_import_batches FOR INSERT TO authenticated
  WITH CHECK(public.has_hrm_permission(auth.uid(),property_id,'opening_balances','create'));
CREATE POLICY payroll_opening_balances_read ON public.payroll_opening_balances FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'opening_balances','read'));
CREATE POLICY payroll_opening_balances_create ON public.payroll_opening_balances FOR INSERT TO authenticated
  WITH CHECK(public.has_hrm_permission(auth.uid(),property_id,'opening_balances','create'));

GRANT SELECT,INSERT,UPDATE ON
  public.payroll_settings,public.payroll_pay_frequencies,public.payroll_calendar_periods,
  public.payroll_salary_structures,public.payroll_salary_grades,public.payroll_pay_components,
  public.payroll_structure_components,public.payroll_employee_compensations,
  public.payroll_employee_components,public.payroll_payment_details,
  public.payroll_statutory_rule_sets TO authenticated;
GRANT SELECT,INSERT ON
  public.payroll_opening_import_batches,public.payroll_opening_balances TO authenticated;
GRANT ALL ON
  public.payroll_settings,public.payroll_pay_frequencies,public.payroll_calendar_periods,
  public.payroll_salary_structures,public.payroll_salary_grades,public.payroll_pay_components,
  public.payroll_structure_components,public.payroll_employee_compensations,
  public.payroll_employee_components,public.payroll_payment_details,
  public.payroll_statutory_rule_sets,public.payroll_opening_import_batches,
  public.payroll_opening_balances TO service_role;

CREATE OR REPLACE FUNCTION public.seed_payroll_configuration_permissions(_property_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  INSERT INTO public.role_permissions(property_id,role,module,action,allowed)
  SELECT _property_id,r::public.app_role,m,a,true FROM (VALUES
    ('payroll_overview','read'),('payroll_settings','read'),('payroll_settings','manage'),
    ('pay_calendars','read'),('pay_calendars','manage'),
    ('salary_structures','read'),('salary_structures','manage'),
    ('pay_components','read'),('pay_components','manage'),
    ('employee_compensation','read'),('employee_compensation','manage'),
    ('employee_compensation_sensitive','read'),
    ('payment_details','read'),('payment_details','manage'),
    ('payment_details_full','read'),('payment_details','approve'),
    ('statutory_rules','read'),('statutory_rules','manage'),
    ('opening_balances','read'),('opening_balances','create'),('opening_balances','manage')
  ) p(m,a) CROSS JOIN (VALUES('super_admin'),('hotel_owner'),('general_manager'),('hr')) roles(r)
  WHERE r<>'general_manager' OR m NOT IN(
    'employee_compensation','employee_compensation_sensitive',
    'payment_details','payment_details_full','opening_balances'
  )
  ON CONFLICT DO NOTHING;
END $$;
SELECT public.seed_payroll_configuration_permissions(id) FROM public.properties;
REVOKE ALL ON FUNCTION public.seed_payroll_configuration_permissions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_payroll_configuration_permissions(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.seed_payroll_configuration_permissions_for_property()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN PERFORM public.seed_payroll_configuration_permissions(NEW.id); RETURN NEW; END $$;
CREATE TRIGGER properties_seed_payroll_configuration_permissions
AFTER INSERT ON public.properties FOR EACH ROW
EXECUTE FUNCTION public.seed_payroll_configuration_permissions_for_property();

CREATE OR REPLACE FUNCTION public.initialize_payroll_settings_for_property()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  INSERT INTO public.payroll_settings(
    property_id,effective_from,currency,jurisdiction_code,timezone,created_by,updated_by
  ) VALUES(
    NEW.id,current_date,NEW.base_currency,'UNSPECIFIED',NEW.timezone,
    COALESCE(auth.uid(),(SELECT id FROM public.profiles ORDER BY created_at LIMIT 1)),
    COALESCE(auth.uid(),(SELECT id FROM public.profiles ORDER BY created_at LIMIT 1))
  );
  RETURN NEW;
END $$;
CREATE TRIGGER properties_initialize_payroll_settings
AFTER INSERT ON public.properties FOR EACH ROW EXECUTE FUNCTION public.initialize_payroll_settings_for_property();

INSERT INTO public.payroll_settings(
  property_id,effective_from,currency,jurisdiction_code,timezone,created_by,updated_by
)
SELECT p.id,current_date,p.base_currency,'UNSPECIFIED',p.timezone,
  COALESCE(p.created_by,(SELECT id FROM public.profiles ORDER BY created_at LIMIT 1)),
  COALESCE(p.created_by,(SELECT id FROM public.profiles ORDER BY created_at LIMIT 1))
FROM public.properties p
WHERE NOT EXISTS(SELECT 1 FROM public.payroll_settings s WHERE s.property_id=p.id);

COMMENT ON TABLE public.payroll_settings IS
  'Phase 4A configuration only. Does not enable payroll calculations or runs.';
COMMENT ON TABLE public.payroll_statutory_rule_sets IS
  'Versioned configuration only; verified status does not claim legal or statutory compliance.';
COMMENT ON TABLE public.payroll_payment_details IS
  'Ciphertext-only sensitive account fields. Encryption keys remain server-side.';
COMMENT ON TABLE public.payroll_opening_balances IS
  'Migration staging evidence only; rows are not payroll runs or calculated results.';
