// Regression coverage for the guarded production-release toolkit's new
// support for an ORDERED SET of approved migrations in one release plan
// (scripts/prod/lib/release-plan.mjs's `migrations` array, and
// scripts/prod/supabase-migrate.mjs's multi-migration runMigrate()). Every
// test here runs against LOCAL git history and LOCAL fixtures/mocks only —
// nothing touches Supabase, SSH, or any real production target, matching
// tests/prod-guards.test.ts's own discipline.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitBlobSha256, redactSecretsFromText, REPO_ROOT } from "../scripts/prod/lib/guard.mjs";
import { loadReleasePlan, normalizeMigrations } from "../scripts/prod/lib/release-plan.mjs";
import {
  parseAppliedRemoteTimestamps,
  resolveMode,
  runMigrate,
} from "../scripts/prod/supabase-migrate.mjs";

function currentHead(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

// The three real, currently-merged reservation-payment migrations — hashes
// computed dynamically from the pristine git blob at whatever HEAD the
// suite runs at (never hardcoded), exactly mirroring how a real release
// plan is built from a real approved commit.
function realThreeMigrationRelPaths(): string[] {
  return [
    "supabase/migrations/20260822130000_reservation_payment_refund.sql",
    "supabase/migrations/20260823090000_reservation_payment_ledger_posting_fix.sql",
    "supabase/migrations/20260823100000_reservation_payment_journal_currency_fix.sql",
  ];
}

function buildRealThreeMigrationPlan() {
  const head = currentHead();
  const migrations = realThreeMigrationRelPaths().map((relPath) => ({
    relPath,
    approvedSha256: gitBlobSha256(head, relPath),
  }));
  return {
    release_id: "test-multi-migration-release",
    operator: "test",
    approved_git_sha: head,
    migrations,
  };
}

describe("release-plan.mjs — backward compatibility (1. old single-migration plan still works)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "prod-multi-migration-plan-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writePlan(obj: unknown): string {
    const p = path.join(dir, "plan.json");
    writeFileSync(p, JSON.stringify(obj));
    return p;
  }

  it("a plan using the original singular `migration` block still loads cleanly, unchanged validation", () => {
    const p = writePlan({
      release_id: "single-mig-release",
      operator: "tester",
      approved_git_sha: "a".repeat(40),
      migration: { relPath: "supabase/migrations/x.sql", approvedSha256: "b".repeat(64) },
    });
    const { plan } = loadReleasePlan(p);
    expect(plan.migration.relPath).toBe("supabase/migrations/x.sql");
  });

  it("normalizeMigrations() returns a one-element array for the singular form", () => {
    const p = writePlan({
      release_id: "single-mig-release",
      operator: "tester",
      approved_git_sha: "a".repeat(40),
      migration: { relPath: "supabase/migrations/x.sql", approvedSha256: "b".repeat(64) },
    });
    const { plan } = loadReleasePlan(p);
    expect(normalizeMigrations(plan)).toEqual([
      { relPath: "supabase/migrations/x.sql", approvedSha256: "b".repeat(64) },
    ]);
  });

  it("a plan with neither migration nor migrations normalizes to an empty array, not an error at load time", () => {
    const p = writePlan({
      release_id: "no-mig-release",
      operator: "tester",
      approved_git_sha: "a".repeat(40),
    });
    const { plan } = loadReleasePlan(p);
    expect(normalizeMigrations(plan)).toEqual([]);
  });

  it("a plan with BOTH migration and migrations set is rejected — exactly one form, never both", () => {
    const p = writePlan({
      release_id: "ambiguous-release",
      operator: "tester",
      approved_git_sha: "a".repeat(40),
      migration: { relPath: "supabase/migrations/x.sql", approvedSha256: "b".repeat(64) },
      migrations: [
        { relPath: "supabase/migrations/20260101000000_y.sql", approvedSha256: "c".repeat(64) },
      ],
    });
    expect(() => loadReleasePlan(p)).toThrow(/exactly one/);
  });
});

