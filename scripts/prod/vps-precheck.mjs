#!/usr/bin/env node
// Section D — VPS precheck (read-only).
//
// REVISED (2026-08-21 human setup): claude-deploy has no general sudo on
// this VPS — only a narrow NOPASSWD entry for the one deploy wrapper (see
// lib/vps.mjs's header comment). This precheck therefore never uses sudo:
// systemd state is queried directly (systemctl is-active is a read-only
// D-Bus call most default polkit policies allow any local user to make),
// and if that ever turns out to be blocked on this box, this script falls
// back to the local HTTP health endpoint as its service-health signal
// instead of escalating to sudo — see the catch branch below. This is the
// "adapt the read-only precheck safely" instruction: prefer a non-sudo
// signal, never broaden sudo for convenience.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadReleasePlan } from "./lib/release-plan.mjs";
import { loadProductionConfig, assertGitRemoteMatches, log, pass, fail } from "./lib/guard.mjs";
import {
  assertVpsRemoteIdentity,
  assertVpsIdentity,
  readVpsGitState,
  assertServiceActive,
  remoteHealthcheck,
} from "./lib/vps.mjs";

const execFileAsync = promisify(execFile);
const LABEL = "vps-precheck";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--plan") out.plan = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadProductionConfig();
  assertGitRemoteMatches(config);
  pass(LABEL, `local git remote matches expected repo (${config.github_repo})`);

  let approvedSha = null;
  if (args.plan) {
    approvedSha = loadReleasePlan(args.plan).plan.approved_git_sha;
  }

  log(LABEL, `Connecting via ssh host alias "${config.ssh_host_alias}" ...`);

  const { remoteUser, remoteHostname } = await assertVpsRemoteIdentity(config);
  pass(LABEL, `SSH identity verified: ${remoteUser}@${remoteHostname}`);

  const { remotePwd, remoteOrigin } = await assertVpsIdentity(config);
  pass(LABEL, `application directory matches (${remotePwd})`);
  pass(LABEL, `remote git remote matches expected repo (${remoteOrigin})`);

  const gitState = await readVpsGitState(config);
  log(LABEL, `remote HEAD is currently ${gitState.sha} (dirty: ${gitState.dirty})`);
  if (gitState.dirty) {
    log(
      LABEL,
      `NOTE: remote working tree has ${gitState.statusLines} uncommitted line(s) — a real deploy would refuse this`,
    );
  }

  await execFileAsync("git", ["fetch", "origin", "main"]);
  const expected = (await execFileAsync("git", ["rev-parse", "origin/main"])).stdout.trim();
  log(LABEL, `local view of origin/main is ${expected}`);
  if (approvedSha && expected !== approvedSha) {
    throw new Error(
      `origin/main (${expected}) does not match the release plan's approved_git_sha (${approvedSha}). ` +
        "Refusing — the plan approves one specific commit, and main has moved past or differs from it.",
    );
  }
  if (approvedSha) pass(LABEL, "origin/main matches the release plan's approved commit");
  if (gitState.sha === expected) {
    log(LABEL, "remote is already at origin/main — a deploy would be a no-op (still safe to run)");
  }

  let serviceStatus;
  try {
    serviceStatus = await assertServiceActive(config);
    pass(LABEL, `systemd service "${config.systemd_service}" is active (queried without sudo)`);
  } catch (e) {
    log(LABEL, `systemctl query unavailable to claude-deploy without sudo (${e.message})`);
    log(
      LABEL,
      "falling back to the local HTTP health endpoint as the service-health signal — not escalating to sudo",
    );
    serviceStatus = "unknown (see health check below)";
  }

  // Authoritative and fatal: this VPS is shared with another app that also
  // used to answer on port 3000 (the earlier "loopback quirk" finding was
  // actually just probing the wrong app's port, per the confirmed
  // vps_local_health_port). Hotel PMS's own local health check on its own
  // port must be treated as a real signal, not tolerated as flaky.
  const health = await remoteHealthcheck(config);
  process.stdout.write(health.stdout);
  pass(LABEL, `local health check on 127.0.0.1:${config.vps_local_health_port} passed`);

  log(LABEL, `Verifying public health at https://${config.production_domain} ...`);
  const publicHealth = await execFileAsync(
    "bash",
    ["scripts/healthcheck.sh", `https://${config.production_domain}`],
    { timeout: 20_000 },
  );
  process.stdout.write(publicHealth.stdout);
  pass(LABEL, "public health check passed");

  log(
    LABEL,
    `precheck summary: remote_sha=${gitState.sha} expected_sha=${expected} service_status=${serviceStatus} local_health_port=${config.vps_local_health_port}`,
  );
}

main().catch((e) => {
  fail(LABEL, e.message);
  process.exit(1);
});
