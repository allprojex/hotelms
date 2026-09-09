#!/usr/bin/env node
// Takes every calculated payroll run through the rest of its life:
//
//   acknowledge warnings → lock for review → approve → finalize →
//   generate payslips → publish payslips
//
// Each step is the application's own RPC, in the order the Payroll Processing
// screens call them. The one step that is NOT here is the calculation itself:
// that runs in the application (calculateDraftPayrollRun → payroll-calculation.ts
// → payroll_store_calculation_results). See scripts/demo/README.md for how to
// drive it against a running instance; this script refuses to invent results.
//
//   node scripts/demo/payroll-lifecycle.mjs [--dry-run]

import { randomUUID } from "node:crypto";
import { loadContext, signIn, serviceClient } from "./lib/env.mjs";
import { loadStaffClients } from "./stages/04-operations.mjs";

const ctx = loadContext();
const service = serviceClient(ctx);
const admin = await signIn(ctx, ctx.adminEmail, ctx.adminPassword, "demo.admin");
const pid = ctx.propertyId;

// payroll_settings.require_payroll_separation_of_duties is on, so whoever
// submits a run may not approve it. The HR manager reviews and submits; the
// administrator approves. Those are the roles the permission matrix actually
// grants payroll approval to — hr, hotel_owner and super_admin; the general
// manager holds none of them.
const { hr } = await loadStaffClients({
  ctx,
  admin,
  signIn: (email, password, label) => signIn(ctx, email, password, label),
});

const runs = await service.select(
  "payroll_runs",
  `select=id,run_code,status,current_calculation_version,employee_count,net_total&property_id=eq.${pid}&order=run_code.asc&limit=50`,
);
if (!runs.length) {
  console.log("No payroll runs found — run the payroll stage of the seeder first.");
  process.exit(0);
}

for (const run of runs) {
  console.log(`\n${run.run_code} — status ${run.status}, ${run.employee_count ?? 0} employees`);
  if (run.status === "draft") {
    console.log("  · not calculated yet — calculate it in the application first (README: payroll)");
    continue;
  }
  if (ctx.dryRun) continue;

  // 1. acknowledge every open warning, with a reason that says why it is fine
  if (run.status === "calculated") {
    const findings = await service.select(
      "payroll_calculation_findings",
      `select=id,finding_code,severity,acknowledged_at&property_id=eq.${pid}&payroll_run_id=eq.${run.id}&calculation_version=eq.${run.current_calculation_version}&limit=2000`,
    );
    const open = findings.filter((f) => f.severity === "warning" && !f.acknowledged_at);
    let acknowledged = 0;
    for (const finding of open) {
      const reason =
        finding.finding_code === "INCOMPLETE_ATTENDANCE"
          ? "Attendance backfill covers the most recent fortnight only in this demonstration environment; salaried staff are paid in full."
          : "Reviewed against the employee's compensation record; no adjustment required.";
      const r = await admin.tryRpc("payroll_acknowledge_warning", {
        _property_id: pid,
        _finding_id: finding.id,
        _reason: reason,
      });
      if (r.ok) acknowledged++;
      else if (acknowledged === 0) console.log(`  ! acknowledge: ${JSON.stringify(r.body).slice(0, 200)}`);
    }
    console.log(`  · acknowledged ${acknowledged} of ${open.length} warnings`);

    const locked = await hr.tryRpc("payroll_transition_review", {
      _property_id: pid, _run_id: run.id, _action: "lock", _reason: "Reviewed by the HR manager",
    });
    console.log(locked.ok ? "  · locked for review" : `  ! lock: ${JSON.stringify(locked.body).slice(0, 220)}`);
    if (!locked.ok) continue;
    run.status = "locked_for_review";
  }

  // 2. approval — a run that was returned for correction re-enters here, and
  // one already submitted only needs the approval half.
  if (["locked_for_review", "returned_for_correction", "submitted_for_approval"].includes(run.status)) {
    const steps =
      run.status === "submitted_for_approval" ? [["approve", admin]] : [["submit", hr], ["approve", admin]];
    for (const [action, actor] of steps) {
      const r = await actor.tryRpc("payroll_approval_transition", {
        _property_id: pid,
        _run_id: run.id,
        _action: action,
        _calculation_version: run.current_calculation_version,
        _reason: action === "approve" ? "Approved for payment" : "Submitted for approval",
        _idempotency_key: randomUUID(),
      });
      console.log(
        r.ok
          ? `  · ${action === "submit" ? "submitted" : "approved"} by ${actor.label}`
          : `  ! ${action}: ${JSON.stringify(r.body).slice(0, 220)}`,
      );
    }
  }

  // 3. finalisation
  const finalized = await admin.tryRpc("payroll_finalize_run", {
    _property_id: pid,
    _run_id: run.id,
    _calculation_version: run.current_calculation_version,
    _idempotency_key: randomUUID(),
  });
  if (!finalized.ok) {
    console.log(`  ! finalize: ${JSON.stringify(finalized.body).slice(0, 240)}`);
    continue;
  }
  const finalizedId = typeof finalized.body === "string" ? finalized.body : finalized.body?.id ?? finalized.body;
  console.log(`  · finalised (${String(finalizedId).slice(0, 8)})`);

  // 4. payslips
  const generated = await admin.tryRpc("payroll_generate_payslips", {
    _property_id: pid, _finalized_payroll_id: finalizedId, _employee_ids: null,
  });
  console.log(generated.ok ? "  · payslips generated" : `  ! payslips: ${JSON.stringify(generated.body).slice(0, 220)}`);
  const published = await admin.tryRpc("payroll_publish_payslips", {
    _property_id: pid, _finalized_payroll_id: finalizedId, _employee_ids: null, _publish: true,
    _reason: "Published to staff for the demonstration environment",
  });
  console.log(published.ok ? "  · payslips published" : `  ! publish: ${JSON.stringify(published.body).slice(0, 220)}`);
}

const payslips = await service.select("payroll_payslips", `select=id&property_id=eq.${pid}&limit=2000`);
console.log(`\n${payslips.length} payslips on file.`);
