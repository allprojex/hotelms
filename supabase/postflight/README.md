# Postflight verification SQL

Same convention as `supabase/preflight/`, run *after* a migration instead of
before: every statement here must be a read-only `SELECT`, reviewed by a
human alongside the migration it verifies, and referenced from a release
plan's `postflight_sql` field.

`scripts/prod/supabase-verify.mjs` refuses to run any file here that
contains an INSERT/UPDATE/DELETE/DDL keyword outside a comment — see
`scripts/prod/lib/guard.mjs`'s `assertReadOnlySqlFile`.

Name new files to match their migration, e.g.
`20260821120000_ar_credit_note_receipt_reversal_postflight.sql`, and write
checks that confirm the migration's expected end-state: the new
function/table/column exists and behaves as intended, row counts look
sane, nothing was silently skipped.
