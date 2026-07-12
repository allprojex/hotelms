
CREATE TABLE public.accounting_sync_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  name text NOT NULL,
  webhook_url text,
  signing_secret text NOT NULL DEFAULT encode(extensions.gen_random_bytes(24), 'hex'),
  is_active boolean NOT NULL DEFAULT true,
  last_sync_at timestamptz,
  last_sync_status text,
  last_sync_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounting_sync_targets TO authenticated;
GRANT ALL ON public.accounting_sync_targets TO service_role;
ALTER TABLE public.accounting_sync_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY sync_targets_read ON public.accounting_sync_targets FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], property_id));
CREATE POLICY sync_targets_write ON public.accounting_sync_targets FOR ALL
  USING (has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], property_id))
  WITH CHECK (has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], property_id));
CREATE TRIGGER trg_sync_targets_updated_at BEFORE UPDATE ON public.accounting_sync_targets
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE TABLE public.accounting_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES public.accounting_sync_targets(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  from_date date NOT NULL,
  to_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  entries_count integer NOT NULL DEFAULT 0,
  csv_payload text,
  response_status integer,
  response_body text,
  error text,
  triggered_by uuid REFERENCES auth.users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounting_sync_runs TO authenticated;
GRANT ALL ON public.accounting_sync_runs TO service_role;
ALTER TABLE public.accounting_sync_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY sync_runs_read ON public.accounting_sync_runs FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], property_id));
CREATE POLICY sync_runs_write ON public.accounting_sync_runs FOR ALL
  USING (has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], property_id))
  WITH CHECK (has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], property_id));
CREATE INDEX idx_sync_runs_target ON public.accounting_sync_runs(target_id, started_at DESC);

-- Build a daily journal summary for a property over a date range.
-- Returns one row per (entry_date, account) with debit/credit totals in base currency.
CREATE OR REPLACE FUNCTION public.accounting_daily_summary(_property_id uuid, _from date, _to date)
RETURNS TABLE(entry_date date, account_code text, account_name text, account_type account_type,
              debit_base numeric, credit_base numeric, entries_count integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT je.entry_date, a.code, a.name, a.type,
         COALESCE(SUM(jl.debit_base),0)::numeric,
         COALESCE(SUM(jl.credit_base),0)::numeric,
         COUNT(DISTINCT je.id)::int
  FROM public.journal_entries je
  JOIN public.journal_lines jl ON jl.entry_id = je.id
  JOIN public.accounts a ON a.id = jl.account_id
  WHERE je.property_id = _property_id
    AND je.entry_date BETWEEN _from AND _to
    AND public.has_any_role(auth.uid(),
        ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id)
  GROUP BY je.entry_date, a.code, a.name, a.type
  ORDER BY je.entry_date, a.code;
$$;
GRANT EXECUTE ON FUNCTION public.accounting_daily_summary(uuid,date,date) TO authenticated;
