-- Phase 3A: workforce time settings, shift scheduling, duty roster, and holidays.
-- Additive only; attendance events and calculations are intentionally excluded.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE public.hr_workforce_settings (
  property_id uuid PRIMARY KEY REFERENCES public.properties(id) ON DELETE RESTRICT,
  timezone text NOT NULL DEFAULT 'Africa/Accra',
  default_working_days smallint[] NOT NULL DEFAULT ARRAY[1,2,3,4,5]::smallint[],
  standard_start_time time NOT NULL DEFAULT '08:00',
  standard_end_time time NOT NULL DEFAULT '17:00',
  grace_period_minutes integer NOT NULL DEFAULT 10 CHECK (grace_period_minutes BETWEEN 0 AND 240),
  late_threshold_minutes integer NOT NULL DEFAULT 15 CHECK (late_threshold_minutes BETWEEN 0 AND 240),
  early_departure_threshold_minutes integer NOT NULL DEFAULT 15
    CHECK (early_departure_threshold_minutes BETWEEN 0 AND 240),
  minimum_full_day_minutes integer NOT NULL DEFAULT 480
    CHECK (minimum_full_day_minutes BETWEEN 1 AND 1440),
  minimum_half_day_minutes integer NOT NULL DEFAULT 240
    CHECK (minimum_half_day_minutes BETWEEN 1 AND 1440),
  maximum_open_shift_minutes integer NOT NULL DEFAULT 960
    CHECK (maximum_open_shift_minutes BETWEEN 60 AND 2880),
  allow_overnight_shifts boolean NOT NULL DEFAULT true,
  weekend_treatment text NOT NULL DEFAULT 'normal'
    CHECK (weekend_treatment IN ('normal','non_working','premium_placeholder')),
  holiday_treatment text NOT NULL DEFAULT 'non_working'
    CHECK (holiday_treatment IN ('normal','non_working','premium_placeholder')),
  rounding_rule text NOT NULL DEFAULT 'none'
    CHECK (rounding_rule IN ('none','nearest','up','down')),
  rounding_interval_minutes integer NOT NULL DEFAULT 15
    CHECK (rounding_interval_minutes IN (5,10,15,30,60)),
  attendance_approval_required boolean NOT NULL DEFAULT true,
  manual_adjustment_enabled boolean NOT NULL DEFAULT false,
  biometric_attendance_enabled boolean NOT NULL DEFAULT false,
  biometric_integration_mode text NOT NULL DEFAULT 'disabled'
    CHECK (biometric_integration_mode IN ('disabled','manual_placeholder','api_placeholder','device_placeholder')),
  maximum_consecutive_workdays smallint NOT NULL DEFAULT 6
    CHECK (maximum_consecutive_workdays BETWEEN 1 AND 31),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(default_working_days) BETWEEN 1 AND 7),
  CHECK (default_working_days <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
  CHECK (minimum_half_day_minutes <= minimum_full_day_minutes),
  CHECK (late_threshold_minutes >= grace_period_minutes),
  CHECK (
    (biometric_attendance_enabled AND biometric_integration_mode <> 'disabled')
    OR (NOT biometric_attendance_enabled AND biometric_integration_mode = 'disabled')
  )
);

CREATE TABLE public.hr_shift_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
  code text NOT NULL CHECK (char_length(trim(code)) BETWEEN 1 AND 40),
  description text,
  start_time time NOT NULL,
  end_time time NOT NULL,
  is_overnight boolean NOT NULL DEFAULT false,
  break_minutes integer NOT NULL DEFAULT 0 CHECK (break_minutes BETWEEN 0 AND 720),
  grace_period_minutes integer NOT NULL DEFAULT 0 CHECK (grace_period_minutes BETWEEN 0 AND 240),
  expected_work_minutes integer NOT NULL CHECK (expected_work_minutes BETWEEN 1 AND 2880),
  colour text CHECK (colour IS NULL OR colour ~ '^#[0-9A-Fa-f]{6}$'),
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  archived_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, id),
  UNIQUE (property_id, code)
);

