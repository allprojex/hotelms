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
//   8. Only then does the real `supabase db push` run — and only in --yes
//      (apply) mode.
//
// There is no flag or code path that accepts inline SQL text as "the
// migration" — the only input is a file that must already be committed to
// git and hash-approved.
//
// MODES (fix for a real incident, 2026-08-22): this script now requires
// exactly one of --check or --yes.
//   --check : runs every guard above through the dry-run check, then exits
//             0 on success. NEVER calls `supabase db push` for real — only
//             `--dry-run`. This is the orchestrator's own pre-apply
//             checkpoint stage.
//   --yes   : re-runs every guard above from scratch (never trusts a prior
//             --check run — production state could have changed in
//             between), then performs the real apply.
// Before this fix, the same script always ran the guard chain and then
// EXITED NON-ZERO if --yes was absent, as a deliberate "not yet confirmed"
// refusal — a real, secondary use of that as a checkpoint by
// scripts/prod-release.sh (`stage "02-..." node supabase-migrate.mjs
// --plan "$PLAN" || true`) failed anyway, because stage()'s own `exit
// "$code"` on failure is a hard, unconditional process exit that no
// trailing `|| true` at the call site can intercept (that only catches a
// `return`, not an `exit` from inside the called shell function) — so a
// deliberately-refusing, otherwise-fully-passing dry-run check killed the
// entire release script before stage "03-migration-apply" ever ran, even
// when the top-level invocation legitimately included --yes. Discovered
// during this toolkit's first real production release attempt (production
// was never written to — the script stopped safely, just too early).
// Fixed by making a clean, successful dry-run check its own real exit-0
// mode, so the orchestrator no longer needs to treat one particular
// non-zero exit as "actually fine."
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

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--plan") out.plan = argv[++i];
    if (argv[i] === "--yes") out.yes = true;
    if (argv[i] === "--check") out.check = true;
  }
  return out;
}

/** Pure decision: which mode does this argv select? Never touches the
 * filesystem, network, or git — safe to unit test in isolation. Throws a
 * plain Error (not GuardError) for a usage mistake, same as every other
 * argument-shape problem in this toolkit's CLI entry points. */
export function resolveMode(args) {
  if (args.check && args.yes) {
    throw new Error("Specify only one of --check or --yes, not both.");
  }
  if (args.check) return "check";
  if (args.yes) return "apply";
  throw new Error(
    "Specify exactly one mode: --check (run every guard + a dry-run, exit 0 " +
      "on success, never apply anything) or --yes (re-run every guard, then " +
      "apply the approved migration for real). " +
      "Usage: supabase-migrate.mjs --plan <path> --check|--yes",
  );
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

/** Runs the full guard chain (human confirmation, git remote, HEAD-matches-
 * plan, project ref, db-url, migration-hash, dry-run + exactly-one-pending)
 * and, depending on `mode`, either stops after a clean dry-run (`"check"`)
 * or goes on to perform the real apply (`"apply"`). Every dependency that
 * would otherwise touch the network is injectable (defaulting to the real
 * implementation) specifically so tests can exercise this exact function —
 * mode dispatch, guard ordering, "check never applies" — without live
 * Supabase credentials. Never skips a guard for either mode: "apply" always
 * re-runs everything from scratch rather than trusting a prior "check". */
export async function runMigrate({
  plan,
  mode,
  runCli = runCliMasked,
  checkProjectRef = assertProjectRefKnownToCli,
}) {
  if (mode !== "check" && mode !== "apply") {
    throw new Error(`runMigrate: mode must be "check" or "apply", got ${JSON.stringify(mode)}`);
  }
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
  await checkProjectRef(config, runCli);
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
  // runCli (defaults to runCliMasked), not execFileAsync directly: the
  // supabase CLI has been observed to echo the full --db-url argument
  // (including the plaintext password) into its OWN error output on
  // failure (e.g. a connection error) — see redactSecretsFromText's
  // comment in lib/guard.mjs. This is the single most important call site
  // in this toolkit to get that right. shell: true — Windows npm-installed
  // `supabase` is a .cmd shim execFile can't spawn directly; Node still
  // safely quotes each array argument (verified against a
  // connection-string-shaped argument containing ://, @, : before relying
  // on this in a script that handles real credentials).
  const dryRun = await runCli("supabase", ["db", "push", "--db-url", url, "--dry-run"], {
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

  if (mode === "check") {
    pass(
      LABEL,
      "check mode: every guard passed and the dry-run confirms exactly the approved migration " +
        "is pending — nothing was applied",
    );
    return { applied: false, actualSha256 };
  }

  log(LABEL, "Applying migration for real: `supabase db push` ...");
  // --yes here is the Supabase CLI's own flag ("answer yes to all
  // prompts") — NOT a substitute for this script's own --yes mode above.
  // Discovered while rehearsing this against a local disposable stack: a
  // plain `db push` without it renders an interactive [Y/n] confirmation,
  // which would hang forever in this script's non-TTY child process. By
  // this point every safety gate above has already passed (hash match,
  // exactly-one-pending dry-run check, human_confirmation, this script's
  // own --yes mode) — the CLI's own prompt would be redundant, not a
  // missing safety check.
  const applied = await runCli("supabase", ["db", "push", "--db-url", url, "--yes"], {
    maxBuffer: 10 * 1024 * 1024,
    shell: true,
  });
  process.stdout.write(applied.stdout);
  if (applied.stderr?.trim()) log(LABEL, `stderr: ${applied.stderr.trim()}`);
  pass(LABEL, `migration applied: ${plan.migration.relPath} (sha256 ${actualSha256})`);
  return { applied: true, actualSha256 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = resolveMode(args);
  const { plan } = loadReleasePlan(args.plan);
  await runMigrate({ plan, mode });
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
