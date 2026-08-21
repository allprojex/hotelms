#!/usr/bin/env node
// Section C.4 — optional PostgREST schema-cache reload.
//
// Needed after a migration that changes a function signature/return type or
// adds/removes a table PostgREST needs to know about (Supabase's REST layer
// caches the schema and doesn't always pick up DDL changes automatically).
// Runs exactly one hardcoded statement — `select pg_notify('pgrst', 'reload
// schema')` — never anything else. This is not a general "run write SQL"
// tool: the statement is fixed in this file's source, not accepted as input.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  loadProductionConfig,
  assertHumanConfirmed,
  resolveProductionDbUrl,
  assertProjectRefKnownToCli,
  log,
  pass,
  fail,
} from "./lib/guard.mjs";

const execFileAsync = promisify(execFile);
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
  // shell: true — see supabase-migrate.mjs's comment: Windows npm-installed
  // `supabase` is a .cmd shim execFile can't spawn without it; array
  // arguments (including the connection string) are still safely quoted.
  const { stdout, stderr } = await execFileAsync(
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
