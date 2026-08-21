#!/usr/bin/env node
// Shared VPS SSH helpers. Every remote command is a fixed string built only
// from production.config.json's own validated fields — never from argv or
// any other caller-supplied input — so there is no command-injection
// surface here beyond what production.config.json itself already commits.
//
// Confirmed access model (2026-08-21 human setup): the `claude-deploy` SSH
// user has NO general sudo access on this VPS. The only sudo it can run,
// under a NOPASSWD sudoers entry scoped to exactly one command, is the
// root-owned wrapper at production.config.json's vps_deploy_wrapper
// (/usr/local/sbin/deploy-infinity-pms, mode 750). That wrapper — reviewed
// separately, not owned by this toolkit — does the actual fetch/ff-only
// merge/build/restart/health/log-tail sequence itself. This file therefore
// never attempts `sudo systemctl restart`, `sudo -E bash
// deploy-hostinger.sh`, or any other ad-hoc sudo command: the deploy path
// is exactly `sudo -n <vps_deploy_wrapper>`, nothing else, ever.
//
// Status/read-only checks (systemctl is-active, hostname, whoami, git
// status) are attempted WITHOUT sudo — querying a system unit's state is a
// read-only D-Bus call most systemd/polkit default policies permit for any
// local user, unlike start/stop/restart. If claude-deploy's actual
// permissions turn out narrower than that on this box, these throw a clear,
// specific error rather than silently reporting "healthy" — see
// assertServiceActive's catch branch. Nothing here escalates sudo to work
// around a permission gap; that would violate the reviewed, narrow sudoers
// scope by design.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GuardError } from "./guard.mjs";

const execFileAsync = promisify(execFile);

export async function ssh(config, remoteCommand, opts = {}) {
  return execFileAsync("ssh", [config.ssh_host_alias, remoteCommand], {
    timeout: opts.timeout ?? 30_000,
    maxBuffer: 5 * 1024 * 1024,
  });
}

function assertVpsFieldsPresent(config) {
  const required = ["vps_expected_hostname", "vps_ssh_user", "vps_deploy_wrapper"];
  const missing = required.filter((k) => !config[k]);
  if (missing.length) {
    throw new GuardError(
      `production.config.json is missing VPS field(s) needed for this check: ${missing.join(", ")}`,
    );
  }
}

/** Confirms the SSH alias actually connects, and to the expected user@host —
 * not just "some host answered". Runs `whoami` and `hostname` in one round
 * trip, no sudo. */
export async function assertVpsRemoteIdentity(config) {
  assertVpsFieldsPresent(config);
  let stdout;
  try {
    ({ stdout } = await ssh(config, "whoami && hostname"));
  } catch (e) {
    throw new GuardError(
      `Could not connect via ssh host alias "${config.ssh_host_alias}": ${e.message}`,
    );
  }
  const [remoteUser, remoteHostname] = stdout.trim().split("\n");
  if (remoteUser !== config.vps_ssh_user) {
    throw new GuardError(
      `Connected as "${remoteUser}", expected "${config.vps_ssh_user}". Refusing — wrong SSH identity.`,
    );
  }
  if (remoteHostname !== config.vps_expected_hostname) {
    throw new GuardError(
      `Remote hostname is "${remoteHostname}", expected "${config.vps_expected_hostname}". ` +
        "Refusing — this SSH alias may be pointed at the wrong machine.",
    );
  }
  return { remoteUser, remoteHostname };
}

/** Confirms the remote app directory and its git remote match config. Plain
 * (non-sudo) commands — the app directory must be at least readable by
 * claude-deploy for this to succeed; if it isn't, this throws with the raw
 * permission error rather than escalating. */
export async function assertVpsIdentity(config) {
  const { stdout } = await ssh(
    config,
    `cd ${config.vps_app_path} && pwd && git remote get-url origin`,
  );
  const [remotePwd, remoteOrigin] = stdout.trim().split("\n");
  if (remotePwd !== config.vps_app_path) {
    throw new GuardError(
      `Remote app directory is "${remotePwd}", expected "${config.vps_app_path}"`,
    );
  }
  const normalized = remoteOrigin
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");
  if (!normalized.toLowerCase().endsWith(config.github_repo.toLowerCase())) {
    throw new GuardError(
      `Remote git remote (${remoteOrigin}) does not match expected repo (${config.github_repo})`,
    );
  }
  return { remotePwd, remoteOrigin };
}

