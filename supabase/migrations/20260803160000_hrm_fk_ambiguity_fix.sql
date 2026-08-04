
-- Follow-up to 20260803150000: five of the simple FKs just added were
-- redundant with an existing composite FK on the same column, and several
-- queries embed with the *bare* target table name (no alias/column hint),
-- e.g. "*,hr_roster_leave_conflicts(id,status)" in leave.functions.ts and
-- "*,hr_announcement_departments(department_id),..." in hrm.functions.ts.
-- PostgREST resolves a bare embed only when exactly one relationship exists
-- between the two tables; adding a second (simple) FK on top of the original
-- composite one made these specific relationships ambiguous, breaking
-- queries that worked before 20260803150000 - confirmed live:
-- "Could not embed because more than one relationship was found for
-- 'hr_leave_requests' and 'hr_roster_leave_conflicts'".
--
-- Each of these five had exactly one legitimate relationship pre-existing
-- (the composite FK), so the fix is to drop the redundant addition rather
-- than touch application code. This does not reintroduce the original
-- "relationship not found" bug because these five were never using the
-- simple FK in the first place - only the explicit alias:column(...) embeds
-- (already verified working, e.g. department:department_id(...)) need a
-- simple FK to resolve.
ALTER TABLE public.hr_roster_leave_conflicts
  DROP CONSTRAINT hr_roster_leave_conflicts_leave_request_id_fkey;

ALTER TABLE public.hr_holiday_departments
  DROP CONSTRAINT hr_holiday_departments_holiday_id_fkey;

ALTER TABLE public.hr_announcement_departments
  DROP CONSTRAINT hr_announcement_departments_announcement_id_fkey;

ALTER TABLE public.hr_announcement_designations
  DROP CONSTRAINT hr_announcement_designations_announcement_id_fkey;

ALTER TABLE public.hr_announcement_employees
  DROP CONSTRAINT hr_announcement_employees_announcement_id_fkey;

-- hr_employees <-> hr_departments has two genuinely distinct relationships
-- (employee's department via department_id, and department's head via
-- department_head_id) that were ALREADY ambiguous for a bare embed before
-- any of these migrations - this is not new. getHrmDashboard's bare
-- "hr_departments(name),hr_designations(title)" embed has been fixed in
-- src/lib/hrm/hrm.functions.ts to use explicit department:department_id(...)
-- / designation:designation_id(...) hints instead (same pattern already used
-- by listEmployees/getEmployee), so no schema change is needed for that one -
-- department_head_id's simple FK is kept since head:department_head_id(...)
-- in listDepartments also uses an explicit hint and is unaffected.