describe("release-plan.mjs — migrations array structural validation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "prod-multi-migration-plan-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writePlan(migrations: unknown): string {
    const p = path.join(dir, "plan.json");
    writeFileSync(
      p,
      JSON.stringify({
        release_id: "r",
        operator: "tester",
        approved_git_sha: "a".repeat(40),
        migrations,
      }),
    );
    return p;
  }

  it("2. loads a valid ordered 3-migration array cleanly, normalizeMigrations preserves order", () => {
    const migrations = [
      { relPath: "supabase/migrations/20260101000000_a.sql", approvedSha256: "1".repeat(64) },
      { relPath: "supabase/migrations/20260102000000_b.sql", approvedSha256: "2".repeat(64) },
      { relPath: "supabase/migrations/20260103000000_c.sql", approvedSha256: "3".repeat(64) },
    ];
    const { plan } = loadReleasePlan(writePlan(migrations));
    expect(normalizeMigrations(plan)).toEqual(migrations);
  });

  it("rejects an empty migrations array", () => {
    expect(() => loadReleasePlan(writePlan([]))).toThrow(/non-empty array/);
  });

  it("7. rejects duplicate filenames in the plan", () => {
    const migrations = [
      { relPath: "supabase/migrations/20260101000000_a.sql", approvedSha256: "1".repeat(64) },
      { relPath: "supabase/migrations/20260101000000_a.sql", approvedSha256: "2".repeat(64) },
    ];
    expect(() => loadReleasePlan(writePlan(migrations))).toThrow(/duplicate filename/);
  });

  it("8. rejects duplicate migration timestamps even with different slugs", () => {
    const migrations = [
      { relPath: "supabase/migrations/20260101000000_a.sql", approvedSha256: "1".repeat(64) },
      { relPath: "supabase/migrations/20260101000000_b.sql", approvedSha256: "2".repeat(64) },
    ];
    expect(() => loadReleasePlan(writePlan(migrations))).toThrow(/duplicate migration timestamp/);
  });

  it("9. rejects a path-traversal relPath", () => {
    const migrations = [
      {
        relPath: "supabase/migrations/../../etc/passwd.sql",
        approvedSha256: "1".repeat(64),
      },
    ];
    expect(() => loadReleasePlan(writePlan(migrations))).toThrow(/unsafe/);
  });

  it("9. rejects an absolute path relPath", () => {
    const migrations = [{ relPath: "/etc/passwd.sql", approvedSha256: "1".repeat(64) }];
    expect(() => loadReleasePlan(writePlan(migrations))).toThrow(/unsafe/);
  });

  it("rejects a relPath outside supabase/migrations/", () => {
    const migrations = [
      { relPath: "supabase/other/20260101000000_a.sql", approvedSha256: "1".repeat(64) },
    ];
    expect(() => loadReleasePlan(writePlan(migrations))).toThrow(/supabase\/migrations/);
  });

  it("rejects a filename with no 14-digit timestamp prefix", () => {
    const migrations = [
      { relPath: "supabase/migrations/not_timestamped.sql", approvedSha256: "1".repeat(64) },
    ];
    expect(() => loadReleasePlan(writePlan(migrations))).toThrow(/timestamp/);
  });

  it("rejects a malformed approvedSha256 on any one entry", () => {
    const migrations = [
      { relPath: "supabase/migrations/20260101000000_a.sql", approvedSha256: "1".repeat(64) },
      { relPath: "supabase/migrations/20260102000000_b.sql", approvedSha256: "too-short" },
    ];
    expect(() => loadReleasePlan(writePlan(migrations))).toThrow(/SHA-256/);
  });
});

