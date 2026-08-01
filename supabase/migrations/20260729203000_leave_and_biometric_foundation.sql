-- Phase 3C: leave management and vendor-neutral biometric architecture.
-- Additive only; no payroll effects and no raw biometric data or live adapters.

DO $$
DECLARE status_constraint name; status_definition text;
BEGIN
  SELECT c.conname,pg_get_constraintdef(c.oid) INTO status_constraint,status_definition
  FROM pg_constraint c
  WHERE c.conrelid='public.hr_attendance_summaries'::regclass AND c.contype='c'
    AND pg_get_constraintdef(c.oid) ILIKE '%attendance_status%'
  LIMIT 1;
  IF status_definition IS NULL OR status_definition NOT ILIKE '%on_leave%' THEN
    IF status_constraint IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.hr_attendance_summaries DROP CONSTRAINT %I',status_constraint);
    END IF;
    ALTER TABLE public.hr_attendance_summaries
      ADD CONSTRAINT hr_attendance_summaries_attendance_status_check
      CHECK (attendance_status IN (
        'present','absent','late','half_day','holiday','rest_day','incomplete','excused','on_leave'
      ));
  END IF;
END $$;

CREATE TABLE public.hr_leave_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES public.properties(id),
  name text NOT NULL, code text NOT NULL, description text, paid boolean NOT NULL DEFAULT true,
  annual_entitlement numeric(8,2) NOT NULL DEFAULT 0 CHECK (annual_entitlement >= 0),
  entitlement_unit text NOT NULL DEFAULT 'days' CHECK (entitlement_unit='days'),
  accrual_method text NOT NULL DEFAULT 'annual' CHECK (accrual_method IN ('annual','periodic','manual')),
  accrual_frequency text NOT NULL DEFAULT 'yearly' CHECK (accrual_frequency IN ('monthly','quarterly','yearly','none')),
  leave_year_start_month smallint NOT NULL DEFAULT 1 CHECK(leave_year_start_month BETWEEN 1 AND 12),
  carry_forward_enabled boolean NOT NULL DEFAULT false, maximum_carry_forward numeric(8,2) NOT NULL DEFAULT 0,
  carry_forward_expiry_days integer, minimum_notice_days integer NOT NULL DEFAULT 0,
  maximum_consecutive_days numeric(8,2), minimum_request_duration numeric(8,2) NOT NULL DEFAULT 0.5,
  partial_day_supported boolean NOT NULL DEFAULT true, supporting_document_required boolean NOT NULL DEFAULT false,
  negative_balance_allowed boolean NOT NULL DEFAULT false, probation_eligible boolean NOT NULL DEFAULT false,
  minimum_service_days integer NOT NULL DEFAULT 0, eligibility_rules jsonb NOT NULL DEFAULT '{}',
  approval_required boolean NOT NULL DEFAULT true, active boolean NOT NULL DEFAULT true,
  archived_at timestamptz, archived_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id), UNIQUE(property_id,code),
  CHECK (NOT carry_forward_enabled OR maximum_carry_forward > 0),
  CHECK (partial_day_supported OR minimum_request_duration >= 1),
  CHECK (maximum_consecutive_days IS NULL OR maximum_consecutive_days >= minimum_request_duration),
  CHECK (approval_required)
);
CREATE UNIQUE INDEX hr_leave_types_code_ci_uniq ON public.hr_leave_types(property_id,lower(code));

CREATE TABLE public.hr_leave_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, employee_id uuid NOT NULL,
  leave_type_id uuid NOT NULL, period_start date NOT NULL, period_end date NOT NULL,
  opening_balance numeric(10,2) NOT NULL DEFAULT 0, accrued_amount numeric(10,2) NOT NULL DEFAULT 0,
  carried_amount numeric(10,2) NOT NULL DEFAULT 0, used_amount numeric(10,2) NOT NULL DEFAULT 0,
  pending_amount numeric(10,2) NOT NULL DEFAULT 0, adjusted_amount numeric(10,2) NOT NULL DEFAULT 0,
  remaining_balance numeric(10,2) GENERATED ALWAYS AS
    (opening_balance+accrued_amount+carried_amount+adjusted_amount-used_amount-pending_amount) STORED,
  calculation_version integer NOT NULL DEFAULT 1, last_recalculated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,employee_id,leave_type_id,period_start,period_end), UNIQUE(property_id,id),
  FOREIGN KEY(property_id,employee_id) REFERENCES public.hr_employees(property_id,id),
  FOREIGN KEY(property_id,leave_type_id) REFERENCES public.hr_leave_types(property_id,id),
  CHECK(period_end>=period_start)
);

CREATE TABLE public.hr_leave_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, employee_id uuid NOT NULL,
  leave_type_id uuid NOT NULL, start_date date NOT NULL, end_date date NOT NULL,
  partial_day_mode text NOT NULL DEFAULT 'none' CHECK(partial_day_mode IN ('none','morning','afternoon')),
  partial_day_date date, total_requested_days numeric(8,2) NOT NULL CHECK(total_requested_days>0),
  reason text NOT NULL, supporting_document_path text, supporting_document_name text,
  supporting_document_mime text, supporting_document_size integer,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected','returned','withdrawn','cancelled')),
  current_approval_step integer NOT NULL DEFAULT 0, submitted_at timestamptz, reviewed_at timestamptz,
  cancelled_at timestamptz, withdrawn_at timestamptz, created_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id), FOREIGN KEY(property_id,employee_id) REFERENCES public.hr_employees(property_id,id),
  FOREIGN KEY(property_id,leave_type_id) REFERENCES public.hr_leave_types(property_id,id),
  CHECK(end_date>=start_date),
  CHECK(supporting_document_path IS NULL OR supporting_document_path LIKE property_id::text||'/'||employee_id::text||'/%'),
  CHECK(supporting_document_size IS NULL OR supporting_document_size BETWEEN 1 AND 10485760),
  CHECK(supporting_document_mime IS NULL OR supporting_document_mime IN ('application/pdf','image/jpeg','image/png'))
);
ALTER TABLE public.hr_leave_requests ADD CONSTRAINT hr_leave_requests_no_overlap
EXCLUDE USING gist(property_id WITH =,employee_id WITH =,daterange(start_date,end_date,'[]') WITH &&)
WHERE(status IN ('submitted','approved'));
CREATE INDEX hr_leave_requests_period_idx ON public.hr_leave_requests(property_id,start_date,end_date,status);
CREATE INDEX hr_leave_requests_employee_idx
  ON public.hr_leave_requests(property_id,employee_id,status,start_date);

CREATE TABLE public.hr_leave_approval_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, request_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('submitted','approved','rejected','returned','withdrawn','cancelled')),
  previous_status text NOT NULL, new_status text NOT NULL, reason text, actor_id uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(property_id,request_id) REFERENCES public.hr_leave_requests(property_id,id)
);
CREATE INDEX hr_leave_approval_history_request_idx
  ON public.hr_leave_approval_history(property_id,request_id,created_at);
