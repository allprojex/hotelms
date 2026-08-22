// Tests for scripts/prod/lib/*.mjs — the guard logic behind the production
// automation toolkit (see docs/prod-release-runbook.md). Every test here
// runs against LOCAL git history and LOCAL fixture files only — nothing
// touches Supabase, SSH, or any network target. This is deliberate: these
// guards are what stand between an approved release and an unreviewed one,
// so they need to be provably correct without ever needing production
// access to test them.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
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
import { parsePendingMigrations } from "../scripts/prod/supabase-migrate.mjs";

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
