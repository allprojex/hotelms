#!/usr/bin/env bash
set -Eeuo pipefail

# Deploy one explicitly approved commit to the isolated Demo service.
# Usage (as root): deploy-demo.sh <40-character-approved-git-sha>

DEMO_DIR="/opt/infinity-pms-demo"
DEMO_USER="pms-demo"
DEMO_SERVICE="infinity-pms-demo.service"
DEMO_PORT="3200"
DEMO_REF="akcppyymgoubsqedpkch"
DEMO_SITE="app.infinitytechub.com"
PRODUCTION_DIR="/opt/infinity-pms"
PRODUCTION_SERVICE="infinity-pms.service"
PRODUCTION_PORT="3100"
PRODUCTION_REF="texhuavnrdhaohqzlyqw"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

APPROVED_SHA="${1:-}"
[[ "$APPROVED_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "provide the approved 40-character Git SHA"
[[ "$(id -u)" -eq 0 ]] || fail "run through sudo/root"
[[ "$DEMO_DIR" != "$PRODUCTION_DIR" ]] || fail "Demo and Production directories match"
[[ -f "$DEMO_DIR/.env.demo" ]] || fail "Demo environment file is missing"

grep -q "$DEMO_REF" "$DEMO_DIR/.env.demo" || fail "Demo project reference is absent"
if grep -q "$PRODUCTION_REF" "$DEMO_DIR/.env.demo"; then
  fail "Production project reference found in Demo environment"
fi
grep -Eq '^PORT="?3200"?$' "$DEMO_DIR/.env.demo" || fail "Demo port is not 3200"

PRODUCTION_PID_BEFORE="$(systemctl show "$PRODUCTION_SERVICE" -p MainPID --value)"
PRODUCTION_SHA_BEFORE="$(git -c safe.directory="$PRODUCTION_DIR" -C "$PRODUCTION_DIR" rev-parse HEAD)"
systemctl is-active --quiet "$PRODUCTION_SERVICE" || fail "Production is not active"
curl -fsS --max-time 10 "http://127.0.0.1:$PRODUCTION_PORT/api/public/health" >/dev/null \
  || fail "Production health check failed before deployment"

DIRTY_EXCEPT_LOCK="$({
  git -c safe.directory="$DEMO_DIR" -C "$DEMO_DIR" status --porcelain --untracked-files=all
} | grep -vE '^.. package-lock\.json$' || true)"
[[ -z "$DIRTY_EXCEPT_LOCK" ]] || fail "Demo checkout has changes other than package-lock.json"

sudo -u "$DEMO_USER" git -c safe.directory="$DEMO_DIR" -C "$DEMO_DIR" fetch origin "$APPROVED_SHA"
FETCHED_SHA="$(git -c safe.directory="$DEMO_DIR" -C "$DEMO_DIR" rev-parse FETCH_HEAD^{commit})"
[[ "$FETCHED_SHA" = "$APPROVED_SHA" ]] || fail "fetched commit does not match approved SHA"

# Discard only a stale lockfile left by an earlier failed deployment. The
# approved commit's lockfile is authoritative and must stay paired with its
# package.json; preserving an older server copy makes npm ci fail as soon as a
# dependency changes. No hard reset, clean, or broad restore is permitted.
sudo -u "$DEMO_USER" git -c safe.directory="$DEMO_DIR" -C "$DEMO_DIR" restore package-lock.json
sudo -u "$DEMO_USER" git -c safe.directory="$DEMO_DIR" -C "$DEMO_DIR" checkout --detach "$APPROVED_SHA"

cd "$DEMO_DIR"
nice -n 15 ionice -c3 sudo -u "$DEMO_USER" \
  env NODE_OPTIONS="--max-old-space-size=1536" npm ci --no-audit --no-fund
nice -n 15 ionice -c3 sudo -u "$DEMO_USER" \
  env NODE_OPTIONS="--max-old-space-size=1536" npm run build -- --mode demo

[[ -f "$DEMO_DIR/.output/server/index.mjs" ]] || fail "server bundle is missing"
CLIENT_DIR="$DEMO_DIR/.output/public/assets"
[[ -d "$CLIENT_DIR" ]] || fail "client bundle is missing"
if grep -rq "$PRODUCTION_REF" "$DEMO_DIR/.output" 2>/dev/null; then
  fail "Production project reference found in Demo bundle"
fi
grep -rq "$DEMO_REF" "$CLIENT_DIR" || fail "Demo project reference absent from client bundle"
grep -rq "$DEMO_SITE" "$CLIENT_DIR" || fail "Demo site URL absent from client bundle"

systemctl restart "$DEMO_SERVICE"
for _ in {1..10}; do
  if curl -fsS --max-time 10 "http://127.0.0.1:$DEMO_PORT/api/public/health" >/dev/null; then
    break
  fi
  sleep 3
done
systemctl is-active --quiet "$DEMO_SERVICE" || fail "Demo service is inactive"
curl -fsS --max-time 10 "http://127.0.0.1:$DEMO_PORT/api/public/health" >/dev/null \
  || fail "Demo health check failed"

PRODUCTION_PID_AFTER="$(systemctl show "$PRODUCTION_SERVICE" -p MainPID --value)"
PRODUCTION_SHA_AFTER="$(git -c safe.directory="$PRODUCTION_DIR" -C "$PRODUCTION_DIR" rev-parse HEAD)"
[[ "$PRODUCTION_PID_AFTER" = "$PRODUCTION_PID_BEFORE" ]] || fail "Production PID changed"
[[ "$PRODUCTION_SHA_AFTER" = "$PRODUCTION_SHA_BEFORE" ]] || fail "Production SHA changed"
systemctl is-active --quiet "$PRODUCTION_SERVICE" || fail "Production became inactive"
curl -fsS --max-time 10 "http://127.0.0.1:$PRODUCTION_PORT/api/public/health" >/dev/null \
  || fail "Production health check failed after deployment"

echo "Demo deployment completed for $APPROVED_SHA"
