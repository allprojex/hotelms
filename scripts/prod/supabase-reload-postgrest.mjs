#!/usr/bin/env node
// Section C.4 — optional PostgREST schema-cache reload.
//
// Needed after a migration that changes a function signature/return type or
// adds/removes a table PostgREST needs to know about (Supabase's REST layer
// caches the schema and doesn't always pick up DDL changes automatically).
// Runs exactly one hardcoded statement — `select pg_notify('pgrst', 'reload
// schema')` — never anything else. This is not a general "run write SQL"
// tool: the statement is fixed in this file's source, not accepted as input.

import {
  loadProductionConfig,
  assertHumanConfirmed,
  resolveProductionDbUrl,
  assertProjectRefKnownToCli,
  runCliMasked,
  log,
  pass,
  fail,
} from "./lib/guard.mjs";

const LABEL = "supabase-reload-postgrest";
const RELOAD_STATEMENT = "select pg_notify('pgrst', 'reload schema');";

async function main() {
  const config = loadProductionConfig();
  assertHumanConfirmed(config);
  pass(LABEL, "human_confirmation.confirmed is true");

  log(LABEL, `Target: ${config.supabase_project_ref} (${config.supabase_project_name_expected})`);
  await assertProjectRefKnownToCli(config);
  pass(LABEL, "project ref verified via Supabase Management API");

  const { url, masked } = resolveProductionDbUrl(config);
  pass(LABEL, `PROD_SUPABASE_DB_URL matches expected project ref (${masked})`);

  log(LABEL, "Sending PostgREST schema reload notification ...");
  // runCliMasked, not execFileAsync directly — see supabase-preflight.mjs's
  // comment: the supabase CLI has been observed to echo the plaintext
  // --db-url argument into its own error output on failure.
  const { stdout, stderr } = await runCliMasked(
    "supabase",
    ["db", "query", "--db-url", url, RELOAD_STATEMENT],
    { maxBuffer: 1024 * 1024, shell: true },
  );
  if (stdout?.trim()) process.stdout.write(stdout);
  if (stderr?.trim()) log(LABEL, `stderr: ${stderr.trim()}`);
  pass(LABEL, "PostgREST schema reload notification sent");
}

main().catch((e) => {
  fail(LABEL, e.message);
  process.exit(1);
});
