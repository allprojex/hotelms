// Regression coverage for scripts/prod-release.sh's stage() function — the
// generic sequencing mechanism every stage (preflight, migration check,
// migration apply, verify, reload, precheck, deploy, ui-smoke) runs
// through. This is the exact mechanism a real incident (2026-08-22)
// exposed: a stage wrapping a command that deliberately exits non-zero as
// an "expected" checkpoint was killed by stage()'s own unconditional
// `exit "$code"` on failure, which a trailing `|| true` at the call site
// cannot intercept (that only catches a `return`, not an `exit` from
// inside the called shell function). The fix was to give
// scripts/prod/supabase-migrate.mjs a real, successful --check exit mode
// instead of relying on stage() treating one particular failure as fine —
// this file proves stage() itself behaves correctly and consistently for
// every stage, with no special-casing needed: a passing command lets the
// pipeline continue, a failing command halts it immediately, and no later
// command ever runs after a failure.
//
// The exact stage() source is extracted from the real
// scripts/prod-release.sh (never reimplemented) so this test breaks
// loudly if that function is ever changed in a way that alters its
// semantics, rather than silently testing stale logic.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT } from "../scripts/prod/lib/guard.mjs";

function readNormalized(relPath: string): string {
  return readFileSync(path.join(REPO_ROOT, relPath), "utf8").replace(/\r\n/g, "\n");
}

function extractStageFunction(): string {
  const source = readNormalized("scripts/prod-release.sh");
  const match = source.match(/^stage\(\) \{\n[\s\S]*?\n\}\n/m);
  if (!match) {
    throw new Error(
      "Could not extract stage() from scripts/prod-release.sh — its shape changed; update this test's extraction regex to match.",
    );
  }
  return match[0];
}

describe("stage() — extracted from the real scripts/prod-release.sh, generic sequencing semantics", () => {
  let dir: string;
  let runDir: string;
  let stagesTsv: string;
  let planPath: string;
  let driverPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "prod-release-stage-test-"));
    runDir = path.join(dir, "run");
    stagesTsv = path.join(runDir, "stages.tsv");
    // A minimal, structurally valid release plan — release-report.mjs (called
    // by stage()'s own failure path) must be able to load it without itself
    // erupting, even though that specific call is `|| true`-guarded.
    planPath = path.join(dir, "plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        release_id: "stage-fn-test",
        operator: "test",
        approved_git_sha: "a".repeat(40),
      }),
    );
    driverPath = path.join(dir, "driver.sh");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeDriver(body: string) {
    const stageFn = extractStageFunction();
    const script = [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      `PLAN="${planPath.replace(/\\/g, "/")}"`,
      `RUN_DIR="${runDir.replace(/\\/g, "/")}"`,
      `STAGES_TSV="${stagesTsv.replace(/\\/g, "/")}"`,
      'mkdir -p "$RUN_DIR"',
      ': > "$STAGES_TSV"',
      'cd "' + REPO_ROOT.replace(/\\/g, "/") + '"', // release-report.mjs is invoked as a relative path
      stageFn,
      body,
    ].join("\n");
    writeFileSync(driverPath, script);
  }

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

  function runDriver(): { exitCode: number; stdout: string } {
    try {
      const stdout = execFileSync("bash", [driverPath], { encoding: "utf8" });
      return { exitCode: 0, stdout };
    } catch (e) {
      const err = e as { status: number; stdout: string };
      return { exitCode: err.status, stdout: err.stdout ?? "" };
    }
  }

  it("a passing stage lets the pipeline continue to the next line", () => {
    writeDriver(
      ['stage "step-one" node -e "process.exit(0)"', 'echo "REACHED_AFTER_STEP_ONE"'].join("\n"),
    );
    const { exitCode, stdout } = runDriver();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("REACHED_AFTER_STEP_ONE");
    expect(readStages()).toEqual([{ name: "step-one", status: "PASS" }]);
  });

  it("a failing stage halts the whole script immediately — no later command in the driver ever runs", () => {
    writeDriver(
      [
        'stage "step-one" node -e "process.exit(0)"',
        'stage "step-two" node -e "process.exit(1)"',
        'echo "SHOULD_NEVER_APPEAR"',
      ].join("\n"),
    );
    const { exitCode, stdout } = runDriver();
    expect(exitCode).not.toBe(0);
    expect(stdout).not.toContain("SHOULD_NEVER_APPEAR");
    expect(readStages()).toEqual([
      { name: "step-one", status: "PASS" },
      { name: "step-two", status: "FAIL" },
    ]);
  });

  it("this is exactly the shape of the real incident: a stage wrapping a command that deliberately exits non-zero (the OLD supabase-migrate.mjs behavior, no --check mode) still halts everything, proving `|| true` at the call site cannot rescue it — the actual fix had to be at the wrapped command's own exit code, not at this call site", () => {
    writeDriver(
      [
        // Mirrors the exact bug: a command that is "expected" to fail,
        // wrapped in `|| true` at the call site.
        'stage "deliberately-refusing-checkpoint" node -e "process.exit(1)" || true',
        'echo "REACHED_STAGE_THREE"',
      ].join("\n"),
    );
    const { exitCode, stdout } = runDriver();
    // Reproduces the incident: the || true does NOT save it. This is the
    // documentation-by-test of why the fix was a real --check mode, not a
    // change to this call-site pattern.
    expect(exitCode).not.toBe(0);
    expect(stdout).not.toContain("REACHED_STAGE_THREE");
  });

  it("three stages: pass, pass, fail — the third stage's failure stops before a fourth ever runs, and stages.tsv records exactly the first three", () => {
    writeDriver(
      [
        'stage "s1" node -e "process.exit(0)"',
        'stage "s2" node -e "process.exit(0)"',
        'stage "s3" node -e "process.exit(1)"',
        'stage "s4" node -e "process.exit(0)"',
      ].join("\n"),
    );
    const { exitCode } = runDriver();
    expect(exitCode).not.toBe(0);
    expect(readStages()).toEqual([
      { name: "s1", status: "PASS" },
      { name: "s2", status: "PASS" },
      { name: "s3", status: "FAIL" },
    ]);
  });

  it("records a PASS row per successful stage in call order, matching what release-report.mjs reads to build its stage table", () => {
    writeDriver(
      ['stage "alpha" node -e "process.exit(0)"', 'stage "beta" node -e "process.exit(0)"'].join(
        "\n",
      ),
    );
    runDriver();
    expect(readStages()).toEqual([
      { name: "alpha", status: "PASS" },
      { name: "beta", status: "PASS" },
    ]);
  });
});

