-- Phase 4C: payroll approval, finalization, payslip, payment preparation,
-- statutory-liability, journal-draft, period-close, correction and reversal foundation.
-- This is preparation only: no bank transmission, payment execution, statutory filing,
-- accounting posting, or legal compliance certification is implemented here.

ALTER TABLE public.payroll_settings
  ADD COLUMN require_payroll_separation_of_duties boolean NOT NULL DEFAULT true,
  ADD COLUMN allow_automatic_payslip_publication boolean NOT NULL DEFAULT false,
  ADD COLUMN prevent_new_drafts_after_finalization boolean NOT NULL DEFAULT true,
  ADD COLUMN require_verified_payment_details_for_finalization boolean NOT NULL DEFAULT false;

ALTER TABLE public.payroll_calendar_periods
  ADD COLUMN payroll_finalized_at timestamptz,
  ADD COLUMN payroll_finalized_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  ADD COLUMN payroll_closed_at timestamptz,
  ADD COLUMN payroll_closed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  ADD COLUMN payroll_reopened_at timestamptz,
  ADD COLUMN payroll_reopened_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  ADD COLUMN payroll_reopen_reason text,
  ADD CONSTRAINT payroll_period_reopen_reason_required
    CHECK(payroll_reopen_reason IS NULL OR char_length(trim(payroll_reopen_reason))>=5);

DO $$
DECLARE status_constraint text;
BEGIN
  SELECT conname INTO status_constraint
  FROM pg_constraint
  WHERE conrelid='public.payroll_runs'::regclass
    AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%locked_for_review%'
    AND pg_get_constraintdef(oid) LIKE '%archived%'
  LIMIT 1;
  IF status_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.payroll_runs DROP CONSTRAINT %I', status_constraint);
  END IF;
  ALTER TABLE public.payroll_runs ADD CONSTRAINT payroll_runs_status_phase4c CHECK(status IN(
    'draft','calculating','calculated','calculation_failed','locked_for_review','submitted_for_approval',
    'approved','rejected','returned_for_correction','reopened','finalizing','finalized','reversed','archived'
  ));
END $$;

CREATE TABLE public.payroll_approval_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  payroll_run_id uuid NOT NULL,
  run_version_id uuid NOT NULL,
  calculation_version integer NOT NULL CHECK(calculation_version>0),
  action text NOT NULL CHECK(action IN('submitted','approved','rejected','returned_for_correction','reopened','resubmitted')),
  prior_status text NOT NULL,
  new_status text NOT NULL,
  reason text,
  idempotency_key uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  action_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}',
  UNIQUE(property_id,payroll_run_id,idempotency_key),
  UNIQUE(property_id,id),
  FOREIGN KEY(property_id,payroll_run_id) REFERENCES public.payroll_runs(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,run_version_id) REFERENCES public.payroll_run_versions(property_id,id) ON DELETE RESTRICT,
  CHECK(reason IS NULL OR char_length(trim(reason))>=5),
  CHECK(jsonb_typeof(metadata)='object')
);
CREATE INDEX payroll_approval_actions_run_idx
  ON public.payroll_approval_actions(property_id,payroll_run_id,action_at DESC);

CREATE TABLE public.finalized_payrolls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  source_payroll_run_id uuid NOT NULL,
  source_run_version_id uuid NOT NULL,
  calendar_period_id uuid NOT NULL,
  final_payroll_code text NOT NULL,
  calculation_version integer NOT NULL CHECK(calculation_version>0),
  status text NOT NULL DEFAULT 'finalized' CHECK(status IN('finalized','reversed')),
  currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),
  employee_count integer NOT NULL CHECK(employee_count>=0),
  gross_total numeric(20,4) NOT NULL,
  deduction_total numeric(20,4) NOT NULL,
  net_total numeric(20,4) NOT NULL,
  employer_cost_total numeric(20,4) NOT NULL,
  approval_evidence jsonb NOT NULL DEFAULT '[]',
  source_hash text NOT NULL,
  idempotency_key uuid NOT NULL,
  finalized_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  finalized_at timestamptz NOT NULL DEFAULT now(),
  reversed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reversed_at timestamptz,
  reversal_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  UNIQUE(property_id,source_run_version_id),
  UNIQUE(property_id,source_payroll_run_id,idempotency_key),
  UNIQUE(property_id,final_payroll_code),
  FOREIGN KEY(property_id,source_payroll_run_id) REFERENCES public.payroll_runs(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,source_run_version_id) REFERENCES public.payroll_run_versions(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,calendar_period_id) REFERENCES public.payroll_calendar_periods(property_id,id) ON DELETE RESTRICT,
  CHECK(jsonb_typeof(approval_evidence)='array'),
  CHECK(reversal_reason IS NULL OR char_length(trim(reversal_reason))>=5)
);
CREATE INDEX finalized_payrolls_period_idx
  ON public.finalized_payrolls(property_id,calendar_period_id,finalized_at DESC);
CREATE UNIQUE INDEX finalized_payrolls_one_active_period_uniq
  ON public.finalized_payrolls(property_id,calendar_period_id)
  WHERE status='finalized';

CREATE TABLE public.finalized_payroll_employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  finalized_payroll_id uuid NOT NULL,
  source_run_employee_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  compensation_id uuid,
  currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),
  base_salary numeric(20,4) NOT NULL,
  prorated_base_salary numeric(20,4) NOT NULL,
  gross_pay numeric(20,4) NOT NULL,
  employee_deductions numeric(20,4) NOT NULL,
  employer_contributions numeric(20,4) NOT NULL,
  net_pay numeric(20,4) NOT NULL,
  employer_cost numeric(20,4) NOT NULL,
  attendance_input_summary jsonb NOT NULL DEFAULT '{}',
  leave_input_summary jsonb NOT NULL DEFAULT '{}',
  calculation_trace jsonb NOT NULL DEFAULT '{}',
  source_references jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  UNIQUE(property_id,finalized_payroll_id,employee_id),
  UNIQUE(property_id,source_run_employee_id),
  FOREIGN KEY(property_id,finalized_payroll_id) REFERENCES public.finalized_payrolls(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,source_run_employee_id) REFERENCES public.payroll_run_employees(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,employee_id) REFERENCES public.hr_employees(property_id,id) ON DELETE RESTRICT,
  CHECK(jsonb_typeof(attendance_input_summary)='object' AND jsonb_typeof(leave_input_summary)='object'),
  CHECK(jsonb_typeof(calculation_trace)='object' AND jsonb_typeof(source_references)='array')
);
CREATE INDEX finalized_payroll_employees_employee_idx
  ON public.finalized_payroll_employees(property_id,employee_id,created_at DESC);

