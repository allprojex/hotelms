#!/usr/bin/env node
// Loads and validates a per-release plan (see release-plan.example.json).
// The release plan is the human's written approval record for one specific
// release: which commit, which migration + its approved hash, which SQL
// files are safe to run read-only, and which UI smoke tags are authorized.
// Every guarded script cross-checks the live world against this file and
// refuses on any mismatch.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { GuardError, REPO_ROOT } from "./guard.mjs";

const SHA_RE = /^[0-9a-f]{40}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;

export function loadReleasePlan(planPath) {
  if (!planPath) {
    throw new GuardError(
      "No release plan path given. Usage: pass --plan <path-to-release-plan.json> " +
        "(copy scripts/prod/release-plan.example.json and fill it in for this release).",
    );
  }
  const resolved = path.isAbsolute(planPath) ? planPath : path.join(REPO_ROOT, planPath);
  if (!existsSync(resolved)) {
    throw new GuardError(`Release plan not found: ${resolved}`);
  }
  let plan;
  try {
    plan = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (e) {
    throw new GuardError(`Release plan at ${resolved} is not valid JSON: ${e.message}`);
  }

  if (!plan.release_id || typeof plan.release_id !== "string") {
    throw new GuardError("Release plan is missing release_id");
  }
  if (!plan.operator || typeof plan.operator !== "string") {
    throw new GuardError("Release plan is missing operator");
  }
  if (!plan.approved_git_sha || !SHA_RE.test(plan.approved_git_sha)) {
    throw new GuardError("Release plan's approved_git_sha must be a 40-char hex commit SHA");
  }

  if (plan.migration) {
    if (!plan.migration.relPath || !plan.migration.approvedSha256) {
      throw new GuardError("Release plan's migration block needs relPath and approvedSha256");
    }
    if (!SHA256_RE.test(plan.migration.approvedSha256)) {
      throw new GuardError("Release plan's migration.approvedSha256 must be a 64-char hex SHA-256");
    }
  }

  if (plan.ui_smoke) {
    const allowedTags = ["@prod-readonly", "@prod-write", "@prod-financial"];
    for (const tag of plan.ui_smoke.tags ?? []) {
      if (!allowedTags.includes(tag)) {
        throw new GuardError(`Release plan ui_smoke.tags contains unknown tag "${tag}"`);
      }
    }
    if (plan.ui_smoke.tags?.includes("@prod-write") && !plan.ui_smoke.authorize_write_tests) {
      throw new GuardError(
        "Release plan requests @prod-write UI tests but authorize_write_tests is not true",
      );
    }
    if (
      plan.ui_smoke.tags?.includes("@prod-financial") &&
      !plan.ui_smoke.authorize_financial_tests
    ) {
      throw new GuardError(
        "Release plan requests @prod-financial UI tests but authorize_financial_tests is not true",
      );
    }
  }

  return { plan, resolvedPath: resolved };
}

/** Confirms the currently checked-out git commit matches the release plan's
 * approved_git_sha exactly — the release plan approves ONE specific commit,
 * never "whatever HEAD happens to be right now". */
export function assertHeadMatchesPlan(plan, repoRoot = REPO_ROOT) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  if (head !== plan.approved_git_sha) {
    throw new GuardError(
      `Checked-out HEAD (${head}) does not match the release plan's approved_git_sha (${plan.approved_git_sha}).`,
    );
  }
  return head;
}