CREATE TABLE public.hr_leave_balance_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, balance_id uuid NOT NULL,
  previous_amount numeric(10,2) NOT NULL, proposed_amount numeric(10,2) NOT NULL,
  reason text NOT NULL CHECK(char_length(trim(reason))>=5), status text NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','rejected')),
  submitted_by uuid NOT NULL REFERENCES public.profiles(id), reviewed_by uuid REFERENCES public.profiles(id),
  reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(property_id,balance_id) REFERENCES public.hr_leave_balances(property_id,id)
);
CREATE UNIQUE INDEX hr_leave_balance_adjustments_pending_uniq
ON public.hr_leave_balance_adjustments(property_id,balance_id)
WHERE status='pending';
CREATE INDEX hr_leave_balance_adjustments_history_idx
  ON public.hr_leave_balance_adjustments(property_id,balance_id,created_at);

CREATE TABLE public.hr_roster_leave_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, roster_id uuid NOT NULL,
  leave_request_id uuid NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','overridden','cleared')),
  override_reason text, resolved_by uuid REFERENCES public.profiles(id), resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(property_id,roster_id,leave_request_id),
  FOREIGN KEY(property_id,roster_id) REFERENCES public.hr_duty_roster(property_id,id),
  FOREIGN KEY(property_id,leave_request_id) REFERENCES public.hr_leave_requests(property_id,id)
);
CREATE INDEX hr_roster_leave_conflicts_open_idx
  ON public.hr_roster_leave_conflicts(property_id,leave_request_id,status);

CREATE TABLE public.hr_biometric_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES public.properties(id),
  name text NOT NULL, location text, provider_adapter text NOT NULL,
  capability text[] NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'unconfigured'
    CHECK(status IN ('unconfigured','offline','online_placeholder','disabled')),
  connector_config_reference text, health_metadata jsonb NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT false, archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id), UNIQUE(property_id,name),
  CHECK(connector_config_reference IS NULL OR connector_config_reference ~ '^secret://[a-zA-Z0-9/_-]+$'),
  CHECK(lower(health_metadata::text) !~ '(fingerprint|face.?image|template|credential|password|secret|token|raw.?payload)')
);
CREATE TABLE public.hr_biometric_employee_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, device_id uuid NOT NULL,
  employee_id uuid NOT NULL, external_employee_identifier text NOT NULL, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(property_id,device_id,external_employee_identifier),
  FOREIGN KEY(property_id,device_id) REFERENCES public.hr_biometric_devices(property_id,id),
  FOREIGN KEY(property_id,employee_id) REFERENCES public.hr_employees(property_id,id)
);
CREATE INDEX hr_biometric_employee_mappings_employee_idx
  ON public.hr_biometric_employee_mappings(property_id,employee_id,active);
CREATE TABLE public.hr_biometric_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, device_id uuid NOT NULL,
  adapter_type text NOT NULL, status text NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','processing','completed','partial','failed','retry_pending')),
  safe_provider_reference text, imported_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE(property_id,id), FOREIGN KEY(property_id,device_id) REFERENCES public.hr_biometric_devices(property_id,id)
);
CREATE TABLE public.hr_biometric_normalized_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL, device_id uuid NOT NULL,
  batch_id uuid NOT NULL, external_employee_identifier text NOT NULL, employee_id uuid,
  source_event_id text NOT NULL, event_at timestamptz NOT NULL,
  event_type text NOT NULL CHECK(event_type IN('clock_in','clock_out','break_start','break_end')),
  deduplication_key text NOT NULL, processing_status text NOT NULL DEFAULT 'pending'
    CHECK(processing_status IN ('pending','mapped','converted','unmapped','rejected','retry_pending')),
  rejection_reason text, attendance_event_id uuid REFERENCES public.hr_attendance_events(id),
  payload_hash text, safe_provider_reference text, ingested_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(property_id,id),
  UNIQUE(property_id,deduplication_key), UNIQUE(property_id,device_id,source_event_id),
  FOREIGN KEY(property_id,device_id) REFERENCES public.hr_biometric_devices(property_id,id),
  FOREIGN KEY(property_id,batch_id) REFERENCES public.hr_biometric_import_batches(property_id,id),
  FOREIGN KEY(property_id,employee_id) REFERENCES public.hr_employees(property_id,id)
);
CREATE INDEX hr_biometric_normalized_events_review_idx
  ON public.hr_biometric_normalized_events(property_id,processing_status,ingested_at);
CREATE TABLE public.hr_biometric_processing_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL,
  normalized_event_id uuid NOT NULL, previous_status text, new_status text NOT NULL,
  message text, safe_metadata jsonb NOT NULL DEFAULT '{}',
  actor_id uuid REFERENCES public.profiles(id), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(property_id,normalized_event_id)
    REFERENCES public.hr_biometric_normalized_events(property_id,id),
  CHECK(lower(safe_metadata::text) !~ '(fingerprint|face.?image|template|credential|password|secret|token|raw.?payload)')
);
CREATE INDEX hr_biometric_processing_logs_event_idx
  ON public.hr_biometric_processing_logs(property_id,normalized_event_id,created_at);

ALTER TABLE public.hr_duty_roster
  ADD COLUMN leave_override_reason text,
  ADD COLUMN leave_override_by uuid REFERENCES public.profiles(id);

CREATE OR REPLACE FUNCTION public.hr_calculate_leave_days(
  _property_id uuid, _start date, _end date, _partial_mode text DEFAULT 'none'
) RETURNS numeric LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE days numeric := 0; d date; working smallint[];
BEGIN
  IF _end < _start THEN RAISE EXCEPTION 'Invalid leave date range'; END IF;
  SELECT default_working_days INTO working FROM public.hr_workforce_settings
  WHERE property_id=_property_id;
  FOR d IN SELECT generate_series(_start,_end,interval '1 day')::date LOOP
    IF EXTRACT(dow FROM d)::smallint = ANY(COALESCE(working,ARRAY[1,2,3,4,5]::smallint[]))
      AND NOT EXISTS(SELECT 1 FROM public.hr_holidays h
        WHERE h.property_id=_property_id AND h.active AND h.archived_at IS NULL
        AND ((NOT h.recurring_annually AND h.holiday_date=d)
          OR (h.recurring_annually AND EXTRACT(month FROM h.holiday_date)=EXTRACT(month FROM d)
            AND EXTRACT(day FROM h.holiday_date)=EXTRACT(day FROM d)))) THEN
      days := days+1;
    END IF;
  END LOOP;
  IF _partial_mode<>'none' THEN
    IF days<>1 THEN RAISE EXCEPTION 'Partial leave must be one working day'; END IF;
    days:=0.5;
  END IF;
  RETURN days;
