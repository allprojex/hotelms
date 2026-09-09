-- READ ONLY. STEP 9: current ledger position, so the dry-run movement can be
-- added to it to produce a proposed-after trial balance.

-- 1. Current balance per account (BEFORE).
SELECT a.system_key, a.code, a.name, a.type::text AS account_type,
       ROUND(COALESCE(sum(l.debit_base), 0), 4) AS debit_base,
       ROUND(COALESCE(sum(l.credit_base), 0), 4) AS credit_base,
       ROUND(COALESCE(sum(l.debit_base), 0) - COALESCE(sum(l.credit_base), 0), 4) AS net
  FROM public.accounts a
  LEFT JOIN public.journal_lines l ON l.account_id = a.id
  JOIN public.properties p ON p.id = a.property_id
 WHERE p.name ILIKE '%Theskwoff hotel%'
 GROUP BY a.system_key, a.code, a.name, a.type::text
 ORDER BY a.system_key;

-- 2. Whole-ledger totals (BEFORE), all properties.
SELECT ROUND(sum(l.debit_base), 4) AS total_debit_base,
       ROUND(sum(l.credit_base), 4) AS total_credit_base,
       ROUND(sum(l.debit_base) - sum(l.credit_base), 4) AS difference
  FROM public.journal_lines l;

-- 3. Does any accounting period exist anywhere, in any state?
SELECT count(*) AS total_periods,
       count(*) FILTER (WHERE status = 'open') AS open,
       count(*) FILTER (WHERE status = 'locked') AS locked,
       count(*) FILTER (WHERE status = 'closed') AS closed
  FROM public.accounting_periods;

-- 4. Entries whose base amounts do not tie -- the residue population.
SELECT count(*) AS entries_with_base_residue,
       ROUND(sum(abs(diff)), 4) AS total_absolute_residue
  FROM (SELECT je.id, sum(l.debit_base) - sum(l.credit_base) AS diff
          FROM public.journal_entries je JOIN public.journal_lines l ON l.entry_id = je.id
         GROUP BY je.id HAVING sum(l.debit_base) <> sum(l.credit_base)) q;
