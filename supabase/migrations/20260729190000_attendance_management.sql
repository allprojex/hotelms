-- Phase 3B: immutable attendance events, summaries, time clock and adjustments.
-- Additive only. No biometric ingestion, leave, payroll or compensation logic.

CREATE TABLE public.hr_attendance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'clock_in','clock_out','break_start','break_end',
    'manual_clock_in','manual_clock_out','manual_break_start','manual_break_end',
    'correction_marker'
  )),
  event_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  business_date date NOT NULL,
  source text NOT NULL CHECK (source IN ('web_time_clock','manual_adjustment','system_correction')),
  source_event_id text,
  roster_id uuid,
  session_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  correlation_id uuid,
  request_id uuid,
  invalidated_at timestamptz,
  invalidated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  invalidation_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (property_id, id),
  FOREIGN KEY (property_id, employee_id)
    REFERENCES public.hr_employees(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, roster_id)
    REFERENCES public.hr_duty_roster(property_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(session_metadata) = 'object'),
  CHECK (
    (invalidated_at IS NULL AND invalidated_by IS NULL AND invalidation_reason IS NULL)
    OR (invalidated_at IS NOT NULL AND invalidated_by IS NOT NULL
      AND char_length(trim(invalidation_reason)) >= 5)
  )
);

CREATE UNIQUE INDEX hr_attendance_events_request_uniq
  ON public.hr_attendance_events(property_id, created_by, request_id)
  WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX hr_attendance_events_source_uniq
  ON public.hr_attendance_events(property_id, source, source_event_id)
  WHERE source_event_id IS NOT NULL;
CREATE INDEX hr_attendance_events_employee_time_idx
  ON public.hr_attendance_events(property_id, employee_id, event_at);
CREATE INDEX hr_attendance_events_business_date_idx
  ON public.hr_attendance_events(property_id, business_date, employee_id);

CREATE TABLE public.hr_attendance_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  business_date date NOT NULL,
  roster_id uuid,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  first_clock_in timestamptz,
  last_clock_out timestamptz,
  worked_minutes integer NOT NULL DEFAULT 0 CHECK (worked_minutes >= 0),
  break_minutes integer NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  late_minutes integer NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
  early_departure_minutes integer NOT NULL DEFAULT 0 CHECK (early_departure_minutes >= 0),
  overtime_minutes integer NOT NULL DEFAULT 0 CHECK (overtime_minutes >= 0),
  attendance_status text NOT NULL DEFAULT 'incomplete' CHECK (attendance_status IN (
    'present','absent','late','half_day','holiday','rest_day','incomplete','excused'
  )),
  calculation_status text NOT NULL DEFAULT 'calculated'
    CHECK (calculation_status IN ('calculated','incomplete','adjusted','error')),
  source_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  approval_status text NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('not_required','pending','approved','rejected','returned')),
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  notes text,
  calculation_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, employee_id, business_date),
  UNIQUE (property_id, id),
  FOREIGN KEY (property_id, employee_id)
    REFERENCES public.hr_employees(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, roster_id)
    REFERENCES public.hr_duty_roster(property_id, id) ON DELETE RESTRICT,
  CHECK (
    (approval_status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    OR approval_status <> 'approved'
  )
);

CREATE INDEX hr_attendance_summaries_period_idx
  ON public.hr_attendance_summaries(property_id, business_date, attendance_status);
CREATE INDEX hr_attendance_summaries_employee_idx
  ON public.hr_attendance_summaries(property_id, employee_id, business_date DESC);

CREATE TABLE public.hr_attendance_calculation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  summary_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  business_date date NOT NULL,
  trigger_source text NOT NULL CHECK (trigger_source IN (
    'time_clock','manual_event','adjustment_approval','explicit_recalculation'
  )),
  event_ids uuid[] NOT NULL DEFAULT '{}',
  previous_values jsonb,
  calculated_values jsonb NOT NULL,
  calculated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (property_id, summary_id)
    REFERENCES public.hr_attendance_summaries(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, employee_id)
    REFERENCES public.hr_employees(property_id, id) ON DELETE RESTRICT
);
CREATE INDEX hr_attendance_calculation_runs_summary_idx
  ON public.hr_attendance_calculation_runs(property_id, summary_id, created_at DESC);