END $$;

CREATE OR REPLACE FUNCTION public.recalculate_hr_leave_balance(
  _property_id uuid,_employee_id uuid,_leave_type_id uuid,_period_start date,_period_end date
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE bid uuid; pending numeric; used numeric; accrued numeric:=0; carried numeric:=0;
  prior_remaining numeric:=0; elapsed_months integer:=0; lt public.hr_leave_types%ROWTYPE;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT (
    public.has_hrm_permission(auth.uid(),_property_id,'leave_balances','manage')
    OR public.has_hrm_permission(auth.uid(),_property_id,'leave_balances','read')
    OR public.has_hrm_permission(auth.uid(),_property_id,'leave','approve')
    OR EXISTS(
      SELECT 1 FROM public.hr_employees own
      WHERE own.property_id=_property_id AND own.id=_employee_id
        AND own.staff_user_id=auth.uid() AND own.archived_at IS NULL
    )
  ) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT * INTO lt FROM public.hr_leave_types
  WHERE id=_leave_type_id AND property_id=_property_id;
  IF lt.id IS NULL THEN RAISE EXCEPTION 'Leave type not found'; END IF;
  SELECT COALESCE(sum(total_requested_days),0) INTO pending FROM public.hr_leave_requests
  WHERE property_id=_property_id AND employee_id=_employee_id AND leave_type_id=_leave_type_id
    AND status='submitted' AND start_date BETWEEN _period_start AND _period_end;
  SELECT COALESCE(sum(total_requested_days),0) INTO used FROM public.hr_leave_requests
  WHERE property_id=_property_id AND employee_id=_employee_id AND leave_type_id=_leave_type_id
    AND status='approved' AND start_date BETWEEN _period_start AND _period_end;
  IF lt.accrual_method='annual' THEN
    accrued:=lt.annual_entitlement;
  ELSIF lt.accrual_method='periodic' AND current_date>=_period_start THEN
    elapsed_months:=(
      EXTRACT(year FROM age(LEAST(current_date,_period_end),_period_start))::integer*12+
      EXTRACT(month FROM age(LEAST(current_date,_period_end),_period_start))::integer+1
    );
    accrued:=CASE lt.accrual_frequency
      WHEN 'monthly' THEN lt.annual_entitlement*LEAST(elapsed_months,12)/12
      WHEN 'quarterly' THEN lt.annual_entitlement*LEAST(CEIL(elapsed_months/3.0),4)/4
      WHEN 'yearly' THEN lt.annual_entitlement
      ELSE 0 END;
  END IF;
  IF lt.carry_forward_enabled AND (
    lt.carry_forward_expiry_days IS NULL OR
    current_date<=_period_start+lt.carry_forward_expiry_days
  ) THEN
    SELECT COALESCE(remaining_balance,0) INTO prior_remaining
    FROM public.hr_leave_balances
    WHERE property_id=_property_id AND employee_id=_employee_id
      AND leave_type_id=_leave_type_id AND period_end=_period_start-1
    ORDER BY period_start DESC LIMIT 1;
    carried:=LEAST(GREATEST(COALESCE(prior_remaining,0),0),lt.maximum_carry_forward);
  END IF;
  INSERT INTO public.hr_leave_balances(property_id,employee_id,leave_type_id,period_start,period_end,
    accrued_amount,carried_amount,pending_amount,used_amount)
  VALUES(_property_id,_employee_id,_leave_type_id,_period_start,_period_end,
    accrued,carried,pending,used)
  ON CONFLICT(property_id,employee_id,leave_type_id,period_start,period_end) DO UPDATE SET
    accrued_amount=EXCLUDED.accrued_amount,pending_amount=EXCLUDED.pending_amount,
    used_amount=EXCLUDED.used_amount,carried_amount=EXCLUDED.carried_amount,
    calculation_version=hr_leave_balances.calculation_version+1,
    last_recalculated_at=now()
  RETURNING id INTO bid;
  IF NOT lt.negative_balance_allowed AND
    (SELECT remaining_balance FROM public.hr_leave_balances WHERE id=bid)<0 THEN
    RAISE EXCEPTION 'Insufficient leave balance';
  END IF;
  RETURN bid;
END $$;

CREATE OR REPLACE FUNCTION public.hr_leave_period_start(_date date,_start_month smallint)
RETURNS date LANGUAGE sql IMMUTABLE SET search_path=public AS $$
  SELECT make_date(
    EXTRACT(year FROM _date)::integer-
      CASE WHEN EXTRACT(month FROM _date)::integer<_start_month THEN 1 ELSE 0 END,
    _start_month,1
  )
$$;

CREATE OR REPLACE FUNCTION public.hr_initialize_leave_balances(
  _property_id uuid,_employee_id uuid DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE item record; period_start date; initialized integer:=0;
BEGIN
  IF _employee_id IS NULL THEN
    IF NOT public.has_hrm_permission(auth.uid(),_property_id,'leave_balances','read')
      THEN RAISE EXCEPTION 'Not authorized'; END IF;
  ELSIF NOT (
    public.has_hrm_permission(auth.uid(),_property_id,'leave_balances','read') OR EXISTS(
      SELECT 1 FROM public.hr_employees own
      WHERE own.property_id=_property_id AND own.id=_employee_id
        AND own.staff_user_id=auth.uid() AND own.archived_at IS NULL
    )
  ) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  FOR item IN
    SELECT e.id employee_id,t.id leave_type_id,t.leave_year_start_month
    FROM public.hr_employees e CROSS JOIN public.hr_leave_types t
    WHERE e.property_id=_property_id AND t.property_id=_property_id
      AND e.archived_at IS NULL AND e.employment_status IN('active','probation')
      AND t.active AND t.archived_at IS NULL
      AND (_employee_id IS NULL OR e.id=_employee_id)
  LOOP
    period_start:=public.hr_leave_period_start(current_date,item.leave_year_start_month);
    IF NOT EXISTS(
      SELECT 1 FROM public.hr_leave_balances b
      WHERE b.property_id=_property_id AND b.employee_id=item.employee_id
        AND b.leave_type_id=item.leave_type_id AND b.period_start=period_start
        AND b.last_recalculated_at::date=current_date
    ) THEN
      PERFORM public.recalculate_hr_leave_balance(
        _property_id,item.employee_id,item.leave_type_id,period_start,
        (period_start+interval '1 year - 1 day')::date
      );
      initialized:=initialized+1;
    END IF;
  END LOOP;
  RETURN initialized;
END $$;

CREATE OR REPLACE FUNCTION public.hr_submit_leave_request(_property_id uuid,_request_id uuid)
RETURNS public.hr_leave_requests LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r public.hr_leave_requests%ROWTYPE; lt public.hr_leave_types%ROWTYPE; e public.hr_employees%ROWTYPE;
  period_start date; period_end date; previous_status text; manager_user_id uuid;
BEGIN
  SELECT * INTO r FROM public.hr_leave_requests WHERE id=_request_id AND property_id=_property_id FOR UPDATE;
  SELECT * INTO e FROM public.hr_employees WHERE id=r.employee_id AND property_id=_property_id;
  SELECT * INTO lt FROM public.hr_leave_types WHERE id=r.leave_type_id AND property_id=_property_id;
  IF r.id IS NULL OR r.status NOT IN('draft','returned') THEN RAISE EXCEPTION 'Editable request not found'; END IF;
  IF NOT lt.active OR lt.archived_at IS NOT NULL THEN RAISE EXCEPTION 'Leave type is not active'; END IF;
  IF e.staff_user_id<>auth.uid() AND NOT public.has_hrm_permission(auth.uid(),_property_id,'leave','approve')
    THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF e.archived_at IS NOT NULL OR e.employment_status NOT IN('active','probation')
    THEN RAISE EXCEPTION 'Inactive employee cannot request leave'; END IF;
  IF e.employment_status='probation' AND NOT lt.probation_eligible THEN RAISE EXCEPTION 'Not eligible during probation'; END IF;
  IF r.start_date-e.hire_date<lt.minimum_service_days THEN RAISE EXCEPTION 'Minimum service duration not met'; END IF;
  IF lt.supporting_document_required AND (
    r.supporting_document_path IS NULL OR NOT EXISTS(
      SELECT 1 FROM storage.objects o
      WHERE o.bucket_id='employee-documents' AND o.name=r.supporting_document_path
    )
  ) THEN RAISE EXCEPTION 'Supporting document required'; END IF;
  IF r.partial_day_mode<>'none' AND NOT lt.partial_day_supported
    THEN RAISE EXCEPTION 'Partial-day leave is not supported'; END IF;
  IF r.start_date<current_date+lt.minimum_notice_days THEN RAISE EXCEPTION 'Minimum notice not met'; END IF;
  previous_status:=r.status;
  r.total_requested_days:=public.hr_calculate_leave_days(_property_id,r.start_date,r.end_date,r.partial_day_mode);
  IF r.total_requested_days<=0 THEN RAISE EXCEPTION 'Leave range has no working days'; END IF;
  IF r.total_requested_days<lt.minimum_request_duration OR
    (lt.maximum_consecutive_days IS NOT NULL AND r.total_requested_days>lt.maximum_consecutive_days)
    THEN RAISE EXCEPTION 'Requested duration is outside policy'; END IF;
  period_start:=public.hr_leave_period_start(r.start_date,lt.leave_year_start_month);
  period_end:=(period_start+interval '1 year - 1 day')::date;
  PERFORM set_config('app.leave_transition','true',true);
  UPDATE public.hr_leave_requests SET status='submitted',submitted_at=now(),
    total_requested_days=r.total_requested_days,current_approval_step=1 WHERE id=r.id RETURNING * INTO r;
  INSERT INTO public.hr_leave_approval_history(property_id,request_id,action,previous_status,new_status,actor_id)
    VALUES(_property_id,r.id,'submitted',previous_status,'submitted',auth.uid());
  SELECT staff_user_id INTO manager_user_id FROM public.hr_employees
  WHERE id=e.reporting_manager_id AND property_id=_property_id AND archived_at IS NULL;
  IF manager_user_id IS NOT NULL THEN
    PERFORM public.notify(_property_id,manager_user_id,'leave','normal',
      'Leave request awaiting review',
      e.first_name||' '||e.last_name||' submitted a leave request.',
      '/hrm/leave',jsonb_build_object('leaveRequestId',r.id));
  END IF;
  PERFORM public.recalculate_hr_leave_balance(_property_id,r.employee_id,r.leave_type_id,period_start,period_end);
  INSERT INTO public.hr_roster_leave_conflicts(property_id,roster_id,leave_request_id)
    SELECT _property_id,roster.id,r.id FROM public.hr_duty_roster roster
    WHERE roster.property_id=_property_id AND roster.employee_id=r.employee_id
      AND roster.duty_date BETWEEN r.start_date AND r.end_date AND roster.archived_at IS NULL
    ON CONFLICT DO NOTHING;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.hr_decide_leave_request(
 _property_id uuid,_request_id uuid,_decision text,_reason text DEFAULT NULL
) RETURNS public.hr_leave_requests LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r public.hr_leave_requests%ROWTYPE; lt public.hr_leave_types%ROWTYPE;
  old_status text; d date; pstart date; pend date;
  reviewer_employee_id uuid; employee_user_id uuid;
BEGIN
  IF _decision NOT IN('approved','rejected','returned','withdrawn','cancelled') THEN RAISE EXCEPTION 'Invalid decision'; END IF;
  SELECT * INTO r FROM public.hr_leave_requests WHERE id=_request_id AND property_id=_property_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF; old_status:=r.status;
  SELECT * INTO lt FROM public.hr_leave_types WHERE id=r.leave_type_id AND property_id=_property_id;
  IF _decision IN('approved','rejected','returned','cancelled') THEN
    IF NOT public.has_hrm_permission(auth.uid(),_property_id,'leave',
      CASE WHEN _decision='cancelled' THEN 'delete' ELSE 'approve' END) THEN RAISE EXCEPTION 'Not authorized'; END IF;
    IF (SELECT staff_user_id FROM public.hr_employees WHERE id=r.employee_id)=auth.uid()
      THEN RAISE EXCEPTION 'Leave requests cannot be self-approved'; END IF;
    IF NOT public.has_hrm_permission(auth.uid(),_property_id,'leave_property','read') THEN
      SELECT id INTO reviewer_employee_id FROM public.hr_employees
      WHERE property_id=_property_id AND staff_user_id=auth.uid() AND archived_at IS NULL;
      IF reviewer_employee_id IS NULL OR
        (SELECT reporting_manager_id FROM public.hr_employees WHERE id=r.employee_id)<>reviewer_employee_id
      THEN RAISE EXCEPTION 'Reviewer is outside the employee reporting scope'; END IF;
    END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM public.hr_employees e WHERE e.id=r.employee_id AND e.staff_user_id=auth.uid())
      THEN RAISE EXCEPTION 'Not authorized'; END IF;
  END IF;
  IF _decision<>'approved' AND char_length(trim(COALESCE(_reason,'')))<5
    THEN RAISE EXCEPTION 'A reason is required'; END IF;
  IF (_decision='approved' AND r.status<>'submitted') OR
     (_decision IN('rejected','returned') AND r.status<>'submitted') OR
     (_decision='withdrawn' AND r.status<>'submitted') OR
     (_decision='cancelled' AND r.status<>'approved') THEN RAISE EXCEPTION 'Invalid finalized transition'; END IF;
  PERFORM set_config('app.leave_transition','true',true);
  UPDATE public.hr_leave_requests SET status=_decision,
    reviewed_at=CASE WHEN _decision IN('approved','rejected','returned') THEN now() ELSE reviewed_at END,
    withdrawn_at=CASE WHEN _decision='withdrawn' THEN now() ELSE withdrawn_at END,
    cancelled_at=CASE WHEN _decision='cancelled' THEN now() ELSE cancelled_at END
  WHERE id=r.id RETURNING * INTO r;
  INSERT INTO public.hr_leave_approval_history(property_id,request_id,action,previous_status,new_status,reason,actor_id)
    VALUES(_property_id,r.id,_decision,old_status,_decision,NULLIF(trim(_reason),''),auth.uid());
  SELECT staff_user_id INTO employee_user_id FROM public.hr_employees
  WHERE id=r.employee_id AND property_id=_property_id;
  IF employee_user_id IS NOT NULL THEN
    PERFORM public.notify(_property_id,employee_user_id,'leave','normal',
      'Leave request '||_decision,'Your leave request is '||_decision||'.',
      '/hrm/leave',jsonb_build_object('leaveRequestId',r.id));
  END IF;
  pstart:=public.hr_leave_period_start(r.start_date,lt.leave_year_start_month);
  pend:=(pstart+interval '1 year - 1 day')::date;
  PERFORM public.recalculate_hr_leave_balance(_property_id,r.employee_id,r.leave_type_id,pstart,pend);
  IF _decision='approved' AND r.partial_day_mode='none' THEN
    FOR d IN SELECT generate_series(r.start_date,r.end_date,interval '1 day')::date LOOP
      IF public.hr_calculate_leave_days(_property_id,d,d,'none')>0 THEN
        INSERT INTO public.hr_attendance_summaries(property_id,employee_id,business_date,attendance_status,
          calculation_status,source_summary,approval_status)
        VALUES(_property_id,r.employee_id,d,'on_leave','adjusted',jsonb_build_object('leaveRequestId',r.id),'not_required')
        ON CONFLICT(property_id,employee_id,business_date) DO UPDATE SET
          attendance_status=CASE WHEN hr_attendance_summaries.first_clock_in IS NULL THEN 'on_leave'
            ELSE hr_attendance_summaries.attendance_status END,
          source_summary=hr_attendance_summaries.source_summary||jsonb_build_object('leaveRequestId',r.id),
          calculation_status='adjusted';
      END IF;
    END LOOP;
  ELSIF _decision='cancelled' THEN
    UPDATE public.hr_attendance_summaries SET source_summary=source_summary-'leaveRequestId',
      calculation_status='calculated',
      attendance_status=CASE WHEN first_clock_in IS NULL THEN 'incomplete' ELSE attendance_status END
    WHERE property_id=_property_id AND employee_id=r.employee_id
      AND business_date BETWEEN r.start_date AND r.end_date
      AND source_summary->>'leaveRequestId'=r.id::text;
  END IF;
  IF _decision IN('withdrawn','cancelled','rejected','returned') THEN
    UPDATE public.hr_roster_leave_conflicts SET status='cleared',resolved_by=auth.uid(),resolved_at=now()
    WHERE property_id=_property_id AND leave_request_id=r.id AND status='open';
  END IF;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.hr_block_roster_leave_conflict()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.hr_leave_requests l WHERE l.property_id=NEW.property_id
   AND l.employee_id=NEW.employee_id AND l.status IN('submitted','approved')
   AND NEW.duty_date BETWEEN l.start_date AND l.end_date) THEN
   IF char_length(trim(COALESCE(NEW.leave_override_reason,'')))<5 OR
      NOT public.has_hrm_permission(auth.uid(),NEW.property_id,'duty_roster','manage')
   THEN RAISE EXCEPTION 'Roster conflicts with submitted or approved leave'; END IF;
   NEW.leave_override_by:=auth.uid();
 ELSE
   NEW.leave_override_reason:=NULL;
   NEW.leave_override_by:=NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hr_duty_roster_leave_conflict BEFORE INSERT OR UPDATE OF employee_id,duty_date,shift_id
