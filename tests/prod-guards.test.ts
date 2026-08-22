// Tests for scripts/prod/lib/*.mjs — the guard logic behind the production
// automation toolkit (see docs/prod-release-runbook.md). Every test here
// runs against LOCAL git history and LOCAL fixture files only — nothing
// touches Supabase, SSH, or any real production target. This is
// deliberate: these guards are what stand between an approved release and
// an unreviewed one, so they need to be provably correct without ever
// needing production access to test them. One exception, clearly marked
// where it appears below: a single test in the
// "execStatementViaSupabaseCli" block makes a real, fast-failing
// connection attempt to a deliberately invalid hostname (never a real
// Supabase target) specifically to prove a real incident's fix (a
// multi-line SQL statement no longer hangs when passed to the real
// `supabase` CLI) — a fake/injected executor can't prove that, only an
// actual child-process invocation can.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  GuardError,
  loadProductionConfig,
  assertHumanConfirmed,
  maskConnectionString,
  extractProjectRefFromDbUrl,
  resolveProductionDbUrl,
  gitBlobSha256,
  assertCommitExists,
  assertMigrationApproved,
  assertReadOnlySqlFile,
  assertGitRemoteMatches,
  redactSecretsFromText,
  runCliMasked,
  REPO_ROOT,
} from "../scripts/prod/lib/guard.mjs";
import { loadReleasePlan } from "../scripts/prod/lib/release-plan.mjs";
import { parsePendingMigrations, resolveMode, runMigrate } from "../scripts/prod/supabase-migrate.mjs";
import {
  splitSqlStatements,
  assertStatementReadOnly,
  runReadOnlySqlStatements,
  execStatementViaSupabaseCli,
} from "../scripts/prod/lib/sql-runner.mjs";

// A real, already-merged migration from this repo's own history — reviewed
// and merged earlier in this project (see git log). Its SHA256 was computed
// and verified independently against the merged origin/main blob, so it's a
// trustworthy known-good fixture for the hash-comparison guard.
const KNOWN_COMMIT = "880ec7ec70969541d5cfb279a09750a81666c31d";
const KNOWN_MIGRATION_PATH =
  "supabase/migrations/20260821120000_ar_credit_note_receipt_reversal.sql";
const KNOWN_MIGRATION_SHA256 = "a1520c2d6fcf4b589ccee2ddb284c45430ba658e486479d93b162c125c821135";

function commitExistsLocally(sha: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: REPO_ROOT });
    return true;
  } catch {
    return false;
  }
}

