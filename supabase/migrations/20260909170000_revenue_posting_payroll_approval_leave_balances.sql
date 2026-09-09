-- Three runtime defects that stop shipped features working. Each was
-- reproduced against a full copy of the production schema carrying three
-- months of trading, and each is fixed at its root rather than worked around.
--
-- ============================================================================
-- 1. Revenue posting: a checkout or a POS close can succeed while its journal
--    silently fails to post, and both post in the wrong currency.
-- ============================================================================
--
-- Two independent faults compound in the same code path.
--
-- (a) Authorization. post_journal() requires the caller to hold one of
--     super_admin / hotel_owner / general_manager / accountant. But the two
--     functions that post operational revenue are called from AFTER-UPDATE
--     triggers on behalf of whoever performed the operation:
--
--       reservations.status -> 'checked_out'   (front_desk, reservations, …)
--         -> tg_autopost_reservation -> post_reservation_checkout
--       pos_orders.status  -> 'closed'          (front_desk, cashier, …)
--         -> tg_autopost_pos          -> post_pos_order_close
--
--     Those role sets do not intersect: `reservations` RLS admits front_desk
--     and reservations, and close_pos_order() admits front_desk and cashier —
--     none of which post_journal() accepts. So when the people who actually do
--     these jobs do them, post_journal() raises 'Not permitted to post
--     journal'.
--
-- (b) Silence. Both functions end in `EXCEPTION WHEN OTHERS THEN RAISE NOTICE
--     …; RETURN NULL;`. The exception is swallowed, the trigger returns
--     normally, and the operational write commits. The guest is checked out,
--     the order is closed and paid — and no revenue ever reaches the ledger.
--     Nothing surfaces to the user, and nothing is written anywhere a report
--     would find it.
--
-- (c) Currency. Both still pass the literal 'USD' to post_journal(). The
--     20260823100000 fix corrected exactly this in post_payment() and did not
--     reach these two. post_journal() then compares that currency against the
--     property's base_currency and, when they differ, converts through
--     fx_convert() — which returns 1 when no rate exists, so the base amounts
--     happen to be right while every folio and POS entry is labelled in a
--     currency the property does not trade in.
--
-- The fix, in the same shape the payment fix already established:
--
--   * A new post_journal_internal() carries the posting logic with no role
--     check. It is SECURITY DEFINER and its EXECUTE grant is revoked from
--     PUBLIC/anon/authenticated, so it is reachable only from inside the
--     SECURITY DEFINER functions that own the operational authorization —
--     never over PostgREST. This mirrors apply_stock_delta(), which is
--     likewise callable only from within the functions that use it.
--   * post_journal() keeps its role check unchanged for manual journals and
--     delegates the work, so accountant-only manual posting is unaffected.
--   * post_reservation_checkout() and post_pos_order_close() take the currency
--     from properties.base_currency — the same authoritative field
--     post_payment() uses — and never from a literal. A property trading in
--     USD still posts USD; a GHS property posts GHS.
--   * Neither function swallows a failure any more. If the journal cannot be
--     written, the exception propagates and the operational write rolls back
--     with it, so a checkout or a POS close can no longer report success while
--     the ledger is left empty. run_night_audit()'s own per-reservation
--     BEGIN/EXCEPTION block still records such a failure as an audit error
--     rather than aborting the whole audit.
--
-- ============================================================================
-- 2. Payroll cannot leave review.
-- ============================================================================
--
-- payroll_runs carries
--   CHECK ((status = 'locked_for_review') = (review_locked_at IS NOT NULL))
-- so the review lock timestamp must be set exactly while the run is locked.
-- payroll_transition_review('reopen') already clears review_locked_by/at when
-- it moves a run out of that state; payroll_approval_transition() does not,
-- so every submit from locked_for_review violates the constraint with 23514
-- and no run can reach approved, finalized, or a payslip.
--
-- ============================================================================
-- 3. Leave balances cannot be initialised.
-- ============================================================================
--
-- hr_initialize_leave_balances() declares a variable named period_start and
-- then compares `b.period_start = period_start` inside an EXISTS over
-- hr_leave_balances, where a column of that name is in scope. PL/pgSQL cannot
-- resolve the bare reference and raises 42702 for every employee. Renaming the
-- variable to _period_start — the prefix this schema already uses for
-- parameters — removes the ambiguity without changing behaviour.