ON public.hr_duty_roster FOR EACH ROW EXECUTE FUNCTION public.hr_block_roster_leave_conflict();

CREATE OR REPLACE FUNCTION public.hr_record_roster_leave_override()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.leave_override_by IS NOT NULL AND char_length(trim(COALESCE(NEW.leave_override_reason,'')))>=5 THEN
    INSERT INTO public.hr_roster_leave_conflicts(
      property_id,roster_id,leave_request_id,status,override_reason,resolved_by,resolved_at
    )
    SELECT NEW.property_id,NEW.id,l.id,'overridden',NEW.leave_override_reason,NEW.leave_override_by,now()
    FROM public.hr_leave_requests l
    WHERE l.property_id=NEW.property_id AND l.employee_id=NEW.employee_id
      AND l.status IN('submitted','approved') AND NEW.duty_date BETWEEN l.start_date AND l.end_date
    ON CONFLICT(property_id,roster_id,leave_request_id) DO UPDATE SET
      status='overridden',override_reason=EXCLUDED.override_reason,
      resolved_by=EXCLUDED.resolved_by,resolved_at=EXCLUDED.resolved_at;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hr_duty_roster_record_leave_override
AFTER INSERT OR UPDATE OF employee_id,duty_date,shift_id ON public.hr_duty_roster
FOR EACH ROW EXECUTE FUNCTION public.hr_record_roster_leave_override();

