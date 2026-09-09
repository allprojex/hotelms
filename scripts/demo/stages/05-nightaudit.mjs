// Stage 5 — close the books for every past business date.
//
// The canonical mechanism is run_night_audit(), and this stage calls it first
// for every date in the operating window. On this schema that RPC fails on
// every call:
//
//   42804: column "status" is of type night_audit_status but expression is of
//          type text — "You will need to rewrite or cast the expression."
//
// (run_night_audit inserts an unqualified CASE ... THEN 'failed' ELSE
// 'completed' END into night_audits.status with no cast.) The function is
// therefore unusable in production too; it is reported as a defect with a
// focused fix proposed separately, and NOT patched into the demo database,
// which must stay schema-identical to production.
//
// So that the demo is not left with three months of guests who never checked
// out, this stage then performs the two state transitions the night audit
// would have made, as the general manager:
//
//   * departures whose check-out date has passed are checked out — the
//     reservations UPDATE fires tg_autopost_reservation →
//     post_reservation_checkout → post_journal, so the folio journal is still
//     written by the application's own posting logic, dated on the guest's
//     actual check-out date;
//   * bookings whose arrival date passed without a check-in are marked
//     no_show, exactly as the audit's own loop does.
//
// Rerunnable: both passes are filtered on current status, so a second run
// finds nothing to do.

import { day } from "../lib/random.mjs";
import { loadStaffClients } from "./04-operations.mjs";

const HISTORY_DAYS = 86;

export async function run({ ctx, admin, signIn, log }) {
  const pid = ctx.propertyId;
  const { gm } = await loadStaffClients({ ctx, admin, signIn });
  const start = day(ctx.asOf, -HISTORY_DAYS);

  if (ctx.dryRun) {
    log("  · dry run — no night audits attempted");
    return {};
  }

  let audited = 0;
  let firstError = null;
  for (let i = 0; i <= HISTORY_DAYS; i++) {
    const date = day(start, i);
    const res = await gm.tryRpc("run_night_audit", { _property_id: pid, _business_date: date, _lock_period: false });
    if (res.ok) audited++;
    else if (!firstError) firstError = `${res.status} ${JSON.stringify(res.body).slice(0, 240)}`;
  }
  log(`  · run_night_audit succeeded for ${audited} of ${HISTORY_DAYS + 1} dates`);
  if (firstError) log(`  ! run_night_audit is failing: ${firstError}`);

  // ── departures still shown as in house ────────────────────────────────────
  const stale = await gm.select(
    "reservations",
    `select=id,code,check_out&property_id=eq.${pid}&status=eq.checked_in&check_out=lte.${ctx.asOf}&order=check_out.asc&limit=5000`,
  );
  let checkedOut = 0;
  for (let i = 0; i < stale.length; i += 25) {
    const slice = stale.slice(i, i + 25);
    await gm.update("reservations", `id=in.(${slice.map((r) => r.id).join(",")})`, { status: "checked_out" });
    checkedOut += slice.length;
  }
  log(`  · checked out ${checkedOut} departed stays (folio journals posted by the checkout trigger)`);

  // ── arrivals that never turned up ─────────────────────────────────────────
  const missed = await gm.select(
    "reservations",
    `select=id&property_id=eq.${pid}&status=eq.confirmed&check_in=lt.${ctx.asOf}&limit=5000`,
  );
  let noShows = 0;
  for (let i = 0; i < missed.length; i += 25) {
    const slice = missed.slice(i, i + 25);
    await gm.update("reservations", `id=in.(${slice.map((r) => r.id).join(",")})`, { status: "no_show" });
    noShows += slice.length;
  }
  log(`  · marked ${noShows} no-shows`);

  const posted = await gm.select("journal_entries", `select=id&property_id=eq.${pid}&source=eq.folio&limit=5000`);
  log(`  · folio journal entries now on file: ${posted.length}`);

  return { state: { nightAuditWorking: audited > 0 } };
}
