#!/usr/bin/env node
// Section C.1 — read-only Supabase production preflight.
//
// Runs a human-reviewed, read-only SQL file (supabase/preflight/*.sql, same
// convention this repo already uses) against the production project and
// prints its output. Never mutates anything: assertReadOnlySqlFile() refuses
// to run a file containing INSERT/UPDATE/DELETE/DDL keywords outside
// comments, and this script never accepts inline SQL from argv — only a file
// path.
//
// Usage:
//   PROD_SUPABASE_DB_URL=... node scripts/prod/supabase-preflight.mjs --plan <release-plan.json>
//   PROD_SUPABASE_DB_URL=... node scripts/prod/supabase-preflight.mjs --file <path-to-sql>
//
// Exit code 0 = ran and produced output (inspect it yourself — this script
// does not judge the *content* of preflight findings, only that the file was
// safe to run and that it ran against the right project). Non-zero = a guard
// failed or the query itself errored.

import path from "node:path";
import {
  loadProductionConfig,
  resolveProductionDbUrl,
  assertProjectRefKnownToCli,
  assertReadOnlySqlFile,
  runCliMasked,
  REPO_ROOT,
  log,
  pass,
  fail,
} from "./lib/guard.mjs";
import { loadReleasePlan } from "./lib/release-plan.mjs";

const LABEL = "supabase-preflight";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--plan") out.plan = argv[++i];
    else if (argv[i] === "--file") out.file = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let sqlFileRel = args.file;
  if (!sqlFileRel && args.plan) {
    const { plan } = loadReleasePlan(args.plan);
    sqlFileRel = plan.preflight_sql;
    if (!sqlFileRel) throw new Error("Release plan has no preflight_sql set");
  }
  if (!sqlFileRel) {
    throw new Error("Pass --file <sql-path> or --plan <release-plan.json> with preflight_sql set");
  }

  const config = loadProductionConfig();
  log(LABEL, `Target: ${config.supabase_project_ref} (${config.supabase_project_name_expected})`);

  await assertProjectRefKnownToCli(config);
  pass(LABEL, "project ref verified via Supabase Management API");

  const { url, masked } = resolveProductionDbUrl(config);
  pass(LABEL, `PROD_SUPABASE_DB_URL matches expected project ref (${masked})`);

  const sqlPath = path.isAbsolute(sqlFileRel) ? sqlFileRel : path.join(REPO_ROOT, sqlFileRel);
  assertReadOnlySqlFile(sqlPath);
  pass(LABEL, `${sqlFileRel} contains no write/DDL keywords outside comments`);

  log(LABEL, `Running ${sqlFileRel} (read-only) ...`);
  // runCliMasked, not execFileAsync directly: the supabase CLI has been
  // observed to echo the full --db-url argument (including the plaintext
  // password) into its OWN error output on failure (e.g. a connection
  // error) — see redactSecretsFromText's comment in lib/guard.mjs. Every
  // error path here is scrubbed before it can reach a log line.
  // shell: true — Windows npm-installed `supabase` is a .cmd shim execFile
  // can't spawn without it; array arguments (including the connection
  // string) are still safely quoted.
  const { stdout, stderr } = await runCliMasked(
    "supabase",
    ["db", "query", "--db-url", url, "--file", sqlPath, "--output", "json"],
    { maxBuffer: 20 * 1024 * 1024, shell: true },
  );
  if (stderr?.trim()) log(LABEL, `stderr: ${stderr.trim()}`);
  process.stdout.write(stdout);
  pass(LABEL, "preflight query completed — review the output above for any non-empty result sets");
}

main().catch((e) => {
  fail(LABEL, e.message);
  process.exit(1);
});
