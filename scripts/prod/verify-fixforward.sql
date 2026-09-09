-- READ ONLY post-deploy verification for the revenue-posting fix-forward release.
-- Authorization, currency, isolation and enforcement checks against production.

-- 1. Grantees on the posting surface (ACL inspection; no privilege keyword used).
SELECT p.proname AS function,
       COALESCE((SELECT string_agg(DISTINCT COALESCE(pg_get_userbyid(a.grantee), 'PUBLIC'), ', ')
                   FROM aclexplode(p.proacl) a), '(no acl = owner only)') AS grantees,
       (p.proacl IS NULL) AS acl_null_owner_only,
       p.prosecdef AS security_definer,
       pg_get_userbyid(p.proowner) AS owner
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('post_journal_internal', 'log_audit_event', 'post_journal',
                     'post_reservation_checkout', 'post_pos_order_close',
                     'tg_autopost_reservation', 'tg_autopost_pos')
 ORDER BY p.proname;

-- 2. Currency: no hardcoded literal anywhere in the posting path; base_currency read.
SELECT p.proname AS function,
       (p.prosrc LIKE '%''USD''%') AS has_usd_literal,
       (p.prosrc LIKE '%''GHS''%') AS has_ghs_literal,
       (p.prosrc LIKE '%base_currency%') AS reads_base_currency,
       (p.prosrc LIKE '%EXCEPTION WHEN OTHERS%') AS swallows_errors
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('post_reservation_checkout', 'post_pos_order_close', 'post_journal_internal')
 ORDER BY p.proname;

-- 3. Enforcement still present inside the engine.
SELECT (prosrc LIKE '%balanced%') AS balancing_enforced,
       (prosrc LIKE '%accounting_periods%') AS period_lock_enforced,
       (prosrc LIKE '%_property_id%') AS property_scoped
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'post_journal_internal';

-- 4. Manual journals still role-gated.
SELECT (prosrc LIKE '%has_any_role%') AS manual_journal_role_gated
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'post_journal';

-- 5. Triggers still attached to the operational tables.
SELECT c.relname AS table_name, t.tgname AS trigger_name, t.tgenabled AS enabled
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
 WHERE NOT t.tgisinternal AND c.relname IN ('reservations', 'pos_orders')
 ORDER BY c.relname, t.tgname;

-- 6. Production properties and their configured currency.
SELECT id, name, base_currency FROM public.properties ORDER BY name;

-- 7. Accounting periods (expect none defined).
SELECT count(*) AS period_count,
       count(*) FILTER (WHERE status IN ('locked', 'closed')) AS locked_or_closed
  FROM public.accounting_periods;
