#!/usr/bin/env node
// Shared guard library for scripts/prod/*.mjs.
//
// Every function here is a narrow, single-purpose validation check. Nothing
// in this file talks to the network on its own except assertProjectRefKnownToCli
// (read-only Supabase Management API call) — callers wire these checks
// together explicitly so the actual dangerous operation (a real db push, a
// real ssh deploy) only ever runs after every relevant guard in this file
// has passed. There is deliberately no "just run this SQL" or "just run this
// shell command" escape hatch: every exported function does exactly one
// checked thing.
//
// Nothing in this file ever prints a secret. Connection strings and tokens
// are only ever handled long enough to validate them, then discarded or
// passed to a child process via env/argv — never logged, never written to
// disk, never included in error messages.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
export const CONFIG_PATH = path.join(__dirname, "..", "production.config.json");

export class GuardError extends Error {
  constructor(message) {
    super(message);
    this.name = "GuardError";
  }
}

/** Loads and structurally validates production.config.json. Never caches —
 * every invocation re-reads from disk so a mid-session edit is always seen. */
export function loadProductionConfig(configPath = CONFIG_PATH) {
  if (!existsSync(configPath)) {
    throw new GuardError(`Production config not found at ${configPath}`);
  }
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new GuardError(`Production config at ${configPath} is not valid JSON: ${e.message}`);
  }
  const required = [
    "github_repo",
    "supabase_project_ref",
    "supabase_project_name_expected",
    "production_domain",
    "vps_app_path",
    "systemd_service",
    "ssh_host_alias",
  ];
  const missing = required.filter((k) => !config[k] || typeof config[k] !== "string");
  if (missing.length) {
    throw new GuardError(`Production config is missing required field(s): ${missing.join(", ")}`);
  }
  if (!config.human_confirmation || typeof config.human_confirmation.confirmed !== "boolean") {
    throw new GuardError(
      "Production config is missing human_confirmation.confirmed (must be true/false)",
    );
  }
  // Refuse a ref/domain that still looks like an unfilled placeholder.
  if (/your-project-ref|CHANGE_?ME|example\.com/i.test(config.supabase_project_ref)) {
    throw new GuardError("supabase_project_ref still looks like a placeholder — set the real ref");
  }
  return config;
}

/** Write-path gate. Every script that can mutate production (migration apply,
 * VPS deploy, PostgREST reload) must call this before doing anything else. */
export function assertHumanConfirmed(config) {
  if (config.human_confirmation?.confirmed !== true) {
    throw new GuardError(
      "human_confirmation.confirmed is not true in scripts/prod/production.config.json — " +
        "a human must explicitly confirm the production identity before any write path may run. " +
        "See docs/prod-release-runbook.md.",
    );
  }
}

/** Redacts credentials from a Postgres connection string for safe logging.
 * postgresql://user:password@host:port/db -> postgresql://user:***@host:port/db */
export function maskConnectionString(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<unparseable connection string, not logged>";
  }
}

/** Extracts the Supabase project ref embedded in a connection string's
 * hostname or username, supporting both the direct (db.<ref>.supabase.co)
 * and pooler (aws-0-<region>.pooler.supabase.com, user postgres.<ref>) forms. */
export function extractProjectRefFromDbUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new GuardError("PROD_SUPABASE_DB_URL is not a valid connection string URL");
  }
  const directMatch = u.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (directMatch) return directMatch[1];
  const poolerUserMatch = decodeURIComponent(u.username || "").match(/^postgres\.([a-z0-9]+)$/i);
  if (poolerUserMatch && /pooler\.supabase\.com$/i.test(u.hostname)) return poolerUserMatch[1];
  throw new GuardError(
    `Could not extract a Supabase project ref from the connection string's host/user (host: ${u.hostname}). ` +
      "Expected db.<ref>.supabase.co or a pooler URL with user postgres.<ref>.",
  );
}

