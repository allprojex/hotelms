
-- Task 4 of the stabilization audit: check whether the same composite-FK /
-- PostgREST-embedding problem (fixed for HRM in 20260803140000/150000/160000)
-- also exists in Payroll, Expense Management, and WebAuthn.
--
-- Expense management: verified already correct - every property-scoped
-- reference column on expenses/cost_centres/etc. has BOTH an inline simple FK
-- and the composite FK from the same original migration. No fix needed
-- (confirmed live via REST).
--
-- WebAuthn: passkey_enrollments.employee_id and
-- passkey_enrollment_history.enrollment_id are composite-only, matching the
-- broken pattern, but nothing embeds them via alias:column(...) yet (no
-- passkey query joins employee/enrollment names). Not fixed here since
-- there's nothing to verify against; flagged as a known latent risk if that
-- changes.
--
-- Payroll: confirmed broken - every payroll_* table uses the same
-- composite-only (property_id, x) FK pattern as the original HRM tables,
-- and payroll-runs.functions.ts / payroll-finalization.functions.ts /
-- payroll.functions.ts embed these relationships via explicit
-- alias:column(...) syntax throughout (e.g. "period:calendar_period_id(...)",
-- "employee:employee_id(...)", "payroll:finalized_payroll_id(...)").
-- No bare (unaliased) embeds exist anywhere in the payroll functions, so
-- there is no ambiguity risk here the way there was for HRM's junction
-- tables - safe to add the full set in one pass.

