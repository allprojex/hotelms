
-- Fix: HRM tables use composite foreign keys (property_id, x) so a department/
-- designation/manager reference can never cross a property boundary. But
-- PostgREST's relationship-embedding (the "department:department_id(name)"
-- syntax used throughout src/lib/hrm/hrm.functions.ts) only resolves simple,
-- single-column foreign keys - it cannot see composite ones at all. Every HRM
-- list/detail query that embeds a department, designation, manager, or
-- department head name has been failing with "Could not find a relationship
-- between ... in the schema cache" since these tables were introduced.
--
-- These additive, simple single-column FKs exist purely so PostgREST can
-- discover the relationship for embedding. They duplicate what the existing
-- composite FKs already enforce and change no application behavior or RLS -
-- the composite FKs remain the actual cross-property integrity guarantee.

ALTER TABLE public.hr_employees
  ADD CONSTRAINT hr_employees_department_id_fkey
    FOREIGN KEY (department_id) REFERENCES public.hr_departments(id) ON DELETE SET NULL,
  ADD CONSTRAINT hr_employees_designation_id_fkey
    FOREIGN KEY (designation_id) REFERENCES public.hr_designations(id) ON DELETE SET NULL,
  ADD CONSTRAINT hr_employees_reporting_manager_id_fkey
    FOREIGN KEY (reporting_manager_id) REFERENCES public.hr_employees(id) ON DELETE SET NULL;

ALTER TABLE public.hr_designations
  ADD CONSTRAINT hr_designations_department_id_fkey
    FOREIGN KEY (department_id) REFERENCES public.hr_departments(id) ON DELETE SET NULL;

ALTER TABLE public.hr_departments
  ADD CONSTRAINT hr_departments_department_head_id_fkey
    FOREIGN KEY (department_head_id) REFERENCES public.hr_employees(id) ON DELETE SET NULL;