describe("loadProductionConfig", () => {
  it("loads the real production.config.json with every required field", () => {
    const config = loadProductionConfig();
    expect(config.github_repo).toBe("allprojex/hotelms");
    expect(config.supabase_project_ref).toMatch(/^[a-z0-9]+$/);
    expect(typeof config.human_confirmation.confirmed).toBe("boolean");
  });

  it("throws on a config missing a required field", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "prod-guard-test-"));
    const badConfigPath = path.join(dir, "bad.json");
    writeFileSync(badConfigPath, JSON.stringify({ github_repo: "x/y" }));
    expect(() => loadProductionConfig(badConfigPath)).toThrow(GuardError);
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws on a config with a placeholder-looking project ref", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "prod-guard-test-"));
    const badConfigPath = path.join(dir, "bad.json");
    writeFileSync(
      badConfigPath,
      JSON.stringify({
        github_repo: "x/y",
        supabase_project_ref: "your-project-ref",
        supabase_project_name_expected: "x",
        production_domain: "x.com",
        vps_app_path: "/opt/x",
        systemd_service: "x",
        ssh_host_alias: "x",
        human_confirmation: { confirmed: false },
      }),
    );
    expect(() => loadProductionConfig(badConfigPath)).toThrow(/placeholder/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("assertHumanConfirmed", () => {
  it("throws when confirmed is false", () => {
    expect(() => assertHumanConfirmed({ human_confirmation: { confirmed: false } })).toThrow(
      GuardError,
    );
  });
  it("passes when confirmed is true", () => {
    expect(() => assertHumanConfirmed({ human_confirmation: { confirmed: true } })).not.toThrow();
  });
});

describe("maskConnectionString", () => {
  it("redacts the password but keeps the host visible", () => {
    const masked = maskConnectionString(
      "postgresql://postgres:supersecret@db.abcxyz.supabase.co:5432/postgres",
    );
    expect(masked).not.toContain("supersecret");
    expect(masked).toContain("db.abcxyz.supabase.co");
  });
});

describe("redactSecretsFromText / runCliMasked — regression test for a real incident (2026-08-22)", () => {
  // Real incident: `supabase db query --db-url <url> ...` failed (DNS
  // resolution error) and the CLI itself echoed the full, unredacted
  // command line — including the plaintext password — into its own error
  // output, which this toolkit's error handling then logged verbatim. Every
  // execFile* call in the four supabase-*.mjs scripts that can touch
  // PROD_SUPABASE_DB_URL was moved to runCliMasked() specifically because
  // of this. These tests reproduce the exact shape of that failure using a
  // throwaway fake credential (never a real one) and a plain `node -e`
  // child process standing in for the `supabase` CLI, so this is a genuine
  // exercise of the child-process error path, not just the regex in
  // isolation.
  const FAKE_URL =
    "postgresql://postgres:FAKESECRET_do_not_use@db.example.supabase.co:5432/postgres";

  it("redactSecretsFromText scrubs a postgres URL out of arbitrary text", () => {
    const text = `Command failed: supabase db query --db-url ${FAKE_URL} --file x.sql\nhostname resolving error`;
    const scrubbed = redactSecretsFromText(text);
    expect(scrubbed).not.toContain("FAKESECRET_do_not_use");
    expect(scrubbed).not.toContain(FAKE_URL);
    expect(scrubbed).toContain("hostname resolving error");
  });

  it("redactSecretsFromText scrubs a pooler-form connection string (user postgres.<ref>) the same way as the direct form", () => {
    const poolerUrl =
      "postgresql://postgres.texhuavnrdhaohqzlyqw:FAKESECRET_pooler@aws-0-eu-west-1.pooler.supabase.com:6543/postgres";
    const scrubbed = redactSecretsFromText(`error connecting: ${poolerUrl}`);
    expect(scrubbed).not.toContain("FAKESECRET_pooler");
    expect(scrubbed).not.toContain(poolerUrl);
  });

  it("redactSecretsFromText scrubs a bearer token", () => {
    const scrubbed = redactSecretsFromText(
      "Authorization: Bearer sbp_fake1234567890abcdefFAKETOKEN",
    );
    expect(scrubbed).not.toContain("sbp_fake1234567890abcdefFAKETOKEN");
    expect(scrubbed).toContain("Bearer ***REDACTED***");
  });

  it("redactSecretsFromText scrubs generic token/secret/password-shaped assignments (defense in depth, even outside connection strings)", () => {
    const scrubbed = redactSecretsFromText(
      "SUPABASE_ACCESS_TOKEN=sbp_fake_leaked_value_here and password: hunter2fake",
    );
    expect(scrubbed).not.toContain("sbp_fake_leaked_value_here");
    expect(scrubbed).not.toContain("hunter2fake");
  });

  it("redactSecretsFromText leaves ordinary non-secret text untouched", () => {
    const text =
      "Applying migration 20260821120000_ar_credit_note_receipt_reversal.sql...\nFinished supabase db push.";
    expect(redactSecretsFromText(text)).toBe(text);
  });

  it("runCliMasked scrubs the credential from a real child-process failure that echoes its own argv (reproduces the actual incident shape)", async () => {
    await expect(
      runCliMasked("node", [
        "-e",
        "process.stderr.write('Command failed: supabase db query --db-url ' + process.argv[1]); process.exit(1);",
        FAKE_URL,
      ]),
    ).rejects.toMatchObject({
      message: expect.not.stringContaining("FAKESECRET_do_not_use"),
    });
  });

  it("runCliMasked's rejected error also has stdout/stderr redacted, not just .message", async () => {
    try {
      await runCliMasked("node", [
        "-e",
        "process.stderr.write('leaked: ' + process.argv[1]); process.exit(3);",
        FAKE_URL,
      ]);
      expect.unreachable("expected runCliMasked to throw");
    } catch (e) {
      const err = e as Error & { stderr?: string };
      expect(err.message).not.toContain("FAKESECRET_do_not_use");
      expect(err.stderr ?? "").not.toContain("FAKESECRET_do_not_use");
    }
  });

  it("runCliMasked redacts stdout/stderr on the success path too (defense in depth)", async () => {
    const { stdout } = await runCliMasked("node", [
      "-e",
      "process.stdout.write('connecting to ' + process.argv[1]);",
      FAKE_URL,
    ]);
    expect(stdout).not.toContain("FAKESECRET_do_not_use");
  });
});

describe("extractProjectRefFromDbUrl", () => {
  it("extracts the ref from a direct connection URL", () => {
    expect(
      extractProjectRefFromDbUrl("postgresql://postgres:pw@db.abcxyz123.supabase.co:5432/postgres"),
    ).toBe("abcxyz123");
  });
  it("extracts the ref from a pooler connection URL", () => {
    expect(
      extractProjectRefFromDbUrl(
        "postgresql://postgres.abcxyz123:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres",
      ),
    ).toBe("abcxyz123");
  });
  it("throws on a host that isn't a recognizable Supabase pattern", () => {
    expect(() =>
      extractProjectRefFromDbUrl("postgresql://user:pw@evil.example.com:5432/db"),
    ).toThrow(GuardError);
  });
});

describe("resolveProductionDbUrl", () => {
  const config = { supabase_project_ref: "texhuavnrdhaohqzlyqw" };
  const ORIGINAL = process.env.PROD_SUPABASE_DB_URL;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PROD_SUPABASE_DB_URL;
    else process.env.PROD_SUPABASE_DB_URL = ORIGINAL;
  });

  it("throws when the env var is not set", () => {
    delete process.env.PROD_SUPABASE_DB_URL;
    expect(() => resolveProductionDbUrl(config)).toThrow(/not set/);
  });

  it("throws when the ref in the URL doesn't match config", () => {
    process.env.PROD_SUPABASE_DB_URL =
      "postgresql://postgres:pw@db.wrongref.supabase.co:5432/postgres";
    expect(() => resolveProductionDbUrl(config)).toThrow(/unexpected project/);
  });

  it("passes and masks the URL when the ref matches", () => {
    process.env.PROD_SUPABASE_DB_URL =
      "postgresql://postgres:pw@db.texhuavnrdhaohqzlyqw.supabase.co:5432/postgres";
    const { masked } = resolveProductionDbUrl(config);
    expect(masked).not.toContain(":pw@");
  });
});

