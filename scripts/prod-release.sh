#!/usr/bin/env bash
# Section H — master production release entry point.
#
# Gated sequence, each stage stopping the whole run on failure:
#   PREFLIGHT -> MIGRATION (hash-checked) -> DATABASE VERIFY ->
#   POSTGREST RELOAD (if the plan needs it) -> VPS PRECHECK -> DEPLOY ->
#   UI SMOKE -> FINAL REPORT
#
# Usage:
#   scripts/prod-release.sh <release-plan.json>            # rehearsal: runs
#     every read-only/check stage, stops at the first real mutation gate
#     (migration apply) without touching anything, and reports what WOULD
#     happen next.
#   scripts/prod-release.sh <release-plan.json> --yes       # runs for real,
#     including migration apply and VPS deploy.
#
# `set -e` means any non-zero exit from any stage halts the script
# immediately — there is no path where a later stage runs after an earlier
# one failed.
set -euo pipefail

PLAN="${1:-}"
CONFIRM="${2:-}"
if [ -z "$PLAN" ]; then
  echo "Usage: $0 <release-plan.json> [--yes]" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

YES_FLAG=""
if [ "$CONFIRM" = "--yes" ]; then
  YES_FLAG="--yes"
fi

RELEASE_ID="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).release_id)" "$PLAN")"
RUN_DIR="scripts/prod/releases/${RELEASE_ID}/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RUN_DIR"
STAGES_TSV="$RUN_DIR/stages.tsv"
: > "$STAGES_TSV"

stage() {
  local name="$1"; shift
  local log_file="$RUN_DIR/${name}.log"
  echo ""
  echo "==================== ${name} ===================="
  local started
  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if "$@" 2>&1 | tee "$log_file"; then
    printf '%s\tPASS\t%s\n' "$name" "$started" >> "$STAGES_TSV"
  else
    local code=$?
    printf '%s\tFAIL\t%s\n' "$name" "$started" >> "$STAGES_TSV"
    echo ""
    echo "STAGE '${name}' FAILED — stopping. No later stage will run." >&2
    node scripts/prod/release-report.mjs --plan "$PLAN" --rundir "$RUN_DIR" --outcome FAIL || true
    exit "$code"
  fi
}

HAS_MIGRATION="$(node -e "console.log(!!JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).migration)" "$PLAN")"
NEEDS_RELOAD="$(node -e "console.log(!!JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).postgrest_reload_required)" "$PLAN")"

stage "01-preflight" node scripts/prod/supabase-preflight.mjs --plan "$PLAN"

if [ "$HAS_MIGRATION" = "true" ]; then
  # Run twice by design: the first call (--check) performs every guard
  # (hash check, dry-run, project-ref check) and exits 0 on success without
  # mutating anything — this IS "migration hash check" as its own visible
  # stage, and a genuine failure here (mismatched hash, more than one
  # pending migration, etc.) correctly halts the whole release via
  # stage()'s own exit-on-failure, same as every other stage. The second
  # call (--yes, only when the whole pipeline was invoked with --yes)
  # re-runs every guard from scratch and then performs the real apply.
  #
  # Fixed 2026-08-22: this used to call supabase-migrate.mjs with no flag
  # at all, relying on its own deliberate "refuse without --yes" non-zero
  # exit as an expected checkpoint, worked around with a trailing `|| true`
  # on this line. That never worked: stage()'s own `exit "$code"` on
  # failure is an unconditional process exit that a trailing `|| true` at
  # the call site cannot intercept (that only catches a `return`, not an
  # `exit` from inside the called function) — so the deliberate refusal
  # killed this whole script before stage 03 ever ran, even with a
  # legitimate top-level --yes. supabase-migrate.mjs now has a real,
  # successful-exit --check mode instead of relying on one particular
  # failure being "expected."
  stage "02-migration-hash-check" node scripts/prod/supabase-migrate.mjs --plan "$PLAN" --check
  if [ -n "$YES_FLAG" ]; then
    stage "03-migration-apply" node scripts/prod/supabase-migrate.mjs --plan "$PLAN" --yes
    stage "04-database-verify" node scripts/prod/supabase-verify.mjs --plan "$PLAN"
  else
    echo ""
    echo "Rehearsal mode (no --yes): migration hash check passed; stopping before the real apply."
    node scripts/prod/release-report.mjs --plan "$PLAN" --rundir "$RUN_DIR" --outcome "REHEARSAL-OK"
    exit 0
  fi
else
  echo "Release plan has no migration — skipping migration/verify stages."
fi

if [ "$NEEDS_RELOAD" = "true" ] && [ -n "$YES_FLAG" ]; then
  stage "05-postgrest-reload" node scripts/prod/supabase-reload-postgrest.mjs
fi

stage "06-vps-precheck" node scripts/prod/vps-precheck.mjs --plan "$PLAN"

if [ -n "$YES_FLAG" ]; then
  stage "07-vps-deploy" node scripts/prod/vps-deploy.mjs --plan "$PLAN" --yes
  stage "08-ui-smoke" node scripts/prod/ui-smoke.mjs --plan "$PLAN"
else
  echo ""
  echo "Rehearsal mode (no --yes): vps-precheck passed; stopping before the real deploy."
  node scripts/prod/release-report.mjs --plan "$PLAN" --rundir "$RUN_DIR" --outcome "REHEARSAL-OK"
  exit 0
fi

node scripts/prod/release-report.mjs --plan "$PLAN" --rundir "$RUN_DIR" --outcome PASS
echo ""
echo "Release ${RELEASE_ID} complete. Report: $RUN_DIR/report.md"
