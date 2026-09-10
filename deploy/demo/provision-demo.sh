#!/usr/bin/env bash
# Provision the Hotel PMS DEMO instance on the shared VPS.
#
# Run as root, ONCE, on srv1760881. Idempotent: re-running it is safe and
# will not disturb a demo that is already provisioned.
#
#   sudo bash provision-demo.sh
#
# WHAT IT DOES NOT DO, deliberately:
#   - never touches /opt/infinity-pms, infinity-pms.service, port 3100,
#     the production env file, or the theskwoffhotel.com nginx block;
#   - never reloads nginx (that is a separate, verified step in README.md);
#   - never requests a certificate (certbot is a separate step);
#   - never writes secrets. You upload .env.demo yourself, out of band.
#
# It aborts on the first sign that any of the above assumptions is wrong.

set -euo pipefail

DEMO_USER="pms-demo"
DEMO_DIR="/opt/infinity-pms-demo"
DEMO_PORT="3200"
REPO="https://github.com/allprojex/hotelms.git"
PROD_DIR="/opt/infinity-pms"
PROD_SERVICE="infinity-pms"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m  %s\n' "$*"; }
die()  { printf '\n\033[31mABORT: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root"

# ---------------------------------------------------------------------------
say "Guard: production must be untouched and healthy before we start"
# ---------------------------------------------------------------------------
systemctl is-active --quiet "$PROD_SERVICE" || die "$PROD_SERVICE is not active — fix production before adding a demo"
ok "$PROD_SERVICE is active"
PROD_PID_BEFORE="$(systemctl show "$PROD_SERVICE" -p MainPID --value)"
PROD_SHA_BEFORE="$(git -C "$PROD_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
ok "production PID $PROD_PID_BEFORE at $PROD_SHA_BEFORE (recorded, must be unchanged at the end)"

[ "$DEMO_DIR" != "$PROD_DIR" ] || die "demo directory equals production directory"

# ---------------------------------------------------------------------------
say "Guard: the demo port must be free"
# ---------------------------------------------------------------------------
if ss -ltn "( sport = :$DEMO_PORT )" | tail -n +2 | grep -q .; then
    echo "Something is already listening on $DEMO_PORT:"
    ss -ltnp "( sport = :$DEMO_PORT )" || true
    die "port $DEMO_PORT is occupied. STOPPING rather than killing an unknown process. Investigate, then either free it or pick another port and update the unit, the nginx block and .env.demo together."
fi
ok "port $DEMO_PORT is free"

# ---------------------------------------------------------------------------
say "System user"
# ---------------------------------------------------------------------------
if id -u "$DEMO_USER" >/dev/null 2>&1; then
    ok "user $DEMO_USER already exists"
else
    useradd --system --create-home --home-dir "/var/lib/$DEMO_USER" --shell /usr/sbin/nologin "$DEMO_USER"
    ok "created system user $DEMO_USER (no shell, no login)"
fi

# ---------------------------------------------------------------------------
say "Application directory"
# ---------------------------------------------------------------------------
if [ -d "$DEMO_DIR/.git" ]; then
    ok "$DEMO_DIR already a checkout"
else
    mkdir -p "$DEMO_DIR"
    git clone "$REPO" "$DEMO_DIR"
    ok "cloned into $DEMO_DIR"
fi
chown -R "$DEMO_USER:$DEMO_USER" "$DEMO_DIR"
chmod 755 "$DEMO_DIR"
ok "owned by $DEMO_USER"

# Let the demo user run git in its own directory without a "dubious ownership"
# refusal, without granting anything global.
sudo -u "$DEMO_USER" git config --global --add safe.directory "$DEMO_DIR" 2>/dev/null || true

# ---------------------------------------------------------------------------
say "Environment file"
# ---------------------------------------------------------------------------
if [ -f "$DEMO_DIR/.env.demo" ]; then
    chown "$DEMO_USER:$DEMO_USER" "$DEMO_DIR/.env.demo"
    chmod 600 "$DEMO_DIR/.env.demo"
    ok ".env.demo present, ownership and mode 0600 enforced"

    # Fail closed on the one mistake that would be catastrophic: demo config
    # pointing at the production database.
    if grep -q "texhuavnrdhaohqzlyqw" "$DEMO_DIR/.env.demo"; then
        die ".env.demo references the PRODUCTION Supabase project. Refusing to continue."
    fi
    grep -q "akcppyymgoubsqedpkch" "$DEMO_DIR/.env.demo" || die ".env.demo does not reference the demo Supabase project akcppyymgoubsqedpkch"
    grep -q "^PORT=\"\?$DEMO_PORT" "$DEMO_DIR/.env.demo" || die ".env.demo does not set PORT=$DEMO_PORT"
    ok "env names the demo project only, on port $DEMO_PORT"
else
    echo
    echo "    .env.demo is NOT present at $DEMO_DIR/.env.demo."
    echo "    Upload it now (see README.md step 3), then re-run this script."
    echo "    Nothing further will be done until it exists."
    exit 0
fi

# ---------------------------------------------------------------------------
say "Build (nice'd, so production keeps the CPU it needs)"
# ---------------------------------------------------------------------------
cd "$DEMO_DIR"
sudo -u "$DEMO_USER" git fetch origin main --quiet
sudo -u "$DEMO_USER" git checkout main --quiet
sudo -u "$DEMO_USER" git reset --hard origin/main --quiet
BUILD_SHA="$(git rev-parse HEAD)"
ok "checked out main at $BUILD_SHA"

free -m | head -2
df -h "$DEMO_DIR" | tail -1

# --max-old-space-size keeps the bundler from ballooning on a 4 GB box that is
# also serving production. nice/ionice keep it off production's toes.
nice -n 15 ionice -c3 sudo -u "$DEMO_USER" env NODE_OPTIONS="--max-old-space-size=1536" npm ci --no-audit --no-fund
nice -n 15 ionice -c3 sudo -u "$DEMO_USER" env NODE_OPTIONS="--max-old-space-size=1536" npm run build
ok "built"

[ -f "$DEMO_DIR/.output/server/index.mjs" ] || die "build produced no .output/server/index.mjs"
ok "server bundle present"

# The VITE_ values are inlined at build time, so prove the bundle really
# carries the demo identity rather than production's.
if grep -rq "texhuavnrdhaohqzlyqw" "$DEMO_DIR/.output" 2>/dev/null; then
    die "the built bundle contains the PRODUCTION Supabase ref. Refusing to install it."
fi
grep -rq "akcppyymgoubsqedpkch" "$DEMO_DIR/.output" 2>/dev/null \
    && ok "bundle carries the demo Supabase ref" \
    || echo "    note: demo ref not found as a literal in .output (may be chunked); verify via /api/public/health after start"

# ---------------------------------------------------------------------------
say "systemd unit"
# ---------------------------------------------------------------------------
install -m 644 "$DEMO_DIR/deploy/demo/infinity-pms-demo.service" /etc/systemd/system/infinity-pms-demo.service
ok "installed /etc/systemd/system/infinity-pms-demo.service"
systemctl daemon-reload
systemctl enable infinity-pms-demo.service
systemctl restart infinity-pms-demo.service
sleep 4
systemctl is-active --quiet infinity-pms-demo.service || { journalctl -u infinity-pms-demo -n 40 --no-pager; die "demo service did not become active"; }
ok "infinity-pms-demo.service active (PID $(systemctl show infinity-pms-demo -p MainPID --value))"

# ---------------------------------------------------------------------------
say "Local health"
# ---------------------------------------------------------------------------
for i in 1 2 3 4 5 6 7 8 9 10; do
    CODE="$(curl -s -o /tmp/demo-health.json -w '%{http_code}' --max-time 10 "http://127.0.0.1:$DEMO_PORT/api/public/health" || true)"
    [ "$CODE" = "200" ] && break
    sleep 3
done
[ "$CODE" = "200" ] || { cat /tmp/demo-health.json 2>/dev/null; die "demo health did not return 200 (got $CODE)"; }
cat /tmp/demo-health.json; echo
grep -q '"ok": *true' /tmp/demo-health.json || die "demo health returned 200 but a check is not ok"
ok "demo local health 200 on 127.0.0.1:$DEMO_PORT"

# ---------------------------------------------------------------------------
say "Guard: production must be exactly as we found it"
# ---------------------------------------------------------------------------
PROD_PID_AFTER="$(systemctl show "$PROD_SERVICE" -p MainPID --value)"
PROD_SHA_AFTER="$(git -C "$PROD_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
systemctl is-active --quiet "$PROD_SERVICE" || die "production is no longer active"
[ "$PROD_PID_AFTER" = "$PROD_PID_BEFORE" ] || die "production PID changed ($PROD_PID_BEFORE -> $PROD_PID_AFTER) — production was restarted, which must not happen"
[ "$PROD_SHA_AFTER" = "$PROD_SHA_BEFORE" ] || die "production SHA changed"
curl -fsS --max-time 10 http://127.0.0.1:3100/api/public/health >/dev/null || die "production health check failed"
ok "production untouched: same PID $PROD_PID_AFTER, same SHA, health 200"

say "Done. Demo is running on 127.0.0.1:$DEMO_PORT."
cat <<EOF

    NEXT, in this order (see deploy/demo/README.md):
      4. DNS      point app.infinitytechub.com at this host
      5. Nginx    install the server block, nginx -t, then reload
      6. TLS      certbot --nginx -d app.infinitytechub.com

    Demo SHA:  $BUILD_SHA
    Service:   infinity-pms-demo.service
    Port:      $DEMO_PORT
EOF
