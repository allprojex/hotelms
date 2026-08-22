#!/usr/bin/env node
// Section C.3 — read-only post-migration verification.
//
// Same shape and same guards as supabase-preflight.mjs — the only
// difference is which SQL file it runs (release plan's postflight_sql,
// authored by the human reviewer to confirm the migration's expected
// end-state: new function/table/column exists, row counts look sane,
// nothing was silently skipped). Kept as a separate script from preflight
// (rather than one script with a --phase flag) so its permission grant can
// never accidentally be invoked before a migration has actually run.
//
// Executes statement-by-statement via lib/sql-runner.mjs — same reasoning
// as supabase-preflight.mjs: `supabase db query --file` rejects any
// multi-statement file outright at the Postgres protocol level.

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

const LABEL = "supabase-verify";

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
    sqlFileRel = plan.postflight_sql;
    if (!sqlFileRel) throw new Error("Release plan has no postflight_sql set");
  }
  if (!sqlFileRel) {
    throw new Error("Pass --file <sql-path> or --plan <release-plan.json> with postflight_sql set");
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

  log(LABEL, `Running ${sqlFileRel} (read-only verification, statement by statement) ...`);
  const results = await runReadOnlySqlStatements(url, sqlText, { label: LABEL });
  pass(
    LABEL,
    `verification completed — all ${results.length} statement(s) ran; confirm the expected rows/values are present above`,
  );
}

main().catch((e) => {
  fail(LABEL, e.message);
  process.exit(1);
});