describe("git-based migration approval guard (real repo history, no network)", () => {
  it("assertCommitExists passes for a real commit and throws for a fake one", () => {
    if (!commitExistsLocally(KNOWN_COMMIT)) {
      // Environment doesn't have this commit fetched locally — skip rather
      // than fail, since this is a local-history availability issue, not a
      // guard-logic bug.
      return;
    }
    expect(() => assertCommitExists(KNOWN_COMMIT)).not.toThrow();
    expect(() => assertCommitExists("0000000000000000000000000000000000000000")).toThrow(
      GuardError,
    );
  });

  it("gitBlobSha256 matches the independently-verified hash for a real merged migration", () => {
    if (!commitExistsLocally(KNOWN_COMMIT)) return;
    expect(gitBlobSha256(KNOWN_COMMIT, KNOWN_MIGRATION_PATH)).toBe(KNOWN_MIGRATION_SHA256);
  });

  it("assertMigrationApproved passes when the hash matches", () => {
    if (!commitExistsLocally(KNOWN_COMMIT)) return;
    expect(() =>
      assertMigrationApproved({
        commit: KNOWN_COMMIT,
        relPath: KNOWN_MIGRATION_PATH,
        approvedSha256: KNOWN_MIGRATION_SHA256,
      }),
    ).not.toThrow();
  });

  it("assertMigrationApproved throws on a tampered/wrong approved hash", () => {
    if (!commitExistsLocally(KNOWN_COMMIT)) return;
    expect(() =>
      assertMigrationApproved({
        commit: KNOWN_COMMIT,
        relPath: KNOWN_MIGRATION_PATH,
        approvedSha256: "0".repeat(64),
      }),
    ).toThrow(/SHA256 mismatch/);
  });

  it("assertMigrationApproved throws on a path outside supabase/migrations", () => {
    if (!commitExistsLocally(KNOWN_COMMIT)) return;
    expect(() =>
      assertMigrationApproved({
        commit: KNOWN_COMMIT,
        relPath: "scripts/prod-release.sh",
        approvedSha256: "0".repeat(64),
      }),
    ).toThrow(/does not look like a migration path/);
  });

  it("assertMigrationApproved throws when the path was never tracked at that commit", () => {
    if (!commitExistsLocally(KNOWN_COMMIT)) return;
    expect(() =>
      assertMigrationApproved({
        commit: KNOWN_COMMIT,
        relPath: "supabase/migrations/00000000000000_never_existed.sql",
        approvedSha256: "0".repeat(64),
      }),
    ).toThrow();
  });
});

describe("assertReadOnlySqlFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "prod-guard-sql-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes a genuinely read-only SELECT-only file", () => {
    const p = path.join(dir, "ok.sql");
    writeFileSync(
      p,
      "SELECT id FROM public.ar_invoices WHERE amount_paid < 0;\n-- INSERT mentioned only in a comment\n",
    );
    expect(() => assertReadOnlySqlFile(p)).not.toThrow();
  });

  it("rejects a file containing a real INSERT statement", () => {
    const p = path.join(dir, "bad.sql");
    writeFileSync(p, "INSERT INTO public.ar_invoices (id) VALUES ('x');\n");
    expect(() => assertReadOnlySqlFile(p)).toThrow(/non-read-only keyword/);
  });

  it("rejects a file containing DROP TABLE", () => {
    const p = path.join(dir, "bad2.sql");
    writeFileSync(p, "SELECT 1;\nDROP TABLE public.ar_invoices;\n");
    expect(() => assertReadOnlySqlFile(p)).toThrow(GuardError);
  });

  it("the repo's own existing preflight file passes as read-only", () => {
    const existing = path.join(
      REPO_ROOT,
      "supabase/preflight/20260807_ar_ap_payment_integrity_preflight.sql",
    );
    expect(() => assertReadOnlySqlFile(existing)).not.toThrow();
  });
});

describe("assertGitRemoteMatches", () => {
  it("passes for the real configured repo", () => {
    const config = loadProductionConfig();
    expect(() => assertGitRemoteMatches(config)).not.toThrow();
  });
  it("throws for a mismatched expected repo", () => {
    expect(() => assertGitRemoteMatches({ github_repo: "someone/else" })).toThrow(GuardError);
  });
});

