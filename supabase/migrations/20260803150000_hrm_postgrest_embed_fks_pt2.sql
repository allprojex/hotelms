
-- Follow-up to 20260803140000_hrm_postgrest_embed_fks.sql: the same composite
-- (property_id, x) FK / PostgREST-embedding problem exists across the rest of
-- the HRM schema (scheduling, attendance, leave, biometric) - not just
-- employees/designations/departments. Confirmed live: /hrm/leave failed with
-- "Could not find a relationship between 'hr_leave_requests' and
-- 'employee_id' in the schema cache" even after the first migration.
--
-- Same fix, same reasoning: additive simple single-column FKs purely so
-- PostgREST can discover the relationship for embedding. The composite FKs
-- remain the real cross-property integrity guarantee; nothing here changes
-- existing behavior, RLS, or data.
--
-- Scope: workforce_scheduling, attendance_management, and
-- leave_and_biometric_foundation only (what /hrm/employees, /hrm/attendance,
-- and /hrm/leave actually query). WebAuthn/passkeys, expense management, and
-- payroll have the identical composite-FK pattern and will very likely need
-- the same treatment once their embedding queries are exercised - flagged
-- separately, not included in this pass.

-- workforce_scheduling
ALTER TABLE public.hr_duty_roster
  ADD CONSTRAINT hr_duty_roster_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE RESTRICT,
  ADD CONSTRAINT hr_duty_roster_shift_id_fkey
    FOREIGN KEY (shift_id) REFERENCES public.hr_shift_templates(id) ON DELETE RESTRICT,
  ADD CONSTRAINT hr_duty_roster_department_id_fkey
    FOREIGN KEY (department_id) REFERENCES public.hr_departments(id) ON DELETE RESTRICT;

ALTER TABLE public.hr_holiday_departments
  ADD CONSTRAINT hr_holiday_departments_holiday_id_fkey
    FOREIGN KEY (holiday_id) REFERENCES public.hr_holidays(id) ON DELETE CASCADE,
  ADD CONSTRAINT hr_holiday_departments_department_id_fkey
    FOREIGN KEY (department_id) REFERENCES public.hr_departments(id) ON DELETE RESTRICT;

-- attendance_management
ALTER TABLE public.hr_attendance_events
  ADD CONSTRAINT hr_attendance_events_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE RESTRICT,
  ADD CONSTRAINT hr_attendance_events_roster_id_fkey
    FOREIGN KEY (roster_id) REFERENCES public.hr_duty_roster(id) ON DELETE RESTRICT;

ALTER TABLE public.hr_attendance_summaries
  ADD CONSTRAINT hr_attendance_summaries_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE RESTRICT,
  ADD CONSTRAINT hr_attendance_summaries_roster_id_fkey
    FOREIGN KEY (roster_id) REFERENCES public.hr_duty_roster(id) ON DELETE RESTRICT;

ALTER TABLE public.hr_attendance_calculation_runs
  ADD CONSTRAINT hr_attendance_calculation_runs_summary_id_fkey
    FOREIGN KEY (summary_id) REFERENCES public.hr_attendance_summaries(id) ON DELETE RESTRICT,
  ADD CONSTRAINT hr_attendance_calculation_runs_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE RESTRICT;

ALTER TABLE public.hr_attendance_adjustments
  ADD CONSTRAINT hr_attendance_adjustments_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE RESTRICT,
  ADD CONSTRAINT hr_attendance_adjustments_summary_id_fkey
    FOREIGN KEY (summary_id) REFERENCES public.hr_attendance_summaries(id) ON DELETE RESTRICT;

-- leave_and_biometric_foundation
ALTER TABLE public.hr_leave_balances
  ADD CONSTRAINT hr_leave_balances_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE RESTRICT,
  ADD CONSTRAINT hr_leave_balances_leave_type_id_fkey
    FOREIGN KEY (leave_type_id) REFERENCES public.hr_leave_types(id) ON DELETE RESTRICT;

ALTER TABLE public.hr_leave_requests
  ADD CONSTRAINT hr_leave_requests_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE RESTRICT,
  ADD CONSTRAINT hr_leave_requests_leave_type_id_fkey
    FOREIGN KEY (leave_type_id) REFERENCES public.hr_leave_types(id) ON DELETE RESTRICT;

