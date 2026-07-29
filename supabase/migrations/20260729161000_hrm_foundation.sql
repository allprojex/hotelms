-- Phase 2: property-scoped HRM foundation.
-- Additive only. No existing tables or columns are renamed or removed.

CREATE OR REPLACE FUNCTION public.has_hrm_permission(
  _user_id uuid,
  _property_id uuid,
  _module text,
  _action text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    LEFT JOIN LATERAL (
      SELECT candidate.allowed
      FROM public.role_permissions candidate
      WHERE candidate.role = ur.role
        AND candidate.custom_role_id IS NULL
        AND (candidate.property_id IS NULL OR candidate.property_id = _property_id)
        AND candidate.module = _module
        AND candidate.action = _action
      ORDER BY (candidate.property_id = _property_id) DESC
      LIMIT 1
    ) rp ON true
    WHERE ur.user_id = _user_id
      AND (ur.property_id IS NULL OR ur.property_id = _property_id)
      AND (
        ur.role = 'super_admin'
        OR COALESCE(rp.allowed, false)
      )
  )
$$;

REVOKE ALL ON FUNCTION public.has_hrm_permission(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_hrm_permission(uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_hrm_permission(uuid, uuid, text, text) TO service_role;

CREATE TABLE public.hr_departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
  code text NOT NULL CHECK (char_length(trim(code)) BETWEEN 1 AND 40),
  description text,
  department_head_id uuid,
  parent_department_id uuid REFERENCES public.hr_departments(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  archived_at timestamptz,
  archived_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, code),
  UNIQUE (property_id, id)
);

CREATE TABLE public.hr_designations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  department_id uuid,
  title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 120),
  code text NOT NULL CHECK (char_length(trim(code)) BETWEEN 1 AND 40),
  description text,
  rank integer CHECK (rank IS NULL OR rank >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  archived_at timestamptz,
  archived_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, code),
  UNIQUE (property_id, id),
  FOREIGN KEY (property_id, department_id)
    REFERENCES public.hr_departments(property_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.hr_employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  employee_number text NOT NULL CHECK (char_length(trim(employee_number)) BETWEEN 1 AND 50),
  first_name text NOT NULL CHECK (char_length(trim(first_name)) BETWEEN 1 AND 100),
  middle_name text,
  last_name text NOT NULL CHECK (char_length(trim(last_name)) BETWEEN 1 AND 100),
  preferred_name text,
  profile_photo_path text,
  work_email text,
  department_id uuid,
  designation_id uuid,
  employment_type text NOT NULL DEFAULT 'full_time'
    CHECK (employment_type IN ('full_time', 'part_time', 'contract', 'temporary', 'casual', 'intern')),
  employment_status text NOT NULL DEFAULT 'active'
    CHECK (employment_status IN ('active', 'inactive', 'probation', 'suspended', 'exited', 'archived')),
  hire_date date NOT NULL DEFAULT current_date,
  probation_end_date date,
  confirmation_date date,
  exit_date date,
  reporting_manager_id uuid,
  work_location text,
  staff_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes text,
  tags text[] NOT NULL DEFAULT '{}',
  archived_at timestamptz,
  archived_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, employee_number),
  UNIQUE (property_id, id),
  FOREIGN KEY (property_id, department_id)
    REFERENCES public.hr_departments(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, designation_id)
    REFERENCES public.hr_designations(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, reporting_manager_id)
    REFERENCES public.hr_employees(property_id, id) ON DELETE RESTRICT,
  CHECK (reporting_manager_id IS NULL OR reporting_manager_id <> id),
  CHECK (exit_date IS NULL OR exit_date >= hire_date),
  CHECK (confirmation_date IS NULL OR confirmation_date >= hire_date),
  CHECK (probation_end_date IS NULL OR probation_end_date >= hire_date)
);

CREATE UNIQUE INDEX hr_employees_active_staff_user_uniq
  ON public.hr_employees(property_id, staff_user_id)
  WHERE staff_user_id IS NOT NULL AND archived_at IS NULL;

