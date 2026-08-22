#!/usr/bin/env node
// Section C.2 — apply ONE reviewed, hash-approved migration to production.
//
// This is the single most dangerous script in this toolkit and is written
// fail-closed at every step:
//   1. production.config.json's human_confirmation.confirmed must be true.
//   2. A release plan (--plan) is required — no inline SQL, no ad-hoc path.
//   3. Checked-out HEAD must exactly equal the release plan's approved_git_sha.
//   4. The migration file must be tracked in git at that exact commit, and
//      its PRISTINE git-blob SHA-256 must exactly equal the plan's
//      approvedSha256 — never the working-tree copy, which could differ.
//   5. The Supabase project ref is re-verified live via the Management API.
//   6. PROD_SUPABASE_DB_URL's embedded project ref must match config exactly.
//   7. `supabase db push --dry-run` must show EXACTLY the one approved
//      migration pending — zero, or more than one, or a different filename
//      aborts before anything is applied.
//   8. Only then does the real `supabase db push` run.
//
// There is no flag or code path that accepts inline SQL text as "the
// migration" — the only input is a file that must already be committed to
// git and hash-approved.
//
// NOTE ON STEP 7's PARSING: verified (2026-08-21) against real
// `supabase db push --dry-run` output from a local disposable Supabase
// stack (CLI 2.107.0) — not the production or Demo Hotel project, since
// no database credentials for either were available without asking for a
// password to be pasted into chat, which this toolkit avoids by design.
// The CLI's own output format doesn't vary by target (local vs. cloud), so
// this is a genuine verification of the parser against the real CLI, not a
// simulation — see docs/prod-release-runbook.md's "Demo/dry-run parser
// rehearsal" for the exact transcript and reasoning. Both the
// exactly-one-pending case and the nothing-pending ("up to date") case are
// handled explicitly; anything else still aborts rather than guessing.

import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadProductionConfig,
  assertHumanConfirmed,
  resolveProductionDbUrl,
  assertProjectRefKnownToCli,
  assertMigrationApproved,
  assertGitRemoteMatches,
  runCliMasked,
  log,
  pass,
  fail,
} from "./lib/guard.mjs";
import { loadReleasePlan, assertHeadMatchesPlan } from "./lib/release-plan.mjs";

const LABEL = "supabase-migrate";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--plan") out.plan = argv[++i];
    if (argv[i] === "--yes") out.yes = true;
  }
  return out;
}

/** Best-effort, fail-closed parse of `supabase db push --dry-run` output.
 * Returns the set of migration filenames it believes would be applied, or
 * throws if the output can't be confidently interpreted.
 *
 * Verified against real `supabase db push --dry-run` output (CLI 2.107.0,
 * against a local disposable stack — see docs/prod-release-runbook.md's
 * "Demo/dry-run parser rehearsal"): a pending migration renders as
 * ` • <filename>.sql` under "Would push these migrations:"; nothing pending
 * renders as the literal line "Local database is up to date." with no
 * filename at all. Both are handled explicitly below, rather than lumping
 * "nothing found" into one generic, less actionable error. Exported so
 * tests/prod-guards.test.ts can exercise it directly against those exact
 * captured strings. */