ALTER TABLE public.hr_leave_approval_history
  ADD CONSTRAINT hr_leave_approval_history_request_id_fkey
    FOREIGN KEY (request_id) REFERENCES public.hr_leave_requests(id) ON DELETE RESTRICT;

ALTER TABLE public.hr_leave_balance_adjustments
  ADD CONSTRAINT hr_leave_balance_adjustments_balance_id_fkey
    FOREIGN KEY (balance_id) REFERENCES public.hr_leave_balances(id) ON DELETE RESTRICT;

ALTER TABLE public.hr_roster_leave_conflicts
  ADD CONSTRAINT hr_roster_leave_conflicts_roster_id_fkey
    FOREIGN KEY (roster_id) REFERENCES public.hr_duty_roster(id) ON DELETE RESTRICT,
  ADD CONSTRAINT hr_roster_leave_conflicts_leave_request_id_fkey
    FOREIGN KEY (leave_request_id) REFERENCES public.hr_leave_requests(id) ON DELETE RESTRICT;

ALTER TABLE public.hr_biometric_employee_mappings
  ADD CONSTRAINT hr_biometric_employee_mappings_device_id_fkey
    FOREIGN KEY (device_id) REFERENCES public.hr_biometric_devices(id) ON DELETE RESTRICT,
  ADD CONSTRAINT hr_biometric_employee_mappings_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE RESTRICT;

ALTER TABLE public.hr_biometric_import_batches
  ADD CONSTRAINT hr_biometric_import_batches_device_id_fkey
    FOREIGN KEY (device_id) REFERENCES public.hr_biometric_devices(id) ON DELETE RESTRICT;

ALTER TABLE public.hr_biometric_normalized_events
  ADD CONSTRAINT hr_biometric_normalized_events_device_id_fkey
    FOREIGN KEY (device_id) REFERENCES public.hr_biometric_devices(id) ON DELETE RESTRICT,
  ADD CONSTRAINT hr_biometric_normalized_events_batch_id_fkey
    FOREIGN KEY (batch_id) REFERENCES public.hr_biometric_import_batches(id) ON DELETE RESTRICT,
  ADD CONSTRAINT hr_biometric_normalized_events_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE RESTRICT;

ALTER TABLE public.hr_biometric_processing_logs
  ADD CONSTRAINT hr_biometric_processing_logs_normalized_event_id_fkey
    FOREIGN KEY (normalized_event_id) REFERENCES public.hr_biometric_normalized_events(id) ON DELETE RESTRICT;

-- hr_announcement_* junction tables (announcements page embeds these)
ALTER TABLE public.hr_announcement_departments
  ADD CONSTRAINT hr_announcement_departments_announcement_id_fkey
    FOREIGN KEY (announcement_id) REFERENCES public.hr_staff_announcements(id) ON DELETE CASCADE,
  ADD CONSTRAINT hr_announcement_departments_department_id_fkey
    FOREIGN KEY (department_id) REFERENCES public.hr_departments(id) ON DELETE RESTRICT;

ALTER TABLE public.hr_announcement_designations
  ADD CONSTRAINT hr_announcement_designations_announcement_id_fkey
    FOREIGN KEY (announcement_id) REFERENCES public.hr_staff_announcements(id) ON DELETE CASCADE,
  ADD CONSTRAINT hr_announcement_designations_designation_id_fkey
    FOREIGN KEY (designation_id) REFERENCES public.hr_designations(id) ON DELETE RESTRICT;

ALTER TABLE public.hr_announcement_employees
  ADD CONSTRAINT hr_announcement_employees_announcement_id_fkey
    FOREIGN KEY (announcement_id) REFERENCES public.hr_staff_announcements(id) ON DELETE CASCADE,
  ADD CONSTRAINT hr_announcement_employees_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE RESTRICT;

-- hr_employee_documents (Employee Documents page embeds this)
ALTER TABLE public.hr_employee_documents
  ADD CONSTRAINT hr_employee_documents_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE RESTRICT;