CREATE UNIQUE INDEX hr_shift_templates_code_ci_uniq
  ON public.hr_shift_templates(property_id, lower(code));
CREATE INDEX hr_shift_templates_list_idx
  ON public.hr_shift_templates(property_id, active, name)
  WHERE archived_at IS NULL;

CREATE TABLE public.hr_duty_roster (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  duty_date date NOT NULL,
  department_id uuid,
  work_location text,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','cancelled','completed_placeholder')),
  notes text,
  publication_status text NOT NULL DEFAULT 'draft'
    CHECK (publication_status IN ('draft','published','unpublished')),
  published_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  published_at timestamptz,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  archived_at timestamptz,
  archived_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, id),
  FOREIGN KEY (property_id, employee_id)
    REFERENCES public.hr_employees(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, shift_id)
    REFERENCES public.hr_shift_templates(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, department_id)
    REFERENCES public.hr_departments(property_id, id) ON DELETE RESTRICT,
  CHECK (ends_at > starts_at)
);

ALTER TABLE public.hr_duty_roster
  ADD CONSTRAINT hr_duty_roster_no_overlap
  EXCLUDE USING gist (
    property_id WITH =,
    employee_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
  WHERE (archived_at IS NULL AND status <> 'cancelled');

CREATE INDEX hr_duty_roster_period_idx
  ON public.hr_duty_roster(property_id, duty_date, department_id);
CREATE INDEX hr_duty_roster_employee_idx
  ON public.hr_duty_roster(property_id, employee_id, duty_date);
CREATE INDEX hr_duty_roster_publication_idx
  ON public.hr_duty_roster(property_id, publication_status, duty_date)
  WHERE archived_at IS NULL;

CREATE TABLE public.hr_holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 160),
  holiday_date date NOT NULL,
  recurring_annually boolean NOT NULL DEFAULT false,
  holiday_type text NOT NULL DEFAULT 'public'
    CHECK (holiday_type IN ('public','company','religious','local','other')),
  treatment text NOT NULL DEFAULT 'paid'
    CHECK (treatment IN ('paid','unpaid','normal_placeholder')),
  scope_type text NOT NULL DEFAULT 'property'
    CHECK (scope_type IN ('property','departments')),
  description text,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  archived_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, id)
);

CREATE UNIQUE INDEX hr_holidays_property_date_uniq
  ON public.hr_holidays(property_id, holiday_date)
  WHERE scope_type = 'property' AND active AND archived_at IS NULL AND NOT recurring_annually;
CREATE UNIQUE INDEX hr_holidays_property_recurring_uniq
  ON public.hr_holidays(
    property_id,
    EXTRACT(month FROM holiday_date),
    EXTRACT(day FROM holiday_date)
  )
  WHERE scope_type = 'property' AND active AND archived_at IS NULL AND recurring_annually;
CREATE INDEX hr_holidays_list_idx
  ON public.hr_holidays(property_id, holiday_date, active);

CREATE TABLE public.hr_holiday_departments (
  holiday_id uuid NOT NULL,
  property_id uuid NOT NULL,
  department_id uuid NOT NULL,
  PRIMARY KEY (holiday_id, department_id),
  FOREIGN KEY (property_id, holiday_id)
    REFERENCES public.hr_holidays(property_id, id) ON DELETE CASCADE,
  FOREIGN KEY (property_id, department_id)
    REFERENCES public.hr_departments(property_id, id) ON DELETE RESTRICT
);

CREATE INDEX hr_holiday_departments_lookup_idx
  ON public.hr_holiday_departments(property_id, department_id);

CREATE OR REPLACE FUNCTION public.hr_validate_workforce_settings()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'Invalid IANA timezone: %', NEW.timezone;
  END IF;
  IF NEW.standard_start_time = NEW.standard_end_time THEN
    RAISE EXCEPTION 'Standard workday cannot have zero duration';
  END IF;
  IF NEW.standard_end_time < NEW.standard_start_time AND NOT NEW.allow_overnight_shifts THEN
    RAISE EXCEPTION 'Overnight standard workday requires overnight shifts to be enabled';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hr_workforce_settings_validate