describe("scripts/prod-release.sh — stage 02 invocation itself (static check that the actual bug is fixed)", () => {
  const source = readNormalized("scripts/prod-release.sh");

  it("stage 02 now calls supabase-migrate.mjs with --check, not with no mode flag at all", () => {
    expect(source).toContain(
      'stage "02-migration-hash-check" node scripts/prod/supabase-migrate.mjs --plan "$PLAN" --check',
    );
  });

  it("stage 02's invocation no longer relies on a trailing `|| true` to survive an expected failure — there is nothing left for it to rescue", () => {
    const stageTwoLine = source
      .split("\n")
      .find((line) => line.includes('"02-migration-hash-check"'));
    expect(stageTwoLine).toBeDefined();
    expect(stageTwoLine).not.toMatch(/\|\|\s*true/);
  });

  it("stage 03 (the real apply) still requires --yes, unchanged", () => {
    expect(source).toContain(
      'stage "03-migration-apply" node scripts/prod/supabase-migrate.mjs --plan "$PLAN" --yes',
    );
  });

  it("every other stage's invocation is untouched by this fix (preflight, verify, reload, precheck, deploy, ui-smoke)", () => {
    expect(source).toContain(
      'stage "01-preflight" node scripts/prod/supabase-preflight.mjs --plan "$PLAN"',
    );
    expect(source).toContain(
      'stage "04-database-verify" node scripts/prod/supabase-verify.mjs --plan "$PLAN"',
    );
    expect(source).toContain(
      'stage "05-postgrest-reload" node scripts/prod/supabase-reload-postgrest.mjs',
    );
    expect(source).toContain(
      'stage "06-vps-precheck" node scripts/prod/vps-precheck.mjs --plan "$PLAN"',
    );
    expect(source).toContain(
      'stage "07-vps-deploy" node scripts/prod/vps-deploy.mjs --plan "$PLAN" --yes',
    );
    expect(source).toContain('stage "08-ui-smoke" node scripts/prod/ui-smoke.mjs --plan "$PLAN"');
  });

  it("the human-readable rehearsal-mode messaging still refers to a real checkpoint, not stale wording about the old behavior", () => {
    expect(source).toContain(
      "Rehearsal mode (no --yes): migration hash check passed; stopping before the real apply.",
    );
  });
});
