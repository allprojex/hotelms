-- READ ONLY. Investigation: why does ThesKwoff Bar carry base_currency = AUD?
-- No mutation of any kind. Evidence gathering only.

-- 1. Every column of public.properties, so the investigation can be exhaustive.
SELECT column_name, data_type, column_default, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'properties'
 ORDER BY ordinal_position;

-- 2. Every currency-bearing column anywhere in the schema, with its default.
SELECT table_name, column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public' AND column_name ILIKE '%currency%'
 ORDER BY table_name, column_name;

-- 3. The full Bar property row alongside the hotel, for comparison.
SELECT id, name, code, currency AS legacy_currency, base_currency, timezone, created_at, updated_at, active
  FROM public.properties
 ORDER BY created_at;

-- 4. Does AUD appear anywhere else at all -- fx rates, bills, invoices, receipts?
SELECT 'fx_rates' AS source, count(*) AS rows
  FROM public.fx_rates WHERE from_code = 'AUD' OR to_code = 'AUD';

-- 5. All fx_rates, which is what turned the folio entries into a tenth of themselves.
SELECT from_code, to_code, rate, as_of_date
  FROM public.fx_rates ORDER BY as_of_date DESC, from_code LIMIT 30;

-- 6. What the Bar has actually traded: POS orders.
SELECT p.name AS property, count(o.*) AS pos_orders,
       min(o.created_at) AS first_order, max(o.created_at) AS last_order,
       count(*) FILTER (WHERE o.status = 'closed') AS closed,
       ROUND(sum(COALESCE(o.total, 0)), 2) AS total_value
  FROM public.properties p LEFT JOIN public.pos_orders o ON o.property_id = p.id
 GROUP BY p.name ORDER BY p.name;

-- 7. Journal entries recorded against each property, and in what currency.
SELECT p.name AS property, p.base_currency AS property_currency,
       je.source::text AS source, je.currency AS entry_currency,
       count(*) AS entries,
       ROUND(sum(l.debit), 2) AS sum_debit_txn,
       ROUND(sum(l.debit_base), 2) AS sum_debit_base,
       min(COALESCE(l.fx_rate, 1)) AS min_fx, max(COALESCE(l.fx_rate, 1)) AS max_fx
  FROM public.journal_entries je
  JOIN public.journal_lines l ON l.entry_id = je.id
  JOIN public.properties p ON p.id = je.property_id
 GROUP BY p.name, p.base_currency, je.source::text, je.currency
 ORDER BY p.name, je.source::text;

-- 8. Tax codes per property -- another place an intended jurisdiction shows.
SELECT p.name AS property, t.code, t.rate, t.is_active
  FROM public.tax_codes t JOIN public.properties p ON p.id = t.property_id
 ORDER BY p.name, t.code;

-- 9. Chart of accounts per property: does the Bar have its own accounts at all?
SELECT p.name AS property, count(a.*) AS accounts
  FROM public.properties p LEFT JOIN public.accounts a ON a.property_id = p.id
 GROUP BY p.name ORDER BY p.name;

-- 10. Any audit trail on the properties table itself.
SELECT entity, action, count(*) AS events, min(created_at) AS first, max(created_at) AS last
  FROM public.audit_logs
 WHERE entity ILIKE '%propert%'
 GROUP BY entity, action ORDER BY entity, action;

-- 11. Rooms / outlets attached to the Bar, to see what kind of property it is.
SELECT p.name AS property, count(r.*) AS rooms
  FROM public.properties p LEFT JOIN public.rooms r ON r.property_id = p.id
 GROUP BY p.name ORDER BY p.name;

-- 12. Defaults on the two properties currency columns and the system default.
SELECT table_name, column_name, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND ((table_name = 'properties' AND column_name IN ('currency', 'base_currency'))
        OR (table_name = 'system_settings' AND column_name = 'default_currency'));

-- 13. The system-wide default currency setting.
SELECT default_currency FROM public.system_settings LIMIT 5;

-- 14. The currency catalogue: what a configurator could actually pick from.
SELECT code, name, symbol, decimals FROM public.currencies ORDER BY code;

-- 15. fx_rates scoped to each property, since the rate is per-property.
SELECT p.name AS property, f.from_code, f.to_code, f.rate, f.as_of_date
  FROM public.fx_rates f JOIN public.properties p ON p.id = f.property_id
 ORDER BY p.name, f.as_of_date DESC;
