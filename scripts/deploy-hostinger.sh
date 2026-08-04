#!/usr/bin/env bash
# Deploy/update ThesKwoff Hotel on a Hostinger Ubuntu VPS.
# Run from /opt/infinity-pms after cloning the GitHub repository.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/infinity-pms}"
SERVICE_NAME="${SERVICE_NAME:-infinity-pms}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env.production}"

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

cd "$APP_DIR"

command -v node >/dev/null 2>&1 || die "node is not installed"
command -v npm >/dev/null 2>&1 || die "npm is not installed"

NODE_OK="$(node -p "const [a,b]=process.versions.node.split('.').map(Number); Number(a === 22 && b >= 12)")"
if [ "$NODE_OK" != "1" ]; then
  die "Node $(node -v) is unsupported. Use Node 22.12 or newer."
fi

if [ ! -f "$ENV_FILE" ]; then
  die "missing $ENV_FILE. Copy .env.production.example and fill it in first."
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

for key in SUPABASE_URL SUPABASE_PUBLISHABLE_KEY VITE_SUPABASE_URL VITE_SUPABASE_PUBLISHABLE_KEY; do
  if [ -z "${!key:-}" ]; then
    die "$key is required in $ENV_FILE"
  fi
done

log "installing dependencies"
# --include=dev: vite.config.ts imports @lovable.dev/vite-tanstack-config, a
# devDependency needed to run the build itself. Without this flag, sourcing
# .env.production's NODE_ENV=production above causes npm to omit
# devDependencies, so the package is silently missing and `vite build` fails
# with "Cannot find package '@lovable.dev/vite-tanstack-config'".
npm ci --include=dev

log "building production bundle"
npm run build

log "restarting $SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"
sudo systemctl --no-pager --full status "$SERVICE_NAME" || true

log "probing local health endpoint"
curl -fsS "http://127.0.0.1:${PORT:-3000}/api/public/health" || true
printf '\n'