/** Reads PROD_SUPABASE_DB_URL from the environment, validates it is present,
 * and confirms the project ref embedded in it matches production.config.json
 * exactly. Never logs the raw URL. */
export function resolveProductionDbUrl(config) {
  const url = process.env.PROD_SUPABASE_DB_URL;
  if (!url) {
    throw new GuardError(
      "PROD_SUPABASE_DB_URL is not set. Export it in your own shell session before running this " +
        "script — never write it to a file in this repo. See docs/prod-release-runbook.md.",
    );
  }
  const refInUrl = extractProjectRefFromDbUrl(url);
  if (refInUrl !== config.supabase_project_ref) {
    throw new GuardError(
      `PROD_SUPABASE_DB_URL points at project ref "${refInUrl}", but production.config.json ` +
        `expects "${config.supabase_project_ref}". Refusing to connect to an unexpected project.`,
    );
  }
  return { url, masked: maskConnectionString(url) };
}

/** Read-only Management API check: confirms the configured project ref is a
 * real, healthy project with (loosely) the expected name. Uses whatever
 * credentials `supabase login` already stored — never a token this script
 * holds itself. */
export async function assertProjectRefKnownToCli(config) {
  let stdout;
  try {
    // shell: true — on Windows, a plain (npm-installed) `supabase` is a
    // .cmd shim that execFile can't resolve without going through a shell;
    // discovered and fixed while rehearsing this script for real (see
    // docs/prod-release-runbook.md). Safe here: every argument is a fixed
    // literal, never caller-supplied input.
    ({ stdout } = await execFileAsync("supabase", ["projects", "list", "--output", "json"], {
      maxBuffer: 10 * 1024 * 1024,
      shell: true,
    }));
  } catch (e) {
    throw new GuardError(
      `Could not run "supabase projects list" (is the CLI authenticated? run 'supabase login'): ${e.message}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new GuardError(
      `"supabase projects list --output json" did not return valid JSON: ${e.message}`,
    );
  }
  const projects = Array.isArray(parsed) ? parsed : parsed.projects;
  if (!Array.isArray(projects)) {
    throw new GuardError('"supabase projects list --output json" returned an unexpected shape');
  }
  const match = projects.find(
    (p) => p.ref === config.supabase_project_ref || p.id === config.supabase_project_ref,
  );
  if (!match) {
    throw new GuardError(
      `Project ref "${config.supabase_project_ref}" was not found via "supabase projects list" for the ` +
        "currently authenticated account. Refusing to proceed against an unverifiable target.",
    );
  }
  if (match.status && match.status !== "ACTIVE_HEALTHY") {
    throw new GuardError(
      `Project "${config.supabase_project_ref}" reports status "${match.status}", not ACTIVE_HEALTHY.`,
    );
  }
  if (
    match.name &&
    !match.name.toLowerCase().includes(config.supabase_project_name_expected.toLowerCase())
  ) {
    throw new GuardError(
      `Project "${config.supabase_project_ref}" is named "${match.name}" via the Supabase API, which does ` +
        `not contain the expected "${config.supabase_project_name_expected}". Refusing — this looks like ` +
        "the wrong project (e.g. a demo/staging copy with a reused ref would still fail this check).",
    );
  }
  return match;
}

/** Computes SHA-256 of a file's PRISTINE git blob content at a given
 * commit-ish — never the working-tree copy, which could be locally edited.
 * Also confirms the path is actually tracked at that commit (not merely
 * present on disk). */
export function gitBlobSha256(commitish, relPath, repoRoot = REPO_ROOT) {
  let lsTreeOut;
  try {
    lsTreeOut = execFileSync("git", ["ls-tree", commitish, "--", relPath], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } catch (e) {
    throw new GuardError(`git ls-tree failed for ${commitish}:${relPath}: ${e.message}`);
  }
  if (!lsTreeOut.trim()) {
    throw new GuardError(`${relPath} is not tracked in git at commit ${commitish}`);
  }
  let blob;
  try {
    blob = execFileSync("git", ["cat-file", "-p", `${commitish}:${relPath}`], {
      cwd: repoRoot,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (e) {
    throw new GuardError(`git cat-file failed for ${commitish}:${relPath}: ${e.message}`);
  }
  return createHash("sha256").update(blob).digest("hex");
}

/** Confirms a given commit-ish actually exists in this repo's git history
 * (not merely a plausible-looking hex string). */
export function assertCommitExists(commitish, repoRoot = REPO_ROOT) {
  try {
    execFileSync("git", ["cat-file", "-e", `${commitish}^{commit}`], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    throw new GuardError(`Commit ${commitish} does not exist in this repository's git history`);
  }
}

/** The core migration-approval gate (release-plan.json's migration block):
 * the migration path must exist in git at the approved commit, and its
 * pristine blob SHA-256 must exactly equal the approved hash recorded in the
 * release plan. Throws GuardError with a clear reason on any mismatch. */
export function assertMigrationApproved({ commit, relPath, approvedSha256 }, repoRoot = REPO_ROOT) {
  if (!commit || !relPath || !approvedSha256) {
    throw new GuardError(
      "Migration approval check requires commit, relPath, and approvedSha256 all present",
    );
  }
  assertCommitExists(commit, repoRoot);
  if (!relPath.startsWith("supabase/migrations/") || !relPath.endsWith(".sql")) {
    throw new GuardError(
      `Refusing: "${relPath}" does not look like a migration path (expected supabase/migrations/*.sql)`,
    );
  }
  const actualSha256 = gitBlobSha256(commit, relPath, repoRoot);
  if (actualSha256 !== approvedSha256.toLowerCase()) {
    throw new GuardError(
      `SHA256 mismatch for ${relPath} at commit ${commit}.\n` +
        `  approved: ${approvedSha256}\n  actual:   ${actualSha256}\n` +
        "Refusing to apply an unreviewed or altered migration.",
    );
  }
  return actualSha256;
}

/** Defense-in-depth scanner for SQL files that must be read-only (preflight
 * and postflight/verification files). Not a real SQL parser — a deliberately
 * conservative keyword check that rejects anything resembling a write or DDL
 * statement outside of a line comment. Rejects on the side of caution: a
 * false positive just means a human has to look at the file, a false
 * negative would mean a "read-only" script mutates production. */
const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|MERGE|CALL|EXECUTE|VACUUM|REINDEX|COPY)\b/i;