ALTER TABLE public.payroll_settings
  ADD CONSTRAINT payroll_settings_default_pay_frequency_id_fkey
    FOREIGN KEY (default_pay_frequency_id) REFERENCES public.payroll_pay_frequencies(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_calendar_periods
  ADD CONSTRAINT payroll_calendar_periods_pay_frequency_id_fkey
    FOREIGN KEY (pay_frequency_id) REFERENCES public.payroll_pay_frequencies(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_salary_structures
  ADD CONSTRAINT payroll_salary_structures_pay_frequency_id_fkey
    FOREIGN KEY (pay_frequency_id) REFERENCES public.payroll_pay_frequencies(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_salary_grades
  ADD CONSTRAINT payroll_salary_grades_salary_structure_id_fkey
    FOREIGN KEY (salary_structure_id) REFERENCES public.payroll_salary_structures(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_structure_components
  ADD CONSTRAINT payroll_structure_components_salary_structure_id_fkey
    FOREIGN KEY (salary_structure_id) REFERENCES public.payroll_salary_structures(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_structure_components_salary_grade_id_fkey
    FOREIGN KEY (salary_grade_id) REFERENCES public.payroll_salary_grades(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_structure_components_pay_component_id_fkey
    FOREIGN KEY (pay_component_id) REFERENCES public.payroll_pay_components(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_employee_compensations
  ADD CONSTRAINT payroll_employee_compensations_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_employee_compensations_salary_structure_id_fkey
    FOREIGN KEY (salary_structure_id) REFERENCES public.payroll_salary_structures(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_employee_compensations_salary_grade_id_fkey
    FOREIGN KEY (salary_grade_id) REFERENCES public.payroll_salary_grades(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_employee_compensations_pay_frequency_id_fkey
    FOREIGN KEY (pay_frequency_id) REFERENCES public.payroll_pay_frequencies(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_employee_components
  ADD CONSTRAINT payroll_employee_components_compensation_id_fkey
    FOREIGN KEY (compensation_id) REFERENCES public.payroll_employee_compensations(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_employee_components_pay_component_id_fkey
    FOREIGN KEY (pay_component_id) REFERENCES public.payroll_pay_components(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_payment_details
  ADD CONSTRAINT payroll_payment_details_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_opening_balances
  ADD CONSTRAINT payroll_opening_balances_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_opening_balances_import_batch_id_fkey
    FOREIGN KEY (import_batch_id) REFERENCES public.payroll_opening_import_batches(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_opening_balances_supersedes_id_fkey
    FOREIGN KEY (supersedes_id) REFERENCES public.payroll_opening_balances(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_component_calculation_rules
  ADD CONSTRAINT payroll_component_calculation_rules_pay_component_id_fkey
    FOREIGN KEY (pay_component_id) REFERENCES public.payroll_pay_components(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_component_calculation_rules_basis_component_id_fkey
    FOREIGN KEY (basis_component_id) REFERENCES public.payroll_pay_components(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_runs
  ADD CONSTRAINT payroll_runs_calendar_period_id_fkey
    FOREIGN KEY (calendar_period_id) REFERENCES public.payroll_calendar_periods(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_runs_payroll_settings_id_fkey
    FOREIGN KEY (payroll_settings_id) REFERENCES public.payroll_settings(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_run_versions
  ADD CONSTRAINT payroll_run_versions_payroll_run_id_fkey
    FOREIGN KEY (payroll_run_id) REFERENCES public.payroll_runs(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_run_versions_payroll_settings_id_fkey
    FOREIGN KEY (payroll_settings_id) REFERENCES public.payroll_settings(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_run_employees
  ADD CONSTRAINT payroll_run_employees_payroll_run_id_fkey
    FOREIGN KEY (payroll_run_id) REFERENCES public.payroll_runs(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_run_employees_run_version_id_fkey
    FOREIGN KEY (run_version_id) REFERENCES public.payroll_run_versions(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_run_employees_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_run_employees_compensation_id_fkey
    FOREIGN KEY (compensation_id) REFERENCES public.payroll_employee_compensations(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_run_line_items
  ADD CONSTRAINT payroll_run_line_items_payroll_run_id_fkey
    FOREIGN KEY (payroll_run_id) REFERENCES public.payroll_runs(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_run_line_items_run_version_id_fkey
    FOREIGN KEY (run_version_id) REFERENCES public.payroll_run_versions(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_run_line_items_run_employee_id_fkey
    FOREIGN KEY (run_employee_id) REFERENCES public.payroll_run_employees(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_run_line_items_pay_component_id_fkey
    FOREIGN KEY (pay_component_id) REFERENCES public.payroll_pay_components(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_run_line_items_statutory_rule_id_fkey
    FOREIGN KEY (statutory_rule_id) REFERENCES public.payroll_statutory_rule_sets(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_calculation_findings
  ADD CONSTRAINT payroll_calculation_findings_payroll_run_id_fkey
    FOREIGN KEY (payroll_run_id) REFERENCES public.payroll_runs(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_calculation_findings_run_version_id_fkey
    FOREIGN KEY (run_version_id) REFERENCES public.payroll_run_versions(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_calculation_findings_run_employee_id_fkey
    FOREIGN KEY (run_employee_id) REFERENCES public.payroll_run_employees(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_manual_inputs
  ADD CONSTRAINT payroll_manual_inputs_calendar_period_id_fkey
    FOREIGN KEY (calendar_period_id) REFERENCES public.payroll_calendar_periods(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_manual_inputs_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_manual_inputs_pay_component_id_fkey
    FOREIGN KEY (pay_component_id) REFERENCES public.payroll_pay_components(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_manual_inputs_supersedes_id_fkey
    FOREIGN KEY (supersedes_id) REFERENCES public.payroll_manual_inputs(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_approval_actions
  ADD CONSTRAINT payroll_approval_actions_payroll_run_id_fkey
    FOREIGN KEY (payroll_run_id) REFERENCES public.payroll_runs(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_approval_actions_run_version_id_fkey
    FOREIGN KEY (run_version_id) REFERENCES public.payroll_run_versions(id) ON DELETE RESTRICT;

ALTER TABLE public.finalized_payrolls
  ADD CONSTRAINT finalized_payrolls_source_payroll_run_id_fkey
    FOREIGN KEY (source_payroll_run_id) REFERENCES public.payroll_runs(id) ON DELETE RESTRICT,
  ADD CONSTRAINT finalized_payrolls_source_run_version_id_fkey
    FOREIGN KEY (source_run_version_id) REFERENCES public.payroll_run_versions(id) ON DELETE RESTRICT,
  ADD CONSTRAINT finalized_payrolls_calendar_period_id_fkey
    FOREIGN KEY (calendar_period_id) REFERENCES public.payroll_calendar_periods(id) ON DELETE RESTRICT;

ALTER TABLE public.finalized_payroll_employees
  ADD CONSTRAINT finalized_payroll_employees_finalized_payroll_id_fkey
    FOREIGN KEY (finalized_payroll_id) REFERENCES public.finalized_payrolls(id) ON DELETE RESTRICT,
  ADD CONSTRAINT finalized_payroll_employees_source_run_employee_id_fkey
    FOREIGN KEY (source_run_employee_id) REFERENCES public.payroll_run_employees(id) ON DELETE RESTRICT,
  ADD CONSTRAINT finalized_payroll_employees_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE RESTRICT;

ALTER TABLE public.finalized_payroll_line_items
  ADD CONSTRAINT finalized_payroll_line_items_finalized_payroll_id_fkey
    FOREIGN KEY (finalized_payroll_id) REFERENCES public.finalized_payrolls(id) ON DELETE RESTRICT,
  ADD CONSTRAINT finalized_payroll_line_items_finalized_employee_id_fkey
    FOREIGN KEY (finalized_employee_id) REFERENCES public.finalized_payroll_employees(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_payslips
  ADD CONSTRAINT payroll_payslips_finalized_payroll_id_fkey
    FOREIGN KEY (finalized_payroll_id) REFERENCES public.finalized_payrolls(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_payslips_finalized_employee_id_fkey
    FOREIGN KEY (finalized_employee_id) REFERENCES public.finalized_payroll_employees(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_payslips_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_payment_batches
  ADD CONSTRAINT payroll_payment_batches_finalized_payroll_id_fkey
    FOREIGN KEY (finalized_payroll_id) REFERENCES public.finalized_payrolls(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_payment_batch_lines
  ADD CONSTRAINT payroll_payment_batch_lines_batch_id_fkey
    FOREIGN KEY (batch_id) REFERENCES public.payroll_payment_batches(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_payment_batch_lines_finalized_employee_id_fkey
    FOREIGN KEY (finalized_employee_id) REFERENCES public.finalized_payroll_employees(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_payment_batch_lines_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_payment_batch_lines_payment_detail_id_fkey
    FOREIGN KEY (payment_detail_id) REFERENCES public.payroll_payment_details(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_statutory_liability_summaries
  ADD CONSTRAINT payroll_statutory_liability_summaries_finalized_payroll_id_fkey
    FOREIGN KEY (finalized_payroll_id) REFERENCES public.finalized_payrolls(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_journal_drafts
  ADD CONSTRAINT payroll_journal_drafts_finalized_payroll_id_fkey
    FOREIGN KEY (finalized_payroll_id) REFERENCES public.finalized_payrolls(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_journal_draft_lines
  ADD CONSTRAINT payroll_journal_draft_lines_journal_draft_id_fkey
    FOREIGN KEY (journal_draft_id) REFERENCES public.payroll_journal_drafts(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_period_close_history
  ADD CONSTRAINT payroll_period_close_history_calendar_period_id_fkey
    FOREIGN KEY (calendar_period_id) REFERENCES public.payroll_calendar_periods(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_correction_requests
  ADD CONSTRAINT payroll_correction_requests_finalized_payroll_id_fkey
    FOREIGN KEY (finalized_payroll_id) REFERENCES public.finalized_payrolls(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_correction_requests_affected_employee_id_fkey
    FOREIGN KEY (affected_employee_id) REFERENCES public.hr_employees(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_correction_review_history
  ADD CONSTRAINT payroll_correction_review_history_correction_request_id_fkey
    FOREIGN KEY (correction_request_id) REFERENCES public.payroll_correction_requests(id) ON DELETE RESTRICT;

ALTER TABLE public.payroll_reversal_requests
  ADD CONSTRAINT payroll_reversal_requests_finalized_payroll_id_fkey
    FOREIGN KEY (finalized_payroll_id) REFERENCES public.finalized_payrolls(id) ON DELETE RESTRICT;
