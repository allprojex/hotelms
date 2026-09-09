-- READ ONLY. Does the folio journal capture everything a guest is charged?
-- post_reservation_checkout() posts reservations.rate_total only.

-- 1. Charges recorded against reservations, beyond the room rate.
SELECT rc.description, count(*) AS charges,
       ROUND(sum(rc.amount), 2) AS amount
  FROM public.reservation_charges rc
 GROUP BY rc.description
 ORDER BY 3 DESC NULLS LAST LIMIT 15;

-- 2. For checked-out stays: room rate vs total charges vs payments collected.
SELECT count(*) AS stays,
       ROUND(sum(r.rate_total), 2) AS rate_total_sum,
       ROUND(sum(COALESCE(ch.charges, 0)), 2) AS reservation_charges_sum,
       ROUND(sum(COALESCE(pm.paid, 0)), 2) AS payments_sum
  FROM public.reservations r
  LEFT JOIN LATERAL (SELECT sum(amount) AS charges FROM public.reservation_charges c WHERE c.reservation_id = r.id) ch ON true
  LEFT JOIN LATERAL (SELECT sum(amount) AS paid FROM public.payments p WHERE p.reservation_id = r.id AND p.status = 'posted') pm ON true
 WHERE r.status = 'checked_out';

-- 3. Is any reservation_charge represented in the ledger at all?
SELECT count(*) AS charge_rows,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.journal_entries je
                                       WHERE je.source_ref = rc.id::text)) AS with_own_journal
  FROM public.reservation_charges rc;