-- ============================================================================
-- 1a. post_journal_internal: the posting engine, without the caller role test
-- ============================================================================
CREATE OR REPLACE FUNCTION public.post_journal_internal(
  _property_id uuid,
  _entry_date date,
  _currency text,
  _memo text,
  _source journal_source,
  _source_ref text,
  _lines jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE
  _entry_id UUID; _prop RECORD; _period_id UUID; _line JSONB;
  _acct_id UUID; _dr NUMERIC; _cr NUMERIC; _dr_b NUMERIC; _cr_b NUMERIC;
  _rate NUMERIC; _sum_dr NUMERIC := 0; _sum_cr NUMERIC := 0;
BEGIN
  SELECT * INTO _prop FROM public.properties WHERE id=_property_id;
  IF _prop IS NULL THEN RAISE EXCEPTION 'Property not found'; END IF;

  -- Block posting into a locked period. Unchanged from post_journal().
  SELECT id INTO _period_id FROM public.accounting_periods
    WHERE property_id=_property_id AND _entry_date BETWEEN start_date AND end_date AND status IN ('locked','closed')
    LIMIT 1;
  IF _period_id IS NOT NULL THEN RAISE EXCEPTION 'Period is locked'; END IF;

  _rate := CASE WHEN _currency=_prop.base_currency THEN 1
                ELSE public.fx_convert(_property_id, _currency, _prop.base_currency, 1, _entry_date) END;

  INSERT INTO public.journal_entries(property_id, entry_date, memo, source, source_ref, currency, posted_by)
  VALUES (_property_id, _entry_date, _memo, _source, _source_ref, _currency, auth.uid())
  RETURNING id INTO _entry_id;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    _acct_id := (_line->>'account_id')::UUID;
    _dr := COALESCE((_line->>'debit')::NUMERIC, 0);
    _cr := COALESCE((_line->>'credit')::NUMERIC, 0);
    _dr_b := ROUND(_dr * _rate, 4);
    _cr_b := ROUND(_cr * _rate, 4);
    INSERT INTO public.journal_lines(entry_id, account_id, debit, credit, currency, fx_rate, debit_base, credit_base, memo)
    VALUES (_entry_id, _acct_id, _dr, _cr, _currency, _rate, _dr_b, _cr_b, _line->>'memo');
    _sum_dr := _sum_dr + _dr_b;
    _sum_cr := _sum_cr + _cr_b;
  END LOOP;

  IF ROUND(_sum_dr,2) <> ROUND(_sum_cr,2) THEN
    RAISE EXCEPTION 'Journal not balanced (DR %, CR %)', _sum_dr, _sum_cr;
  END IF;
  RETURN _entry_id;
END; $function$;

-- Never reachable over PostgREST: only the SECURITY DEFINER functions that
-- carry their own operational authorization may call it.
REVOKE ALL ON FUNCTION public.post_journal_internal(uuid, date, text, text, journal_source, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.post_journal_internal(uuid, date, text, text, journal_source, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.post_journal_internal(uuid, date, text, text, journal_source, text, jsonb) FROM authenticated;

-- ============================================================================
-- 1b. post_journal keeps the manual-posting role check and delegates
-- ============================================================================
CREATE OR REPLACE FUNCTION public.post_journal(
  _property_id uuid,
  _entry_date date,
  _currency text,
  _memo text,
  _source journal_source,
  _source_ref text,
  _lines jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
  -- Manual journal posting stays accountant-and-above, exactly as before.
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id) THEN
    RAISE EXCEPTION 'Not permitted to post journal';
  END IF;
  RETURN public.post_journal_internal(_property_id, _entry_date, _currency, _memo, _source, _source_ref, _lines);
END; $function$;

-- ============================================================================
-- 1c. Folio posting: property currency, no swallowed failure
-- ============================================================================
CREATE OR REPLACE FUNCTION public.post_reservation_checkout(_res_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE r RECORD; _prop RECORD; _room NUMERIC; _tax NUMERIC := 0; _tax_rate NUMERIC := 0;
        _ar UUID; _rev UUID; _tax_acc UUID; _lines JSONB; _existing UUID; _currency TEXT;
BEGIN
  SELECT * INTO r FROM public.reservations WHERE id=_res_id;
  IF r IS NULL THEN RETURN NULL; END IF;
  -- Idempotent: skip if already posted
  SELECT id INTO _existing FROM public.journal_entries WHERE source='folio' AND source_ref=_res_id::text LIMIT 1;
  IF _existing IS NOT NULL THEN RETURN _existing; END IF;

  SELECT * INTO _prop FROM public.properties WHERE id=r.property_id;
  IF _prop IS NULL THEN
    RAISE EXCEPTION 'Reservation % has no property; its folio journal cannot be posted', r.code;
  END IF;
  -- properties.base_currency is the authoritative accounting currency, the
  -- same field post_payment() and post_journal()'s own FX comparison use.
  _currency := _prop.base_currency;
  IF _currency IS NULL OR btrim(_currency) = '' THEN
    RAISE EXCEPTION 'Property % has no base currency configured; reservation % cannot post its folio journal', _prop.name, r.code;
  END IF;

  SELECT id INTO _ar FROM public.accounts WHERE property_id=r.property_id AND system_key='ar';
  SELECT id INTO _rev FROM public.accounts WHERE property_id=r.property_id AND system_key='room_revenue';
  SELECT id INTO _tax_acc FROM public.accounts WHERE property_id=r.property_id AND system_key='tax_payable';
  IF _ar IS NULL OR _rev IS NULL OR _tax_acc IS NULL THEN
    RAISE EXCEPTION 'Accounting setup is incomplete for this property (ar/room_revenue/tax_payable); reservation % cannot post its folio journal', r.code;
  END IF;
  SELECT rate INTO _tax_rate FROM public.tax_codes WHERE property_id=r.property_id AND code='STD' LIMIT 1;
  _room := ROUND(COALESCE(r.rate_total,0) / (1 + COALESCE(_tax_rate,0)/100), 4);
  _tax  := ROUND(COALESCE(r.rate_total,0) - _room, 4);
  _lines := jsonb_build_array(
    jsonb_build_object('account_id',_ar,'debit',r.rate_total,'credit',0,'memo','Reservation '||r.code),
    jsonb_build_object('account_id',_rev,'debit',0,'credit',_room,'memo','Room revenue'),
    jsonb_build_object('account_id',_tax_acc,'debit',0,'credit',_tax,'memo','Tax on room')
  );
  RETURN public.post_journal_internal(r.property_id, COALESCE(r.check_out, CURRENT_DATE), _currency,
    'Folio '||r.code, 'folio', r.id::text, _lines);
END; $function$;

-- ============================================================================
-- 1d. POS posting: property currency, no swallowed failure
-- ============================================================================
CREATE OR REPLACE FUNCTION public.post_pos_order_close(_order_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE o RECORD; _prop RECORD; _cash UUID; _rev UUID; _tax_acc UUID; _lines JSONB; _existing UUID; _currency TEXT;
BEGIN
  SELECT * INTO o FROM public.pos_orders WHERE id=_order_id;
  IF o IS NULL OR o.status <> 'closed' THEN RETURN NULL; END IF;
  SELECT id INTO _existing FROM public.journal_entries WHERE source='pos' AND source_ref=_order_id::text LIMIT 1;
  IF _existing IS NOT NULL THEN RETURN _existing; END IF;

  SELECT * INTO _prop FROM public.properties WHERE id=o.property_id;
  IF _prop IS NULL THEN
    RAISE EXCEPTION 'POS order % has no property; its journal cannot be posted', o.code;
  END IF;
  _currency := _prop.base_currency;
  IF _currency IS NULL OR btrim(_currency) = '' THEN
    RAISE EXCEPTION 'Property % has no base currency configured; POS order % cannot post its journal', _prop.name, o.code;
  END IF;

  SELECT id INTO _cash FROM public.accounts WHERE property_id=o.property_id AND system_key='cash';
  SELECT id INTO _rev FROM public.accounts WHERE property_id=o.property_id AND system_key='fnb_revenue';
  SELECT id INTO _tax_acc FROM public.accounts WHERE property_id=o.property_id AND system_key='tax_payable';
  IF _cash IS NULL OR _rev IS NULL OR _tax_acc IS NULL THEN
    RAISE EXCEPTION 'Accounting setup is incomplete for this property (cash/fnb_revenue/tax_payable); POS order % cannot post its journal', o.code;
  END IF;
  _lines := jsonb_build_array(
    jsonb_build_object('account_id',_cash,'debit',o.total,'credit',0,'memo','POS '||o.code),
    jsonb_build_object('account_id',_rev,'debit',0,'credit',o.subtotal,'memo','F&B revenue'),
    jsonb_build_object('account_id',_tax_acc,'debit',0,'credit',o.tax,'memo','Sales tax')
  );
  RETURN public.post_journal_internal(o.property_id, COALESCE(o.closed_at::date, CURRENT_DATE), _currency,
    'POS Order '||o.code, 'pos', o.id::text, _lines);
END; $function$;

-- ============================================================================
-- 2a. The payroll audit helper the payroll module has always called and this
--     schema has never had
-- ============================================================================
--
-- Twelve payroll functions — approval, finalisation, payslip generation and
-- publication, period close, journal drafts, payment batches, exports,
-- corrections and reversals — end their work with
--
--   PERFORM public.log_audit_event(_property_id, '<entity>', <id>::text,
--                                  '<action>', jsonb_build_object(…));
--
-- and that function has no CREATE anywhere in this repository's migration
-- history: it does not exist. 20260818090000 recorded the gap in a comment and
-- deliberately left it alone. The consequence is that every one of those
-- functions raises 42883 the moment it reaches its audit line and rolls its
-- whole transaction back — so payroll cannot be approved, finalised, or
-- produce a payslip, whatever else is fixed.
--
-- The signature is the one all twelve call sites already use
-- (uuid, text, text, text, jsonb). It writes to audit_logs, the general audit
-- table the application already reads, and it is revoked from client roles: it
-- is an internal helper for SECURITY DEFINER functions, not an endpoint.
CREATE OR REPLACE FUNCTION public.log_audit_event(
  _property_id uuid,
  _entity_type text,
  _entity_id text,
  _action text,
  _meta jsonb DEFAULT '{}'::jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE _id uuid; _entity_uuid uuid;
BEGIN
  -- audit_logs.entity_id is uuid; every existing call site passes a uuid cast
  -- to text, but a non-uuid reference is kept in meta rather than lost.
  IF _entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    _entity_uuid := _entity_id::uuid;
  END IF;
  INSERT INTO public.audit_logs(user_id, property_id, action, entity, entity_id, meta)
  VALUES (
    auth.uid(),
    _property_id,
    _action,
    _entity_type,
    _entity_uuid,
    COALESCE(_meta, '{}'::jsonb)
      || CASE WHEN _entity_uuid IS NULL AND _entity_id IS NOT NULL
              THEN jsonb_build_object('entity_ref', _entity_id)
              ELSE '{}'::jsonb END
  )
  RETURNING id INTO _id;
  RETURN _id;
END $function$;

REVOKE ALL ON FUNCTION public.log_audit_event(uuid, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_audit_event(uuid, text, text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.log_audit_event(uuid, text, text, text, jsonb) FROM authenticated;

-- ============================================================================
-- 2b. Payroll approval clears the review lock it leaves behind
-- ============================================================================
CREATE OR REPLACE FUNCTION public.payroll_approval_transition(_property_id uuid, _run_id uuid, _action text, _calculation_version integer, _reason text, _idempotency_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
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
  -- payroll_runs_check: (status = 'locked_for_review') = (review_locked_at IS NOT NULL).
  -- Every transition out of review must therefore release the lock, exactly as
  -- payroll_transition_review('reopen') already does.
  UPDATE public.payroll_runs
    SET status=new_status,
        review_locked_by=CASE WHEN new_status='locked_for_review' THEN review_locked_by ELSE NULL END,
        review_locked_at=CASE WHEN new_status='locked_for_review' THEN review_locked_at ELSE NULL END,
        updated_by=actor,
        updated_at=now()
    WHERE property_id=_property_id AND id=_run_id;
  INSERT INTO public.payroll_approval_actions(property_id,payroll_run_id,run_version_id,calculation_version,action,prior_status,new_status,reason,idempotency_key,actor_id)
  VALUES(_property_id,_run_id,version_id,_calculation_version,approval_action,run_row.status,new_status,NULLIF(trim(COALESCE(_reason,'')),''),_idempotency_key,actor);
  PERFORM public.log_audit_event(_property_id,'payroll_approval',_run_id::text,approval_action,jsonb_build_object('version',_calculation_version,'priorStatus',run_row.status,'newStatus',new_status));
  RETURN jsonb_build_object('status',new_status,'idempotent',false);
END $function$;

-- ============================================================================
-- 2c. Payroll finalisation, payslips and payment export can reach pgcrypto
-- ============================================================================
--
-- payroll_finalize_run(), payroll_generate_payslips() and
-- payroll_export_payment_batch() each hash their evidence with digest(), which
-- pgcrypto installs into the `extensions` schema on Supabase. All three are
-- pinned to `SET search_path=public`, so the call cannot resolve and every one
-- of them fails with 42883 ("function digest(text, unknown) does not exist").
-- Finalisation, payslip generation and payment-file export are therefore
-- unreachable on any property.
--
-- Only the search path changes; the function bodies are untouched.
ALTER FUNCTION public.payroll_finalize_run(uuid, uuid, integer, uuid) SET search_path = public, extensions;
ALTER FUNCTION public.payroll_generate_payslips(uuid, uuid, uuid[]) SET search_path = public, extensions;
ALTER FUNCTION public.payroll_export_payment_batch(uuid, uuid, uuid) SET search_path = public, extensions;

-- ============================================================================
-- 2d. Payroll finalisation: the statutory liability summary is not groupable
-- ============================================================================
--
-- payroll_finalize_run() builds payroll_statutory_liability_summaries with
--   SELECT …, COALESCE(s.rule_category, fli.line_type), …
--   GROUP BY fli.property_id, fli.statutory_rule_id, fli.statutory_rule_version,
--            s.rule_category, s.verification_status
-- and fli.line_type appears in neither the GROUP BY nor an aggregate, so
-- Postgres rejects the statement with 42803 and finalisation fails after the
-- run has already been approved.
--
-- The fallback is only a label for the case where the statutory rule row is
-- missing, and every line grouped here belongs to one rule — which has exactly
-- one result type — so min() names that line type without changing the
-- grouping. Adding fli.line_type to the GROUP BY instead would silently split
-- a rule summary into several rows the moment a rule ever emitted two line
-- types.
--
-- Also carries the pgcrypto search_path from 2c, since the whole definition is
-- replaced here.
CREATE OR REPLACE FUNCTION public.payroll_finalize_run(_property_id uuid, _run_id uuid, _calculation_version integer, _idempotency_key uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $function$
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
  SELECT fli.property_id,final_id,fli.statutory_rule_id,fli.statutory_rule_version,COALESCE(s.rule_category,min(fli.line_type)),run_row.currency,
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
END $function$;

-- ============================================================================
-- 3. Leave balance initialisation: unambiguous period_start
-- ============================================================================
CREATE OR REPLACE FUNCTION public.hr_initialize_leave_balances(_property_id uuid, _employee_id uuid DEFAULT NULL::uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE item record; _period_start date; initialized integer:=0;
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
    _period_start:=public.hr_leave_period_start(current_date,item.leave_year_start_month);
    IF NOT EXISTS(
      SELECT 1 FROM public.hr_leave_balances b
      WHERE b.property_id=_property_id AND b.employee_id=item.employee_id
        AND b.leave_type_id=item.leave_type_id AND b.period_start=_period_start
        AND b.last_recalculated_at::date=current_date
    ) THEN
      PERFORM public.recalculate_hr_leave_balance(
        _property_id,item.employee_id,item.leave_type_id,_period_start,
        (_period_start+interval '1 year - 1 day')::date
      );
      initialized:=initialized+1;
    END IF;
  END LOOP;
  RETURN initialized;
END $function$;