BEFORE INSERT OR UPDATE ON public.hr_workforce_settings
FOR EACH ROW EXECUTE FUNCTION public.hr_validate_workforce_settings();

CREATE OR REPLACE FUNCTION public.hr_prepare_shift_template()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  span_minutes integer;
  max_minutes integer;
  overnight_allowed boolean;
BEGIN
  IF NEW.start_time = NEW.end_time THEN
    RAISE EXCEPTION 'Shift cannot have zero duration';
  END IF;
  NEW.is_overnight := NEW.end_time < NEW.start_time;
  span_minutes := (
    EXTRACT(EPOCH FROM (
      (
        CASE WHEN NEW.is_overnight THEN date '2000-01-02' ELSE date '2000-01-01' END
        + NEW.end_time
      )
      - (date '2000-01-01' + NEW.start_time)
    )) / 60
  )::integer;
  NEW.expected_work_minutes := span_minutes - NEW.break_minutes;
  IF NEW.expected_work_minutes <= 0 THEN
    RAISE EXCEPTION 'Break duration must be shorter than the shift';
  END IF;
  SELECT maximum_open_shift_minutes, allow_overnight_shifts
    INTO max_minutes, overnight_allowed
  FROM public.hr_workforce_settings
  WHERE property_id = NEW.property_id;
  max_minutes := COALESCE(max_minutes, 960);
  overnight_allowed := COALESCE(overnight_allowed, true);
  IF NEW.is_overnight AND NOT overnight_allowed THEN
    RAISE EXCEPTION 'Overnight shifts are disabled for this property';
  END IF;
  IF span_minutes > max_minutes THEN
    RAISE EXCEPTION 'Shift exceeds the property maximum duration';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hr_shift_templates_prepare
BEFORE INSERT OR UPDATE OF start_time, end_time, break_minutes, property_id
ON public.hr_shift_templates
FOR EACH ROW EXECUTE FUNCTION public.hr_prepare_shift_template();

CREATE OR REPLACE FUNCTION public.hr_prepare_roster_assignment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  employee_row public.hr_employees%ROWTYPE;
  shift_row public.hr_shift_templates%ROWTYPE;
  workforce_timezone text;
  consecutive_limit integer;
  has_rest_day boolean;
BEGIN
  SELECT * INTO employee_row FROM public.hr_employees
  WHERE id = NEW.employee_id AND property_id = NEW.property_id;
  IF employee_row.id IS NULL THEN
    RAISE EXCEPTION 'Employee does not belong to this property';
  END IF;
  IF employee_row.archived_at IS NOT NULL
     OR employee_row.employment_status NOT IN ('active','probation') THEN
    RAISE EXCEPTION 'Inactive employees cannot be assigned to a roster';
  END IF;

  SELECT * INTO shift_row FROM public.hr_shift_templates
  WHERE id = NEW.shift_id AND property_id = NEW.property_id;
  IF shift_row.id IS NULL THEN
    RAISE EXCEPTION 'Shift does not belong to this property';
  END IF;
  IF shift_row.archived_at IS NOT NULL OR NOT shift_row.active THEN
    RAISE EXCEPTION 'Archived or inactive shifts cannot be assigned';
  END IF;

  SELECT timezone, maximum_consecutive_workdays
    INTO workforce_timezone, consecutive_limit
  FROM public.hr_workforce_settings
  WHERE property_id = NEW.property_id;
  IF workforce_timezone IS NULL THEN
    SELECT COALESCE(timezone, 'Africa/Accra') INTO workforce_timezone
    FROM public.properties WHERE id = NEW.property_id;
  END IF;
  consecutive_limit := COALESCE(consecutive_limit, 6);

  NEW.starts_at := (NEW.duty_date + shift_row.start_time) AT TIME ZONE workforce_timezone;
  NEW.ends_at := (
    NEW.duty_date
    + CASE WHEN shift_row.is_overnight THEN 1 ELSE 0 END
    + shift_row.end_time
  ) AT TIME ZONE workforce_timezone;
  NEW.department_id := COALESCE(NEW.department_id, employee_row.department_id);

  IF NEW.duty_date >= current_date THEN
    SELECT EXISTS (
      SELECT 1
      FROM generate_series(1, consecutive_limit) day_offset
      WHERE NOT EXISTS (
        SELECT 1 FROM public.hr_duty_roster prior
        WHERE prior.property_id = NEW.property_id
          AND prior.employee_id = NEW.employee_id
          AND prior.id <> NEW.id
          AND prior.archived_at IS NULL
          AND prior.status <> 'cancelled'
          AND prior.duty_date = NEW.duty_date - day_offset
      )
    ) INTO has_rest_day;
    IF NOT has_rest_day THEN
      RAISE EXCEPTION 'Assignment exceeds the configured consecutive-workday threshold';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hr_duty_roster_prepare
