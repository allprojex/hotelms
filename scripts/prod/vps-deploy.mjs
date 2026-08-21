#!/usr/bin/env node
// Section D — VPS deploy (write path).
//
// REVISED (2026-08-21 human setup): the actual fetch/ff-only-merge/
// build/restart/health/log-tail sequence is now performed by a reviewed,
// root-owned server-side wrapper (production.config.json's
// vps_deploy_wrapper, /usr/local/sbin/deploy-infinity-pms) invoked through
// one exact, narrow NOPASSWD sudoers entry for the claude-deploy SSH user.
// This script does NOT recreate that sequence itself over plain SSH —
// doing so would either fail (claude-deploy has no general sudo) or, if it
// somehow succeeded some other way, would bypass the reviewed, restricted
// deploy design entirely. This script's job is now only: verify
// preconditions -> invoke exactly `sudo -n <wrapper>` -> verify the
// wrapper's own reported outcome -> add the one check the wrapper can't do
// itself (public, external health, since the wrapper only checks local).
//
// Requires --yes to actually invoke the wrapper; without it, every
// precondition check runs and it stops just before the mutation.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  loadProductionConfig,
  assertHumanConfirmed,
  assertGitRemoteMatches,
  log,
  pass,
  fail,
} from "./lib/guard.mjs";
import { loadReleasePlan } from "./lib/release-plan.mjs";
import {
  assertVpsRemoteIdentity,
  assertVpsIdentity,
  assertVpsCleanTree,
  getVpsHeadSha,
  runDeployWrapper,
  remoteHealthcheck,
} from "./lib/vps.mjs";

const execFileAsync = promisify(execFile);
const LABEL = "vps-deploy";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--plan") out.plan = argv[++i];
    if (argv[i] === "--yes") out.yes = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { plan } = loadReleasePlan(args.plan);

  const config = loadProductionConfig();
  assertHumanConfirmed(config);
  pass(LABEL, "human_confirmation.confirmed is true");

  assertGitRemoteMatches(config);
  pass(LABEL, `local git remote matches expected repo (${config.github_repo})`);

  await execFileAsync("git", ["fetch", "origin", "main"]);
  const expected = (await execFileAsync("git", ["rev-parse", "origin/main"])).stdout.trim();
  if (expected !== plan.approved_git_sha) {
    throw new Error(
      `origin/main (${expected}) does not match the release plan's approved_git_sha (${plan.approved_git_sha}). Refusing to deploy.`,
    );
  }
  pass(LABEL, `origin/main matches the release plan's approved commit (${expected})`);

  log(LABEL, `Connecting via ssh host alias "${config.ssh_host_alias}" ...`);
  const { remoteUser, remoteHostname } = await assertVpsRemoteIdentity(config);
  pass(LABEL, `SSH identity verified: ${remoteUser}@${remoteHostname}`);

  const { remotePwd, remoteOrigin } = await assertVpsIdentity(config);
  pass(LABEL, `remote application directory matches (${remotePwd})`);
  pass(LABEL, `remote git remote matches expected repo (${remoteOrigin})`);

  await assertVpsCleanTree(config);
  pass(LABEL, "remote working tree is clean");

  const beforeSha = await getVpsHeadSha(config);
  log(LABEL, `remote HEAD before deploy: ${beforeSha}`);

  if (!args.yes) {
    throw new Error(
      "Refusing to deploy without --yes. Every precondition above passed — re-read them, then rerun with --yes appended.",
    );
  }

  log(LABEL, `Invoking the server-side deploy wrapper: sudo -n ${config.vps_deploy_wrapper} ...`);
  const wrapperRun = await runDeployWrapper(config);
  process.stdout.write(wrapperRun.stdout);
  if (wrapperRun.stderr?.trim()) log(LABEL, `stderr: ${wrapperRun.stderr.trim()}`);
  pass(LABEL, "deploy wrapper completed");

  const finalSha = await getVpsHeadSha(config);
  if (finalSha !== plan.approved_git_sha) {
    throw new Error(
      `Final remote HEAD (${finalSha}) does not match the approved commit (${plan.approved_git_sha}). ` +
        "The wrapper ran, but did not land on the expected commit — investigate before trusting this deploy.",
    );
  }
  pass(LABEL, `final remote SHA verified: ${finalSha}`);

  // Authoritative and fatal: this VPS is shared with another app on port
  // 3000 (the earlier "loopback quirk" finding was actually just probing
  // the wrong app's port — see docs/prod-release-runbook.md's "known VPS
  // findings"). Hotel PMS's own local health check, on its own confirmed
  // port, must gate a real deploy — it is not tolerated as flaky.
  const localHealth = await remoteHealthcheck(config);
  process.stdout.write(localHealth.stdout);
  pass(LABEL, `local health check on 127.0.0.1:${config.vps_local_health_port} passed`);

  log(LABEL, `Verifying public health at https://${config.production_domain} ...`);
  let publicHealthOk = false;
  try {
    const publicHealth = await execFileAsync(
      "bash",
      ["scripts/healthcheck.sh", `https://${config.production_domain}`],
      { timeout: 20_000 },
    );
    process.stdout.write(publicHealth.stdout);
    publicHealthOk = true;
  } catch (e) {
    fail(LABEL, `public health check failed: ${e.stdout ?? e.message}`);
  }
  if (!publicHealthOk) {
    throw new Error(
      "Public health check failed after deploy. The wrapper reported success and the local check passed, " +
        "but the public endpoint did not respond healthy — investigate Nginx/DNS/TLS before declaring success.",
    );
  }
  pass(LABEL, "public health check passed");

  pass(LABEL, `deploy complete: ${beforeSha} -> ${finalSha}`);
}

main().catch((e) => {
  fail(LABEL, e.message);
  process.exit(1);
});