describe("loadReleasePlan", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "prod-guard-plan-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writePlan(obj: unknown): string {
    const p = path.join(dir, "plan.json");
    writeFileSync(p, JSON.stringify(obj));
    return p;
  }

  it("throws when no path is given", () => {
    expect(() => loadReleasePlan(undefined as unknown as string)).toThrow(GuardError);
  });

  it("throws when approved_git_sha isn't a 40-char hex sha", () => {
    const p = writePlan({ release_id: "r1", operator: "a", approved_git_sha: "not-a-sha" });
    expect(() => loadReleasePlan(p)).toThrow(/approved_git_sha/);
  });

  it("throws when migration.approvedSha256 is malformed", () => {
    const p = writePlan({
      release_id: "r1",
      operator: "a",
      approved_git_sha: "a".repeat(40),
      migration: { relPath: "supabase/migrations/x.sql", approvedSha256: "short" },
    });
    expect(() => loadReleasePlan(p)).toThrow(/approvedSha256/);
  });

  it("throws when @prod-write is requested without authorize_write_tests", () => {
    const p = writePlan({
      release_id: "r1",
      operator: "a",
      approved_git_sha: "a".repeat(40),
      ui_smoke: { tags: ["@prod-write"], authorize_write_tests: false },
    });
    expect(() => loadReleasePlan(p)).toThrow(/authorize_write_tests/);
  });

  it("throws when @prod-financial is requested without authorize_financial_tests", () => {
    const p = writePlan({
      release_id: "r1",
      operator: "a",
      approved_git_sha: "a".repeat(40),
      ui_smoke: { tags: ["@prod-financial"], authorize_financial_tests: false },
    });
    expect(() => loadReleasePlan(p)).toThrow(/authorize_financial_tests/);
  });

  it("throws on an unknown ui_smoke tag", () => {
    const p = writePlan({
      release_id: "r1",
      operator: "a",
      approved_git_sha: "a".repeat(40),
      ui_smoke: { tags: ["@totally-made-up"] },
    });
    expect(() => loadReleasePlan(p)).toThrow(/unknown tag/);
  });

  it("loads a fully valid plan cleanly", () => {
    const p = writePlan({
      release_id: "2026-08-21-example",
      operator: "tester",
      approved_git_sha: "a".repeat(40),
      migration: { relPath: "supabase/migrations/x.sql", approvedSha256: "b".repeat(64) },
      ui_smoke: { tags: ["@prod-readonly"] },
    });
    const { plan } = loadReleasePlan(p);
    expect(plan.release_id).toBe("2026-08-21-example");
  });

  it("the shipped release-plan.example.json fails validation on its placeholder zeros (by design — it must be filled in before use)", () => {
    const examplePath = path.join(REPO_ROOT, "scripts/prod/release-plan.example.json");
    expect(() => loadReleasePlan(examplePath)).toThrow();
  });
});

describe("parsePendingMigrations — verified against real `supabase db push --dry-run` output (CLI 2.107.0, captured against a local disposable stack on 2026-08-21, see docs/prod-release-runbook.md)", () => {
  it("parses the exactly-one-pending case", () => {
    const realOutput = [
      "DRY RUN: migrations will *not* be pushed to the database.",
      "Connecting to local database...",
      "Would push these migrations:",
      " • 20260821120000_ar_credit_note_receipt_reversal.sql",
      "Finished supabase db push.",
      "",
    ].join("\n");
    const pending = parsePendingMigrations(realOutput);
    expect(pending.size).toBe(1);
    expect(pending.has("20260821120000_ar_credit_note_receipt_reversal.sql")).toBe(true);
  });

  it("throws a specific, actionable error on the nothing-pending ('up to date') case, not the generic parse-failure message", () => {
    const realOutput = [
      "DRY RUN: migrations will *not* be pushed to the database.",
      "Connecting to local database...",
      "Local database is up to date.",
      "",
    ].join("\n");
    expect(() => parsePendingMigrations(realOutput)).toThrow(/already up to date/);
  });

  it("throws the generic (still fail-closed) message for genuinely unrecognizable output", () => {
    expect(() =>
      parsePendingMigrations("some totally unexpected CLI output with no filenames"),
    ).toThrow(/Could not identify any pending migration filename/);
  });

  it("still finds the filename even with surrounding noise (stderr concatenated, warnings, version-nag lines)", () => {
    const realOutput = [
      "DRY RUN: migrations will *not* be pushed to the database.",
      "Connecting to local database...",
      "Would push these migrations:",
      " • 20260821120000_ar_credit_note_receipt_reversal.sql",
      "Finished supabase db push.",
      "A new version of Supabase CLI is available: v2.115.0 (currently installed v2.107.0)",
      "We recommend updating regularly for new features and bug fixes: https://supabase.com/docs/guides/cli/getting-started#updating-the-supabase-cli",
    ].join("\n");
    const pending = parsePendingMigrations(realOutput);
    expect(pending.size).toBe(1);
  });
});

describe("resolveMode — pure argv-shape decision, no I/O", () => {
  it("throws when neither --check nor --yes is given", () => {
    expect(() => resolveMode({})).toThrow(/Specify exactly one mode/);
  });
  it("throws when both --check and --yes are given", () => {
    expect(() => resolveMode({ check: true, yes: true })).toThrow(/only one of --check or --yes/);
  });
  it("resolves to 'check' for --check alone", () => {
    expect(resolveMode({ check: true })).toBe("check");
  });
  it("resolves to 'apply' for --yes alone", () => {
    expect(resolveMode({ yes: true })).toBe("apply");
  });
});

