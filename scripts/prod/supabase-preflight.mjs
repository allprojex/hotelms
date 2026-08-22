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
// Executes statement-by-statement via lib/sql-runner.mjs, not as one whole
// file — `supabase db query --file` submits the whole file as a single
// prepared statement, which Postgres rejects outright for any file with
// more than one SQL statement (discovered against the real production
// pooler; see sql-runner.mjs's header for the full story). Every file under
// supabase/preflight/ has always had multiple statements, so this isn't an
// edge case — it's how every real preflight file here is actually shaped.
//
// Usage:
//   PROD_SUPABASE_DB_URL=... node scripts/prod/supabase-preflight.mjs --plan <release-plan.json>
//   PROD_SUPABASE_DB_URL=... node scripts/prod/supabase-preflight.mjs --file <path-to-sql>
//
// Exit code 0 = every statement ran and produced output (inspect it
// yourself — this script does not judge the *content* of preflight
// findings, only that the file was safe to run and that it ran against the
// right project). Non-zero = a guard failed, or any statement errored (all
// statements after the failing one are skipped — see runReadOnlySqlStatements).

import path from "node:path";
import {
  loadProductionConfig,
  resolveProductionDbUrl,
  assertProjectRefKnownToCli,
  assertReadOnlySqlFile,
  REPO_ROOT,
  log,
  pass,
  fail,
} from "./lib/guard.mjs";
import { runReadOnlySqlStatements } from "./lib/sql-runner.mjs";
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
  const sqlText = assertReadOnlySqlFile(sqlPath);
  pass(LABEL, `${sqlFileRel} contains no write/DDL keywords outside comments (whole-file check)`);

  log(LABEL, `Running ${sqlFileRel} (read-only, statement by statement) ...`);
  const results = await runReadOnlySqlStatements(url, sqlText, { label: LABEL });
  pass(
    LABEL,
    `preflight completed — all ${results.length} statement(s) ran; review the output above for any non-empty result sets`,
  );
}

main().catch((e) => {
  fail(LABEL, e.message);
  process.exit(1);
});