CREATE OR REPLACE FUNCTION public.bulk_assign_hr_duty_roster_with_leave_override(
  _property_id uuid,_employee_ids uuid[],_shift_id uuid,_duty_dates date[],
  _department_id uuid DEFAULT NULL,_work_location text DEFAULT NULL,
  _leave_override_reason text DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE employee_id_value uuid; duty_date_value date; inserted_count integer:=0;
BEGIN
  IF NOT public.has_hrm_permission(auth.uid(),_property_id,'duty_roster','manage')
    THEN RAISE EXCEPTION 'Not authorized to manage this roster'; END IF;
  IF cardinality(_employee_ids)*cardinality(_duty_dates)>200
    THEN RAISE EXCEPTION 'Bulk assignment limit is 200'; END IF;
  FOREACH employee_id_value IN ARRAY _employee_ids LOOP
    FOREACH duty_date_value IN ARRAY _duty_dates LOOP
      INSERT INTO public.hr_duty_roster(
        property_id,employee_id,shift_id,duty_date,department_id,work_location,
        leave_override_reason,starts_at,ends_at,created_by,updated_by
      ) VALUES(
        _property_id,employee_id_value,_shift_id,duty_date_value,_department_id,
        NULLIF(trim(_work_location),''),NULLIF(trim(_leave_override_reason),''),
        now(),now()+interval '1 minute',auth.uid(),auth.uid()
      );
      inserted_count:=inserted_count+1;
    END LOOP;
  END LOOP;
  RETURN inserted_count;
END $$;
REVOKE ALL ON FUNCTION public.bulk_assign_hr_duty_roster_with_leave_override(
  uuid,uuid[],uuid,date[],uuid,text,text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bulk_assign_hr_duty_roster_with_leave_override(
  uuid,uuid[],uuid,date[],uuid,text,text
) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.hr_convert_biometric_event(_property_id uuid,_event_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n public.hr_biometric_normalized_events%ROWTYPE; mapped uuid; aid uuid; bdate date; tz text;
BEGIN
 IF NOT public.has_hrm_permission(auth.uid(),_property_id,'biometric_events','create') THEN RAISE EXCEPTION 'Not authorized'; END IF;
 SELECT * INTO n FROM public.hr_biometric_normalized_events WHERE id=_event_id AND property_id=_property_id FOR UPDATE;
 IF n.attendance_event_id IS NOT NULL THEN RETURN n.attendance_event_id; END IF;
 SELECT employee_id INTO mapped FROM public.hr_biometric_employee_mappings
 WHERE property_id=_property_id AND device_id=n.device_id
   AND external_employee_identifier=n.external_employee_identifier AND active LIMIT 1;
 IF mapped IS NULL THEN
   UPDATE public.hr_biometric_normalized_events SET processing_status='unmapped' WHERE id=n.id;
   INSERT INTO public.hr_biometric_processing_logs(
     property_id,normalized_event_id,previous_status,new_status,message,actor_id
   ) VALUES(_property_id,n.id,n.processing_status,'unmapped',
     'No active employee mapping was found',auth.uid());
   RETURN NULL;
 END IF;
 SELECT timezone INTO tz FROM public.hr_workforce_settings WHERE property_id=_property_id;
 bdate:=(n.event_at AT TIME ZONE COALESCE(tz,'Africa/Accra'))::date;
 INSERT INTO public.hr_attendance_events(property_id,employee_id,event_type,event_at,business_date,
   source,source_event_id,session_metadata,created_by,correlation_id)
 VALUES(_property_id,mapped,n.event_type,n.event_at,bdate,'system_correction',
   n.device_id::text||':'||n.source_event_id,
   jsonb_build_object('deviceId',n.device_id,'adapter','vendor_neutral'),auth.uid(),n.id)
 RETURNING id INTO aid;
 UPDATE public.hr_biometric_normalized_events SET employee_id=mapped,attendance_event_id=aid,
   processing_status='converted' WHERE id=n.id;
 INSERT INTO public.hr_biometric_processing_logs(property_id,normalized_event_id,previous_status,new_status,message,actor_id)
 VALUES(_property_id,n.id,n.processing_status,'converted','Normalized event converted',auth.uid());
 PERFORM public.recalculate_hr_attendance_summary(_property_id,mapped,bdate,'manual_event');
 RETURN aid;
END $$;

CREATE OR REPLACE FUNCTION public.hr_adjust_leave_balance(
 _property_id uuid,_balance_id uuid,_amount numeric,_reason text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE b public.hr_leave_balances%ROWTYPE; aid uuid; lt public.hr_leave_types%ROWTYPE;
BEGIN
 IF NOT public.has_hrm_permission(auth.uid(),_property_id,'leave_balances','manage')
   THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF char_length(trim(COALESCE(_reason,'')))<5 THEN RAISE EXCEPTION 'Adjustment reason required'; END IF;
 SELECT * INTO b FROM public.hr_leave_balances WHERE id=_balance_id AND property_id=_property_id FOR UPDATE;
 IF b.id IS NULL THEN RAISE EXCEPTION 'Balance not found'; END IF;
 SELECT * INTO lt FROM public.hr_leave_types WHERE id=b.leave_type_id;
 IF NOT lt.negative_balance_allowed AND
   b.opening_balance+b.accrued_amount+b.carried_amount+_amount-b.used_amount-b.pending_amount<0
   THEN RAISE EXCEPTION 'Adjustment would create a negative balance'; END IF;
 INSERT INTO public.hr_leave_balance_adjustments(property_id,balance_id,previous_amount,
   proposed_amount,reason,status,submitted_by,reviewed_by,reviewed_at)
 VALUES(_property_id,b.id,b.adjusted_amount,_amount,trim(_reason),'approved',auth.uid(),auth.uid(),now())
 RETURNING id INTO aid;
 UPDATE public.hr_leave_balances SET adjusted_amount=_amount,
   calculation_version=calculation_version+1,last_recalculated_at=now() WHERE id=b.id;
 RETURN aid;
END $$;

CREATE TRIGGER hr_leave_types_updated BEFORE UPDATE ON public.hr_leave_types FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER hr_leave_balances_updated BEFORE UPDATE ON public.hr_leave_balances FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER hr_leave_requests_updated BEFORE UPDATE ON public.hr_leave_requests FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER hr_biometric_devices_updated BEFORE UPDATE ON public.hr_biometric_devices FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE OR REPLACE FUNCTION public.hr_invalidate_leave_type_balances()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF (NEW.annual_entitlement,NEW.accrual_method,NEW.accrual_frequency,
      NEW.carry_forward_enabled,NEW.maximum_carry_forward,NEW.carry_forward_expiry_days,
      NEW.negative_balance_allowed)
    IS DISTINCT FROM
     (OLD.annual_entitlement,OLD.accrual_method,OLD.accrual_frequency,
      OLD.carry_forward_enabled,OLD.maximum_carry_forward,OLD.carry_forward_expiry_days,
      OLD.negative_balance_allowed)
  THEN
    UPDATE public.hr_leave_balances SET last_recalculated_at='epoch'::timestamptz
    WHERE property_id=NEW.property_id AND leave_type_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hr_leave_types_invalidate_balances
AFTER UPDATE ON public.hr_leave_types FOR EACH ROW
EXECUTE FUNCTION public.hr_invalidate_leave_type_balances();
REVOKE ALL ON FUNCTION public.hr_invalidate_leave_type_balances() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.hr_protect_finalized_leave()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.property_id IS DISTINCT FROM OLD.property_id
 THEN RAISE EXCEPTION 'Leave request identity fields are immutable'; END IF;
 IF NEW.status IS DISTINCT FROM OLD.status
   AND COALESCE(current_setting('app.leave_transition',true),'')<>'true'
 THEN RAISE EXCEPTION 'Leave status transitions must use the authorized workflow'; END IF;
 IF OLD.status NOT IN('draft','returned')
   AND (NEW.employee_id,NEW.leave_type_id,NEW.start_date,NEW.end_date,NEW.partial_day_mode,
        NEW.total_requested_days,NEW.reason,NEW.supporting_document_path,
        NEW.supporting_document_name,NEW.supporting_document_mime,NEW.supporting_document_size)
      IS DISTINCT FROM
       (OLD.employee_id,OLD.leave_type_id,OLD.start_date,OLD.end_date,OLD.partial_day_mode,
        OLD.total_requested_days,OLD.reason,OLD.supporting_document_path,
        OLD.supporting_document_name,OLD.supporting_document_mime,OLD.supporting_document_size)
 THEN RAISE EXCEPTION 'Finalized leave request details are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hr_leave_requests_protect BEFORE UPDATE ON public.hr_leave_requests
FOR EACH ROW EXECUTE FUNCTION public.hr_protect_finalized_leave();

ALTER TABLE public.hr_leave_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_leave_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_leave_approval_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_leave_balance_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_roster_leave_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_biometric_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_biometric_employee_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_biometric_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_biometric_normalized_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_biometric_processing_logs ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.hr_current_employee_id(_property_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT id FROM public.hr_employees
  WHERE property_id=_property_id AND staff_user_id=auth.uid() AND archived_at IS NULL
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.hr_current_employee_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_current_employee_id(uuid) TO authenticated,service_role;

CREATE POLICY hr_employees_leave_team_read ON public.hr_employees FOR SELECT TO authenticated
USING(
  public.has_hrm_permission(auth.uid(),property_id,'leave_team','read') AND
  reporting_manager_id=public.hr_current_employee_id(property_id)
);
CREATE POLICY leave_types_access ON public.hr_leave_types FOR ALL TO authenticated
USING(public.has_hrm_permission(auth.uid(),property_id,'leave_settings','read')
  OR public.has_hrm_permission(auth.uid(),property_id,'leave_own','read'))
WITH CHECK(public.has_hrm_permission(auth.uid(),property_id,'leave_settings','manage'));
CREATE POLICY leave_balances_read ON public.hr_leave_balances FOR SELECT TO authenticated
USING(public.has_hrm_permission(auth.uid(),property_id,'leave_balances','read') OR EXISTS(
 SELECT 1 FROM public.hr_employees e
 WHERE e.id=public.hr_leave_balances.employee_id
   AND e.property_id=public.hr_leave_balances.property_id AND e.staff_user_id=auth.uid()));
CREATE POLICY leave_requests_read ON public.hr_leave_requests FOR SELECT TO authenticated
USING(public.has_hrm_permission(auth.uid(),property_id,'leave_property','read') OR EXISTS(
 SELECT 1 FROM public.hr_employees e
 WHERE e.id=public.hr_leave_requests.employee_id
   AND e.property_id=public.hr_leave_requests.property_id
   AND (e.staff_user_id=auth.uid() OR (
     public.has_hrm_permission(auth.uid(),public.hr_leave_requests.property_id,'leave_team','read') AND EXISTS(
       SELECT 1 FROM public.hr_employees manager
       WHERE manager.property_id=public.hr_leave_requests.property_id
         AND manager.staff_user_id=auth.uid() AND manager.id=e.reporting_manager_id
         AND manager.archived_at IS NULL
     )
   ))));
CREATE POLICY leave_requests_own_write ON public.hr_leave_requests FOR INSERT TO authenticated
WITH CHECK(status='draft' AND created_by=auth.uid()
 AND public.has_hrm_permission(auth.uid(),property_id,'leave_own','create') AND EXISTS(
 SELECT 1 FROM public.hr_employees e WHERE e.id=public.hr_leave_requests.employee_id
   AND e.property_id=public.hr_leave_requests.property_id AND e.staff_user_id=auth.uid()));
CREATE POLICY leave_requests_manage ON public.hr_leave_requests FOR UPDATE TO authenticated
USING(public.has_hrm_permission(auth.uid(),property_id,'leave','approve') OR EXISTS(
 SELECT 1 FROM public.hr_employees e WHERE e.id=public.hr_leave_requests.employee_id
   AND e.property_id=public.hr_leave_requests.property_id AND e.staff_user_id=auth.uid()));
CREATE POLICY leave_history_read ON public.hr_leave_approval_history FOR SELECT TO authenticated
USING(public.has_hrm_permission(auth.uid(),property_id,'leave_property','read') OR EXISTS(
 SELECT 1 FROM public.hr_leave_requests r JOIN public.hr_employees e ON e.id=r.employee_id
 WHERE r.id=public.hr_leave_approval_history.request_id
   AND r.property_id=public.hr_leave_approval_history.property_id AND (
   e.staff_user_id=auth.uid() OR (
     public.has_hrm_permission(auth.uid(),public.hr_leave_approval_history.property_id,'leave_team','read') AND EXISTS(
       SELECT 1 FROM public.hr_employees manager
       WHERE manager.property_id=public.hr_leave_approval_history.property_id
         AND manager.staff_user_id=auth.uid() AND manager.id=e.reporting_manager_id
         AND manager.archived_at IS NULL
     )
   )
 )));
CREATE POLICY leave_adjustments_read ON public.hr_leave_balance_adjustments FOR SELECT TO authenticated
USING(public.has_hrm_permission(auth.uid(),property_id,'leave_balances','manage'));
CREATE POLICY roster_leave_conflicts_access ON public.hr_roster_leave_conflicts FOR ALL TO authenticated
USING(public.has_hrm_permission(auth.uid(),property_id,'duty_roster','read'))
WITH CHECK(public.has_hrm_permission(auth.uid(),property_id,'duty_roster','manage'));
CREATE POLICY biometric_devices_access ON public.hr_biometric_devices FOR ALL TO authenticated
USING(public.has_hrm_permission(auth.uid(),property_id,'biometric_devices','read'))
WITH CHECK(public.has_hrm_permission(auth.uid(),property_id,'biometric_devices','manage'));
CREATE POLICY biometric_mapping_access ON public.hr_biometric_employee_mappings FOR ALL TO authenticated
USING(public.has_hrm_permission(auth.uid(),property_id,'biometric_mappings','manage'))
WITH CHECK(public.has_hrm_permission(auth.uid(),property_id,'biometric_mappings','manage'));
CREATE POLICY biometric_import_access ON public.hr_biometric_import_batches FOR ALL TO authenticated
USING(public.has_hrm_permission(auth.uid(),property_id,'biometric_events','read'))
WITH CHECK(public.has_hrm_permission(auth.uid(),property_id,'biometric_events','create'));
CREATE POLICY biometric_events_access ON public.hr_biometric_normalized_events FOR ALL TO authenticated
USING(public.has_hrm_permission(auth.uid(),property_id,'biometric_events','read'))
WITH CHECK(public.has_hrm_permission(auth.uid(),property_id,'biometric_events','create'));
CREATE POLICY biometric_logs_read ON public.hr_biometric_processing_logs FOR SELECT TO authenticated
USING(public.has_hrm_permission(auth.uid(),property_id,'biometric_events','read'));
CREATE POLICY biometric_logs_create ON public.hr_biometric_processing_logs FOR INSERT TO authenticated
WITH CHECK(public.has_hrm_permission(auth.uid(),property_id,'biometric_events','create'));

GRANT SELECT,INSERT,UPDATE ON public.hr_leave_types,public.hr_leave_balances,public.hr_leave_requests,
 public.hr_leave_approval_history,public.hr_roster_leave_conflicts,
 public.hr_biometric_devices,public.hr_biometric_employee_mappings,public.hr_biometric_import_batches,
 public.hr_biometric_normalized_events TO authenticated;
GRANT SELECT ON public.hr_leave_balance_adjustments,public.hr_biometric_processing_logs TO authenticated;
GRANT INSERT ON public.hr_biometric_processing_logs TO authenticated;
GRANT ALL ON public.hr_leave_types,public.hr_leave_balances,public.hr_leave_requests,
 public.hr_leave_approval_history,public.hr_leave_balance_adjustments,public.hr_roster_leave_conflicts,
 public.hr_biometric_devices,public.hr_biometric_employee_mappings,public.hr_biometric_import_batches,
 public.hr_biometric_normalized_events TO service_role;
GRANT ALL ON public.hr_biometric_processing_logs TO service_role;

REVOKE ALL ON FUNCTION public.hr_submit_leave_request(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hr_decide_leave_request(uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recalculate_hr_leave_balance(uuid,uuid,uuid,date,date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hr_convert_biometric_event(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hr_initialize_leave_balances(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_submit_leave_request(uuid,uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.hr_decide_leave_request(uuid,uuid,text,text) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.recalculate_hr_leave_balance(uuid,uuid,uuid,date,date) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.hr_convert_biometric_event(uuid,uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.hr_initialize_leave_balances(uuid,uuid) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.hr_adjust_leave_balance(uuid,uuid,numeric,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_adjust_leave_balance(uuid,uuid,numeric,text) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.seed_leave_biometric_permissions(_property_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 INSERT INTO public.role_permissions(property_id,role,module,action,allowed)
 SELECT _property_id,r::public.app_role,m,a,true FROM (VALUES
  ('leave_team','read'),('leave_property','read'),('leave','approve'),('leave','delete'),
  ('leave_settings','read'),('leave_settings','manage'),('leave_balances','read'),
  ('leave_balances','manage'),('leave_calendar','read'),('leave_documents','read'),
  ('biometric_devices','read'),('biometric_devices','manage'),('biometric_mappings','manage'),
  ('biometric_events','create'),('biometric_events','read')
 ) p(m,a) CROSS JOIN (VALUES('super_admin'),('hotel_owner'),('general_manager'),('hr')) roles(r)
 ON CONFLICT DO NOTHING;
 INSERT INTO public.role_permissions(property_id,role,module,action,allowed)
 SELECT _property_id,r::public.app_role,m,a,true FROM (VALUES
  ('leave_own','read'),('leave_own','create'),('leave_own','update'),('leave_calendar','read')
 ) p(m,a) CROSS JOIN (VALUES
  ('super_admin'),('hotel_owner'),('general_manager'),('hr'),('manager'),('front_desk'),
  ('reservations'),('cashier'),('accountant'),('housekeeping_supervisor'),('housekeeping'),
  ('maintenance'),('kitchen'),('restaurant_manager'),('waiter'),('storekeeper'),
  ('guest_relations'),('security'),('auditor')
 ) roles(r) ON CONFLICT DO NOTHING;
 INSERT INTO public.role_permissions(property_id,role,module,action,allowed) VALUES
 (_property_id,'manager','leave_team','read',true),
  (_property_id,'manager','leave','approve',true),
  (_property_id,'manager','leave_documents','read',true)
 ON CONFLICT DO NOTHING;
END $$;
SELECT public.seed_leave_biometric_permissions(id) FROM public.properties;
REVOKE ALL ON FUNCTION public.seed_leave_biometric_permissions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_leave_biometric_permissions(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.seed_leave_biometric_permissions_for_property()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN PERFORM public.seed_leave_biometric_permissions(NEW.id); RETURN NEW; END $$;
CREATE TRIGGER properties_seed_leave_biometric_permissions AFTER INSERT ON public.properties
FOR EACH ROW EXECUTE FUNCTION public.seed_leave_biometric_permissions_for_property();

CREATE POLICY leave_document_upload ON storage.objects FOR INSERT TO authenticated
WITH CHECK(bucket_id='employee-documents' AND EXISTS(
 SELECT 1 FROM public.hr_leave_requests r JOIN public.hr_employees e ON e.id=r.employee_id
 WHERE r.property_id::text=(storage.foldername(name))[1]
   AND r.employee_id::text=(storage.foldername(name))[2]
   AND (storage.foldername(name))[3]='leave'
   AND (e.staff_user_id=auth.uid() OR (
     public.has_hrm_permission(auth.uid(),r.property_id,'leave_documents','read') AND (
       public.has_hrm_permission(auth.uid(),r.property_id,'leave_property','read') OR EXISTS(
         SELECT 1 FROM public.hr_employees manager WHERE manager.property_id=r.property_id
           AND manager.staff_user_id=auth.uid() AND manager.id=e.reporting_manager_id
           AND manager.archived_at IS NULL
       )
     )
   ))
));
CREATE POLICY leave_document_cleanup ON storage.objects FOR DELETE TO authenticated
USING(bucket_id='employee-documents' AND (storage.foldername(name))[3]='leave' AND EXISTS(
 SELECT 1 FROM public.hr_employees e
 WHERE e.property_id::text=(storage.foldername(name))[1]
   AND e.id::text=(storage.foldername(name))[2] AND e.staff_user_id=auth.uid()
));
CREATE POLICY leave_document_read ON storage.objects FOR SELECT TO authenticated
USING(bucket_id='employee-documents' AND EXISTS(
 SELECT 1 FROM public.hr_leave_requests r JOIN public.hr_employees e ON e.id=r.employee_id
 WHERE r.supporting_document_path=name
   AND (e.staff_user_id=auth.uid() OR (
     public.has_hrm_permission(auth.uid(),r.property_id,'leave_documents','read') AND (
       public.has_hrm_permission(auth.uid(),r.property_id,'leave_property','read') OR EXISTS(
         SELECT 1 FROM public.hr_employees manager WHERE manager.property_id=r.property_id
           AND manager.staff_user_id=auth.uid() AND manager.id=e.reporting_manager_id
           AND manager.archived_at IS NULL
       )
     )
   ))
));

COMMENT ON TABLE public.hr_biometric_devices IS
'Vendor-neutral configuration metadata only. No live adapter or raw biometric data is stored.';
COMMENT ON COLUMN public.hr_biometric_devices.connector_config_reference IS
'Reference to an external encrypted secret; never a credential value.';