describe("runMigrate — real incident fix regression (2026-08-22): a real --check/--yes mode split so a clean checkpoint is a real, successful exit rather than a deliberate failure the orchestrator has to treat as expected", () => {
  const ORIGINAL_URL = process.env.PROD_SUPABASE_DB_URL;
  const FAKE_DB_URL =
    "postgresql://postgres.texhuavnrdhaohqzlyqw:FAKESECRET_migrate_test@aws-0-eu-west-1.pooler.supabase.com:6543/postgres";

  beforeEach(() => {
    process.env.PROD_SUPABASE_DB_URL = FAKE_DB_URL;
  });
  afterEach(() => {
    if (ORIGINAL_URL === undefined) delete process.env.PROD_SUPABASE_DB_URL;
    else process.env.PROD_SUPABASE_DB_URL = ORIGINAL_URL;
  });

  // A real, currently-tracked migration at the current checked-out HEAD —
  // computed dynamically (never hardcoded) so this fixture stays correct
  // regardless of which commit is actually checked out when the suite
  // runs, exactly mirroring how a real release plan is built from a real
  // approved commit.
  function buildRealPlan() {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    const relPath = "supabase/migrations/20260822120000_ap_posting_reversal_hardening.sql";
    const approvedSha256 = gitBlobSha256(head, relPath);
    return {
      release_id: "test-release",
      operator: "test",
      approved_git_sha: head,
      migration: { relPath, approvedSha256 },
    };
  }

  const noOpProjectRefCheck = async () => {};

  function fakeRunCli({ pendingFilename, applyShouldFail = false } = {}) {
    const calls: { cmd: string; args: string[] }[] = [];
    const fn = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (args.includes("--dry-run")) {
        return {
          stdout: [
            "DRY RUN: migrations will *not* be pushed to the database.",
            "Connecting to remote database...",
            "Would push these migrations:",
            ` • ${pendingFilename}`,
            "Finished supabase db push.",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (args.includes("--yes")) {
        if (applyShouldFail) throw new Error("simulated apply failure — not a real DB write");
        return { stdout: "Finished supabase db push.\n", stderr: "" };
      }
      throw new Error(`fakeRunCli: unexpected args ${JSON.stringify(args)}`);
    };
    return { fn, calls };
  }

  it("check mode: passes cleanly and returns applied:false when the dry-run shows exactly the approved migration pending", async () => {
    const plan = buildRealPlan();
    const { fn, calls } = fakeRunCli({
      pendingFilename: "20260822120000_ap_posting_reversal_hardening.sql",
    });
    const result = await runMigrate({
      plan,
      mode: "check",
      runCli: fn,
      checkProjectRef: noOpProjectRefCheck,
    });
    expect(result.applied).toBe(false);
    // Only the dry-run call happened — never an apply.
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain("--dry-run");
  });

  it("check mode never invokes the real apply args (no --yes in any runCli call it makes)", async () => {
    const plan = buildRealPlan();
    const { fn, calls } = fakeRunCli({
      pendingFilename: "20260822120000_ap_posting_reversal_hardening.sql",
    });
    await runMigrate({ plan, mode: "check", runCli: fn, checkProjectRef: noOpProjectRefCheck });
    expect(calls.some((c) => c.args.includes("--yes"))).toBe(false);
  });

  it("apply mode (--yes) re-runs the guard chain and then performs the real apply call", async () => {
    const plan = buildRealPlan();
    const { fn, calls } = fakeRunCli({
      pendingFilename: "20260822120000_ap_posting_reversal_hardening.sql",
    });
    const result = await runMigrate({
      plan,
      mode: "apply",
      runCli: fn,
      checkProjectRef: noOpProjectRefCheck,
    });
    expect(result.applied).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toContain("--dry-run");
    expect(calls[1].args).toContain("--yes");
  });

  it("apply mode still fails closed if the dry-run shows more than one pending migration, and never reaches the apply call", async () => {
    const plan = buildRealPlan();
    const { fn, calls } = fakeRunCli({ pendingFilename: "unused" });
    const twoPending: typeof fn = async (cmd, args) => {
      if (args.includes("--dry-run")) {
        return {
          stdout:
            "Would push these migrations:\n" +
            " • 20260822120000_ap_posting_reversal_hardening.sql\n" +
            " • 20260901000000_unrelated_future_migration.sql\n",
          stderr: "",
        };
      }
      return fn(cmd, args);
    };
    await expect(
      runMigrate({ plan, mode: "apply", runCli: twoPending, checkProjectRef: noOpProjectRefCheck }),
    ).rejects.toThrow(/Expected exactly 1 pending migration/);
    expect(calls).toHaveLength(0);
  });

  it("apply mode fails closed if the pending migration doesn't match the approved filename", async () => {
    const plan = buildRealPlan();
    const { fn } = fakeRunCli({ pendingFilename: "20260901000000_some_other_migration.sql" });
    await expect(
      runMigrate({ plan, mode: "apply", runCli: fn, checkProjectRef: noOpProjectRefCheck }),
    ).rejects.toThrow(/does not match the approved migration/);
  });

  it("a real apply failure (stage 03's own failure case) propagates as a rejection, not a silent success", async () => {
    const plan = buildRealPlan();
    const { fn } = fakeRunCli({
      pendingFilename: "20260822120000_ap_posting_reversal_hardening.sql",
      applyShouldFail: true,
    });
    await expect(
      runMigrate({ plan, mode: "apply", runCli: fn, checkProjectRef: noOpProjectRefCheck }),
    ).rejects.toThrow(/simulated apply failure/);
  });

  it("runMigrate requires mode to be exactly 'check' or 'apply' — never silently defaults", async () => {
    const plan = buildRealPlan();
    await expect(
      runMigrate({ plan, mode: "yolo" as never, checkProjectRef: noOpProjectRefCheck }),
    ).rejects.toThrow(/mode must be "check" or "apply"/);
  });

  it("no thrown error from a failed apply leaks the fake production credential", async () => {
    const plan = buildRealPlan();
    const { fn } = fakeRunCli({
      pendingFilename: "20260822120000_ap_posting_reversal_hardening.sql",
      applyShouldFail: true,
    });
    try {
      await runMigrate({ plan, mode: "apply", runCli: fn, checkProjectRef: noOpProjectRefCheck });
      expect.unreachable("expected runMigrate to throw");
    } catch (e) {
      const err = e as Error;
      expect(err.message).not.toContain("FAKESECRET_migrate_test");
      expect(err.message).not.toContain(FAKE_DB_URL);
    }
  });
});

describe("preflight/postflight SQL — enum columns must be cast to text for the Supabase CLI's JSON output (real incident, 2026-08-22)", () => {
  // Real incident: the AP hardening release's own postflight file failed
  // in production with "unknown oid ... cannot be scanned into
  // *interface {}" when a statement returned a raw custom-enum column
  // (ap_bills.status) through `supabase db query --output json` — the
  // CLI's JSON decoder has no registered scanner for an arbitrary
  // custom-enum OID. Reproduced live against a local disposable Postgres
  // instance with real enum data, through the real Supabase CLI
  // (2.107.0): the uncast form crashes every time a matching row exists;
  // `status::text` does not, and decodes cleanly. Every preflight/
  // postflight SELECT statement that returns one of this migration's own
  // enum-typed columns (ap_bills.status is `ap_status`, ap_payments.status
  // is the new `ap_payment_status`) must cast it. The preflight file's own
  // two affected statements happened to match zero rows in the actual
  // release run (no void bills, no amount_paid inconsistency existed) —
  // so the bug never fired there, but it is the identical latent defect,
  // fixed proactively here alongside the postflight file rather than left
  // for the next time either WHERE clause actually matches a row.
  const ENUM_COLUMNS = ["status"];

  /** Deliberately conservative, not a real SQL parser — same philosophy as
   * guard.mjs's own WRITE_KEYWORDS scanner (see its doc comment): a false
   * positive just means a human looks at one more line; a false negative
   * would mean this exact incident recurs silently. Finds every
   * `SELECT ... FROM` span in the (comment-stripped) SQL and flags any
   * bare occurrence of an enum column name in that select-list that isn't
   * already cast to ::text/::varchar. */
  function bareEnumSelectExpressions(sql: string): string[] {
    const withoutLineComments = sql.replace(/--[^\n]*/g, "");
    const withoutBlockComments = withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, "");
    const offenders: string[] = [];
    for (const selectMatch of withoutBlockComments.matchAll(/select\s+([\s\S]*?)\sfrom\s/gi)) {
      const selectList = selectMatch[1];
      for (const col of ENUM_COLUMNS) {
        const re = new RegExp(
          `\\b(?:[a-z_][a-z0-9_]*\\.)?${col}\\b(?!\\s*::\\s*(text|varchar))`,
          "gi",
        );
        for (const m of selectList.matchAll(re)) offenders.push(m[0]);
      }
    }
    return offenders;
  }

  it("detector sanity: flags a bare enum column in a SELECT list", () => {
    expect(
      bareEnumSelectExpressions("SELECT status, count(*) FROM public.ap_bills GROUP BY status;"),
    ).toEqual(["status"]);
  });

  it("detector sanity: does not flag a properly cast column", () => {
    expect(
      bareEnumSelectExpressions(
        "SELECT status::text, count(*) FROM public.ap_bills GROUP BY status;",
      ),
    ).toEqual([]);
  });

  it("detector sanity: does not flag a table-qualified but properly cast column", () => {
    expect(bareEnumSelectExpressions("SELECT b.status::text FROM public.ap_bills b;")).toEqual([]);
  });

  it("detector sanity: does not flag the column name when it only appears in a WHERE clause (outside any SELECT list)", () => {
    expect(
      bareEnumSelectExpressions("SELECT count(*) FROM public.ap_bills WHERE status = 'void';"),
    ).toEqual([]);
  });

  it("detector sanity: flags a bare table-qualified occurrence too", () => {
    expect(bareEnumSelectExpressions("SELECT b.status FROM public.ap_bills b;")).toEqual([
      "b.status",
    ]);
  });

  it("the real postflight file has zero bare enum columns left in any SELECT list", () => {
    const sql = readFileSync(
      path.join(
        REPO_ROOT,
        "supabase/postflight/20260822120000_ap_posting_reversal_hardening_postflight.sql",
      ),
      "utf8",
    );
    expect(bareEnumSelectExpressions(sql)).toEqual([]);
  });

  it("the real preflight file has zero bare enum columns left in any SELECT list", () => {
    const sql = readFileSync(
      path.join(
        REPO_ROOT,
        "supabase/preflight/20260822_ap_posting_reversal_hardening_preflight.sql",
      ),
      "utf8",
    );
    expect(bareEnumSelectExpressions(sql)).toEqual([]);
  });

  it("both files still pass the toolkit's own read-only file-content guard after the fix (casting to ::text does not introduce a write/DDL keyword)", () => {
    const postflightPath = path.join(
      REPO_ROOT,
      "supabase/postflight/20260822120000_ap_posting_reversal_hardening_postflight.sql",
    );
    const preflightPath = path.join(
      REPO_ROOT,
      "supabase/preflight/20260822_ap_posting_reversal_hardening_preflight.sql",
    );
    expect(() => assertReadOnlySqlFile(postflightPath)).not.toThrow();
    expect(() => assertReadOnlySqlFile(preflightPath)).not.toThrow();
  });
});

describe("splitSqlStatements — real incident fix (2026-08-22): supabase db query --file rejects multi-statement files at the Postgres protocol level (SQLSTATE 42601), discovered against the real production pooler", () => {
  it("splits two simple SELECT statements", () => {
    const stmts = splitSqlStatements("SELECT 1; SELECT 2;");
    expect(stmts).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("does not split on a semicolon inside a single-quoted string", () => {
    const stmts = splitSqlStatements("SELECT 'a;b' AS x; SELECT 2;");
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toBe("SELECT 'a;b' AS x");
  });

  it("does not split on a semicolon inside a dollar-quoted block (untagged $$ and tagged $tag$)", () => {
    const untagged = splitSqlStatements("SELECT $$a;b$$ AS x; SELECT 2;");
    expect(untagged).toHaveLength(2);
    expect(untagged[0]).toBe("SELECT $$a;b$$ AS x");

    const tagged = splitSqlStatements("SELECT $tag$a;b$tag$ AS x; SELECT 2;");
    expect(tagged).toHaveLength(2);
    expect(tagged[0]).toBe("SELECT $tag$a;b$tag$ AS x");
  });

  it("does not split on a semicolon inside a line comment", () => {
    const stmts = splitSqlStatements("SELECT 1; -- a comment; with a semicolon\nSELECT 2;");
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toBe("SELECT 1");
  });

  it("does not split on a semicolon inside a block comment, including a nested one", () => {
    const stmts = splitSqlStatements("SELECT 1; /* c; omment */ SELECT 2;");
    expect(stmts).toHaveLength(2);

    const nested = splitSqlStatements("SELECT 1; /* outer /* inner; */ still outer; */ SELECT 2;");
    expect(nested).toHaveLength(2);
    expect(nested[1]).toContain("SELECT 2");
  });

  it("drops empty statements produced by repeated/trailing semicolons", () => {
    const stmts = splitSqlStatements("SELECT 1;;;   SELECT 2;");
    expect(stmts).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("drops a comment-only fragment entirely (not a phantom empty statement)", () => {
    const stmts = splitSqlStatements("SELECT 1; -- just a trailing comment, nothing after it\n");
    expect(stmts).toEqual(["SELECT 1"]);
  });

  it("does NOT naive-split(';') — this is the specific case a naive split would get wrong", () => {
    const naive = "SELECT 'a;b;c' AS x; SELECT 'd;e' AS y;".split(";");
    expect(naive.length).not.toBe(2); // proves the naive approach breaks on this input
    const correct = splitSqlStatements("SELECT 'a;b;c' AS x; SELECT 'd;e' AS y;");
    expect(correct).toHaveLength(2);
  });
});

describe("assertStatementReadOnly — per-statement guard, independent of guard.mjs's whole-file check", () => {
  it("passes a genuinely read-only statement", () => {
    expect(() => assertStatementReadOnly("SELECT 1 FROM public.ar_invoices", 1)).not.toThrow();
  });

  it("rejects a write statement hidden after a valid SELECT (by statement position, not just presence anywhere in the file)", () => {
    const stmts = splitSqlStatements("SELECT 1; UPDATE public.ar_invoices SET total = 0;");
    expect(stmts).toHaveLength(2);
    expect(() => assertStatementReadOnly(stmts[0], 1)).not.toThrow();
    expect(() => assertStatementReadOnly(stmts[1], 2)).toThrow(/non-read-only keyword/);
  });

  it("a word like UPDATE/DELETE inside a line comment does not false-trigger", () => {
    const stmts = splitSqlStatements(
      "SELECT 1; -- UPDATE foo SET x=1 (this is just a comment)\nSELECT 2;",
    );
    expect(stmts).toHaveLength(2);
    expect(() => stmts.forEach((s, i) => assertStatementReadOnly(s, i + 1))).not.toThrow();
  });

  it("a word like UPDATE/DELETE inside a block comment does not false-trigger", () => {
    const stmts = splitSqlStatements(
      "SELECT 1; /* DELETE FROM foo -- old approach, kept for reference */ SELECT 2;",
    );
    expect(() => stmts.forEach((s, i) => assertStatementReadOnly(s, i + 1))).not.toThrow();
  });

  it("a word like UPDATE/DELETE inside a string literal does not false-trigger (stricter than the whole-file regex check)", () => {
    expect(() =>
      assertStatementReadOnly("SELECT 'UPDATE via the admin API' AS description", 1),
    ).not.toThrow();
  });

  it("never includes the statement's own SQL text in its error message", () => {
    try {
      assertStatementReadOnly("DROP TABLE public.super_secret_table_name", 1);
      expect.unreachable("expected assertStatementReadOnly to throw");
    } catch (e) {
      const err = e as Error;
      expect(err.message).not.toContain("super_secret_table_name");
      expect(err.message).toContain("Statement 1");
    }
  });
});

describe("runReadOnlySqlStatements — orchestration: order, stop-on-first-failure, redaction preserved through error wrapping", () => {
  it("executes every statement in order when all succeed", async () => {
    const calls: string[] = [];
    const fakeExec = async (_url: string, stmt: string) => {
      calls.push(stmt);
      return { stdout: `ok`, stderr: "" };
    };
    const results = await runReadOnlySqlStatements(
      "postgresql://fake",
      "SELECT 1; SELECT 2; SELECT 3;",
      {
        label: "test",
        execStatement: fakeExec,
      },
    );
    expect(calls).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.index)).toEqual([1, 2, 3]);
  });

  it("stops immediately on the first failure — later statements never run", async () => {
    const calls: string[] = [];
    const fakeExec = async (_url: string, stmt: string) => {
      calls.push(stmt);
      if (calls.length === 2) throw new Error("simulated failure on statement 2");
      return { stdout: "ok", stderr: "" };
    };
    await expect(
      runReadOnlySqlStatements("postgresql://fake", "SELECT 1; SELECT 2; SELECT 3;", {
        label: "test",
        execStatement: fakeExec,
      }),
    ).rejects.toThrow(/Statement 2\/3 failed/);
    // Only statements 1 and 2 were ever attempted — statement 3 never ran.
    expect(calls).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("a write statement as the 2nd of 3 is rejected before execution — the 1st already ran, the 3rd never does", async () => {
    const calls: string[] = [];
    const fakeExec = async (_url: string, stmt: string) => {
      calls.push(stmt);
      return { stdout: "ok", stderr: "" };
    };
    await expect(
      runReadOnlySqlStatements(
        "postgresql://fake",
        "SELECT 1; UPDATE public.ar_invoices SET total = 0; SELECT 3;",
        { label: "test", execStatement: fakeExec },
      ),
    ).rejects.toThrow(/non-read-only keyword/);
    expect(calls).toEqual(["SELECT 1"]);
  });

  it("throws a clear error rather than executing anything when the file has no real statements", async () => {
    await expect(
      runReadOnlySqlStatements("postgresql://fake", "-- just a comment, nothing else\n", {
        label: "test",
        execStatement: async () => ({ stdout: "", stderr: "" }),
      }),
    ).rejects.toThrow(/No executable SQL statements/);
  });

  it("error wrapping (adding the 'Statement N/M failed' prefix) never reintroduces a secret that was already redacted upstream", async () => {
    // Simulates exactly what a real failure looks like after passing through
    // runCliMasked (guard.mjs) — already redacted by the time it reaches
    // this layer. Confirms the "Statement N/M failed: " prefix this file
    // adds is purely textual and can't undo that redaction.
    const fakeExec = async () => {
      throw new GuardError(
        "Command failed: supabase db query --db-url postgresql://***REDACTED*** ...",
      );
    };
    try {
      await runReadOnlySqlStatements("postgresql://fake", "SELECT 1;", {
        label: "test",
        execStatement: fakeExec,
      });
      expect.unreachable("expected runReadOnlySqlStatements to throw");
    } catch (e) {
      const err = e as Error;
      expect(err.message).toContain("***REDACTED***");
      expect(err.message).not.toMatch(/postgresql:\/\/[^*]/); // no unredacted connection string slipped in
    }
  });
});

describe("execStatementViaSupabaseCli — real incident fix (2026-08-22): a multi-line statement passed as an inline `shell: true` argument corrupts/hangs on Windows cmd.exe; fixed by writing it to a temp file and using --file", () => {
  const MULTILINE_STATEMENT =
    "SELECT id, code\nFROM public.ap_bills\nWHERE amount_paid < 0 OR amount_paid > total";

  it("a multi-line statement against a deliberately invalid host fails FAST via a real supabase CLI call — proves no hang, not just no error (the actual incident was a 2+ minute hang with zero network connection ever made, not a slow or failing one)", async () => {
    const start = Date.now();
    await expect(
      execStatementViaSupabaseCli(
        "postgresql://postgres:fake@nonexistent-host-for-test.invalid:5432/postgres",
        MULTILINE_STATEMENT,
      ),
    ).rejects.toThrow();
    // Generous relative to the incident (2+ minutes / 120000ms+), tight
    // enough to catch a regression back to hanging.
    expect(Date.now() - start).toBeLessThan(20_000);
  }, 25_000);

  it("the failure output shows the --file flag (temp file), never the multi-line statement text as an inline argument, and redaction still holds", async () => {
    try {
      await execStatementViaSupabaseCli(
        "postgresql://postgres:fake@nonexistent-host-for-test.invalid:5432/postgres",
        MULTILINE_STATEMENT,
      );
      expect.unreachable("expected execStatementViaSupabaseCli to throw");
    } catch (e) {
      const err = e as Error;
      expect(err.message).toContain("--file");
      expect(err.message).not.toContain(MULTILINE_STATEMENT);
      expect(err.message).toContain("postgresql://***REDACTED***");
    }
  }, 25_000);
});
