import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const migration = readFileSync(
  resolve(root, "supabase/migrations/20260729235000_draft_payroll_calculation.sql"),
  "utf8",
);
const server = readFileSync(resolve(root, "src/lib/hrm/payroll-runs.functions.ts"), "utf8");
const domain = readFileSync(resolve(root, "src/lib/hrm/payroll-calculation.ts"), "utf8");
const inputs = readFileSync(resolve(root, "src/lib/hrm/payroll-inputs.ts"), "utf8");
const pages = readFileSync(resolve(root, "src/components/hrm/payroll-run-pages.tsx"), "utf8");
const permissions = readFileSync(resolve(root, "src/lib/hrm/permissions.ts"), "utf8");
const routes = [
  "hrm.payroll.runs.tsx",
  "hrm.payroll.runs.new.tsx",
  "hrm.payroll.runs.$runId.tsx",
  "hrm.payroll.runs.$runId.employees.$employeeId.tsx",
  "hrm.payroll.manual-inputs.tsx",
]
  .map((file) => readFileSync(resolve(root, "src/routes/_authenticated", file), "utf8"))
  .join("\n");

describe("Phase 4B draft payroll security and integration", () => {
  it("adds versioned draft runs, employee results, lines, findings, and manual inputs", () => {
    for (const table of [
      "payroll_runs",
      "payroll_run_versions",
      "payroll_run_employees",
      "payroll_run_line_items",
      "payroll_calculation_findings",
      "payroll_manual_inputs",
    ])
      expect(migration).toContain(`CREATE TABLE public.${table}`);
    expect(migration).toContain("idempotency_key");
    expect(migration).toContain("FOR UPDATE");
  });

  it("keeps writes atomic and records failed calculation leases", () => {
    expect(migration).toContain("payroll_begin_calculation");
    expect(migration).toContain("payroll_store_calculation_results");
    expect(migration).toContain("payroll_fail_calculation");
    expect(server).toContain('db.rpc("payroll_fail_calculation"');
  });

  it("enforces property scope, RLS, and server authorization", () => {
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("FOREIGN KEY(property_id,payroll_run_id)");
    expect(migration).toContain("has_hrm_permission(auth.uid(),property_id");
    expect(server).toContain("await allow(context, data.propertyId");
    expect(domain).toContain("Cross-property");
  });

  it("uses allow-listed methods and rejects executable configuration", () => {
    for (const method of [
      "fixed_amount",
      "percentage_base",
      "percentage_gross",
      "percentage_component",
      "attendance_day",
      "worked_hour",
      "unpaid_day_deduction",
      "fixed_one_time",
      "manual_amount",
      "statutory_rule",
    ])
      expect(domain).toContain(`"${method}"`);
    expect(migration).toContain('"script"|"executable"|"eval"|"javascript"|"formula"');
    expect(domain).not.toMatch(/\beval\s*\(/);
  });

  it("uses only approved attendance and leave sources without fabricated absence", () => {
    expect(inputs).toContain('["approved", "not_required"].includes(row.approvalStatus)');
    expect(inputs).toContain('row.status === "approved"');
    expect(inputs).toContain("incompleteAttendance");
    expect(inputs).not.toContain("scheduledWorkingDays - attendedDays");
  });

  it("preserves complete version snapshots for selected retry requests", () => {
    expect(server).toContain("Every immutable calculation version is a complete snapshot");
    expect(migration).toContain(
      "UNIQUE(property_id,payroll_run_id,calculation_version,employee_id)",
    );
    expect(migration).toContain("status='superseded'");
  });

  it("adds exactly fifteen Phase 4B permission boundaries without manager grants", () => {
    for (const name of [
      "payrollRunsView",
      "payrollRunsCreate",
      "payrollRunsCalculate",
      "payrollRunsRecalculate",
      "payrollRunsLock",
      "payrollRunsReopen",
      "payrollRunsArchive",
      "payrollEmployeeResultsView",
      "payrollCalculationDetailsView",
      "payrollManualInputsView",
      "payrollManualInputsManage",
      "payrollValidationsView",
      "payrollWarningsAcknowledge",
      "payrollDraftExport",
      "payrollDraftPrint",
    ])
      expect(permissions).toContain(name);
    expect(migration).not.toMatch(/\('manager'\)|\('general_manager'\)/);
  });

  it("provides all five routes and all nine draft report types", () => {
    for (const route of [
      "/hrm/payroll/runs",
      "/hrm/payroll/runs/new",
      "/hrm/payroll/runs/$runId",
      "/hrm/payroll/runs/$runId/employees/$employeeId",
      "/hrm/payroll/manual-inputs",
    ])
      expect(pages + server + routes).toContain(route);
    for (const report of [
      "payroll-run-summary",
      "employee-payroll-detail",
      "earning-breakdown",
      "deduction-breakdown",
      "employer-contribution-breakdown",
      "validation-findings",
      "attendance-leave-summary",
      "manual-input-report",
      "calculation-version-comparison",
    ])
      expect(pages).toContain(report);
  });

  it("uses the shared report framework with permission and clear draft marking", () => {
    expect(pages).toContain("exportReport(");
    expect(server).toContain("authorizeReportAction");
    expect(pages).toContain("DRAFT · NOT PAID");
    expect(pages).not.toMatch(/publish payslip|make payment|finalize payroll/i);
  });

  it("blocks review lock on errors and unacknowledged warnings and audits transitions", () => {
    expect(migration).toContain("Blocking payroll validations prevent review lock");
    expect(migration).toContain("Unacknowledged payroll warnings prevent review lock");
    expect(migration).toContain("audit_capture");
    expect(migration).toContain("reopen reason required");
  });
});
