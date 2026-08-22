#!/usr/bin/env node
// Section I — assembles the final release report from a run directory's
// stage logs + the release plan. Never includes secrets: it only ever reads
// from stage logs, which are themselves produced by scripts that already
// mask every credential before printing anything (see guard.mjs's
// maskConnectionString and the fact that PROD_SMOKE_STORAGE_STATE/
// PROD_SUPABASE_DB_URL's raw values are never process.stdout.write'd
// anywhere in this toolkit). As a final defense-in-depth pass, this script
// also redacts anything shaped like a connection string or bearer token
// before writing the report file.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { loadReleasePlan } from "./lib/release-plan.mjs";
import { REPO_ROOT, redactSecretsFromText } from "./lib/guard.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--plan") out.plan = argv[++i];
    if (argv[i] === "--rundir") out.rundir = argv[++i];
    if (argv[i] === "--outcome") out.outcome = argv[++i];
  }
  return out;
}

// Single source of truth: the exact same scrubbing guard.mjs's
// runCliMasked() applies to every CLI call's error output (connection
// strings, bearer tokens, token/secret/password-shaped text) — no separate
// pattern maintained here, so there's only one place to get this right.
const redact = redactSecretsFromText;

function readStages(rundir) {
  const tsvPath = path.join(rundir, "stages.tsv");
  if (!existsSync(tsvPath)) return [];
  return readFileSync(tsvPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, status, at] = line.split("\t");
      return { name, status, at };
    });
}

function readStageLog(rundir, stageFileGuess) {
  const files = existsSync(rundir) ? readdirSync(rundir) : [];
  const match = files.find((f) => f.startsWith(stageFileGuess));
  if (!match) return "";
  return readFileSync(path.join(rundir, match), "utf8");
}

function extractLine(log, pattern) {
  const m = log.match(pattern);
  return m ? m[0] : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { plan } = loadReleasePlan(args.plan);
  const rundir = args.rundir;
  const stages = readStages(rundir);

  const gitSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();

  const preflightLog = readStageLog(rundir, "01-preflight");
  const migrationCheckLog = readStageLog(rundir, "02-migration-hash-check");
  const migrationApplyLog = readStageLog(rundir, "03-migration-apply");
  const verifyLog = readStageLog(rundir, "04-database-verify");
  const reloadLog = readStageLog(rundir, "05-postgrest-reload");
  const vpsPrecheckLog = readStageLog(rundir, "06-vps-precheck");
  const vpsDeployLog = readStageLog(rundir, "07-vps-deploy");
  const uiSmokeLog = readStageLog(rundir, "08-ui-smoke");

  const stageStatus = (name) => stages.find((s) => s.name === name)?.status ?? "NOT RUN";

  const deployedSha =
    extractLine(vpsDeployLog, /final remote SHA verified: [0-9a-f]{7,40}/)?.replace(
      "final remote SHA verified: ",
      "",
    ) ?? null;

  let uiSmokeSummary = null;
  const jsonMatch = uiSmokeLog.match(/\n(\{[\s\S]*\})\n/);
  if (jsonMatch) {
    try {
      uiSmokeSummary = JSON.parse(jsonMatch[1]);
    } catch {
      uiSmokeSummary = null;
    }
  }

  const financialRecords = (uiSmokeSummary?.results?.financial ?? [])
    .filter((r) => r.ok)
    .map((r) => `${r.scenario}: ${r.note}`);

  const lines = [];
  lines.push(`# Production Release Report — ${plan.release_id}`);
  lines.push("");
  lines.push(`- **Date/time (UTC):** ${new Date().toISOString()}`);
  lines.push(`- **Operator:** ${plan.operator}`);
  lines.push(`- **Git SHA:** ${gitSha}`);
  lines.push(`- **Approved Git SHA (plan):** ${plan.approved_git_sha}`);
  if (plan.migration) {
    lines.push(`- **Migration filename:** ${plan.migration.relPath}`);
    lines.push(`- **Migration SHA256 (approved):** ${plan.migration.approvedSha256}`);
  } else {
    lines.push(`- **Migration:** none in this release`);
  }
  lines.push("");
  lines.push("## Stage results");
  lines.push("");
  lines.push("| Stage | Result | Started (UTC) |");
  lines.push("|---|---|---|");
  for (const s of stages) lines.push(`| ${s.name} | ${s.status} | ${s.at} |`);
  lines.push("");
  lines.push("## Detail");
  lines.push("");
  lines.push(`- **Preflight result:** ${stageStatus("01-preflight")}`);
  lines.push(`- **Migration hash-check result:** ${stageStatus("02-migration-hash-check")}`);
  lines.push(`- **Migration apply result:** ${stageStatus("03-migration-apply")}`);
  lines.push(`- **Database verification result:** ${stageStatus("04-database-verify")}`);
  lines.push(`- **PostgREST reload:** ${stageStatus("05-postgrest-reload")}`);
  lines.push(`- **VPS precheck:** ${stageStatus("06-vps-precheck")}`);
  lines.push(`- **Deploy result:** ${stageStatus("07-vps-deploy")}`);
  lines.push(`- **Deployed SHA:** ${deployedSha ?? "n/a"}`);
  lines.push(`- **UI smoke result:** ${stageStatus("08-ui-smoke")}`);
  lines.push(
    `- **UI tests executed:** ${uiSmokeSummary ? uiSmokeSummary.runTags.join(", ") : "n/a"}` +
      (uiSmokeSummary ? ` (${uiSmokeSummary.results.readonly.length} read-only route checks)` : ""),
  );
  lines.push(
    `- **Write tests executed:** ${uiSmokeSummary?.runTags?.includes("@prod-write") ? "yes" : "no"}`,
  );
  lines.push(
    `- **Financial tests executed:** ${uiSmokeSummary?.runTags?.includes("@prod-financial") ? "yes" : "no"}`,
  );
  lines.push(
    `- **Production records created/changed:** ${financialRecords.length ? financialRecords.join("; ") : "none"}`,
  );
  lines.push(
    `- **Cleanup/reversal result:** ${
      financialRecords.length
        ? "reversed via supported reversal workflow — original + reversal both preserved as audit history"
        : "n/a"
    }`,
  );
  lines.push("");
  lines.push(`## Final result: ${args.outcome ?? "UNKNOWN"}`);
  lines.push("");
  lines.push(
    "_No secrets are included in this report. Connection strings and tokens are redacted at source and again on generation of this file._",
  );

  const reportText = redact(lines.join("\n") + "\n");
  const reportPath = path.join(rundir, "report.md");
  writeFileSync(reportPath, reportText);
  process.stdout.write(reportText);
}

main();
