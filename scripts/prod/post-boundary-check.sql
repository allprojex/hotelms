-- READ ONLY. STEP 3: has anything completed AFTER the fix-forward boundary
-- joined the historical omission population? Boundary 2026-09-09T21:55:03.790Z.
-- Payments, reservation checkouts and POS closes are reported separately.

-- 1. PAYMENTS received after the boundary: posted vs journalled.
WITH cutoff AS (SELECT timestamptz '2026-09-09 21:55:03.790+00' AS b)
SELECT count(*) AS payments_after_boundary,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.journal_entries je
                                       WHERE je.source = 'payment' AND je.source_ref = pay.id::text)) AS with_journal,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.journal_entries je
                                           WHERE je.source = 'payment' AND je.source_ref = pay.id::text)) AS joined_omission,
       ROUND(COALESCE(sum(pay.amount), 0), 2) AS amount
  FROM public.payments pay, cutoff c
 WHERE pay.status = 'posted' AND pay.received_at >= c.b;

-- 2. RESERVATION CHECKOUTS after the boundary: did any stay change to checked_out?
WITH cutoff AS (SELECT timestamptz '2026-09-09 21:55:03.790+00' AS b)
SELECT count(*) AS checkouts_after_boundary,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.journal_entries je
                                       WHERE je.source = 'folio' AND je.source_ref = r.id::text)) AS with_journal,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.journal_entries je
                                           WHERE je.source = 'folio' AND je.source_ref = r.id::text)) AS joined_omission,
       ROUND(COALESCE(sum(r.rate_total), 0), 2) AS room_charges
  FROM public.reservations r, cutoff c
 WHERE r.status = 'checked_out' AND r.updated_at >= c.b;

-- 3. POS CLOSES after the boundary.
WITH cutoff AS (SELECT timestamptz '2026-09-09 21:55:03.790+00' AS b)
SELECT count(*) AS pos_closes_after_boundary,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.journal_entries je
                                       WHERE je.source = 'pos' AND je.source_ref = o.id::text)) AS with_journal,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.journal_entries je
                                           WHERE je.source = 'pos' AND je.source_ref = o.id::text)) AS joined_omission,
       ROUND(COALESCE(sum(o.total), 0), 2) AS order_value
  FROM public.pos_orders o, cutoff c
 WHERE o.status = 'closed' AND o.updated_at >= c.b;

-- 4. Every journal entry written since the boundary, with its balance and currency.
WITH cutoff AS (SELECT timestamptz '2026-09-09 21:55:03.790+00' AS b)
SELECT je.source::text AS source, p.name AS property, je.currency,
       p.base_currency AS property_currency,
       count(DISTINCT je.id) AS entries,
       ROUND(sum(l.debit_base), 2) AS debit_base,
       ROUND(sum(l.credit_base), 2) AS credit_base,
       bool_and(je.currency = p.base_currency) AS currency_matches,
       bool_and(COALESCE(l.fx_rate, 1) = 1) AS fx_unit
  FROM public.journal_entries je
  JOIN public.journal_lines l ON l.entry_id = je.id
  JOIN public.properties p ON p.id = je.property_id, cutoff c
 WHERE je.created_at >= c.b
 GROUP BY 1, 2, 3, 4 ORDER BY 1, 2;

-- 5. Has the historical population changed size since the baseline was frozen?
SELECT count(*) AS unposted_stays_now,
       ROUND(COALESCE(sum(r.rate_total), 0), 2) AS room_charges_now
  FROM public.reservations r
 WHERE r.status = 'checked_out'
   AND NOT EXISTS (SELECT 1 FROM public.journal_entries je
                    WHERE je.source = 'folio' AND je.source_ref = r.id::text);