CREATE TABLE public.finalized_payroll_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  finalized_payroll_id uuid NOT NULL,
  finalized_employee_id uuid NOT NULL,
  source_line_item_id uuid NOT NULL,
  pay_component_id uuid,
  statutory_rule_id uuid,
  statutory_rule_version text,
  line_type text NOT NULL,
  line_code text NOT NULL,
  line_name text NOT NULL,
  quantity numeric(20,8) NOT NULL,
  rate numeric(20,8) NOT NULL,
  unrounded_amount numeric(24,8) NOT NULL,
  rounded_amount numeric(20,4) NOT NULL,
  taxable_amount numeric(20,4) NOT NULL DEFAULT 0,
  contribution_basis numeric(20,4) NOT NULL DEFAULT 0,
  display_order integer NOT NULL DEFAULT 0,
  source_type text NOT NULL,
  source_identifier text NOT NULL,
  calculation_explanation jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  UNIQUE(property_id,source_line_item_id),
  FOREIGN KEY(property_id,finalized_payroll_id) REFERENCES public.finalized_payrolls(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,finalized_employee_id) REFERENCES public.finalized_payroll_employees(property_id,id) ON DELETE RESTRICT,
  CHECK(jsonb_typeof(calculation_explanation)='object')
);
CREATE INDEX finalized_payroll_line_items_employee_idx
  ON public.finalized_payroll_line_items(property_id,finalized_employee_id,display_order,line_code);

CREATE TABLE public.payroll_payslips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  finalized_payroll_id uuid NOT NULL,
  finalized_employee_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  document_version integer NOT NULL CHECK(document_version>0),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','published','unpublished','replaced')),
  title text NOT NULL,
  storage_bucket text NOT NULL DEFAULT 'payroll-payslips',
  storage_path text,
  content_hash text NOT NULL,
  masked_payment_summary text,
  document_metadata jsonb NOT NULL DEFAULT '{}',
  generated_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  generated_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  published_at timestamptz,
  unpublished_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  unpublished_at timestamptz,
  unpublish_reason text,
  downloaded_count integer NOT NULL DEFAULT 0 CHECK(downloaded_count>=0),
  last_downloaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  UNIQUE(property_id,finalized_employee_id,document_version),
  FOREIGN KEY(property_id,finalized_payroll_id) REFERENCES public.finalized_payrolls(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,finalized_employee_id) REFERENCES public.finalized_payroll_employees(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,employee_id) REFERENCES public.hr_employees(property_id,id) ON DELETE RESTRICT,
  CHECK(jsonb_typeof(document_metadata)='object'),
  CHECK(unpublish_reason IS NULL OR char_length(trim(unpublish_reason))>=5),
  CHECK(storage_path IS NULL OR storage_path !~ '^https?://')
);
CREATE INDEX payroll_payslips_employee_idx
  ON public.payroll_payslips(property_id,employee_id,status,generated_at DESC);
CREATE UNIQUE INDEX payroll_payslips_current_published_uniq
  ON public.payroll_payslips(property_id,finalized_employee_id)
  WHERE status='published';

CREATE TABLE public.payroll_payment_export_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK(char_length(trim(name)) BETWEEN 3 AND 120),
  format text NOT NULL CHECK(format IN('csv','xlsx','fixed_width')),
  template jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  UNIQUE(property_id,name,version),
  CHECK(jsonb_typeof(template)='object'),
  CHECK(lower(template::text) !~ '(eval|script|javascript|sql|select |insert |update |delete |drop |;--)')
);

CREATE TABLE public.payroll_payment_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  finalized_payroll_id uuid NOT NULL,
  batch_code text NOT NULL,
  payment_method text NOT NULL CHECK(payment_method IN('bank_transfer','mobile_money','cash','cheque','other')),
  currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),
  total_amount numeric(20,4) NOT NULL DEFAULT 0,
  employee_count integer NOT NULL DEFAULT 0 CHECK(employee_count>=0),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','validated','ready_for_export','exported','cancelled')),
  prepared_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  validated_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  validated_at timestamptz,
  export_version integer NOT NULL DEFAULT 0 CHECK(export_version>=0),
  export_hash text,
  exported_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  exported_at timestamptz,
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  UNIQUE(property_id,batch_code),
  UNIQUE(property_id,finalized_payroll_id,payment_method,idempotency_key),
  FOREIGN KEY(property_id,finalized_payroll_id) REFERENCES public.finalized_payrolls(property_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX payroll_payment_batches_active_method_uniq
  ON public.payroll_payment_batches(property_id,finalized_payroll_id,payment_method)
  WHERE status<>'cancelled';

CREATE TABLE public.payroll_payment_batch_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  finalized_employee_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  payment_detail_id uuid,
  payment_method text NOT NULL,
  masked_destination text NOT NULL DEFAULT 'masked',
  payment_amount numeric(20,4) NOT NULL CHECK(payment_amount>=0),
  payment_reference text,
  validation_status text NOT NULL DEFAULT 'warning' CHECK(validation_status IN('valid','warning','blocked')),
  exclusion_reason text,
  excluded_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  excluded_at timestamptz,
  export_status text NOT NULL DEFAULT 'pending' CHECK(export_status IN('pending','exported')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  UNIQUE(property_id,batch_id,finalized_employee_id),
  FOREIGN KEY(property_id,batch_id) REFERENCES public.payroll_payment_batches(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,finalized_employee_id) REFERENCES public.finalized_payroll_employees(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,employee_id) REFERENCES public.hr_employees(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,payment_detail_id) REFERENCES public.payroll_payment_details(property_id,id) ON DELETE RESTRICT,
  CHECK(exclusion_reason IS NULL OR char_length(trim(exclusion_reason))>=5)
);

CREATE TABLE public.payroll_statutory_liability_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  finalized_payroll_id uuid NOT NULL,
  statutory_rule_id uuid,
  statutory_rule_version text,
  rule_category text NOT NULL,
  currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),
  employee_contribution_total numeric(20,4) NOT NULL DEFAULT 0,
  employer_contribution_total numeric(20,4) NOT NULL DEFAULT 0,
  taxable_basis_total numeric(20,4) NOT NULL DEFAULT 0,
  contribution_basis_total numeric(20,4) NOT NULL DEFAULT 0,
  line_count integer NOT NULL DEFAULT 0 CHECK(line_count>=0),
  verification_status text NOT NULL DEFAULT 'unverified',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  UNIQUE(property_id,finalized_payroll_id,statutory_rule_id,statutory_rule_version),
  FOREIGN KEY(property_id,finalized_payroll_id) REFERENCES public.finalized_payrolls(property_id,id) ON DELETE RESTRICT
);

CREATE TABLE public.payroll_journal_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  mapping_category text NOT NULL,
  account_code text NOT NULL,
  account_name text NOT NULL,
  debit_credit text NOT NULL CHECK(debit_credit IN('debit','credit')),
  dimensions jsonb NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  UNIQUE(property_id,mapping_category,version),
  CHECK(jsonb_typeof(dimensions)='object')
);