CREATE TABLE public.hr_employee_private (
  employee_id uuid PRIMARY KEY REFERENCES public.hr_employees(id) ON DELETE RESTRICT,
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  date_of_birth date,
  gender text,
  nationality text,
  marital_status text,
  personal_email text,
  primary_phone text,
  alternate_phone text,
  residential_address text,
  emergency_contact_name text,
  emergency_contact_relationship text,
  emergency_contact_phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, employee_id),
  FOREIGN KEY (property_id, employee_id)
    REFERENCES public.hr_employees(property_id, id) ON DELETE RESTRICT
);

ALTER TABLE public.hr_departments
  ADD CONSTRAINT hr_departments_head_fk
  FOREIGN KEY (property_id, department_head_id)
  REFERENCES public.hr_employees(property_id, id) ON DELETE RESTRICT;

CREATE TABLE public.hr_employee_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN (
    'employment_contract', 'identification', 'certificate', 'qualification',
    'appointment_letter', 'confirmation_letter', 'policy_acknowledgment',
    'medical_document', 'immigration_or_work_permit', 'other'
  )),
  title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 160),
  description text,
  storage_path text NOT NULL,
  file_name text NOT NULL,
  file_type text NOT NULL,
  file_size bigint NOT NULL CHECK (file_size > 0 AND file_size <= 10485760),
  issue_date date,
  expiry_date date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'archived')),
  confidentiality_level text NOT NULL DEFAULT 'internal'
    CHECK (confidentiality_level IN ('internal', 'confidential')),
  uploaded_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  archived_at timestamptz,
  archived_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, storage_path),
  UNIQUE (property_id, id),
  FOREIGN KEY (property_id, employee_id)
    REFERENCES public.hr_employees(property_id, id) ON DELETE RESTRICT,
  CHECK (expiry_date IS NULL OR issue_date IS NULL OR expiry_date >= issue_date)
);

CREATE TABLE public.hr_staff_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 180),
  content text NOT NULL CHECK (char_length(trim(content)) BETWEEN 1 AND 10000),
  audience_type text NOT NULL DEFAULT 'all_staff'
    CHECK (audience_type IN ('all_staff', 'departments', 'designations', 'employees')),
  publication_status text NOT NULL DEFAULT 'draft'
    CHECK (publication_status IN ('draft', 'published', 'unpublished', 'archived')),
  publish_date timestamptz,
  expiry_date timestamptz,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  archived_at timestamptz,
  archived_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, id),
  CHECK (expiry_date IS NULL OR publish_date IS NULL OR expiry_date > publish_date)
);