export function parsePendingMigrations(dryRunOutput) {
  const filenamePattern = /\b(\d{14}_[\w-]+\.sql)\b/g;
  const found = new Set();
  for (const match of dryRunOutput.matchAll(filenamePattern)) found.add(match[1]);
  if (found.size === 0) {
    if (/up to date/i.test(dryRunOutput)) {
      throw new Error(
        "`supabase db push --dry-run` reports the target is already up to date — no migrations are " +
          "pending. If you expected this migration to still need applying, it may already have been " +
          "applied (check `supabase migration list`); refusing to proceed either way.",
      );
    }
    throw new Error(
      "Could not identify any pending migration filename in `supabase db push --dry-run` output. " +
        "Aborting rather than guessing — inspect the dry-run output manually:\n" +
        dryRunOutput,
    );
  }
  return found;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { plan } = loadReleasePlan(args.plan);
  if (!plan.migration) {
    throw new Error("Release plan has no migration block — nothing for this script to do");
  }

  const config = loadProductionConfig();
  assertHumanConfirmed(config);
  pass(LABEL, "human_confirmation.confirmed is true");

  assertGitRemoteMatches(config);
  pass(LABEL, `git remote matches expected repo (${config.github_repo})`);

  const head = assertHeadMatchesPlan(plan);
  pass(LABEL, `checked-out HEAD matches release plan's approved_git_sha (${head})`);

  log(LABEL, `Target: ${config.supabase_project_ref} (${config.supabase_project_name_expected})`);
  await assertProjectRefKnownToCli(config);
  pass(LABEL, "project ref verified via Supabase Management API");

  const { url, masked } = resolveProductionDbUrl(config);
  pass(LABEL, `PROD_SUPABASE_DB_URL matches expected project ref (${masked})`);

  const actualSha256 = assertMigrationApproved({
    commit: plan.approved_git_sha,
    relPath: plan.migration.relPath,
    approvedSha256: plan.migration.approvedSha256,
  });
  pass(
    LABEL,
    `${plan.migration.relPath} pristine git-blob SHA256 matches approved hash (${actualSha256})`,
  );

  const expectedFilename = path.basename(plan.migration.relPath);

  log(LABEL, "Running `supabase db push --dry-run` ...");
  // runCliMasked, not execFileAsync directly: the supabase CLI has been
  // observed to echo the full --db-url argument (including the plaintext
  // password) into its OWN error output on failure (e.g. a connection
  // error) — see redactSecretsFromText's comment in lib/guard.mjs. This is
  // the single most important call site in this toolkit to get that right.
  // shell: true — Windows npm-installed `supabase` is a .cmd shim execFile
  // can't spawn directly; Node still safely quotes each array argument
  // (verified against a connection-string-shaped argument containing
  // ://, @, : before relying on this in a script that handles real
  // credentials).
  const dryRun = await runCliMasked("supabase", ["db", "push", "--db-url", url, "--dry-run"], {
    maxBuffer: 10 * 1024 * 1024,
    shell: true,
  });
  const pending = parsePendingMigrations(dryRun.stdout + "\n" + (dryRun.stderr ?? ""));
  if (pending.size !== 1) {
    throw new Error(
      `Expected exactly 1 pending migration, dry-run shows ${pending.size}: ${[...pending].join(", ")}. ` +
        "Refusing — apply and review any other pending migrations separately, one release at a time.",
    );
  }
  if (![...pending][0].includes(expectedFilename) && expectedFilename !== [...pending][0]) {
    throw new Error(
      `Pending migration ("${[...pending][0]}") does not match the approved migration ` +
        `("${expectedFilename}"). Refusing to apply an unreviewed migration.`,
    );
  }
  pass(LABEL, `dry-run confirms exactly one pending migration, matching the approved one`);

  if (!args.yes) {
    throw new Error(
      "Refusing to apply without --yes. This is the last gate before a real write to production — " +
        "re-read the PASS lines above, then rerun with --yes appended.",
    );
  }

  log(LABEL, "Applying migration for real: `supabase db push` ...");
  // --yes here is the Supabase CLI's own flag ("answer yes to all
  // prompts") — NOT a substitute for this script's own --yes gate above.
  // Discovered while rehearsing this against a local disposable stack: a
  // plain `db push` without it renders an interactive [Y/n] confirmation,
  // which would hang forever in this script's non-TTY child process. By
  // this point every safety gate above has already passed (hash match,
  // exactly-one-pending dry-run check, human_confirmation, this script's
  // own --yes) — the CLI's own prompt would be redundant, not a missing
  // safety check.
  const applied = await runCliMasked("supabase", ["db", "push", "--db-url", url, "--yes"], {
    maxBuffer: 10 * 1024 * 1024,
    shell: true,
  });
  process.stdout.write(applied.stdout);
  if (applied.stderr?.trim()) log(LABEL, `stderr: ${applied.stderr.trim()}`);
  pass(LABEL, `migration applied: ${plan.migration.relPath} (sha256 ${actualSha256})`);
}

// Only run main() when this file is executed directly (node
// supabase-migrate.mjs ...) — not when imported, e.g. by
// tests/prod-guards.test.ts importing parsePendingMigrations above. Without
// this guard, importing this module for testing would immediately attempt
// a real release-plan-driven run and call process.exit().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    fail(LABEL, e.message);
    process.exit(1);
  });
}