CREATE TABLE public.payroll_journal_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  finalized_payroll_id uuid NOT NULL,
  journal_date date NOT NULL,
  reference text NOT NULL,
  description text NOT NULL,
  currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),
  debit_total numeric(20,4) NOT NULL DEFAULT 0,
  credit_total numeric(20,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','blocked','exported')),
  mapping_version integer NOT NULL DEFAULT 1,
  prepared_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  exported_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  exported_at timestamptz,
  export_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  UNIQUE(property_id,finalized_payroll_id,mapping_version),
  FOREIGN KEY(property_id,finalized_payroll_id) REFERENCES public.finalized_payrolls(property_id,id) ON DELETE RESTRICT,
  CHECK(debit_total=credit_total OR status='blocked')
);

CREATE TABLE public.payroll_journal_draft_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  journal_draft_id uuid NOT NULL,
  account_code text NOT NULL,
  account_name text NOT NULL,
  debit numeric(20,4) NOT NULL DEFAULT 0 CHECK(debit>=0),
  credit numeric(20,4) NOT NULL DEFAULT 0 CHECK(credit>=0),
  department_id uuid,
  employee_id uuid,
  source_line_item_id uuid,
  explanation text NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  FOREIGN KEY(property_id,journal_draft_id) REFERENCES public.payroll_journal_drafts(property_id,id) ON DELETE RESTRICT,
  CHECK((debit>0 AND credit=0) OR (credit>0 AND debit=0))
);

CREATE TABLE public.payroll_period_close_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  calendar_period_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN('closed','reopened')),
  reason text NOT NULL CHECK(char_length(trim(reason))>=5),
  actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  action_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  FOREIGN KEY(property_id,calendar_period_id) REFERENCES public.payroll_calendar_periods(property_id,id) ON DELETE RESTRICT
);

CREATE TABLE public.payroll_correction_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  finalized_payroll_id uuid NOT NULL,
  affected_employee_id uuid,
  request_type text NOT NULL CHECK(request_type IN('correction','supplemental','reversal')),
  status text NOT NULL DEFAULT 'requested'
    CHECK(status IN('requested','approved','rejected','execution_blocked','executed')),
  reason text NOT NULL CHECK(char_length(trim(reason))>=5),
  financial_impact numeric(20,4),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  FOREIGN KEY(property_id,finalized_payroll_id) REFERENCES public.finalized_payrolls(property_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(property_id,affected_employee_id) REFERENCES public.hr_employees(property_id,id) ON DELETE RESTRICT,
  CHECK(review_reason IS NULL OR char_length(trim(review_reason))>=5),
  CHECK(status<>'rejected' OR review_reason IS NOT NULL)
);

CREATE TABLE public.payroll_correction_review_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  correction_request_id uuid NOT NULL,
  decision text NOT NULL CHECK(decision IN('approved','rejected')),
  prior_status text NOT NULL,
  reviewer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  review_reason text,
  UNIQUE(property_id,id),
  FOREIGN KEY(property_id,correction_request_id) REFERENCES public.payroll_correction_requests(property_id,id) ON DELETE RESTRICT,
  CHECK(review_reason IS NULL OR char_length(trim(review_reason))>=5)
);
CREATE INDEX payroll_correction_review_history_request_idx
  ON public.payroll_correction_review_history(property_id,correction_request_id,reviewed_at DESC);

CREATE TABLE public.payroll_reversal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  finalized_payroll_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'requested'
    CHECK(status IN('requested','approved','execution_blocked','executed')),
  reason text NOT NULL CHECK(char_length(trim(reason))>=5),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  executed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  executed_at timestamptz,
  UNIQUE(property_id,id),
  FOREIGN KEY(property_id,finalized_payroll_id) REFERENCES public.finalized_payrolls(property_id,id) ON DELETE RESTRICT
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'payroll_approval_actions','finalized_payrolls','finalized_payroll_employees',
    'finalized_payroll_line_items','payroll_payslips','payroll_payment_export_templates',
    'payroll_payment_batches','payroll_payment_batch_lines','payroll_statutory_liability_summaries',
    'payroll_journal_mappings','payroll_journal_drafts','payroll_journal_draft_lines',
    'payroll_period_close_history','payroll_correction_requests','payroll_correction_review_history',
    'payroll_reversal_requests'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
  END LOOP;
END $$;

CREATE POLICY payroll_approval_actions_read ON public.payroll_approval_actions FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payroll_approvals','read'));
CREATE POLICY finalized_payrolls_read ON public.finalized_payrolls FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'finalized_payroll','read'));
CREATE POLICY finalized_payroll_employees_read ON public.finalized_payroll_employees FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'finalized_payroll','read'));
CREATE POLICY finalized_payroll_line_items_read ON public.finalized_payroll_line_items FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'finalized_payroll_sensitive','read'));
CREATE POLICY payroll_payslips_payroll_read ON public.payroll_payslips FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payslips','read'));
CREATE POLICY payroll_payslips_own_published_read ON public.payroll_payslips FOR SELECT TO authenticated
  USING(status='published' AND public.has_hrm_permission(auth.uid(),property_id,'payslips_own','read')
    AND EXISTS(SELECT 1 FROM public.hr_employees e WHERE e.property_id=payroll_payslips.property_id
      AND e.id=payroll_payslips.employee_id AND e.staff_user_id=auth.uid()));
CREATE POLICY payroll_payment_templates_read ON public.payroll_payment_export_templates FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payroll_payment_templates','read'));
CREATE POLICY payroll_payment_batches_read ON public.payroll_payment_batches FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payroll_payment_batches','read'));
CREATE POLICY payroll_payment_batch_lines_read ON public.payroll_payment_batch_lines FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payroll_payment_batches','read'));
CREATE POLICY payroll_statutory_liabilities_read ON public.payroll_statutory_liability_summaries FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payroll_statutory_liabilities','read'));
CREATE POLICY payroll_journal_mappings_read ON public.payroll_journal_mappings FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payroll_journal_mappings','read'));
CREATE POLICY payroll_journal_drafts_read ON public.payroll_journal_drafts FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payroll_journal_drafts','read'));
CREATE POLICY payroll_journal_draft_lines_read ON public.payroll_journal_draft_lines FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payroll_journal_drafts','read'));
CREATE POLICY payroll_period_close_history_read ON public.payroll_period_close_history FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payroll_period_close','read'));
CREATE POLICY payroll_corrections_read ON public.payroll_correction_requests FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payroll_corrections','read'));
CREATE POLICY payroll_correction_review_history_read ON public.payroll_correction_review_history FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payroll_corrections','read'));
CREATE POLICY payroll_reversals_read ON public.payroll_reversal_requests FOR SELECT TO authenticated
  USING(public.has_hrm_permission(auth.uid(),property_id,'payroll_reversals','read'));