CREATE TABLE public.hr_announcement_departments (
  announcement_id uuid NOT NULL,
  property_id uuid NOT NULL,
  department_id uuid NOT NULL,
  PRIMARY KEY (announcement_id, department_id),
  FOREIGN KEY (property_id, announcement_id)
    REFERENCES public.hr_staff_announcements(property_id, id) ON DELETE CASCADE,
  FOREIGN KEY (property_id, department_id)
    REFERENCES public.hr_departments(property_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.hr_announcement_designations (
  announcement_id uuid NOT NULL,
  property_id uuid NOT NULL,
  designation_id uuid NOT NULL,
  PRIMARY KEY (announcement_id, designation_id),
  FOREIGN KEY (property_id, announcement_id)
    REFERENCES public.hr_staff_announcements(property_id, id) ON DELETE CASCADE,
  FOREIGN KEY (property_id, designation_id)
    REFERENCES public.hr_designations(property_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.hr_announcement_employees (
  announcement_id uuid NOT NULL,
  property_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  PRIMARY KEY (announcement_id, employee_id),
  FOREIGN KEY (property_id, announcement_id)
    REFERENCES public.hr_staff_announcements(property_id, id) ON DELETE CASCADE,
  FOREIGN KEY (property_id, employee_id)
    REFERENCES public.hr_employees(property_id, id) ON DELETE RESTRICT
);

CREATE INDEX hr_departments_property_status_idx
  ON public.hr_departments(property_id, status, name);
CREATE UNIQUE INDEX hr_departments_property_code_ci_uniq
  ON public.hr_departments(property_id, lower(code));
CREATE INDEX hr_departments_parent_idx
  ON public.hr_departments(parent_department_id);
CREATE INDEX hr_designations_property_status_idx
  ON public.hr_designations(property_id, status, title);
CREATE UNIQUE INDEX hr_designations_property_code_ci_uniq
  ON public.hr_designations(property_id, lower(code));
CREATE INDEX hr_designations_department_idx
  ON public.hr_designations(department_id);
CREATE INDEX hr_employees_property_status_idx
  ON public.hr_employees(property_id, employment_status, last_name, first_name);
CREATE UNIQUE INDEX hr_employees_property_number_ci_uniq
  ON public.hr_employees(property_id, lower(employee_number));
CREATE INDEX hr_employees_department_idx
  ON public.hr_employees(property_id, department_id);
CREATE INDEX hr_employees_designation_idx
  ON public.hr_employees(property_id, designation_id);
CREATE INDEX hr_employees_hire_date_idx
  ON public.hr_employees(property_id, hire_date DESC);
CREATE INDEX hr_employees_manager_idx
  ON public.hr_employees(reporting_manager_id);
CREATE INDEX hr_employee_documents_employee_idx
  ON public.hr_employee_documents(property_id, employee_id, created_at DESC);
CREATE INDEX hr_employee_documents_expiry_idx
  ON public.hr_employee_documents(property_id, expiry_date)
  WHERE archived_at IS NULL;
CREATE INDEX hr_announcements_active_idx
  ON public.hr_staff_announcements(property_id, publication_status, publish_date, expiry_date);

CREATE OR REPLACE FUNCTION public.hr_validate_department_parent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  cycle_found boolean;
BEGIN
  IF NEW.parent_department_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_department_id = NEW.id THEN
    RAISE EXCEPTION 'A department cannot be its own parent';
  END IF;
  WITH RECURSIVE ancestors AS (
    SELECT id, parent_department_id
    FROM public.hr_departments
    WHERE id = NEW.parent_department_id AND property_id = NEW.property_id
    UNION ALL
    SELECT d.id, d.parent_department_id
    FROM public.hr_departments d
    JOIN ancestors a ON d.id = a.parent_department_id
    WHERE d.property_id = NEW.property_id
  )
  SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = NEW.id) INTO cycle_found;
  IF cycle_found THEN
    RAISE EXCEPTION 'Department parent cycle detected';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hr_departments_validate_parent
BEFORE INSERT OR UPDATE OF parent_department_id, property_id
ON public.hr_departments
FOR EACH ROW EXECUTE FUNCTION public.hr_validate_department_parent();

CREATE OR REPLACE FUNCTION public.hr_prevent_unsafe_structure_archive()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'hr_departments'
     AND OLD.archived_at IS NULL
     AND NEW.archived_at IS NOT NULL
     AND (
       EXISTS (
         SELECT 1 FROM public.hr_employees e
         WHERE e.property_id = NEW.property_id
           AND e.department_id = NEW.id
           AND e.archived_at IS NULL
       )
       OR EXISTS (
         SELECT 1 FROM public.hr_departments child
         WHERE child.property_id = NEW.property_id
           AND child.parent_department_id = NEW.id
           AND child.archived_at IS NULL
       )
     )
  THEN
    RAISE EXCEPTION 'Reassign active employees and child departments before archiving';
  END IF;

  IF TG_TABLE_NAME = 'hr_designations'
     AND OLD.archived_at IS NULL
     AND NEW.archived_at IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.hr_employees e
       WHERE e.property_id = NEW.property_id
         AND e.designation_id = NEW.id
         AND e.archived_at IS NULL
     )
  THEN
    RAISE EXCEPTION 'Reassign active employees before archiving this designation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hr_departments_safe_archive
BEFORE UPDATE OF archived_at ON public.hr_departments
FOR EACH ROW EXECUTE FUNCTION public.hr_prevent_unsafe_structure_archive();
CREATE TRIGGER hr_designations_safe_archive
BEFORE UPDATE OF archived_at ON public.hr_designations
FOR EACH ROW EXECUTE FUNCTION public.hr_prevent_unsafe_structure_archive();

CREATE TRIGGER hr_departments_updated
BEFORE UPDATE ON public.hr_departments
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER hr_designations_updated
BEFORE UPDATE ON public.hr_designations
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER hr_employees_updated
BEFORE UPDATE ON public.hr_employees
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER hr_employee_private_updated
BEFORE UPDATE ON public.hr_employee_private
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER hr_employee_documents_updated
BEFORE UPDATE ON public.hr_employee_documents
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER hr_staff_announcements_updated
BEFORE UPDATE ON public.hr_staff_announcements
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.hr_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_designations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_employee_private ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_employee_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_staff_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_announcement_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_announcement_designations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_announcement_employees ENABLE ROW LEVEL SECURITY;

CREATE POLICY hr_departments_read ON public.hr_departments
FOR SELECT TO authenticated
USING (public.has_hrm_permission(auth.uid(), property_id, 'departments', 'read'));
CREATE POLICY hr_departments_write ON public.hr_departments
FOR ALL TO authenticated
USING (public.has_hrm_permission(auth.uid(), property_id, 'departments', 'manage'))
WITH CHECK (public.has_hrm_permission(auth.uid(), property_id, 'departments', 'manage'));

CREATE POLICY hr_designations_read ON public.hr_designations
FOR SELECT TO authenticated
USING (public.has_hrm_permission(auth.uid(), property_id, 'designations', 'read'));
CREATE POLICY hr_designations_write ON public.hr_designations
FOR ALL TO authenticated
USING (public.has_hrm_permission(auth.uid(), property_id, 'designations', 'manage'))
WITH CHECK (public.has_hrm_permission(auth.uid(), property_id, 'designations', 'manage'));

CREATE POLICY hr_employees_read ON public.hr_employees
FOR SELECT TO authenticated
USING (
  public.has_hrm_permission(auth.uid(), property_id, 'employees', 'read')
  OR staff_user_id = auth.uid()
);
CREATE POLICY hr_employees_insert ON public.hr_employees
FOR INSERT TO authenticated
WITH CHECK (public.has_hrm_permission(auth.uid(), property_id, 'employees', 'create'));
CREATE POLICY hr_employees_update ON public.hr_employees
FOR UPDATE TO authenticated
USING (
  public.has_hrm_permission(auth.uid(), property_id, 'employees', 'update')
  OR public.has_hrm_permission(auth.uid(), property_id, 'employees', 'delete')
)
WITH CHECK (
  public.has_hrm_permission(auth.uid(), property_id, 'employees', 'update')
  OR public.has_hrm_permission(auth.uid(), property_id, 'employees', 'delete')
);

CREATE POLICY hr_employee_private_read ON public.hr_employee_private
FOR SELECT TO authenticated
USING (
  public.has_hrm_permission(auth.uid(), property_id, 'employees_sensitive', 'read')
  OR EXISTS (
    SELECT 1 FROM public.hr_employees e
    WHERE e.id = employee_id AND e.property_id = property_id AND e.staff_user_id = auth.uid()
  )
);
CREATE POLICY hr_employee_private_write ON public.hr_employee_private
FOR ALL TO authenticated
USING (public.has_hrm_permission(auth.uid(), property_id, 'employees', 'update'))
WITH CHECK (public.has_hrm_permission(auth.uid(), property_id, 'employees', 'update'));

CREATE POLICY hr_employee_documents_read ON public.hr_employee_documents
FOR SELECT TO authenticated
USING (
  (
    confidentiality_level = 'internal'
    AND public.has_hrm_permission(auth.uid(), property_id, 'employee_documents', 'read')
  )
  OR (
    confidentiality_level = 'confidential'
    AND public.has_hrm_permission(auth.uid(), property_id, 'confidential_employee_documents', 'read')
  )
  OR EXISTS (
    SELECT 1 FROM public.hr_employees e
    WHERE e.id = employee_id AND e.property_id = property_id AND e.staff_user_id = auth.uid()
  )
);
CREATE POLICY hr_employee_documents_insert ON public.hr_employee_documents
FOR INSERT TO authenticated
WITH CHECK (public.has_hrm_permission(auth.uid(), property_id, 'employee_documents', 'create'));
CREATE POLICY hr_employee_documents_update ON public.hr_employee_documents
FOR UPDATE TO authenticated
USING (
  public.has_hrm_permission(auth.uid(), property_id, 'employee_documents', 'update')
  OR public.has_hrm_permission(auth.uid(), property_id, 'employee_documents', 'delete')
)
WITH CHECK (
  public.has_hrm_permission(auth.uid(), property_id, 'employee_documents', 'update')
  OR public.has_hrm_permission(auth.uid(), property_id, 'employee_documents', 'delete')
);

CREATE POLICY hr_announcements_manage_read ON public.hr_staff_announcements
FOR SELECT TO authenticated
USING (
  public.has_hrm_permission(auth.uid(), property_id, 'staff_announcements', 'read')
  OR (
    publication_status = 'published'
    AND archived_at IS NULL
    AND publish_date <= now()
    AND (expiry_date IS NULL OR expiry_date > now())
    AND EXISTS (
      SELECT 1
      FROM public.hr_employees e
      WHERE e.property_id = hr_staff_announcements.property_id
        AND e.staff_user_id = auth.uid()
        AND e.archived_at IS NULL
        AND (
          audience_type = 'all_staff'
          OR (
            audience_type = 'departments'
            AND EXISTS (
              SELECT 1 FROM public.hr_announcement_departments ad
              WHERE ad.announcement_id = hr_staff_announcements.id
                AND ad.department_id = e.department_id
            )
          )
          OR (
            audience_type = 'designations'
            AND EXISTS (
              SELECT 1 FROM public.hr_announcement_designations ag
              WHERE ag.announcement_id = hr_staff_announcements.id
                AND ag.designation_id = e.designation_id
            )
          )
          OR (
            audience_type = 'employees'
            AND EXISTS (
              SELECT 1 FROM public.hr_announcement_employees ae
              WHERE ae.announcement_id = hr_staff_announcements.id
                AND ae.employee_id = e.id
            )
          )
        )
    )
  )
);
CREATE POLICY hr_announcements_write ON public.hr_staff_announcements
FOR ALL TO authenticated
USING (public.has_hrm_permission(auth.uid(), property_id, 'staff_announcements', 'manage'))
WITH CHECK (public.has_hrm_permission(auth.uid(), property_id, 'staff_announcements', 'manage'));

CREATE POLICY hr_announcement_departments_access ON public.hr_announcement_departments
FOR ALL TO authenticated
USING (
  public.has_hrm_permission(auth.uid(), property_id, 'staff_announcements', 'read')
  OR EXISTS (
    SELECT 1 FROM public.hr_employees e
    WHERE e.property_id = hr_announcement_departments.property_id
      AND e.staff_user_id = auth.uid()
  )
)
WITH CHECK (public.has_hrm_permission(auth.uid(), property_id, 'staff_announcements', 'manage'));
CREATE POLICY hr_announcement_designations_access ON public.hr_announcement_designations
FOR ALL TO authenticated
USING (
  public.has_hrm_permission(auth.uid(), property_id, 'staff_announcements', 'read')
  OR EXISTS (
    SELECT 1 FROM public.hr_employees e
    WHERE e.property_id = hr_announcement_designations.property_id
      AND e.staff_user_id = auth.uid()
  )
)
WITH CHECK (public.has_hrm_permission(auth.uid(), property_id, 'staff_announcements', 'manage'));
CREATE POLICY hr_announcement_employees_access ON public.hr_announcement_employees
FOR ALL TO authenticated
USING (
  public.has_hrm_permission(auth.uid(), property_id, 'staff_announcements', 'read')
  OR EXISTS (
    SELECT 1 FROM public.hr_employees e
    WHERE e.property_id = hr_announcement_employees.property_id
      AND e.staff_user_id = auth.uid()
  )
)
WITH CHECK (public.has_hrm_permission(auth.uid(), property_id, 'staff_announcements', 'manage'));

CREATE POLICY hrm_audit_read ON public.admin_action_logs
FOR SELECT TO authenticated
USING (
  property_id IS NOT NULL
  AND entity_type LIKE 'hr\_%' ESCAPE '\'
  AND public.has_hrm_permission(auth.uid(), property_id, 'employees', 'read')
);

CREATE UNIQUE INDEX notifications_hrm_announcement_recipient_uniq
  ON public.notifications ((metadata->>'announcementId'), user_id)
  WHERE category = 'hrm_announcement' AND user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.publish_hrm_announcement_notifications(
  _announcement_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  announcement public.hr_staff_announcements%ROWTYPE;
  inserted_count integer;
BEGIN
  SELECT * INTO announcement
  FROM public.hr_staff_announcements
  WHERE id = _announcement_id;

  IF announcement.id IS NULL
     OR NOT public.has_hrm_permission(
       auth.uid(), announcement.property_id, 'staff_announcements', 'approve'
     )
  THEN
    RAISE EXCEPTION 'Not authorized to publish this announcement';
  END IF;

  INSERT INTO public.notifications(
    property_id, user_id, category, priority, title, body, link, metadata
  )
  SELECT
    announcement.property_id,
    employee.staff_user_id,
    'hrm_announcement',
    announcement.priority,
    announcement.title,
    announcement.content,
    '/notifications',
    jsonb_build_object('announcementId', announcement.id)
  FROM public.hr_employees employee
  WHERE employee.property_id = announcement.property_id
    AND employee.staff_user_id IS NOT NULL
    AND employee.archived_at IS NULL
    AND employee.employment_status IN ('active', 'probation')
    AND (
      announcement.audience_type = 'all_staff'
      OR (
        announcement.audience_type = 'departments'
        AND EXISTS (
          SELECT 1 FROM public.hr_announcement_departments target
          WHERE target.announcement_id = announcement.id
            AND target.department_id = employee.department_id
        )
      )
      OR (
        announcement.audience_type = 'designations'
        AND EXISTS (
          SELECT 1 FROM public.hr_announcement_designations target
          WHERE target.announcement_id = announcement.id
            AND target.designation_id = employee.designation_id
        )
      )
      OR (
        announcement.audience_type = 'employees'
        AND EXISTS (
          SELECT 1 FROM public.hr_announcement_employees target
          WHERE target.announcement_id = announcement.id
            AND target.employee_id = employee.id
        )
      )
    )
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_hrm_announcement_notifications(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publish_hrm_announcement_notifications(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.publish_hrm_announcement_notifications(uuid) TO service_role;

GRANT SELECT, INSERT, UPDATE ON public.hr_departments TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.hr_designations TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.hr_employees TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.hr_employee_private TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.hr_employee_documents TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.hr_staff_announcements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_announcement_departments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_announcement_designations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_announcement_employees TO authenticated;
GRANT ALL ON public.hr_departments, public.hr_designations, public.hr_employees,
  public.hr_employee_private, public.hr_employee_documents, public.hr_staff_announcements,
  public.hr_announcement_departments, public.hr_announcement_designations,
  public.hr_announcement_employees TO service_role;

CREATE OR REPLACE FUNCTION public.seed_hrm_permissions(_property_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.role_permissions(property_id, role, module, action, allowed)
  SELECT _property_id, role_name::public.app_role, module_name, action_name, true
  FROM (
    VALUES
      ('hrm_dashboard', 'read'),
      ('employees', 'read'), ('employees', 'create'), ('employees', 'update'), ('employees', 'delete'),
      ('employees_sensitive', 'read'),
      ('departments', 'read'), ('departments', 'manage'),
      ('designations', 'read'), ('designations', 'manage'),
      ('employee_documents', 'read'), ('employee_documents', 'create'),
      ('employee_documents', 'update'), ('employee_documents', 'delete'),
      ('confidential_employee_documents', 'read'),
      ('staff_announcements', 'read'), ('staff_announcements', 'manage'),
      ('staff_announcements', 'approve')
  ) permission(module_name, action_name)
  CROSS JOIN (VALUES ('super_admin'), ('hotel_owner'), ('general_manager'), ('hr')) role(role_name)
  ON CONFLICT DO NOTHING;
END;
$$;

SELECT public.seed_hrm_permissions(id) FROM public.properties;

REVOKE ALL ON FUNCTION public.seed_hrm_permissions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_hrm_permissions(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.seed_hrm_permissions_for_property()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.seed_hrm_permissions(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER properties_seed_hrm_permissions
AFTER INSERT ON public.properties
FOR EACH ROW EXECUTE FUNCTION public.seed_hrm_permissions_for_property();

REVOKE ALL ON FUNCTION public.seed_hrm_permissions_for_property() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_hrm_permissions_for_property() TO service_role;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'employee-documents',
  'employee-documents',
  false,
  10485760,
  ARRAY[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE POLICY employee_documents_storage_insert ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'employee-documents'
  AND public.has_hrm_permission(
    auth.uid(),
    ((storage.foldername(name))[1])::uuid,
    'employee_documents',
    'create'
  )
);

CREATE POLICY employee_documents_storage_read ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'employee-documents'
  AND (
    EXISTS (
      SELECT 1
      FROM public.hr_employee_documents d
      WHERE d.storage_path = name
        AND d.property_id = ((storage.foldername(name))[1])::uuid
        AND (
          (
            d.confidentiality_level = 'internal'
            AND public.has_hrm_permission(auth.uid(), d.property_id, 'employee_documents', 'read')
          )
          OR (
            d.confidentiality_level = 'confidential'
            AND public.has_hrm_permission(
              auth.uid(), d.property_id, 'confidential_employee_documents', 'read'
            )
          )
          OR EXISTS (
            SELECT 1 FROM public.hr_employees e
            WHERE e.id = d.employee_id AND e.staff_user_id = auth.uid()
          )
        )
    )
    OR (
      (storage.foldername(name))[4] = 'profile'
      AND public.has_hrm_permission(
        auth.uid(),
        ((storage.foldername(name))[1])::uuid,
        'employees',
        'read'
      )
    )
  )
);

CREATE POLICY employee_documents_storage_cleanup ON storage.objects
FOR DELETE TO authenticated
USING (
  bucket_id = 'employee-documents'
  AND (storage.foldername(name))[4] = 'documents'
  AND public.has_hrm_permission(
    auth.uid(),
    ((storage.foldername(name))[1])::uuid,
    'employee_documents',
    'create'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.hr_employee_documents d WHERE d.storage_path = name
  )
);

COMMENT ON FUNCTION public.has_hrm_permission(uuid, uuid, text, text)
  IS 'Authoritative property-scoped HRM permission check backed by role_permissions.';
COMMENT ON TABLE public.hr_employee_private
  IS 'Sensitive employee PII separated from the general employee directory.';
COMMENT ON TABLE public.hr_employee_documents
  IS 'Document metadata only. File contents remain in the private employee-documents bucket.';
