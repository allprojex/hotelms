#!/usr/bin/env node
// Section C.2 — apply an ORDERED SET of one or more reviewed, hash-approved
// migrations to production.
//
// This is the single most dangerous script in this toolkit and is written
// fail-closed at every step:
//   1. production.config.json's human_confirmation.confirmed must be true.
//   2. A release plan (--plan) is required — no inline SQL, no ad-hoc path.
//   3. Checked-out HEAD must exactly equal the release plan's approved_git_sha.
//   4. EVERY migration file (whether the plan's original singular
//      `migration` block, or its new plural `migrations` array — see
//      lib/release-plan.mjs's normalizeMigrations) must be tracked in git
//      at that exact commit, and its PRISTINE git-blob SHA-256 must exactly
//      equal the plan's approvedSha256 — never the working-tree copy,
//      which could differ. Checked for every migration before any of them
//      are touched.
//   5. The Supabase project ref is re-verified live via the Management API.
//   6. PROD_SUPABASE_DB_URL's embedded project ref must match config exactly.
//   7. `supabase db push --dry-run` must show EXACTLY the approved
//      migration SET, in EXACTLY the approved ORDER — fewer, more, a
//      different filename, or a different order all abort before anything
//      is applied. A single-migration plan is simply the N=1 case of this
//      same check — no special-cased code path.
//   8. Only then does the real `supabase db push` run — and only in --yes
//      (apply) mode. One native, ordered CLI apply for the whole set, never
//      a loop of ad-hoc per-migration SQL execution.
//   9. POST-apply, every approved migration is independently re-verified as
//      recorded remotely (`supabase migration list`) and no longer pending
//      (`supabase db push --dry-run` again) — trusting nothing about the
//      apply call's own reported exit code. A partial apply (some but not
//      all approved migrations actually landed) is reported as an explicit
//      release failure naming exactly which ones did and didn't, never
//      silently treated as success.
//
// There is no flag or code path that accepts inline SQL text as "the
// migration" — the only input is a file (or ordered set of files) that must
// already be committed to git and hash-approved.
//
// MULTI-MIGRATION SUPPORT (this addition): a release plan may set EITHER
// the original singular `migration: {relPath, approvedSha256}` block
// (unchanged, still fully supported) OR a new plural `migrations: [{relPath,
// approvedSha256}, ...]` array for an ordered set approved together as one
// release — never both on the same plan. lib/release-plan.mjs validates the
// array form strictly at load time (every entry needs a timestamp-prefixed
// supabase/migrations/*.sql relPath, no path traversal, no duplicate
// filename, no duplicate migration timestamp) and this script's runMigrate()
// operates on one normalized, ordered array regardless of which shape the
// plan used — there is no branch anywhere below on "was this the singular
// or plural form".
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
import { loadReleasePlan, assertHeadMatchesPlan, normalizeMigrations } from "./lib/release-plan.mjs";

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
 * Returns the set of migration filenames it believes would be applied, in
 * the ORDER they appear in the CLI's own output (a JS Set iterates in
 * insertion order, so `[...parsePendingMigrations(out)]` is a genuinely
 * ordered array, not just a bag of names — the multi-migration guard below
 * relies on that to check exact order, not just exact membership), or
 * throws if the output can't be confidently interpreted.
 *
 * Verified against real `supabase db push --dry-run` output (CLI 2.107.0,
 * against a local disposable stack — see docs/prod-release-runbook.md's
 * "Demo/dry-run parser rehearsal"): a pending migration renders as
 * ` • <filename>.sql` under "Would push these migrations:"; nothing pending
 * renders as the literal line "Local database is up to date." with no
 * filename at all. Both are handled explicitly below, rather than lumping
 * "nothing found" into one generic, less actionable error — UNLESS
 * `allowEmptyAsUpToDate` is set, in which case "up to date" returns an
 * empty set instead of throwing. That flag exists for exactly one caller:
 * the POST-APPLY verification below, where "nothing left pending" is the
 * successful, expected outcome, not an error — every PRE-apply caller
 * leaves it at the default (false), where an unexpectedly-empty dry-run
 * before anything has been applied yet is correctly still a hard failure
 * (see the original incident this distinction is rooted in: a silently
 * already-applied migration must never be waved through as "nothing to
 * check"). Exported so tests/prod-guards.test.ts and
 * tests/prod-multi-migration.test.ts can exercise it directly against
 * those exact captured strings. */
export function parsePendingMigrations(dryRunOutput, { allowEmptyAsUpToDate = false } = {}) {
  const filenamePattern = /\b(\d{14}_[\w-]+\.sql)\b/g;
  const found = new Set();
  for (const match of dryRunOutput.matchAll(filenamePattern)) found.add(match[1]);
  if (found.size === 0) {
    if (/up to date/i.test(dryRunOutput)) {
      if (allowEmptyAsUpToDate) return found;
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

/** Parses `supabase migration list --db-url ...` output and returns the set
 * of migration timestamps that show as APPLIED REMOTELY — i.e. whose
 * "Remote" column is non-blank and equals the "Local" column.
 *
 * Verified against real output (CLI 2.107.0, local disposable stack): a
 * three-column table, header `Local | Remote | Time (UTC)`, a dashed
 * separator row, then one data row per migration:
 *   `   20260822130000 | 20260822130000 | 2026-08-22 13:00:00 `
 * A migration that is tracked locally but NOT yet applied remotely renders
 * with a BLANK Remote column instead of a repeated timestamp — confirmed by
 * directly deleting a row from supabase_migrations.schema_migrations on a
 * local disposable stack and re-running the real CLI command, not guessed:
 *   `   20260823100000 |                | 2026-08-23 10:00:00 `
 * The header and separator rows are naturally excluded since neither
 * "Local"/"Remote"/dashes match \d{14}. */
export function parseAppliedRemoteTimestamps(migrationListOutput) {
  const rowPattern = /^\s*(\d{14})\s*\|\s*(\d{14})?\s*\|/gm;
  const applied = new Set();
  for (const match of migrationListOutput.matchAll(rowPattern)) {
    const [, local, remote] = match;
    if (remote && remote === local) applied.add(local);
  }
  return applied;
}

/** Runs the full guard chain (human confirmation, git remote, HEAD-matches-
 * plan, project ref, db-url, per-migration hash checks, dry-run + exact
 * ordered-set match) and, depending on `mode`, either stops after a clean
 * dry-run (`"check"`) or goes on to perform the real apply (`"apply"`) —
 * for an ORDERED SET of one or more migrations, drawn from either the
 * plan's original singular `migration` block or its new plural `migrations`
 * array (see lib/release-plan.mjs's normalizeMigrations — this function
 * never branches on which shape the plan used past that one call). Every
 * dependency that would otherwise touch the network is injectable
 * (defaulting to the real implementation) specifically so tests can
 * exercise this exact function — mode dispatch, guard ordering, "check
 * never applies", partial-apply detection — without live Supabase
 * credentials. Never skips a guard for either mode: "apply" always re-runs
 * everything from scratch rather than trusting a prior "check". */
export async function runMigrate({
  plan,
  mode,
  runCli = runCliMasked,
  checkProjectRef = assertProjectRefKnownToCli,
}) {
  if (mode !== "check" && mode !== "apply") {
    throw new Error(`runMigrate: mode must be "check" or "apply", got ${JSON.stringify(mode)}`);
  }
  const migrations = normalizeMigrations(plan);
  if (migrations.length === 0) {
    throw new Error("Release plan has no migration/migrations block — nothing for this script to do");
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

  // PART 1 — hash-approve every migration, in the plan's own order, before
  // touching anything else. A hash mismatch on ANY one file — first, last,
  // or in the middle — stops the whole release here; nothing downstream has
  // run yet for any migration, approved or not.
  const results = migrations.map((m) => {
    const actualSha256 = assertMigrationApproved({
      commit: plan.approved_git_sha,
      relPath: m.relPath,
      approvedSha256: m.approvedSha256,
    });
    pass(LABEL, `${m.relPath} pristine git-blob SHA256 matches approved hash (${actualSha256})`);
    const filename = path.basename(m.relPath);
    const timestamp = filename.match(/^(\d{14})_/)?.[1] ?? null;
    return { relPath: m.relPath, filename, timestamp, approvedSha256: m.approvedSha256, actualSha256 };
  });
  const expectedFilenames = results.map((r) => r.filename);

  // PART 2 — dry-run must show EXACTLY this set, in EXACTLY this order: not
  // fewer (a missing approved migration), not more (an unreviewed one
  // snuck in), not reordered (Supabase applies migrations in filename/
  // timestamp order, so a reordered dry-run means the plan's own order
  // doesn't match reality and needs re-review, not a silent reorder here).
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
  const pendingOrdered = [...parsePendingMigrations(dryRun.stdout + "\n" + (dryRun.stderr ?? ""))];
  if (pendingOrdered.length !== expectedFilenames.length) {
    throw new Error(
      `Expected exactly ${expectedFilenames.length} pending migration(s) (${expectedFilenames.join(", ")}), ` +
        `dry-run shows ${pendingOrdered.length}: ${pendingOrdered.join(", ")}. ` +
        "Refusing — the approved set must match pending reality exactly, no more and no fewer.",
    );
  }
  for (let i = 0; i < expectedFilenames.length; i++) {
    const expected = expectedFilenames[i];
    const actual = pendingOrdered[i];
    if (actual !== expected && !actual.includes(expected)) {
      throw new Error(
        `Pending migration order/name mismatch at position ${i + 1}: expected "${expected}", ` +
          `dry-run shows "${actual}". Refusing to apply an unreviewed or misordered migration set.`,
      );
    }
  }
  pass(
    LABEL,
    `dry-run confirms exactly the approved ${expectedFilenames.length} migration(s), in the approved order`,
  );

  if (mode === "check") {
    pass(
      LABEL,
      "check mode: every guard passed and the dry-run confirms exactly the approved migration set " +
        "is pending, in order — nothing was applied",
    );
    return { applied: false, migrations: results };
  }

  // PART 3 — the real apply. One native, ordered `supabase db push --yes`
  // call for the whole approved set — never a loop of ad-hoc per-migration
  // SQL execution. Every migration file itself is already committed,
  // reviewed, and hash-verified; `db push` is the same trusted, transactional
  // apply mechanism used for a single migration, just given more than one
  // file to apply in its own natural (filename-ordered) sequence this time.
  log(LABEL, `Applying ${expectedFilenames.length} migration(s) for real: \`supabase db push\` ...`);
  // --yes here is the Supabase CLI's own flag ("answer yes to all
  // prompts") — NOT a substitute for this script's own --yes mode above.
  // Discovered while rehearsing this against a local disposable stack: a
  // plain `db push` without it renders an interactive [Y/n] confirmation,
  // which would hang forever in this script's non-TTY child process. By
  // this point every safety gate above has already passed (hash match,
  // exact-set-and-order dry-run check, human_confirmation, this script's
  // own --yes mode) — the CLI's own prompt would be redundant, not a
  // missing safety check.
  const applied = await runCli("supabase", ["db", "push", "--db-url", url, "--yes"], {
    maxBuffer: 10 * 1024 * 1024,
    shell: true,
  });
  process.stdout.write(applied.stdout);
  if (applied.stderr?.trim()) log(LABEL, `stderr: ${applied.stderr.trim()}`);

  // PART 4 — post-apply verification, from scratch, trusting nothing about
  // the apply call's own reported success. A partial apply (some but not
  // all approved migrations actually recorded remotely) is a release
  // failure, reported clearly with exactly which migrations did and didn't
  // make it — never silently treated as success because the CLI process
  // itself exited 0.
  log(LABEL, "Verifying remote migration history post-apply ...");
  const postDryRun = await runCli("supabase", ["db", "push", "--db-url", url, "--dry-run"], {
    maxBuffer: 10 * 1024 * 1024,
    shell: true,
  });
  const stillPending = [
    ...parsePendingMigrations(postDryRun.stdout + "\n" + (postDryRun.stderr ?? ""), {
      allowEmptyAsUpToDate: true,
    }),
  ];
  const migrationList = await runCli("supabase", ["migration", "list", "--db-url", url], {
    maxBuffer: 10 * 1024 * 1024,
    shell: true,
  });
  const appliedRemotely = parseAppliedRemoteTimestamps(
    migrationList.stdout + "\n" + (migrationList.stderr ?? ""),
  );

  const partial = [];
  for (const r of results) {
    const stillPendingHere = stillPending.some((f) => f === r.filename || f.includes(r.filename));
    const recordedRemotely = r.timestamp !== null && appliedRemotely.has(r.timestamp);
    r.recordedRemotely = recordedRemotely;
    if (stillPendingHere || !recordedRemotely) {
      partial.push(r.relPath);
    } else {
      pass(LABEL, `${r.relPath} recorded as applied remotely (timestamp ${r.timestamp})`);
    }
  }
  if (partial.length > 0) {
    throw new Error(
      `PARTIAL APPLY DETECTED — release failure. ${partial.length} of ${results.length} approved ` +
        `migration(s) did not verify as applied remotely after \`supabase db push --yes\` reported ` +
        `success: ${partial.join(", ")}. Do not re-run blindly — inspect production's actual migration ` +
        "history (`supabase migration list`) before deciding how to recover.",
    );
  }
  if (stillPending.length > 0) {
    throw new Error(
      `PARTIAL/UNEXPECTED STATE DETECTED — release failure. ${stillPending.length} migration(s) still ` +
        `show pending after apply, including possibly unrelated ones: ${stillPending.join(", ")}. ` +
        "Expected a fully up-to-date target after applying the whole approved set.",
    );
  }
  pass(LABEL, "post-apply verification: every approved migration is recorded remotely, none pending");
  pass(LABEL, `migration set applied: ${results.map((r) => r.relPath).join(", ")}`);
  return { applied: true, migrations: results };
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