CREATE OR REPLACE FUNCTION public.payroll_approval_transition(
  _property_id uuid,_run_id uuid,_action text,_calculation_version integer,_reason text,_idempotency_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor uuid := auth.uid(); run_row public.payroll_runs%ROWTYPE; settings_row public.payroll_settings%ROWTYPE;
DECLARE version_id uuid; new_status text; approval_action text; previous_submitter uuid;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO run_row FROM public.payroll_runs WHERE property_id=_property_id AND id=_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll run not found'; END IF;
  SELECT * INTO settings_row FROM public.payroll_settings WHERE property_id=_property_id AND id=run_row.payroll_settings_id;
  IF run_row.current_calculation_version<>_calculation_version THEN RAISE EXCEPTION 'Stale payroll calculation version'; END IF;
  SELECT id INTO version_id FROM public.payroll_run_versions
    WHERE property_id=_property_id AND payroll_run_id=_run_id AND calculation_version=_calculation_version;
  IF EXISTS(SELECT 1 FROM public.payroll_approval_actions WHERE property_id=_property_id AND payroll_run_id=_run_id
    AND idempotency_key=_idempotency_key) THEN
    RETURN jsonb_build_object('status',run_row.status,'idempotent',true);
  END IF;
  IF _action='submit' THEN
    IF NOT public.has_hrm_permission(actor,_property_id,'payroll_approvals','create') THEN RAISE EXCEPTION 'Not authorized'; END IF;
    IF run_row.status NOT IN('locked_for_review','returned_for_correction') THEN RAISE EXCEPTION 'Run is not ready for approval'; END IF;
    IF EXISTS(SELECT 1 FROM public.payroll_calculation_findings WHERE property_id=_property_id AND payroll_run_id=_run_id
      AND calculation_version=_calculation_version AND severity='blocking') THEN RAISE EXCEPTION 'Blocking payroll validations remain'; END IF;
    new_status:='submitted_for_approval'; approval_action:=CASE WHEN run_row.status='returned_for_correction' THEN 'resubmitted' ELSE 'submitted' END;
  ELSIF _action='approve' THEN
    IF NOT public.has_hrm_permission(actor,_property_id,'payroll_approvals','approve') THEN RAISE EXCEPTION 'Not authorized'; END IF;
    IF run_row.status<>'submitted_for_approval' THEN RAISE EXCEPTION 'Run is not submitted for approval'; END IF;
    SELECT actor_id INTO previous_submitter FROM public.payroll_approval_actions
      WHERE property_id=_property_id AND payroll_run_id=_run_id AND action IN('submitted','resubmitted')
      ORDER BY action_at DESC LIMIT 1;
    IF settings_row.require_payroll_separation_of_duties AND previous_submitter=actor THEN
      RAISE EXCEPTION 'Requester cannot approve this payroll run';
    END IF;
    new_status:='approved'; approval_action:='approved';
  ELSIF _action IN('reject','return') THEN
    IF NOT public.has_hrm_permission(actor,_property_id,'payroll_approvals','delete') THEN RAISE EXCEPTION 'Not authorized'; END IF;
    IF trim(COALESCE(_reason,''))='' OR char_length(trim(_reason))<5 THEN RAISE EXCEPTION 'Reason is required'; END IF;
    IF run_row.status<>'submitted_for_approval' THEN RAISE EXCEPTION 'Run is not submitted for approval'; END IF;
    new_status:=CASE WHEN _action='reject' THEN 'rejected' ELSE 'returned_for_correction' END;
    approval_action:=CASE WHEN _action='reject' THEN 'rejected' ELSE 'returned_for_correction' END;
  ELSE
    RAISE EXCEPTION 'Unsupported approval action';
  END IF;
  UPDATE public.payroll_runs SET status=new_status,updated_by=actor,updated_at=now() WHERE property_id=_property_id AND id=_run_id;
  INSERT INTO public.payroll_approval_actions(property_id,payroll_run_id,run_version_id,calculation_version,action,prior_status,new_status,reason,idempotency_key,actor_id)
  VALUES(_property_id,_run_id,version_id,_calculation_version,approval_action,run_row.status,new_status,NULLIF(trim(COALESCE(_reason,'')),''),_idempotency_key,actor);
  PERFORM public.log_audit_event(_property_id,'payroll_approval',_run_id::text,approval_action,jsonb_build_object('version',_calculation_version,'priorStatus',run_row.status,'newStatus',new_status));
  RETURN jsonb_build_object('status',new_status,'idempotent',false);
END $$;

CREATE OR REPLACE FUNCTION public.payroll_finalize_run(
  _property_id uuid,_run_id uuid,_calculation_version integer,_idempotency_key uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor uuid := auth.uid(); run_row public.payroll_runs%ROWTYPE; version_row public.payroll_run_versions%ROWTYPE;
DECLARE final_id uuid; final_code text; evidence jsonb; source_hash text; total_check record;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT public.has_hrm_permission(actor,_property_id,'payroll_finalization','approve') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT * INTO run_row FROM public.payroll_runs WHERE property_id=_property_id AND id=_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll run not found'; END IF;
  IF run_row.status='finalized' THEN
    SELECT id INTO final_id FROM public.finalized_payrolls WHERE property_id=_property_id AND source_payroll_run_id=_run_id AND idempotency_key=_idempotency_key;
    IF final_id IS NOT NULL THEN RETURN final_id; END IF;
  END IF;
  IF run_row.status<>'approved' THEN RAISE EXCEPTION 'Payroll run must be approved before finalization'; END IF;
  IF run_row.current_calculation_version<>_calculation_version THEN RAISE EXCEPTION 'Stale payroll calculation version'; END IF;
  SELECT * INTO version_row FROM public.payroll_run_versions WHERE property_id=_property_id AND payroll_run_id=_run_id AND calculation_version=_calculation_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll version not found'; END IF;
  IF EXISTS(SELECT 1 FROM public.payroll_calculation_findings WHERE property_id=_property_id AND payroll_run_id=_run_id
    AND calculation_version=_calculation_version AND severity='blocking') THEN RAISE EXCEPTION 'Blocking validations remain'; END IF;
  SELECT count(*) AS employee_count, COALESCE(sum(gross_pay),0) AS gross_total,
    COALESCE(sum(employee_deductions),0) AS deduction_total, COALESCE(sum(net_pay),0) AS net_total,
    COALESCE(sum(employer_cost),0) AS employer_cost_total
  INTO total_check FROM public.payroll_run_employees
  WHERE property_id=_property_id AND payroll_run_id=_run_id AND calculation_version=_calculation_version AND status IN('calculated','warning');
  IF total_check.gross_total<>run_row.gross_total OR total_check.net_total<>run_row.net_total THEN
    RAISE EXCEPTION 'Payroll totals do not reconcile';
  END IF;
  UPDATE public.payroll_runs SET status='finalizing',updated_by=actor,updated_at=now() WHERE property_id=_property_id AND id=_run_id;
  evidence := COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.action_at)
    FROM public.payroll_approval_actions a WHERE a.property_id=_property_id AND a.payroll_run_id=_run_id),'[]'::jsonb);
  source_hash := encode(digest(concat_ws('|',run_row.id::text,version_row.id::text,run_row.current_calculation_version::text,
    run_row.gross_total::text,run_row.net_total::text),'sha256'),'hex');
  final_code := run_row.run_code || '-FINAL-v' || _calculation_version::text;
  INSERT INTO public.finalized_payrolls(property_id,source_payroll_run_id,source_run_version_id,calendar_period_id,final_payroll_code,
    calculation_version,currency,employee_count,gross_total,deduction_total,net_total,employer_cost_total,approval_evidence,source_hash,
    idempotency_key,finalized_by)
  VALUES(_property_id,_run_id,version_row.id,run_row.calendar_period_id,final_code,_calculation_version,run_row.currency,total_check.employee_count,
    total_check.gross_total,total_check.deduction_total,total_check.net_total,total_check.employer_cost_total,evidence,source_hash,_idempotency_key,actor)
  ON CONFLICT(property_id,source_payroll_run_id,idempotency_key) DO UPDATE SET final_payroll_code=EXCLUDED.final_payroll_code
  RETURNING id INTO final_id;
  INSERT INTO public.finalized_payroll_employees(property_id,finalized_payroll_id,source_run_employee_id,employee_id,compensation_id,currency,
    base_salary,prorated_base_salary,gross_pay,employee_deductions,employer_contributions,net_pay,employer_cost,
    attendance_input_summary,leave_input_summary,calculation_trace,source_references)
  SELECT property_id,final_id,id,employee_id,compensation_id,currency,base_salary,prorated_base_salary,gross_pay,employee_deductions,
    employer_contributions,net_pay,employer_cost,attendance_input_summary,leave_input_summary,calculation_trace,source_references
  FROM public.payroll_run_employees WHERE property_id=_property_id AND payroll_run_id=_run_id AND calculation_version=_calculation_version
  ON CONFLICT(property_id,source_run_employee_id) DO NOTHING;
  INSERT INTO public.finalized_payroll_line_items(property_id,finalized_payroll_id,finalized_employee_id,source_line_item_id,pay_component_id,
    statutory_rule_id,statutory_rule_version,line_type,line_code,line_name,quantity,rate,unrounded_amount,rounded_amount,taxable_amount,
    contribution_basis,display_order,source_type,source_identifier,calculation_explanation)
  SELECT li.property_id,final_id,fe.id,li.id,li.pay_component_id,li.statutory_rule_id,li.statutory_rule_version,li.line_type,li.line_code,
    li.line_name,li.quantity,li.rate,li.unrounded_amount,li.rounded_amount,li.taxable_amount,li.contribution_basis,li.display_order,
    li.source_type,li.source_identifier,li.calculation_explanation
  FROM public.payroll_run_line_items li
  JOIN public.finalized_payroll_employees fe ON fe.property_id=li.property_id AND fe.source_run_employee_id=li.run_employee_id
  WHERE li.property_id=_property_id AND li.payroll_run_id=_run_id AND li.run_version_id=version_row.id
  ON CONFLICT(property_id,source_line_item_id) DO NOTHING;
  INSERT INTO public.payroll_statutory_liability_summaries(property_id,finalized_payroll_id,statutory_rule_id,statutory_rule_version,
    rule_category,currency,employee_contribution_total,employer_contribution_total,taxable_basis_total,contribution_basis_total,line_count,verification_status)
  SELECT fli.property_id,final_id,fli.statutory_rule_id,fli.statutory_rule_version,COALESCE(s.rule_category,fli.line_type),run_row.currency,
    COALESCE(sum(CASE WHEN fli.line_type IN('employee_statutory','tax') THEN fli.rounded_amount ELSE 0 END),0),
    COALESCE(sum(CASE WHEN fli.line_type='employer_statutory' THEN fli.rounded_amount ELSE 0 END),0),
    COALESCE(sum(fli.taxable_amount),0),COALESCE(sum(fli.contribution_basis),0),count(*),COALESCE(s.verification_status,'unverified')
  FROM public.finalized_payroll_line_items fli
  LEFT JOIN public.payroll_statutory_rule_sets s ON s.property_id=fli.property_id AND s.id=fli.statutory_rule_id
  WHERE fli.property_id=_property_id AND fli.finalized_payroll_id=final_id AND fli.statutory_rule_id IS NOT NULL
  GROUP BY fli.property_id,fli.statutory_rule_id,fli.statutory_rule_version,s.rule_category,s.verification_status;
  UPDATE public.payroll_runs SET status='finalized',updated_by=actor,updated_at=now() WHERE property_id=_property_id AND id=_run_id;
  UPDATE public.payroll_calendar_periods SET payroll_finalized_at=now(),payroll_finalized_by=actor
    WHERE property_id=_property_id AND id=run_row.calendar_period_id;
  PERFORM public.log_audit_event(_property_id,'payroll_finalization',final_id::text,'finalized',jsonb_build_object('runId',_run_id,'version',_calculation_version));
  RETURN final_id;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_generate_payslips(
  _property_id uuid,_finalized_payroll_id uuid,_employee_ids uuid[] DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor uuid := auth.uid(); inserted_count integer;
BEGIN
  IF actor IS NULL OR NOT public.has_hrm_permission(actor,_property_id,'payslips','create') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  INSERT INTO public.payroll_payslips(property_id,finalized_payroll_id,finalized_employee_id,employee_id,document_version,title,
    content_hash,masked_payment_summary,document_metadata,generated_by)
  SELECT fe.property_id,fe.finalized_payroll_id,fe.id,fe.employee_id,
    COALESCE((SELECT max(document_version)+1 FROM public.payroll_payslips p WHERE p.property_id=fe.property_id AND p.finalized_employee_id=fe.id),1),
    'Payslip ' || fp.final_payroll_code,
    encode(digest(concat_ws('|',fe.id::text,fp.source_hash,fe.net_pay::text,clock_timestamp()::text),'sha256'),'hex'),
    'Payment destination masked',
    jsonb_build_object('source','finalized_payroll','grossPay',fe.gross_pay,'netPay',fe.net_pay,'currency',fe.currency),
    actor
  FROM public.finalized_payroll_employees fe
  JOIN public.finalized_payrolls fp ON fp.property_id=fe.property_id AND fp.id=fe.finalized_payroll_id
  WHERE fe.property_id=_property_id AND fe.finalized_payroll_id=_finalized_payroll_id
    AND (_employee_ids IS NULL OR fe.employee_id=ANY(_employee_ids));
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  PERFORM public.log_audit_event(_property_id,'payroll_payslips',_finalized_payroll_id::text,'generated',jsonb_build_object('count',inserted_count));
  RETURN inserted_count;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_publish_payslips(
  _property_id uuid,_finalized_payroll_id uuid,_employee_ids uuid[] DEFAULT NULL,_publish boolean DEFAULT true,_reason text DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor uuid := auth.uid(); changed_count integer;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF _publish AND NOT public.has_hrm_permission(actor,_property_id,'payslips','approve') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF NOT _publish AND NOT public.has_hrm_permission(actor,_property_id,'payslips','delete') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF NOT _publish AND char_length(trim(COALESCE(_reason,'')))<5 THEN RAISE EXCEPTION 'Unpublish reason is required'; END IF;
  UPDATE public.payroll_payslips SET status=CASE WHEN _publish THEN 'published' ELSE 'unpublished' END,
    published_by=CASE WHEN _publish THEN actor ELSE published_by END,
    published_at=CASE WHEN _publish THEN now() ELSE published_at END,
    unpublished_by=CASE WHEN _publish THEN unpublished_by ELSE actor END,
    unpublished_at=CASE WHEN _publish THEN unpublished_at ELSE now() END,
    unpublish_reason=CASE WHEN _publish THEN unpublish_reason ELSE _reason END
  WHERE property_id=_property_id AND finalized_payroll_id=_finalized_payroll_id
    AND status=CASE WHEN _publish THEN 'draft' ELSE 'published' END
    AND (_employee_ids IS NULL OR employee_id=ANY(_employee_ids));
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  PERFORM public.log_audit_event(_property_id,'payroll_payslips',_finalized_payroll_id::text,
    CASE WHEN _publish THEN 'published' ELSE 'unpublished' END,jsonb_build_object('count',changed_count));
  RETURN changed_count;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_prepare_payment_batch(
  _property_id uuid,_finalized_payroll_id uuid,_payment_method text,_idempotency_key uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor uuid := auth.uid(); fp public.finalized_payrolls%ROWTYPE; v_batch_id uuid; line_count integer;
BEGIN
  IF actor IS NULL OR NOT public.has_hrm_permission(actor,_property_id,'payroll_payment_batches','create') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT * INTO fp FROM public.finalized_payrolls WHERE property_id=_property_id AND id=_finalized_payroll_id AND status='finalized';
  IF NOT FOUND THEN RAISE EXCEPTION 'Finalized payroll not found'; END IF;
  INSERT INTO public.payroll_payment_batches(property_id,finalized_payroll_id,batch_code,payment_method,currency,prepared_by,idempotency_key)
  VALUES(_property_id,_finalized_payroll_id,fp.final_payroll_code || '-' || upper(_payment_method),_payment_method,fp.currency,actor,_idempotency_key)
  ON CONFLICT(property_id,finalized_payroll_id,payment_method,idempotency_key) DO UPDATE SET batch_code=EXCLUDED.batch_code
  RETURNING id INTO v_batch_id;
  INSERT INTO public.payroll_payment_batch_lines(property_id,batch_id,finalized_employee_id,employee_id,payment_detail_id,payment_method,
    masked_destination,payment_amount,payment_reference,validation_status)
  SELECT fe.property_id,v_batch_id,fe.id,fe.employee_id,pd.id,_payment_method,
    CASE WHEN _payment_method='bank_transfer' THEN 'Bank ****' || COALESCE(pd.account_number_last4,'0000')
         WHEN _payment_method='mobile_money' THEN 'Mobile ****' || COALESCE(pd.mobile_number_last4,'0000')
         ELSE 'Destination masked' END,
    fe.net_pay,pd.payment_reference,
    CASE WHEN pd.id IS NULL OR pd.verification_status<>'verified' THEN 'warning' ELSE 'valid' END
  FROM public.finalized_payroll_employees fe
  LEFT JOIN LATERAL (
    SELECT * FROM public.payroll_payment_details d WHERE d.property_id=fe.property_id AND d.employee_id=fe.employee_id
      AND d.payment_method=_payment_method AND d.is_primary AND d.archived_at IS NULL ORDER BY d.effective_from DESC LIMIT 1
  ) pd ON true
  WHERE fe.property_id=_property_id AND fe.finalized_payroll_id=_finalized_payroll_id
  ON CONFLICT(property_id,batch_id,finalized_employee_id) DO NOTHING;
  SELECT count(*) INTO line_count FROM public.payroll_payment_batch_lines WHERE property_id=_property_id AND batch_id=v_batch_id;
  UPDATE public.payroll_payment_batches SET employee_count=line_count,
    total_amount=(SELECT COALESCE(sum(payment_amount),0) FROM public.payroll_payment_batch_lines WHERE property_id=_property_id AND batch_id=v_batch_id)
  WHERE property_id=_property_id AND id=v_batch_id;
  PERFORM public.log_audit_event(_property_id,'payroll_payment_batch',v_batch_id::text,'prepared',jsonb_build_object('method',_payment_method));
  RETURN v_batch_id;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_validate_payment_batch(_property_id uuid,_batch_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor uuid := auth.uid(); v_batch_status text;
BEGIN
  IF actor IS NULL OR NOT public.has_hrm_permission(actor,_property_id,'payroll_payment_batches','approve') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  v_batch_status := CASE WHEN EXISTS(
      SELECT 1 FROM public.payroll_payment_batch_lines WHERE property_id=_property_id AND batch_id=_batch_id AND validation_status='blocked'
    ) THEN 'draft' ELSE 'validated' END;
  UPDATE public.payroll_payment_batches SET status=v_batch_status, validated_by=actor, validated_at=now()
  WHERE property_id=_property_id AND id=_batch_id;
  PERFORM public.log_audit_event(_property_id,'payroll_payment_batch',_batch_id::text,'validated',jsonb_build_object('resultStatus',v_batch_status));
END $$;

CREATE OR REPLACE FUNCTION public.payroll_export_payment_batch(_property_id uuid,_batch_id uuid,_template_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor uuid := auth.uid(); v_export_hash text;
BEGIN
  IF actor IS NULL OR NOT public.has_hrm_permission(actor,_property_id,'payroll_payment_exports','export') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF NOT public.has_hrm_permission(actor,_property_id,'payroll_payment_export_sensitive','export') THEN RAISE EXCEPTION 'Sensitive export permission required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.payroll_payment_export_templates WHERE property_id=_property_id AND id=_template_id AND active) THEN
    RAISE EXCEPTION 'Payment export template not found';
  END IF;
  v_export_hash := encode(digest(concat_ws('|',_batch_id::text,_template_id::text,actor::text,clock_timestamp()::text),'sha256'),'hex');
  UPDATE public.payroll_payment_batches SET status='exported',export_version=export_version+1,export_hash=v_export_hash,exported_by=actor,exported_at=now()
    WHERE property_id=_property_id AND id=_batch_id AND status IN('validated','ready_for_export','exported');
  UPDATE public.payroll_payment_batch_lines SET export_status='exported' WHERE property_id=_property_id AND batch_id=_batch_id;
  PERFORM public.log_audit_event(_property_id,'payroll_payment_export',_batch_id::text,'exported',jsonb_build_object('templateId',_template_id,'hash',v_export_hash));
  RETURN v_export_hash;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_prepare_journal_draft(_property_id uuid,_finalized_payroll_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor uuid := auth.uid(); fp public.finalized_payrolls%ROWTYPE; draft_id uuid; v_debit_total numeric(20,4); v_credit_total numeric(20,4);
BEGIN
  IF actor IS NULL OR NOT public.has_hrm_permission(actor,_property_id,'payroll_journal_drafts','create') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT * INTO fp FROM public.finalized_payrolls WHERE property_id=_property_id AND id=_finalized_payroll_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Finalized payroll not found'; END IF;
  INSERT INTO public.payroll_journal_drafts(property_id,finalized_payroll_id,journal_date,reference,description,currency,status,mapping_version,prepared_by)
  VALUES(_property_id,_finalized_payroll_id,current_date,'PAYROLL-' || fp.final_payroll_code,'Journal draft for finalized payroll ' || fp.final_payroll_code,
    fp.currency,'blocked',1,actor)
  ON CONFLICT(property_id,finalized_payroll_id,mapping_version) DO UPDATE SET prepared_at=now()
  RETURNING id INTO draft_id;
  INSERT INTO public.payroll_journal_draft_lines(property_id,journal_draft_id,account_code,account_name,debit,credit,source_line_item_id,explanation,display_order)
  SELECT _property_id,draft_id,m.account_code,m.account_name,
    CASE WHEN m.debit_credit='debit' THEN sum(abs(fli.rounded_amount)) ELSE 0 END,
    CASE WHEN m.debit_credit='credit' THEN sum(abs(fli.rounded_amount)) ELSE 0 END,
    NULL,'Derived from finalized payroll line category ' || m.mapping_category, row_number() OVER()
  FROM public.payroll_journal_mappings m
  JOIN public.finalized_payroll_line_items fli ON fli.property_id=m.property_id AND fli.finalized_payroll_id=_finalized_payroll_id
    AND ((m.mapping_category='earnings_expense' AND fli.line_type IN('base_earning','earning','reimbursement'))
      OR (m.mapping_category='deduction_liability' AND fli.line_type IN('pre_tax_deduction','post_tax_deduction','employee_statutory','tax'))
      OR (m.mapping_category='employer_contribution_expense' AND fli.line_type='employer_statutory')
      OR (m.mapping_category='payroll_payable' AND fli.line_type IN('base_earning','earning','reimbursement')))
  WHERE m.property_id=_property_id AND m.active
  GROUP BY m.account_code,m.account_name,m.debit_credit,m.mapping_category
  ON CONFLICT DO NOTHING;
  SELECT COALESCE(sum(debit),0),COALESCE(sum(credit),0) INTO v_debit_total,v_credit_total
    FROM public.payroll_journal_draft_lines WHERE property_id=_property_id AND journal_draft_id=draft_id;
  UPDATE public.payroll_journal_drafts SET debit_total=v_debit_total,credit_total=v_credit_total,
    status=CASE WHEN v_debit_total=v_credit_total AND v_debit_total>0 THEN 'draft' ELSE 'blocked' END
    WHERE property_id=_property_id AND id=draft_id;
  PERFORM public.log_audit_event(_property_id,'payroll_journal_draft',draft_id::text,'prepared',jsonb_build_object('debitTotal',v_debit_total,'creditTotal',v_credit_total));
  RETURN draft_id;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_close_period(_property_id uuid,_calendar_period_id uuid,_close boolean,_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor uuid := auth.uid();
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF _close AND NOT public.has_hrm_permission(actor,_property_id,'payroll_period_close','approve') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF NOT _close AND NOT public.has_hrm_permission(actor,_property_id,'payroll_period_reopen','manage') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF char_length(trim(COALESCE(_reason,'')))<5 THEN RAISE EXCEPTION 'Reason is required'; END IF;
  UPDATE public.payroll_calendar_periods SET payroll_closed_at=CASE WHEN _close THEN now() ELSE NULL END,
    payroll_closed_by=CASE WHEN _close THEN actor ELSE NULL END,
    payroll_reopened_at=CASE WHEN _close THEN payroll_reopened_at ELSE now() END,
    payroll_reopened_by=CASE WHEN _close THEN payroll_reopened_by ELSE actor END,
    payroll_reopen_reason=CASE WHEN _close THEN payroll_reopen_reason ELSE _reason END
  WHERE property_id=_property_id AND id=_calendar_period_id;
  INSERT INTO public.payroll_period_close_history(property_id,calendar_period_id,action,reason,actor_id)
  VALUES(_property_id,_calendar_period_id,CASE WHEN _close THEN 'closed' ELSE 'reopened' END,_reason,actor);
  PERFORM public.log_audit_event(_property_id,'payroll_period_close',_calendar_period_id::text,
    CASE WHEN _close THEN 'closed' ELSE 'reopened' END,jsonb_build_object('reason',_reason));
END $$;

CREATE OR REPLACE FUNCTION public.payroll_create_correction_request(
  _property_id uuid,_finalized_payroll_id uuid,_affected_employee_id uuid,_request_type text,_reason text,_financial_impact numeric DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor uuid := auth.uid(); correction_id uuid;
BEGIN
  IF actor IS NULL OR NOT public.has_hrm_permission(actor,_property_id,'payroll_corrections','create') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF char_length(trim(COALESCE(_reason,'')))<5 THEN RAISE EXCEPTION 'Reason is required'; END IF;
  INSERT INTO public.payroll_correction_requests(property_id,finalized_payroll_id,affected_employee_id,request_type,reason,financial_impact,created_by)
  VALUES(_property_id,_finalized_payroll_id,_affected_employee_id,_request_type,_reason,_financial_impact,actor)
  RETURNING id INTO correction_id;
  PERFORM public.log_audit_event(_property_id,'payroll_correction',correction_id::text,'requested',
    jsonb_build_object('requestType',_request_type,'finalizedPayrollId',_finalized_payroll_id));
  RETURN correction_id;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_review_correction_request(
  _property_id uuid,_correction_id uuid,_decision text,_review_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor uuid := auth.uid(); v_request public.payroll_correction_requests%ROWTYPE; v_separation_required boolean;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT public.has_hrm_permission(actor,_property_id,'payroll_corrections','approve') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF _decision NOT IN('approved','rejected') THEN RAISE EXCEPTION 'Unsupported correction decision'; END IF;
  SELECT * INTO v_request FROM public.payroll_correction_requests WHERE property_id=_property_id AND id=_correction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Correction request not found'; END IF;
  IF _decision='rejected' AND char_length(trim(COALESCE(_review_reason,'')))<5 THEN RAISE EXCEPTION 'Rejection reason is required'; END IF;
  IF v_request.status=_decision THEN
    RETURN jsonb_build_object('status',v_request.status,'idempotent',true);
  END IF;
  IF v_request.status<>'requested' THEN RAISE EXCEPTION 'Correction request already reviewed with a different decision'; END IF;
  SELECT ps.require_payroll_separation_of_duties INTO v_separation_required
    FROM public.finalized_payrolls fpz
    JOIN public.payroll_runs pr ON pr.property_id=fpz.property_id AND pr.id=fpz.source_payroll_run_id
    JOIN public.payroll_settings ps ON ps.property_id=pr.property_id AND ps.id=pr.payroll_settings_id
    WHERE fpz.property_id=_property_id AND fpz.id=v_request.finalized_payroll_id;
  IF COALESCE(v_separation_required,true) AND v_request.created_by=actor THEN
    RAISE EXCEPTION 'Requester cannot review their own correction request';
  END IF;
  UPDATE public.payroll_correction_requests SET status=_decision,reviewed_by=actor,reviewed_at=now(),
    review_reason=NULLIF(trim(COALESCE(_review_reason,'')),''),updated_at=now()
  WHERE property_id=_property_id AND id=_correction_id;
  INSERT INTO public.payroll_correction_review_history(property_id,correction_request_id,decision,prior_status,reviewer_id,review_reason)
  VALUES(_property_id,_correction_id,_decision,v_request.status,actor,NULLIF(trim(COALESCE(_review_reason,'')),''));
  PERFORM public.log_audit_event(_property_id,'payroll_correction_review',_correction_id::text,_decision,
    jsonb_build_object('decision',_decision,'requestType',v_request.request_type));
  RETURN jsonb_build_object('status',_decision,'idempotent',false);
END $$;

CREATE OR REPLACE FUNCTION public.payroll_execute_reversal_foundation(_property_id uuid,_finalized_payroll_id uuid,_reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor uuid := auth.uid(); reversal_id uuid;
BEGIN
  IF actor IS NULL OR NOT public.has_hrm_permission(actor,_property_id,'payroll_reversals','approve') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF char_length(trim(COALESCE(_reason,'')))<5 THEN RAISE EXCEPTION 'Reason is required'; END IF;
  INSERT INTO public.payroll_reversal_requests(property_id,finalized_payroll_id,status,reason,created_by,executed_by,executed_at)
  VALUES(_property_id,_finalized_payroll_id,'execution_blocked',
    _reason || ' - execution blocked until pending migrations are verified against a disposable database.',actor,actor,now())
  RETURNING id INTO reversal_id;
  PERFORM public.log_audit_event(_property_id,'payroll_reversal',reversal_id::text,'execution_blocked',jsonb_build_object('finalizedPayrollId',_finalized_payroll_id));
  RETURN reversal_id;
END $$;

REVOKE ALL ON FUNCTION public.payroll_approval_transition(uuid,uuid,text,integer,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_finalize_run(uuid,uuid,integer,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_generate_payslips(uuid,uuid,uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_publish_payslips(uuid,uuid,uuid[],boolean,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_prepare_payment_batch(uuid,uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_validate_payment_batch(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_export_payment_batch(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_prepare_journal_draft(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_close_period(uuid,uuid,boolean,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_create_correction_request(uuid,uuid,uuid,text,text,numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_review_correction_request(uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_execute_reversal_foundation(uuid,uuid,text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.payroll_approval_transition(uuid,uuid,text,integer,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_finalize_run(uuid,uuid,integer,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_generate_payslips(uuid,uuid,uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_publish_payslips(uuid,uuid,uuid[],boolean,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_prepare_payment_batch(uuid,uuid,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_validate_payment_batch(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_export_payment_batch(uuid,uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_prepare_journal_draft(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_close_period(uuid,uuid,boolean,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_create_correction_request(uuid,uuid,uuid,text,text,numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_review_correction_request(uuid,uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_execute_reversal_foundation(uuid,uuid,text) TO authenticated;

GRANT SELECT ON public.payroll_approval_actions,public.finalized_payrolls,public.finalized_payroll_employees,
  public.finalized_payroll_line_items,public.payroll_payslips,public.payroll_payment_export_templates,
  public.payroll_payment_batches,public.payroll_payment_batch_lines,public.payroll_statutory_liability_summaries,
  public.payroll_journal_mappings,public.payroll_journal_drafts,public.payroll_journal_draft_lines,
  public.payroll_period_close_history,public.payroll_correction_requests,public.payroll_correction_review_history,
  public.payroll_reversal_requests TO authenticated;

DO $$
DECLARE permission record;
BEGIN
  FOR permission IN SELECT * FROM (VALUES
    ('payroll_approvals','create'),('payroll_approvals','read'),('payroll_approvals','approve'),('payroll_approvals','delete'),
    ('payroll_finalization','approve'),('finalized_payroll','read'),('finalized_payroll_sensitive','read'),
    ('payslips','create'),('payslips','approve'),('payslips','delete'),('payslips_own','read'),('payslip_downloads','read'),
    ('payroll_payment_batches','read'),('payroll_payment_batches','create'),('payroll_payment_batches','approve'),
    ('payroll_payment_exports','export'),('payroll_payment_export_sensitive','export'),
    ('payroll_payment_templates','read'),('payroll_payment_templates','manage'),
    ('payroll_statutory_liabilities','read'),('payroll_statutory_liabilities','export'),
    ('payroll_journal_mappings','read'),('payroll_journal_mappings','manage'),
    ('payroll_journal_drafts','read'),('payroll_journal_drafts','create'),('payroll_journal_drafts','export'),
    ('payroll_period_close','approve'),('payroll_period_reopen','manage'),
    ('payroll_corrections','read'),('payroll_corrections','create'),('payroll_corrections','approve'),
    ('payroll_reversals','read'),('payroll_reversals','approve'),
    ('supplemental_payroll','create'),('finalized_payroll_reports','export'),('finalized_payroll_reports','print')
  ) AS p(module,action) LOOP
    INSERT INTO public.role_permissions(role,module,action,allowed)
    VALUES('super_admin',permission.module,permission.action,true),
      ('hotel_owner',permission.module,permission.action,true),
      ('hr',permission.module,permission.action,true)
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

COMMENT ON TABLE public.finalized_payrolls IS 'Immutable finalized payroll snapshots; no payment, statutory submission, or accounting posting is implied.';
COMMENT ON TABLE public.payroll_payment_batches IS 'Payment preparation/export foundation only. Statuses intentionally exclude sent, processed, settled and paid.';
COMMENT ON TABLE public.payroll_journal_drafts IS 'Accounting journal drafts only; no external accounting posting is performed.';