BEFORE INSERT OR UPDATE OF employee_id, shift_id, duty_date, property_id, department_id
ON public.hr_duty_roster
FOR EACH ROW EXECUTE FUNCTION public.hr_prepare_roster_assignment();

CREATE OR REPLACE FUNCTION public.hr_validate_holiday_department()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  holiday_row public.hr_holidays%ROWTYPE;
BEGIN
  SELECT * INTO holiday_row FROM public.hr_holidays
  WHERE id = NEW.holiday_id AND property_id = NEW.property_id;
  IF holiday_row.scope_type <> 'departments' THEN
    RAISE EXCEPTION 'Department targets require department holiday scope';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.hr_holiday_departments target
    JOIN public.hr_holidays existing ON existing.id = target.holiday_id
    WHERE target.property_id = NEW.property_id
      AND target.department_id = NEW.department_id
      AND target.holiday_id <> NEW.holiday_id
      AND existing.active
      AND existing.archived_at IS NULL
      AND (
        (NOT holiday_row.recurring_annually AND NOT existing.recurring_annually
          AND existing.holiday_date = holiday_row.holiday_date)
        OR (
          holiday_row.recurring_annually AND existing.recurring_annually
          AND EXTRACT(month FROM existing.holiday_date) = EXTRACT(month FROM holiday_row.holiday_date)
          AND EXTRACT(day FROM existing.holiday_date) = EXTRACT(day FROM holiday_row.holiday_date)
        )
      )
  ) THEN
    RAISE EXCEPTION 'Department already has an active holiday on this date';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hr_holiday_departments_validate
BEFORE INSERT OR UPDATE ON public.hr_holiday_departments
FOR EACH ROW EXECUTE FUNCTION public.hr_validate_holiday_department();

CREATE TRIGGER hr_workforce_settings_updated
BEFORE UPDATE ON public.hr_workforce_settings
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER hr_shift_templates_updated
BEFORE UPDATE ON public.hr_shift_templates
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER hr_duty_roster_updated
BEFORE UPDATE ON public.hr_duty_roster
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER hr_holidays_updated
BEFORE UPDATE ON public.hr_holidays
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.hr_workforce_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_shift_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_duty_roster ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_holiday_departments ENABLE ROW LEVEL SECURITY;

CREATE POLICY hr_workforce_settings_read ON public.hr_workforce_settings
FOR SELECT TO authenticated
USING (public.has_hrm_permission(auth.uid(), property_id, 'workforce_settings', 'read'));
CREATE POLICY hr_workforce_settings_write ON public.hr_workforce_settings
FOR ALL TO authenticated
USING (public.has_hrm_permission(auth.uid(), property_id, 'workforce_settings', 'manage'))
WITH CHECK (public.has_hrm_permission(auth.uid(), property_id, 'workforce_settings', 'manage'));