describe("parseAppliedRemoteTimestamps — verified against real `supabase migration list` output (CLI 2.107.0, local disposable stack)", () => {
  it("a fully-applied migration (Remote column populated, equal to Local) is recognized as applied", () => {
    const output = [
      "   Local          | Remote         | Time (UTC)          ",
      "  ----------------|----------------|---------------------",
      "   20260822130000 | 20260822130000 | 2026-08-22 13:00:00 ",
      "",
    ].join("\n");
    expect(parseAppliedRemoteTimestamps(output)).toEqual(new Set(["20260822130000"]));
  });

  it("a migration with a BLANK Remote column (confirmed real format for a not-yet-applied row) is NOT recognized as applied", () => {
    const output = [
      "   Local          | Remote         | Time (UTC)          ",
      "  ----------------|----------------|---------------------",
      "   20260823100000 |                | 2026-08-23 10:00:00 ",
      "",
    ].join("\n");
    expect(parseAppliedRemoteTimestamps(output)).toEqual(new Set());
  });

  it("correctly distinguishes applied from pending rows within the same multi-row table", () => {
    const output = [
      "   Local          | Remote         | Time (UTC)          ",
      "  ----------------|----------------|---------------------",
      "   20260822130000 | 20260822130000 | 2026-08-22 13:00:00 ",
      "   20260823090000 | 20260823090000 | 2026-08-23 09:00:00 ",
      "   20260823100000 |                | 2026-08-23 10:00:00 ",
      "",
    ].join("\n");
    expect(parseAppliedRemoteTimestamps(output)).toEqual(
      new Set(["20260822130000", "20260823090000"]),
    );
  });

  it("header and separator rows never falsely match (neither contains a 14-digit sequence)", () => {
    const output =
      "   Local          | Remote         | Time (UTC)          \n  ----------------|----------------|---------------------\n";
    expect(parseAppliedRemoteTimestamps(output)).toEqual(new Set());
  });
});