export function assertReadOnlySqlFile(filePath) {
  if (!existsSync(filePath)) {
    throw new GuardError(`SQL file not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, "utf8");
  const withoutLineComments = raw.replace(/--[^\n]*/g, "");
  const withoutBlockComments = withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, "");
  if (WRITE_KEYWORDS.test(withoutBlockComments)) {
    const found = withoutBlockComments.match(WRITE_KEYWORDS)?.[0];
    throw new GuardError(
      `${filePath} contains a non-read-only keyword ("${found}") outside of comments — ` +
        "refusing to run it as a read-only preflight/verification file.",
    );
  }
  return raw;
}

/** Confirms the local repo's git remote matches the expected GitHub repo,
 * as a sanity check before any deploy-adjacent operation. */
export function assertGitRemoteMatches(config, repoRoot = REPO_ROOT) {
  let remoteUrl;
  try {
    remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch (e) {
    throw new GuardError(`Could not read git remote "origin": ${e.message}`);
  }
  const normalized = remoteUrl
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");
  if (!normalized.toLowerCase().endsWith(config.github_repo.toLowerCase())) {
    throw new GuardError(
      `git remote "origin" (${remoteUrl}) does not match the expected repo (${config.github_repo})`,
    );
  }
}

export function log(label, message) {
  process.stdout.write(`[${label}] ${message}\n`);
}

export function pass(label, message) {
  process.stdout.write(`[${label}] PASS — ${message}\n`);
}

export function fail(label, message) {
  process.stderr.write(`[${label}] FAIL — ${message}\n`);
}