CREATE TABLE public.hr_attendance_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  business_date date NOT NULL,
  summary_id uuid,
  adjustment_type text NOT NULL CHECK (adjustment_type IN (
    'add_event','reclassify_event','summary_status','excused_status','roster_reference'
  )),
  reason text NOT NULL CHECK (char_length(trim(reason)) BETWEEN 5 AND 1000),
  previous_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_values jsonb NOT NULL,
  approval_status text NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('pending','approved','rejected','returned')),
  submitted_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_notes text,
  applied_event_id uuid REFERENCES public.hr_attendance_events(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, id),
  FOREIGN KEY (property_id, employee_id)
    REFERENCES public.hr_employees(property_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, summary_id)
    REFERENCES public.hr_attendance_summaries(property_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(previous_values) = 'object' AND jsonb_typeof(proposed_values) = 'object'),
  CHECK (
    (approval_status = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (approval_status <> 'pending' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);
CREATE INDEX hr_attendance_adjustments_review_idx
  ON public.hr_attendance_adjustments(property_id, approval_status, submitted_at);

CREATE TRIGGER hr_attendance_summaries_updated
BEFORE UPDATE ON public.hr_attendance_summaries
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER hr_attendance_adjustments_updated
BEFORE UPDATE ON public.hr_attendance_adjustments
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE OR REPLACE FUNCTION public.hr_attendance_events_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Attendance events are immutable; create an adjustment or correction event';
END;
$$;
CREATE TRIGGER hr_attendance_events_immutable
BEFORE UPDATE OR DELETE ON public.hr_attendance_events
FOR EACH ROW EXECUTE FUNCTION public.hr_attendance_events_immutable();

CREATE OR REPLACE FUNCTION public.recalculate_hr_attendance_summary(
  _property_id uuid,
  _employee_id uuid,
  _business_date date,
  _trigger_source text DEFAULT 'explicit_recalculation'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  settings public.hr_workforce_settings%ROWTYPE;
  roster public.hr_duty_roster%ROWTYPE;
  existing public.hr_attendance_summaries%ROWTYPE;
  result_id uuid;
  first_in_at timestamptz;
  clock_in_at timestamptz;
  clock_out_at timestamptz;
  open_break_at timestamptz;
  break_total integer := 0;
  worked_total integer := 0;
  late_total integer := 0;
  early_total integer := 0;
  overtime_total integer := 0;
  status_value text := 'incomplete';
  calc_status text := 'incomplete';
  event_ids_value uuid[] := '{}';
  approval_value text;
  event_row record;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT (
    public.has_hrm_permission(auth.uid(), _property_id, 'attendance', 'manage')
    OR public.has_hrm_permission(auth.uid(), _property_id, 'attendance_adjustments', 'approve')
    OR EXISTS (
      SELECT 1 FROM public.hr_employees own
      WHERE own.id = _employee_id AND own.property_id = _property_id
        AND own.staff_user_id = auth.uid() AND own.archived_at IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'Not authorized to calculate this attendance summary';
  END IF;

  SELECT * INTO settings FROM public.hr_workforce_settings WHERE property_id = _property_id;
  SELECT * INTO roster FROM public.hr_duty_roster
  WHERE property_id = _property_id AND employee_id = _employee_id
    AND duty_date = _business_date AND archived_at IS NULL AND status <> 'cancelled'
  ORDER BY starts_at LIMIT 1;

  FOR event_row IN
    SELECT id, event_at,
      CASE event_type
        WHEN 'manual_clock_in' THEN 'clock_in'
        WHEN 'manual_clock_out' THEN 'clock_out'
        WHEN 'manual_break_start' THEN 'break_start'
        WHEN 'manual_break_end' THEN 'break_end'
        ELSE event_type
      END AS effective_type
    FROM public.hr_attendance_events
    WHERE property_id = _property_id AND employee_id = _employee_id
      AND business_date = _business_date AND invalidated_at IS NULL
      AND event_type <> 'correction_marker'
    ORDER BY event_at, created_at
  LOOP
    event_ids_value := array_append(event_ids_value, event_row.id);
    IF event_row.effective_type = 'clock_in' AND clock_in_at IS NULL THEN
      clock_in_at := event_row.event_at;
      first_in_at := COALESCE(first_in_at, event_row.event_at);
    ELSIF event_row.effective_type = 'break_start' AND open_break_at IS NULL THEN
      open_break_at := event_row.event_at;
    ELSIF event_row.effective_type = 'break_end' AND open_break_at IS NOT NULL THEN
      break_total := break_total + GREATEST(0,
        FLOOR(EXTRACT(EPOCH FROM (event_row.event_at - open_break_at)) / 60)::integer);
      open_break_at := NULL;
    ELSIF event_row.effective_type = 'clock_out' AND clock_in_at IS NOT NULL THEN
      clock_out_at := event_row.event_at;
      worked_total := worked_total + GREATEST(0,
        FLOOR(EXTRACT(EPOCH FROM (event_row.event_at - clock_in_at)) / 60)::integer);
      clock_in_at := NULL;
    END IF;
  END LOOP;

  IF first_in_at IS NOT NULL AND clock_out_at IS NOT NULL
    AND clock_in_at IS NULL AND open_break_at IS NULL THEN
    worked_total := GREATEST(0, worked_total - break_total);
    calc_status := 'calculated';
    status_value := CASE
      WHEN worked_total >= COALESCE(settings.minimum_full_day_minutes, 480) THEN 'present'
      WHEN worked_total >= COALESCE(settings.minimum_half_day_minutes, 240) THEN 'half_day'
      ELSE 'incomplete'
    END;
    IF roster.id IS NOT NULL THEN
      late_total := GREATEST(0,
        FLOOR(EXTRACT(EPOCH FROM (first_in_at - roster.starts_at)) / 60)::integer
        - COALESCE(settings.late_threshold_minutes, 0));
      early_total := GREATEST(0,
        FLOOR(EXTRACT(EPOCH FROM (roster.ends_at - clock_out_at)) / 60)::integer
        - COALESCE(settings.early_departure_threshold_minutes, 0));
      overtime_total := GREATEST(0,
        FLOOR(EXTRACT(EPOCH FROM (clock_out_at - roster.ends_at)) / 60)::integer);
      IF late_total > 0 AND status_value = 'present' THEN status_value := 'late'; END IF;
    END IF;
  END IF;

  IF cardinality(event_ids_value) = 0 AND EXISTS (
    SELECT 1 FROM public.hr_holidays h
    WHERE h.property_id = _property_id AND h.active AND h.archived_at IS NULL
      AND (h.scope_type = 'property' OR EXISTS (
        SELECT 1 FROM public.hr_holiday_departments hd
        JOIN public.hr_employees emp ON emp.id = _employee_id
        WHERE hd.holiday_id = h.id AND hd.department_id = emp.department_id
      ))
      AND (
        (NOT h.recurring_annually AND h.holiday_date = _business_date)
        OR (h.recurring_annually
          AND EXTRACT(month FROM h.holiday_date) = EXTRACT(month FROM _business_date)
          AND EXTRACT(day FROM h.holiday_date) = EXTRACT(day FROM _business_date))
      )
  ) THEN
    status_value := 'holiday';
    calc_status := 'calculated';
  END IF;

  SELECT * INTO existing FROM public.hr_attendance_summaries
  WHERE property_id = _property_id AND employee_id = _employee_id
    AND business_date = _business_date;
  approval_value := CASE
    WHEN COALESCE(settings.attendance_approval_required, true) THEN 'pending'
    ELSE 'not_required'
  END;

  INSERT INTO public.hr_attendance_summaries(
    property_id, employee_id, business_date, roster_id,
    scheduled_start, scheduled_end, first_clock_in, last_clock_out,
    worked_minutes, break_minutes, late_minutes, early_departure_minutes,
    overtime_minutes, attendance_status, calculation_status, source_summary,
    approval_status, calculation_version
  ) VALUES (
    _property_id, _employee_id, _business_date, roster.id,
    roster.starts_at, roster.ends_at, first_in_at, clock_out_at,
    worked_total, break_total, late_total, early_total, overtime_total,
    status_value, calc_status,
    jsonb_build_object('eventCount', cardinality(event_ids_value), 'eventIds', event_ids_value),
    approval_value, COALESCE(existing.calculation_version, 0) + 1
  )
  ON CONFLICT (property_id, employee_id, business_date) DO UPDATE SET
    roster_id = EXCLUDED.roster_id,
    scheduled_start = EXCLUDED.scheduled_start,
    scheduled_end = EXCLUDED.scheduled_end,
    first_clock_in = EXCLUDED.first_clock_in,
    last_clock_out = EXCLUDED.last_clock_out,
    worked_minutes = EXCLUDED.worked_minutes,
    break_minutes = EXCLUDED.break_minutes,
    late_minutes = EXCLUDED.late_minutes,
    early_departure_minutes = EXCLUDED.early_departure_minutes,
    overtime_minutes = EXCLUDED.overtime_minutes,
    attendance_status = EXCLUDED.attendance_status,
    calculation_status = EXCLUDED.calculation_status,
    source_summary = EXCLUDED.source_summary,
    approval_status = CASE
      WHEN hr_attendance_summaries.approval_status = 'approved'
      THEN 'pending' ELSE EXCLUDED.approval_status END,
    approved_by = CASE WHEN hr_attendance_summaries.approval_status = 'approved' THEN NULL
      ELSE hr_attendance_summaries.approved_by END,
    approved_at = CASE WHEN hr_attendance_summaries.approval_status = 'approved' THEN NULL
      ELSE hr_attendance_summaries.approved_at END,
    calculation_version = hr_attendance_summaries.calculation_version + 1,
    updated_at = now()
  RETURNING id INTO result_id;

  INSERT INTO public.hr_attendance_calculation_runs(
    property_id, summary_id, employee_id, business_date, trigger_source,
    event_ids, previous_values, calculated_values, calculated_by
  ) VALUES (
    _property_id, result_id, _employee_id, _business_date, _trigger_source,
    event_ids_value, CASE WHEN existing.id IS NULL THEN NULL ELSE to_jsonb(existing) END,
    (SELECT to_jsonb(current_summary) FROM public.hr_attendance_summaries current_summary
      WHERE current_summary.id = result_id),
    auth.uid()
  );
  RETURN result_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_hr_time_clock_event(
  _property_id uuid,
  _event_type text,
  _request_id uuid,
  _session_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS public.hr_attendance_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  employee public.hr_employees%ROWTYPE;
  settings public.hr_workforce_settings%ROWTYPE;
  roster public.hr_duty_roster%ROWTYPE;
  existing public.hr_attendance_events%ROWTYPE;
  created public.hr_attendance_events%ROWTYPE;
  last_type text;
  now_value timestamptz := clock_timestamp();
  date_value date;
BEGIN
  IF _event_type NOT IN ('clock_in','clock_out','break_start','break_end') THEN
    RAISE EXCEPTION 'Unsupported time-clock event';
  END IF;
  IF NOT public.has_hrm_permission(auth.uid(), _property_id, 'time_clock', 'read') THEN
    RAISE EXCEPTION 'Not authorized to use the time clock';
  END IF;
  SELECT * INTO employee FROM public.hr_employees
  WHERE property_id = _property_id AND staff_user_id = auth.uid()
    AND archived_at IS NULL AND employment_status IN ('active','probation');
  IF employee.id IS NULL THEN RAISE EXCEPTION 'Account is not linked to one active employee'; END IF;
  IF (SELECT count(*) FROM public.hr_employees WHERE property_id = _property_id
      AND staff_user_id = auth.uid() AND archived_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'Account must be linked to exactly one active employee';
  END IF;
  SELECT * INTO existing FROM public.hr_attendance_events
  WHERE property_id = _property_id AND created_by = auth.uid() AND request_id = _request_id;
  IF existing.id IS NOT NULL THEN RETURN existing; END IF;

  SELECT * INTO settings FROM public.hr_workforce_settings WHERE property_id = _property_id;
  SELECT * INTO roster FROM public.hr_duty_roster
  WHERE property_id = _property_id AND employee_id = employee.id
    AND archived_at IS NULL AND status <> 'cancelled'
    AND now_value BETWEEN starts_at - interval '6 hours'
      AND ends_at + interval '6 hours'
  ORDER BY abs(EXTRACT(EPOCH FROM (now_value - starts_at))) LIMIT 1;
  date_value := COALESCE(roster.duty_date,
    (now_value AT TIME ZONE COALESCE(settings.timezone, 'Africa/Accra'))::date);

  SELECT CASE event_type
    WHEN 'manual_clock_in' THEN 'clock_in' WHEN 'manual_clock_out' THEN 'clock_out'
    WHEN 'manual_break_start' THEN 'break_start' WHEN 'manual_break_end' THEN 'break_end'
    ELSE event_type END
  INTO last_type
  FROM public.hr_attendance_events
  WHERE property_id = _property_id AND employee_id = employee.id
    AND business_date = date_value AND invalidated_at IS NULL
    AND event_type <> 'correction_marker'
  ORDER BY event_at DESC, created_at DESC LIMIT 1;

  IF (_event_type = 'clock_in' AND last_type IN ('clock_in','break_end'))
    OR (_event_type = 'break_start' AND last_type <> 'clock_in' AND last_type <> 'break_end')
    OR (_event_type = 'break_end' AND last_type <> 'break_start')
    OR (_event_type = 'clock_out' AND last_type NOT IN ('clock_in','break_end')) THEN
    RAISE EXCEPTION 'Invalid attendance event sequence';
  END IF;

  INSERT INTO public.hr_attendance_events(
    property_id, employee_id, event_type, event_at, business_date, source,
    roster_id, session_metadata, created_by, correlation_id, request_id
  ) VALUES (
    _property_id, employee.id, _event_type, now_value, date_value, 'web_time_clock',
    roster.id, COALESCE(_session_metadata, '{}'::jsonb) - 'fingerprint' - 'userAgent',
    auth.uid(), _request_id, _request_id
  ) RETURNING * INTO created;
  PERFORM public.recalculate_hr_attendance_summary(
    _property_id, employee.id, date_value, 'time_clock'
  );
  RETURN created;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_hr_attendance_adjustment(
  _property_id uuid,
  _adjustment_id uuid,
  _decision text,
  _review_notes text DEFAULT NULL
)
RETURNS public.hr_attendance_adjustments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  adjustment public.hr_attendance_adjustments%ROWTYPE;
  settings public.hr_workforce_settings%ROWTYPE;
  created_event public.hr_attendance_events%ROWTYPE;
  event_type_value text;
  event_at_value timestamptz;
BEGIN
  IF _decision NOT IN ('approved','rejected','returned') THEN
    RAISE EXCEPTION 'Invalid adjustment decision';
  END IF;
  SELECT * INTO adjustment FROM public.hr_attendance_adjustments
  WHERE id = _adjustment_id AND property_id = _property_id FOR UPDATE;
  IF adjustment.id IS NULL OR adjustment.approval_status <> 'pending' THEN
    RAISE EXCEPTION 'Pending adjustment not found';
  END IF;
  SELECT * INTO settings FROM public.hr_workforce_settings WHERE property_id = _property_id;
  IF COALESCE(settings.attendance_approval_required, true) THEN
    IF NOT public.has_hrm_permission(auth.uid(), _property_id, 'attendance_adjustments', 'approve') THEN
      RAISE EXCEPTION 'Not authorized to approve attendance adjustments';
    END IF;
    IF adjustment.submitted_by = auth.uid() THEN
      RAISE EXCEPTION 'Attendance adjustments cannot be self-approved';
    END IF;
  ELSIF adjustment.submitted_by <> auth.uid()
    AND NOT public.has_hrm_permission(auth.uid(), _property_id, 'attendance_adjustments', 'approve') THEN
    RAISE EXCEPTION 'Not authorized to review this adjustment';
  END IF;

  IF _decision = 'approved' AND adjustment.adjustment_type = 'add_event' THEN
    event_type_value := adjustment.proposed_values->>'eventType';
    event_at_value := (adjustment.proposed_values->>'localEventAt')::timestamp
      AT TIME ZONE COALESCE(settings.timezone, 'Africa/Accra');
    IF event_type_value NOT IN (
      'manual_clock_in','manual_clock_out','manual_break_start','manual_break_end'
    ) OR event_at_value IS NULL THEN
      RAISE EXCEPTION 'Approved manual event is invalid';
    END IF;
    INSERT INTO public.hr_attendance_events(
      property_id, employee_id, event_type, event_at, business_date, source,
      roster_id, created_by, correlation_id
    ) VALUES (
      _property_id, adjustment.employee_id, event_type_value, event_at_value,
      adjustment.business_date, 'manual_adjustment',
      NULLIF(adjustment.proposed_values->>'rosterId','')::uuid,
      adjustment.submitted_by, adjustment.id
    ) RETURNING * INTO created_event;
  END IF;

  UPDATE public.hr_attendance_adjustments SET
    approval_status = _decision,
    reviewed_by = auth.uid(),
    reviewed_at = clock_timestamp(),
    review_notes = NULLIF(trim(_review_notes), ''),
    applied_event_id = created_event.id
  WHERE id = adjustment.id
  RETURNING * INTO adjustment;

  IF _decision = 'approved' THEN
    PERFORM public.recalculate_hr_attendance_summary(
      _property_id, adjustment.employee_id, adjustment.business_date, 'adjustment_approval'
    );
    IF adjustment.adjustment_type IN ('summary_status','excused_status') THEN
      UPDATE public.hr_attendance_summaries SET
        attendance_status = CASE WHEN adjustment.adjustment_type = 'excused_status'
          THEN 'excused' ELSE adjustment.proposed_values->>'attendanceStatus' END,
        calculation_status = 'adjusted',
        notes = COALESCE(adjustment.proposed_values->>'notes', notes)
      WHERE property_id = _property_id AND employee_id = adjustment.employee_id
        AND business_date = adjustment.business_date;
    ELSIF adjustment.adjustment_type = 'roster_reference' THEN
      UPDATE public.hr_attendance_summaries SET
        roster_id = NULLIF(adjustment.proposed_values->>'rosterId','')::uuid,
        calculation_status = 'adjusted'
      WHERE property_id = _property_id AND employee_id = adjustment.employee_id
        AND business_date = adjustment.business_date;
    END IF;
  END IF;
  RETURN adjustment;
END;
$$;

ALTER TABLE public.hr_attendance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_attendance_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_attendance_calculation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_attendance_adjustments ENABLE ROW LEVEL SECURITY;

CREATE POLICY hr_attendance_events_read ON public.hr_attendance_events
FOR SELECT TO authenticated USING (
  public.has_hrm_permission(auth.uid(), property_id, 'attendance_events', 'read')
  OR EXISTS (SELECT 1 FROM public.hr_employees own
    WHERE own.id = employee_id AND own.property_id = property_id
      AND own.staff_user_id = auth.uid())
);
CREATE POLICY hr_attendance_summaries_read ON public.hr_attendance_summaries
FOR SELECT TO authenticated USING (
  public.has_hrm_permission(auth.uid(), property_id, 'attendance', 'read')
  OR (public.has_hrm_permission(auth.uid(), property_id, 'attendance_own', 'read')
    AND EXISTS (SELECT 1 FROM public.hr_employees own
    WHERE own.id = employee_id AND own.property_id = property_id
      AND own.staff_user_id = auth.uid()))
);
CREATE POLICY hr_attendance_summaries_write ON public.hr_attendance_summaries
FOR ALL TO authenticated USING (
  public.has_hrm_permission(auth.uid(), property_id, 'attendance', 'manage')
  OR public.has_hrm_permission(auth.uid(), property_id, 'attendance', 'approve')
) WITH CHECK (
  public.has_hrm_permission(auth.uid(), property_id, 'attendance', 'manage')
  OR public.has_hrm_permission(auth.uid(), property_id, 'attendance', 'approve')
);
CREATE POLICY hr_attendance_runs_read ON public.hr_attendance_calculation_runs
FOR SELECT TO authenticated USING (
  public.has_hrm_permission(auth.uid(), property_id, 'attendance_events', 'read')
);
CREATE POLICY hr_attendance_adjustments_read ON public.hr_attendance_adjustments
FOR SELECT TO authenticated USING (
  public.has_hrm_permission(auth.uid(), property_id, 'attendance_adjustments', 'read')
);
CREATE POLICY hr_attendance_adjustments_create ON public.hr_attendance_adjustments
FOR INSERT TO authenticated WITH CHECK (
  public.has_hrm_permission(auth.uid(), property_id, 'attendance_adjustments', 'create')
  AND submitted_by = auth.uid()
);
CREATE POLICY hr_attendance_adjustments_review ON public.hr_attendance_adjustments
FOR UPDATE TO authenticated USING (
  public.has_hrm_permission(auth.uid(), property_id, 'attendance_adjustments', 'approve')
) WITH CHECK (
  public.has_hrm_permission(auth.uid(), property_id, 'attendance_adjustments', 'approve')
);

GRANT SELECT ON public.hr_attendance_events, public.hr_attendance_summaries,
  public.hr_attendance_calculation_runs, public.hr_attendance_adjustments TO authenticated;
GRANT INSERT ON public.hr_attendance_adjustments TO authenticated;
GRANT UPDATE ON public.hr_attendance_summaries, public.hr_attendance_adjustments TO authenticated;
GRANT ALL ON public.hr_attendance_events, public.hr_attendance_summaries,
  public.hr_attendance_calculation_runs, public.hr_attendance_adjustments TO service_role;
REVOKE ALL ON FUNCTION public.record_hr_time_clock_event(uuid, text, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recalculate_hr_attendance_summary(uuid, uuid, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_hr_attendance_adjustment(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_hr_time_clock_event(uuid, text, uuid, jsonb)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recalculate_hr_attendance_summary(uuid, uuid, date, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_hr_attendance_adjustment(uuid, uuid, text, text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.seed_attendance_permissions(_property_id uuid)
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
      ('attendance','read'), ('attendance','create'), ('attendance','manage'),
      ('attendance','approve'), ('attendance','export'), ('attendance','print'),
      ('attendance_events','read'),
      ('attendance_adjustments','read'), ('attendance_adjustments','create'),
      ('attendance_adjustments','approve')
  ) permission(module_name, action_name)
  CROSS JOIN (VALUES ('super_admin'),('hotel_owner'),('general_manager'),('hr')) role(role_name)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.role_permissions(property_id, role, module, action, allowed)
  SELECT _property_id, role_name::public.app_role, module_name, action_name, true
  FROM (VALUES ('attendance_own','read'), ('time_clock','read'))
    permission(module_name, action_name)
  CROSS JOIN (VALUES
    ('super_admin'),('hotel_owner'),('general_manager'),('hr'),('manager'),
    ('front_desk'),('reservations'),('cashier'),('accountant'),
    ('housekeeping_supervisor'),('housekeeping'),('maintenance'),('kitchen'),
    ('restaurant_manager'),('waiter'),('storekeeper'),('guest_relations'),
    ('security'),('auditor')
  ) role(role_name)
  ON CONFLICT DO NOTHING;
END;
$$;
SELECT public.seed_attendance_permissions(id) FROM public.properties;
REVOKE ALL ON FUNCTION public.seed_attendance_permissions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_attendance_permissions(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.seed_attendance_permissions_for_property()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.seed_attendance_permissions(NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER properties_seed_attendance_permissions
AFTER INSERT ON public.properties
FOR EACH ROW EXECUTE FUNCTION public.seed_attendance_permissions_for_property();
REVOKE ALL ON FUNCTION public.seed_attendance_permissions_for_property() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_attendance_permissions_for_property() TO service_role;

COMMENT ON TABLE public.hr_attendance_events
  IS 'Immutable attendance facts. Corrections use manual events or adjustment records.';
COMMENT ON COLUMN public.hr_attendance_events.event_at
  IS 'Authoritative UTC instant; web clock events use the database server clock.';
COMMENT ON COLUMN public.hr_attendance_summaries.overtime_minutes
  IS 'Informational only; not approved for payroll or payment calculation.';
