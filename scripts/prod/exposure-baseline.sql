-- READ ONLY. Frozen historical exposure baseline, captured immediately after the
-- fix-forward deployment. Boundary: 2026-09-09T21:55:03.790Z UTC (the moment
-- migration 20260909170000 committed). Nothing here repairs anything.
--
-- Methodology is identical to the final pre-merge audit: a stay is "unposted"
-- when no journal_entries row exists with source='folio' and source_ref equal to
-- the reservation id -- the exact idempotency key post_reservation_checkout
-- itself writes and checks. Revenue/tax are derived with the same formula the
-- posting function uses: room_net = rate_total / (1 + STD_rate/100).

-- A/B/C/D/E -- folio omission, per property, capped at the fix-forward boundary.
WITH cutoff AS (SELECT timestamptz '2026-09-09 21:55:03.790+00' AS boundary),
unposted AS (
  SELECT r.id, r.property_id, r.check_out, COALESCE(r.rate_total, 0) AS rate_total,
         COALESCE((SELECT t.rate FROM public.tax_codes t
                    WHERE t.property_id = r.property_id AND t.code = 'STD' LIMIT 1), 0) AS tax_rate
    FROM public.reservations r, cutoff c
   WHERE r.status = 'checked_out'
     AND r.check_out < c.boundary
     AND NOT EXISTS (SELECT 1 FROM public.journal_entries je
                      WHERE je.source = 'folio' AND je.source_ref = r.id::text)
)
SELECT p.name AS property, p.base_currency,
       count(*) AS a_stays_without_folio_journal,
       ROUND(sum(u.rate_total), 2) AS b_room_charge_amount,
       ROUND(sum(ROUND(u.rate_total / (1 + u.tax_rate / 100), 4)), 2) AS c_expected_revenue,
       ROUND(sum(u.rate_total - ROUND(u.rate_total / (1 + u.tax_rate / 100), 4)), 2) AS d_expected_tax,
       ROUND(sum(u.rate_total), 2) AS e_expected_ar,
       max(u.tax_rate) AS tax_rate_used,
       min(u.check_out) AS earliest_check_out,
       max(u.check_out) AS latest_check_out
  FROM unposted u JOIN public.properties p ON p.id = u.property_id
 GROUP BY p.name, p.base_currency
 ORDER BY p.name;

-- A/B totals across all properties.
WITH cutoff AS (SELECT timestamptz '2026-09-09 21:55:03.790+00' AS boundary)
SELECT count(*) AS a_total_stays, ROUND(sum(COALESCE(r.rate_total, 0)), 2) AS b_total_room_charges
  FROM public.reservations r, cutoff c
 WHERE r.status = 'checked_out' AND r.check_out < c.boundary
   AND NOT EXISTS (SELECT 1 FROM public.journal_entries je
                    WHERE je.source = 'folio' AND je.source_ref = r.id::text);

-- Monthly shape of the folio omission, for the repair exercise.
WITH cutoff AS (SELECT timestamptz '2026-09-09 21:55:03.790+00' AS boundary)
SELECT to_char(r.check_out, 'YYYY-MM') AS month, count(*) AS stays,
       ROUND(sum(COALESCE(r.rate_total, 0)), 2) AS room_charges
  FROM public.reservations r, cutoff c
 WHERE r.status = 'checked_out' AND r.check_out < c.boundary
   AND NOT EXISTS (SELECT 1 FROM public.journal_entries je
                    WHERE je.source = 'folio' AND je.source_ref = r.id::text)
 GROUP BY 1 ORDER BY 1;

-- F/G -- payments with no journal entry, capped at the boundary.
WITH cutoff AS (SELECT timestamptz '2026-09-09 21:55:03.790+00' AS boundary)
SELECT count(*) AS f_payments_without_journal,
       ROUND(sum(COALESCE(pay.amount, 0)), 2) AS g_payment_amount,
       min(pay.received_at) AS earliest, max(pay.received_at) AS latest
  FROM public.payments pay, cutoff c
 WHERE pay.status = 'posted' AND pay.received_at < c.boundary
   AND NOT EXISTS (SELECT 1 FROM public.journal_entries je
                    WHERE je.source = 'payment' AND je.source_ref = pay.id::text);

-- H/I -- existing journal entries converted at a non-unit FX rate.
SELECT count(DISTINCT je.id) AS h_fx_affected_entries,
       count(*) AS fx_affected_lines,
       ROUND(sum(l.debit - l.debit_base), 2) AS i_fx_understatement,
       min(je.entry_date) AS earliest, max(je.entry_date) AS latest,
       string_agg(DISTINCT je.source::text, ', ') AS sources
  FROM public.journal_entries je JOIN public.journal_lines l ON l.entry_id = je.id
 WHERE l.fx_rate <> 1;

-- Compensating manual journals (expect none) and the ledger position.
SELECT je.source::text AS source, count(*) AS entries FROM public.journal_entries je
 GROUP BY 1 ORDER BY 1;

-- STEP 11 -- journals written AFTER the fix-forward boundary: currency, balance, source.
WITH cutoff AS (SELECT timestamptz '2026-09-09 21:55:03.790+00' AS boundary)
SELECT je.source::text AS source, p.name AS property, je.currency,
       count(*) AS entries,
       ROUND(sum(l.debit_base), 2) AS total_debit_base,
       ROUND(sum(l.credit_base), 2) AS total_credit_base,
       bool_and(je.currency = p.base_currency) AS currency_matches_property,
       bool_and(COALESCE(l.fx_rate, 1) = 1) AS fx_rate_is_unit
  FROM public.journal_entries je
  JOIN public.journal_lines l ON l.entry_id = je.id
  JOIN public.properties p ON p.id = je.property_id, cutoff c
 WHERE je.created_at >= c.boundary
 GROUP BY 1, 2, 3 ORDER BY 1, 2;

-- STEP 11 -- operational records completed after the boundary and whether each posted.
WITH cutoff AS (SELECT timestamptz '2026-09-09 21:55:03.790+00' AS boundary)
SELECT 'reservations_checked_out' AS record_type,
       count(*) AS total_after_boundary,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.journal_entries je
                                       WHERE je.source = 'folio' AND je.source_ref = r.id::text)) AS with_journal
  FROM public.reservations r, cutoff c
 WHERE r.status = 'checked_out' AND r.updated_at >= c.boundary;