CREATE POLICY hr_shift_templates_read ON public.hr_shift_templates
FOR SELECT TO authenticated
USING (public.has_hrm_permission(auth.uid(), property_id, 'shift_templates', 'read'));
CREATE POLICY hr_shift_templates_write ON public.hr_shift_templates
FOR ALL TO authenticated
USING (public.has_hrm_permission(auth.uid(), property_id, 'shift_templates', 'manage'))
WITH CHECK (public.has_hrm_permission(auth.uid(), property_id, 'shift_templates', 'manage'));

CREATE POLICY hr_duty_roster_read ON public.hr_duty_roster
FOR SELECT TO authenticated
USING (
  public.has_hrm_permission(auth.uid(), property_id, 'duty_roster', 'read')
  OR (
    publication_status = 'published'
    AND archived_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.hr_employees employee
      WHERE employee.id = hr_duty_roster.employee_id
        AND employee.property_id = hr_duty_roster.property_id
        AND employee.staff_user_id = auth.uid()
    )
  )
);
CREATE POLICY hr_duty_roster_insert ON public.hr_duty_roster
FOR INSERT TO authenticated
WITH CHECK (public.has_hrm_permission(auth.uid(), property_id, 'duty_roster', 'manage'));
CREATE POLICY hr_duty_roster_update ON public.hr_duty_roster
FOR UPDATE TO authenticated
USING (
  public.has_hrm_permission(auth.uid(), property_id, 'duty_roster', 'manage')
  OR public.has_hrm_permission(auth.uid(), property_id, 'duty_roster', 'approve')
)
WITH CHECK (
  public.has_hrm_permission(auth.uid(), property_id, 'duty_roster', 'manage')
  OR public.has_hrm_permission(auth.uid(), property_id, 'duty_roster', 'approve')
);

CREATE POLICY hr_holidays_read ON public.hr_holidays
FOR SELECT TO authenticated
USING (public.has_hrm_permission(auth.uid(), property_id, 'holidays', 'read'));
CREATE POLICY hr_holidays_write ON public.hr_holidays
FOR ALL TO authenticated
USING (public.has_hrm_permission(auth.uid(), property_id, 'holidays', 'manage'))
WITH CHECK (public.has_hrm_permission(auth.uid(), property_id, 'holidays', 'manage'));
CREATE POLICY hr_holiday_departments_access ON public.hr_holiday_departments
FOR ALL TO authenticated
USING (public.has_hrm_permission(auth.uid(), property_id, 'holidays', 'read'))
WITH CHECK (public.has_hrm_permission(auth.uid(), property_id, 'holidays', 'manage'));