export async function assertVpsCleanTree(config) {
  const { stdout } = await ssh(config, `cd ${config.vps_app_path} && git status --porcelain`);
  if (stdout.trim()) {
    throw new GuardError(`Remote working tree is not clean:\n${stdout}`);
  }
}

export async function getVpsHeadSha(config) {
  const { stdout } = await ssh(config, `cd ${config.vps_app_path} && git rev-parse HEAD`);
  return stdout.trim();
}

/** Reads the current git status/HEAD without asserting anything — used by
 * the read-only precheck/rehearsal path, which reports these rather than
 * failing on a dirty tree (only the real deploy path needs to fail on one). */
export async function readVpsGitState(config) {
  const { stdout } = await ssh(
    config,
    `cd ${config.vps_app_path} && echo "SHA:$(git rev-parse HEAD)" && echo "STATUS_LINES:$(git status --porcelain | wc -l)"`,
  );
  const sha = stdout.match(/SHA:([0-9a-f]{40})/)?.[1] ?? null;
  const statusLines = Number(stdout.match(/STATUS_LINES:(\d+)/)?.[1] ?? "-1");
  return { sha, dirty: statusLines > 0, statusLines };
}

/** Queries systemd unit state WITHOUT sudo. `systemctl is-active` is a
 * read-only D-Bus query most default polkit policies allow for any local
 * user (unlike start/stop/restart, which do require privilege) — so this
 * deliberately does not use sudo. If claude-deploy's actual permissions on
 * this box are narrower than that, this throws the specific error rather
 * than falling back to sudo (see this file's header comment: never
 * escalate sudo to work around a permission gap). Callers that need a
 * health signal even when this fails should fall back to
 * remoteHealthcheck(), which needs no special permission at all. */
export async function assertServiceActive(config) {
  try {
    const { stdout } = await ssh(config, `systemctl is-active ${config.systemd_service}`);
    const status = stdout.trim();
    if (status !== "active") {
      throw new GuardError(
        `systemd service "${config.systemd_service}" is not active (status: ${status})`,
      );
    }
    return status;
  } catch (e) {
    if (e instanceof GuardError) throw e;
    throw new GuardError(
      `Could not query "systemctl is-active ${config.systemd_service}" without sudo (${e.message}). ` +
        "Not escalating to sudo for this — use remoteHealthcheck() as the non-sudo health signal instead.",
    );
  }
}

/** Local (loopback) health check on the VPS itself, against the port this
 * specific app actually listens on — NOT a hardcoded/guessed default. This
 * VPS is shared with at least one other app that also uses port 3000 (see
 * docs/prod-release-runbook.md's "known VPS findings"), so there is
 * deliberately no fallback default port here: config.vps_local_health_port
 * is required, and this throws rather than silently guessing if it's
 * missing. This check is authoritative for Hotel PMS's own local health —
 * callers must treat a failure here as fatal, not something to tolerate. */
export async function remoteHealthcheck(config) {
  if (!config.vps_local_health_port) {
    throw new GuardError(
      "production.config.json is missing vps_local_health_port — refusing to guess a port on a VPS " +
        "shared with another app.",
    );
  }
  // healthcheck.sh itself appends /api/public/health to whatever base URL
  // it's given — pass the base only, or the path would be doubled.
  const baseUrl = `http://127.0.0.1:${config.vps_local_health_port}`;
  return ssh(config, `bash ${config.vps_app_path}/scripts/healthcheck.sh ${baseUrl}`);
}

/** The ONLY deploy/mutation path this toolkit ever invokes on the VPS: the
 * reviewed, root-owned wrapper, via the exact narrow NOPASSWD sudoers entry
 * that was set up for it. `-n` (non-interactive) makes sudo fail loudly
 * instead of hanging on a password prompt if the sudoers scope was ever
 * changed unexpectedly. This function deliberately does not accept any
 * extra arguments to append to the wrapper invocation — the wrapper's own
 * behavior is fixed, reviewed code, not something this toolkit parameterizes. */
export async function runDeployWrapper(config, opts = {}) {
  assertVpsFieldsPresent(config);
  return ssh(config, `sudo -n ${config.vps_deploy_wrapper}`, {
    timeout: opts.timeout ?? 10 * 60_000,
  });
}
