-- READ ONLY. After the proposed repair, AR would still hold a credit balance.
-- Is that advance deposits on stays that have not yet checked out?

-- 1. Posted payments whose reservation is NOT checked out (advance deposits).
SELECT r.status::text AS reservation_status,
       count(*) AS payments,
       ROUND(sum(pay.amount), 2) AS amount,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.journal_entries je
                                       WHERE je.source = 'payment' AND je.source_ref = pay.id::text)) AS already_journalled
  FROM public.payments pay
  JOIN public.reservations r ON r.id = pay.reservation_id
 WHERE pay.status = 'posted'
 GROUP BY r.status::text
 ORDER BY r.status::text;

-- 2. The same, restricted to payments that already have a journal -- these are
--    the AR credits sitting in the ledger today with no matching folio debit.
SELECT r.status::text AS reservation_status,
       count(*) AS journalled_payments,
       ROUND(sum(pay.amount), 2) AS ar_credit_posted
  FROM public.payments pay
  JOIN public.reservations r ON r.id = pay.reservation_id
 WHERE pay.status = 'posted'
   AND EXISTS (SELECT 1 FROM public.journal_entries je
                WHERE je.source = 'payment' AND je.source_ref = pay.id::text)
 GROUP BY r.status::text
 ORDER BY r.status::text;
