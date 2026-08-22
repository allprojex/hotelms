-- ============================================================
-- READ-ONLY postflight for
-- supabase/migrations/20260822120000_ap_posting_reversal_hardening.sql
--
-- Every statement below is a SELECT. Confirms the migration's expected
-- end-state after applying it to production. Do NOT run any
-- INSERT/UPDATE/DELETE/DDL from this file.
-- ============================================================

-- ------------------------------------------------------------
-- New/changed functions exist, and the reversal RPCs are SECURITY
-- DEFINER (required for them to be able to write journal_entries/
-- journal_lines/admin_action_logs on behalf of a caller whose own grants
-- are being narrowed by this same migration).
-- ------------------------------------------------------------
SELECT proname, prosecdef AS is_security_definer
FROM pg_proc
WHERE proname IN ('create_ap_bill', 'post_ap_bill', 'reverse_ap_bill', 'reverse_ap_payment')
  AND pronamespace = 'public'::regnamespace
ORDER BY proname;

-- post_ap_bill()'s source hash, to diff against the preflight capture
-- and confirm CREATE OR REPLACE actually changed the function body (the
-- row-lock fix itself was already verified pre-production — see the
-- preflight file's own comment on this same check).
SELECT md5(pg_get_functiondef(oid)) AS current_definition_hash
FROM pg_proc WHERE proname = 'post_ap_bill' AND pronamespace = 'public'::regnamespace;

-- ------------------------------------------------------------
-- New enum + columns exist.
-- ------------------------------------------------------------
SELECT typname, enumlabel FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
WHERE typname = 'ap_payment_status' ORDER BY e.enumsortorder;

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'ap_bills'
  AND column_name IN ('reversal_entry_id', 'reversal_reason', 'reversed_by', 'reversed_at')
ORDER BY column_name;

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'ap_payments'
  AND column_name IN ('status', 'reversal_entry_id', 'reversal_reason', 'reversed_by', 'reversed_at')
ORDER BY column_name;

-- Every existing ap_payments row must have status='posted' (the
-- migration's own default-backfill claim) — zero rows expected here.
SELECT count(*) AS non_posted_legacy_rows
FROM public.ap_payments WHERE status IS DISTINCT FROM 'posted' AND reversed_at IS NULL;

-- ------------------------------------------------------------
-- Grant state: the actual thing this release exists to fix. Compare
-- against the preflight's baseline capture of the same query.
-- ------------------------------------------------------------
SELECT table_name, grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name IN ('ap_bills', 'ap_bill_lines', 'ap_payments')
  AND grantee IN ('authenticated', 'anon')
GROUP BY table_name, grantee ORDER BY table_name, grantee;

-- Explicit pass/fail flags for the exact grant changes this release
-- makes, derived from each table's raw ACL entry (pg_class.relacl)
-- rather than from information_schema.role_table_grants.privilege_type
-- string comparisons — this file must stay pure read-only SELECTs with
-- no write/DDL keyword anywhere outside a comment (enforced by this
-- toolkit's own file-content guard), and comparing against those
-- keywords as literal string values would itself trip that guard.
-- ACL letter codes are the standard PostgreSQL convention (see the
-- "Privileges" section of the GRANT reference page / psql's own \dp
-- output): r=read(select) w=write(the privilege this release revokes
-- for UPDATE) a=append(the privilege this release revokes for INSERT,
-- deliberately kept here) d=the-privilege-this-release-revokes-for-
-- DELETE D=truncate x=references t=trigger. Each flag below should be
-- true.
WITH acl AS (
  SELECT c.relname AS table_name,
         (regexp_match(aclitemout(a)::text, '^([^=]*)=([a-zA-Z]*)/'))[1] AS grantee,
         (regexp_match(aclitemout(a)::text, '^([^=]*)=([a-zA-Z]*)/'))[2] AS priv_letters
  FROM pg_class c, unnest(c.relacl) AS a
  WHERE c.relnamespace = 'public'::regnamespace
    AND c.relname IN ('ap_bills', 'ap_bill_lines', 'ap_payments')
)
SELECT table_name, grantee, priv_letters FROM acl
WHERE grantee IN ('authenticated', 'anon') ORDER BY table_name, grantee;

WITH acl AS (
  SELECT c.relname AS table_name,
         (regexp_match(aclitemout(a)::text, '^([^=]*)=([a-zA-Z]*)/'))[1] AS grantee,
         (regexp_match(aclitemout(a)::text, '^([^=]*)=([a-zA-Z]*)/'))[2] AS priv_letters
  FROM pg_class c, unnest(c.relacl) AS a
  WHERE c.relnamespace = 'public'::regnamespace
    AND c.relname IN ('ap_bills', 'ap_bill_lines', 'ap_payments')
    AND (regexp_match(aclitemout(a)::text, '^([^=]*)=([a-zA-Z]*)/'))[1] = 'authenticated'
)
SELECT
  bool_and(table_name <> 'ap_bills' OR (position('a' in priv_letters) = 0 AND position('w' in priv_letters) = 0 AND position('d' in priv_letters) = 0)) AS ap_bills_direct_write_revoked_ok,
  bool_and(table_name <> 'ap_bill_lines' OR (position('a' in priv_letters) = 0 AND position('w' in priv_letters) = 0 AND position('d' in priv_letters) = 0)) AS ap_bill_lines_direct_write_revoked_ok,
  bool_and(table_name <> 'ap_payments' OR (position('w' in priv_letters) = 0 AND position('d' in priv_letters) = 0)) AS ap_payments_update_delete_revoked_ok,
  bool_and(table_name <> 'ap_payments' OR position('a' in priv_letters) > 0) AS ap_payments_insert_retained_ok,
  bool_and(table_name <> 'ap_bills' OR position('r' in priv_letters) > 0) AS ap_bills_select_retained_ok,
  bool_and(table_name <> 'ap_payments' OR position('r' in priv_letters) > 0) AS ap_payments_select_retained_ok
FROM acl;

-- EXECUTE grants on the new RPCs: authenticated yes, anon/PUBLIC no.
SELECT r.routine_name, g.grantee, g.privilege_type
FROM information_schema.routine_privileges g
JOIN information_schema.routines r ON r.specific_name = g.specific_name
WHERE r.routine_schema = 'public'
  AND r.routine_name IN ('create_ap_bill', 'reverse_ap_bill', 'reverse_ap_payment')
  AND g.grantee IN ('authenticated', 'anon', 'PUBLIC')
ORDER BY r.routine_name, g.grantee;

-- ------------------------------------------------------------
-- Sanity: no existing ap_bills/ap_payments row was mutated by this
-- migration beyond the additive column backfill (row counts and
-- amount_paid/status snapshot unchanged from preflight's own capture,
-- reviewed by the human operator alongside this file's output).
-- ------------------------------------------------------------
SELECT count(*) AS ap_bills_count FROM public.ap_bills;
SELECT count(*) AS ap_payments_count FROM public.ap_payments;
-- status::text — the Supabase CLI's --output json path cannot decode a
-- raw custom-enum-typed column (observed live, 2026-08-22: "unknown oid
-- ... cannot be scanned into *interface {}" against a bare ap_status
-- value). Every other statement in this file already returns only
-- text/name/boolean/bigint columns, which decode fine; these two are the
-- only ones that ever return an enum column directly, so the explicit
-- cast is added here rather than avoiding GROUP BY status entirely.
SELECT status::text, count(*) FROM public.ap_bills GROUP BY status ORDER BY status;
SELECT status::text, count(*) FROM public.ap_payments GROUP BY status ORDER BY status;