CREATE OR REPLACE FUNCTION public.bulk_assign_hr_duty_roster(
  _property_id uuid,
  _employee_ids uuid[],
  _shift_id uuid,
  _duty_dates date[],
  _department_id uuid DEFAULT NULL,
  _work_location text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  employee_id_value uuid;
  duty_date_value date;
  inserted_count integer := 0;
BEGIN
  IF NOT public.has_hrm_permission(auth.uid(), _property_id, 'duty_roster', 'manage') THEN
    RAISE EXCEPTION 'Not authorized to manage this roster';
  END IF;
  IF cardinality(_employee_ids) * cardinality(_duty_dates) > 200 THEN
    RAISE EXCEPTION 'Bulk assignment limit is 200';
  END IF;
  FOREACH employee_id_value IN ARRAY _employee_ids LOOP
    FOREACH duty_date_value IN ARRAY _duty_dates LOOP
      INSERT INTO public.hr_duty_roster(
        property_id, employee_id, shift_id, duty_date, department_id,
        work_location, starts_at, ends_at, created_by, updated_by
      ) VALUES (
        _property_id, employee_id_value, _shift_id, duty_date_value, _department_id,
        NULLIF(trim(_work_location), ''), now(), now() + interval '1 minute',
        auth.uid(), auth.uid()
      );
      inserted_count := inserted_count + 1;
    END LOOP;
  END LOOP;
  RETURN inserted_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.copy_hr_duty_roster_period(
  _property_id uuid,
  _source_from date,
  _source_to date,
  _target_from date
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted_count integer;
  date_offset integer;
BEGIN
  IF NOT public.has_hrm_permission(auth.uid(), _property_id, 'duty_roster', 'manage') THEN
    RAISE EXCEPTION 'Not authorized to manage this roster';
  END IF;
  IF _source_to < _source_from THEN
    RAISE EXCEPTION 'Source period is invalid';
  END IF;
  date_offset := _target_from - _source_from;
  INSERT INTO public.hr_duty_roster(
    property_id, employee_id, shift_id, duty_date, department_id,
    work_location, notes, starts_at, ends_at, created_by, updated_by
  )
  SELECT
    source.property_id,
    source.employee_id,
    source.shift_id,
    source.duty_date + date_offset,
    source.department_id,
    source.work_location,
    source.notes,
    now(),
    now() + interval '1 minute',
    auth.uid(),
    auth.uid()
  FROM public.hr_duty_roster source
  WHERE source.property_id = _property_id
    AND source.duty_date BETWEEN _source_from AND _source_to
    AND source.archived_at IS NULL
    AND source.status <> 'cancelled';
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.bulk_assign_hr_duty_roster(uuid, uuid[], uuid, date[], uuid, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copy_hr_duty_roster_period(uuid, date, date, date)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bulk_assign_hr_duty_roster(uuid, uuid[], uuid, date[], uuid, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.copy_hr_duty_roster_period(uuid, date, date, date)
  TO authenticated, service_role;

GRANT SELECT, INSERT, UPDATE ON public.hr_workforce_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.hr_shift_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.hr_duty_roster TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.hr_holidays TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_holiday_departments TO authenticated;
GRANT ALL ON public.hr_workforce_settings, public.hr_shift_templates, public.hr_duty_roster,
  public.hr_holidays, public.hr_holiday_departments TO service_role;

CREATE OR REPLACE FUNCTION public.seed_workforce_permissions(_property_id uuid)
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
      ('workforce_settings','read'), ('workforce_settings','manage'),
      ('shift_templates','read'), ('shift_templates','manage'),
      ('duty_roster','read'), ('duty_roster','manage'), ('duty_roster','approve'),
      ('holidays','read'), ('holidays','manage')
  ) permission(module_name, action_name)
  CROSS JOIN (VALUES ('super_admin'),('hotel_owner'),('general_manager'),('hr')) role(role_name)
  ON CONFLICT DO NOTHING;
END;
$$;

SELECT public.seed_workforce_permissions(id) FROM public.properties;
REVOKE ALL ON FUNCTION public.seed_workforce_permissions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_workforce_permissions(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.seed_workforce_permissions_for_property()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.hr_workforce_settings(property_id, timezone)
  VALUES (NEW.id, COALESCE(NEW.timezone, 'Africa/Accra'))
  ON CONFLICT DO NOTHING;
  PERFORM public.seed_workforce_permissions(NEW.id);
  RETURN NEW;
END;
$$;

INSERT INTO public.hr_workforce_settings(property_id, timezone)
SELECT id, COALESCE(timezone, 'Africa/Accra') FROM public.properties
ON CONFLICT DO NOTHING;

CREATE TRIGGER properties_seed_workforce_settings
AFTER INSERT ON public.properties
FOR EACH ROW EXECUTE FUNCTION public.seed_workforce_permissions_for_property();

REVOKE ALL ON FUNCTION public.seed_workforce_permissions_for_property() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_workforce_permissions_for_property() TO service_role;

COMMENT ON TABLE public.hr_workforce_settings
  IS 'Scheduling policy only; Phase 3A stores no attendance events or calculations.';
COMMENT ON COLUMN public.hr_duty_roster.starts_at
  IS 'UTC instant derived from property timezone, local duty date, and shift start time.';