describe("runMigrate — multi-migration ordered-set flow (real 3-migration reservation-payment release)", () => {
  const ORIGINAL_URL = process.env.PROD_SUPABASE_DB_URL;
  const FAKE_DB_URL =
    "postgresql://postgres.texhuavnrdhaohqzlyqw:FAKESECRET_multi_migrate_test@aws-0-eu-west-1.pooler.supabase.com:6543/postgres";

  beforeEach(() => {
    process.env.PROD_SUPABASE_DB_URL = FAKE_DB_URL;
  });
  afterEach(() => {
    if (ORIGINAL_URL === undefined) delete process.env.PROD_SUPABASE_DB_URL;
    else process.env.PROD_SUPABASE_DB_URL = ORIGINAL_URL;
  });

  const noOpProjectRefCheck = async () => {};
  const REAL_FILENAMES = realThreeMigrationRelPaths().map((p) => path.basename(p));

  function fakeRunCli(
    {
      pendingFilenames,
      applyShouldFail = false,
      postApplyStillPendingFilenames = null as string[] | null,
      missingFromRemoteList = [] as string[],
    } = {} as {
      pendingFilenames: string[];
      applyShouldFail?: boolean;
      postApplyStillPendingFilenames?: string[] | null;
      missingFromRemoteList?: string[];
    },
  ) {
    const calls: { cmd: string; args: string[] }[] = [];
    let dryRunCalls = 0;
    const fn = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (args.includes("--dry-run")) {
        dryRunCalls++;
        if (dryRunCalls === 1) {
          return {
            stdout: [
              "DRY RUN: migrations will *not* be pushed to the database.",
              "Would push these migrations:",
              ...pendingFilenames.map((f) => ` • ${f}`),
              "Finished supabase db push.",
              "",
            ].join("\n"),
            stderr: "",
          };
        }
        if (postApplyStillPendingFilenames && postApplyStillPendingFilenames.length > 0) {
          return {
            stdout: [
              "Would push these migrations:",
              ...postApplyStillPendingFilenames.map((f) => ` • ${f}`),
              "",
            ].join("\n"),
            stderr: "",
          };
        }
        return { stdout: "Local database is up to date.\n", stderr: "" };
      }
      if (args.includes("--yes")) {
        if (applyShouldFail) throw new Error("simulated apply failure — not a real DB write");
        return { stdout: "Finished supabase db push.\n", stderr: "" };
      }
      if (args[0] === "migration" && args[1] === "list") {
        const rows = REAL_FILENAMES.map((f) => {
          const ts = f.match(/^(\d{14})_/)![1];
          const isMissing = missingFromRemoteList.includes(f);
          return `   ${ts} | ${isMissing ? "" : ts} | 2026-08-22 12:00:00 `;
        });
        return {
          stdout: [
            "   Local          | Remote         | Time (UTC)          ",
            "  ----------------|----------------|---------------------",
            ...rows,
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      throw new Error(`fakeRunCli: unexpected args ${JSON.stringify(args)}`);
    };
    return { fn, calls };
  }

  it("2. check mode passes cleanly for the exact approved 3-migration set, in order", async () => {
    const plan = buildRealThreeMigrationPlan();
    const { fn, calls } = fakeRunCli({ pendingFilenames: REAL_FILENAMES });
    const result = await runMigrate({
      plan,
      mode: "check",
      runCli: fn,
      checkProjectRef: noOpProjectRefCheck,
    });
    expect(result.applied).toBe(false);
    expect(result.migrations).toHaveLength(3);
    // 10. check mode never writes: only the one dry-run call is made.
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain("--dry-run");
  });

  it("3. wrong order in the dry-run output fails, even though the same 3 filenames are all present", async () => {
    const plan = buildRealThreeMigrationPlan();
    const reordered = [REAL_FILENAMES[1], REAL_FILENAMES[0], REAL_FILENAMES[2]];
    const { fn } = fakeRunCli({ pendingFilenames: reordered });
    await expect(
      runMigrate({ plan, mode: "check", runCli: fn, checkProjectRef: noOpProjectRefCheck }),
    ).rejects.toThrow(/order\/name mismatch/);
  });

  it("4. an additional fourth pending migration fails — more pending than approved", async () => {
    const plan = buildRealThreeMigrationPlan();
    const { fn } = fakeRunCli({
      pendingFilenames: [...REAL_FILENAMES, "20260901000000_unrelated_future_migration.sql"],
    });
    await expect(
      runMigrate({ plan, mode: "check", runCli: fn, checkProjectRef: noOpProjectRefCheck }),
    ).rejects.toThrow(/Expected exactly 3 pending migration/);
  });

  it("5. a missing approved migration (only 2 of 3 pending) fails — fewer pending than approved", async () => {
    const plan = buildRealThreeMigrationPlan();
    const { fn } = fakeRunCli({ pendingFilenames: REAL_FILENAMES.slice(0, 2) });
    await expect(
      runMigrate({ plan, mode: "check", runCli: fn, checkProjectRef: noOpProjectRefCheck }),
    ).rejects.toThrow(/Expected exactly 3 pending migration/);
  });

  it("6. a hash mismatch on any one file (not just the first) fails before any dry-run is even attempted", async () => {
    const plan = buildRealThreeMigrationPlan();
    plan.migrations[2] = { ...plan.migrations[2], approvedSha256: "f".repeat(64) };
    const { fn, calls } = fakeRunCli({ pendingFilenames: REAL_FILENAMES });
    await expect(
      runMigrate({ plan, mode: "check", runCli: fn, checkProjectRef: noOpProjectRefCheck }),
    ).rejects.toThrow(/SHA256 mismatch/);
    expect(calls).toHaveLength(0);
  });

  it("11. apply without --yes refuses (resolveMode never silently defaults to apply)", () => {
    expect(() => resolveMode({ check: false, yes: false })).toThrow(/Specify exactly one mode/);
  });

  it("12. apply (--yes) proceeds only after all checks pass — a failing hash check on migration 2 of 3 never reaches the real apply call", async () => {
    const plan = buildRealThreeMigrationPlan();
    plan.migrations[1] = { ...plan.migrations[1], approvedSha256: "e".repeat(64) };
    const { fn, calls } = fakeRunCli({ pendingFilenames: REAL_FILENAMES });
    await expect(
      runMigrate({ plan, mode: "apply", runCli: fn, checkProjectRef: noOpProjectRefCheck }),
    ).rejects.toThrow(/SHA256 mismatch/);
    expect(calls.some((c) => c.args.includes("--yes"))).toBe(false);
  });

  it("12. apply (--yes) with a fully valid 3-migration set applies for real and reports every migration as recorded remotely", async () => {
    const plan = buildRealThreeMigrationPlan();
    const { fn } = fakeRunCli({ pendingFilenames: REAL_FILENAMES });
    const result = await runMigrate({
      plan,
      mode: "apply",
      runCli: fn,
      checkProjectRef: noOpProjectRefCheck,
    });
    expect(result.applied).toBe(true);
    expect(result.migrations).toHaveLength(3);
    for (const m of result.migrations) expect(m.recordedRemotely).toBe(true);
  });

  it("13. a real apply-call failure (db push --yes itself errors) is reported as a release failure, not a silent partial success", async () => {
    const plan = buildRealThreeMigrationPlan();
    const { fn } = fakeRunCli({ pendingFilenames: REAL_FILENAMES, applyShouldFail: true });
    await expect(
      runMigrate({ plan, mode: "apply", runCli: fn, checkProjectRef: noOpProjectRefCheck }),
    ).rejects.toThrow(/simulated apply failure/);
  });

  it("13. a partial apply — db push --yes exits 0, but the post-apply dry-run still shows one migration pending — is detected and reported clearly as a release failure, not treated as success", async () => {
    const plan = buildRealThreeMigrationPlan();
    const { fn } = fakeRunCli({
      pendingFilenames: REAL_FILENAMES,
      postApplyStillPendingFilenames: [REAL_FILENAMES[2]],
    });
    await expect(
      runMigrate({ plan, mode: "apply", runCli: fn, checkProjectRef: noOpProjectRefCheck }),
    ).rejects.toThrow(/PARTIAL|UNEXPECTED STATE/);
  });

  it("14. a partial apply — nothing left pending, but `migration list` shows one migration missing from the remote history — is detected and reported clearly", async () => {
    const plan = buildRealThreeMigrationPlan();
    const { fn } = fakeRunCli({
      pendingFilenames: REAL_FILENAMES,
      missingFromRemoteList: [REAL_FILENAMES[0]],
    });
    await expect(
      runMigrate({ plan, mode: "apply", runCli: fn, checkProjectRef: noOpProjectRefCheck }),
    ).rejects.toThrow(/PARTIAL APPLY DETECTED/);
  });

  it("14. remote-history verification runs for ALL approved migrations, not just the first or last", async () => {
    const plan = buildRealThreeMigrationPlan();
    const { fn } = fakeRunCli({ pendingFilenames: REAL_FILENAMES });
    const result = await runMigrate({
      plan,
      mode: "apply",
      runCli: fn,
      checkProjectRef: noOpProjectRefCheck,
    });
    expect(result.migrations.map((m: { relPath: string }) => m.relPath)).toEqual(
      realThreeMigrationRelPaths(),
    );
    expect(result.migrations.every((m: { recordedRemotely: boolean }) => m.recordedRemotely)).toBe(
      true,
    );
  });

  it("16. no thrown error from any failure mode leaks the fake production credential", async () => {
    const plan = buildRealThreeMigrationPlan();
    const { fn } = fakeRunCli({ pendingFilenames: REAL_FILENAMES, applyShouldFail: true });
    try {
      await runMigrate({ plan, mode: "apply", runCli: fn, checkProjectRef: noOpProjectRefCheck });
      expect.unreachable("expected runMigrate to throw");
    } catch (e) {
      const err = e as Error;
      expect(err.message).not.toContain("FAKESECRET_multi_migrate_test");
      expect(err.message).not.toContain(FAKE_DB_URL);
    }
  });
});

describe("16. secrets remain redacted through the multi-migration path (redactSecretsFromText, unchanged, still covers the new call sites)", () => {
  it("a connection string embedded in a migration-list error is still redacted", () => {
    const raw =
      "supabase CLI error: failed to run migration list with postgresql://postgres.texhuavnrdhaohqzlyqw:realpassword@aws-0-eu-west-1.pooler.supabase.com:6543/postgres";
    const redacted = redactSecretsFromText(raw);
    expect(redacted).not.toContain("realpassword");
    expect(redacted).toContain("***REDACTED***");
  });
});

describe("15. orchestrator stops if the migration stage fails — extended for the multi-migration case (same generic stage() mechanism as tests/prod-release-stage.test.ts, exercised here with a multi-migration-shaped failure)", () => {
  function readNormalized(relPath: string): string {
    return readFileSync(path.join(REPO_ROOT, relPath), "utf8").replace(/\r\n/g, "\n");
  }
  function extractStageFunction(): string {
    const source = readNormalized("scripts/prod-release.sh");
    const match = source.match(/^stage\(\) \{\n[\s\S]*?\n\}\n/m);
    if (!match) throw new Error("Could not extract stage() from scripts/prod-release.sh");
    return match[0];
  }

  let dir: string;
  let runDir: string;
  let stagesTsv: string;
  let planPath: string;
  let driverPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "prod-multi-migration-stage-"));
    runDir = path.join(dir, "run");
    stagesTsv = path.join(runDir, "stages.tsv");
    planPath = path.join(dir, "plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        release_id: "multi-mig-stage-test",
        operator: "test",
        approved_git_sha: "a".repeat(40),
      }),
    );
    driverPath = path.join(dir, "driver.sh");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function readStages(): { name: string; status: string }[] {
    if (!existsSync(stagesTsv)) return [];
    return readFileSync(stagesTsv, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, status] = line.split("\t");
        return { name, status };
      });
  }

  it("a migration-hash-check stage failure (e.g. a wrong-order or missing migration in a multi-migration set) halts before migration-apply ever runs", () => {
    const stageFn = extractStageFunction();
    const script = [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      `PLAN="${planPath.replace(/\\/g, "/")}"`,
      `RUN_DIR="${runDir.replace(/\\/g, "/")}"`,
      `STAGES_TSV="${stagesTsv.replace(/\\/g, "/")}"`,
      'mkdir -p "$RUN_DIR"',
      ': > "$STAGES_TSV"',
      'cd "' + REPO_ROOT.replace(/\\/g, "/") + '"',
      stageFn,
      // Simulates supabase-migrate.mjs --check exiting non-zero because the
      // multi-migration set didn't match exactly (wrong order / missing /
      // extra / hash mismatch — any of runMigrate's new failure modes).
      'stage "02-migration-hash-check" node -e "console.error(\'order/name mismatch\'); process.exit(1)"',
      'stage "03-migration-apply" node -e "process.exit(0)"',
      'echo "SHOULD_NEVER_APPEAR"',
    ].join("\n");
    writeFileSync(driverPath, script);

    let exitCode = 0;
    let stdout = "";
    try {
      stdout = execFileSync("bash", [driverPath], { encoding: "utf8" });
    } catch (e) {
      const err = e as { status: number; stdout: string };
      exitCode = err.status;
      stdout = err.stdout ?? "";
    }
    expect(exitCode).not.toBe(0);
    expect(stdout).not.toContain("SHOULD_NEVER_APPEAR");
    expect(readStages()).toEqual([{ name: "02-migration-hash-check", status: "FAIL" }]);
  });
});

describe("17. existing production-release stage tests remain green (documented cross-reference)", () => {
  it("this multi-migration addition changes nothing in scripts/prod-release.sh itself — the orchestrator already just invokes supabase-migrate.mjs --plan ... --check/--yes generically, so tests/prod-release-stage.test.ts needed no changes and was re-run to confirm", () => {
    const source = readFileSync(path.join(REPO_ROOT, "scripts/prod-release.sh"), "utf8");
    expect(source).toContain(
      'stage "02-migration-hash-check" node scripts/prod/supabase-migrate.mjs --plan "$PLAN" --check',
    );
    expect(source).toContain(
      'stage "03-migration-apply" node scripts/prod/supabase-migrate.mjs --plan "$PLAN" --yes',
    );
  });
});
