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

const ctx = loadContext();
const service = serviceClient(ctx);
const admin = await signIn(ctx, ctx.adminEmail, ctx.adminPassword, "demo.admin");
const pid = ctx.propertyId;

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

    const locked = await admin.tryRpc("payroll_transition_review", {
      _property_id: pid, _run_id: run.id, _action: "lock", _reason: "Reviewed by the general manager",
    });
    console.log(locked.ok ? "  · locked for review" : `  ! lock: ${JSON.stringify(locked.body).slice(0, 220)}`);
    if (!locked.ok) continue;
    run.status = "locked_for_review";
  }

  // 2. approval
  if (run.status === "locked_for_review" || run.status === "pending_approval") {
    for (const action of ["submit", "approve"]) {
      const r = await admin.tryRpc("payroll_approval_transition", {
        _property_id: pid,
        _run_id: run.id,
        _action: action,
        _calculation_version: run.current_calculation_version,
        _reason: action === "approve" ? "Approved for payment" : "Submitted for approval",
        _idempotency_key: randomUUID(),
      });
      console.log(r.ok ? `  · ${action}d` : `  ! ${action}: ${JSON.stringify(r.body).slice(0, 220)}`);
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
