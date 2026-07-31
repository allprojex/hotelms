import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const routeDir = path.join(root, "src/routes/_authenticated");
const sidebar = fs.readFileSync(path.join(root, "src/components/app-sidebar.tsx"), "utf8");

describe("Phase 4C payroll routes and navigation", () => {
  const routes = [
    "hrm.payroll.approvals.tsx",
    "hrm.payroll.runs.$runId.approval.tsx",
    "hrm.payroll.finalized.tsx",
    "hrm.payroll.finalized.$payrollId.tsx",
    "hrm.payroll.payslips.tsx",
    "hrm.payroll.payment-batches.tsx",
    "hrm.payroll.payment-templates.tsx",
    "hrm.payroll.statutory-liabilities.tsx",
    "hrm.payroll.journals.tsx",
    "hrm.payroll.corrections.tsx",
  ];

  it("adds the requested Phase 4C routes", () => {
    for (const route of routes) {
      expect(fs.existsSync(path.join(routeDir, route))).toBe(true);
    }
  });

  it("adds only preparation/finalization navigation labels", () => {
    for (const label of [
      "Payroll Approvals",
      "Finalized Payroll",
      "Payslips",
      "Payment Preparation",
      "Payment Export Templates",
      "Statutory Liabilities",
      "Journal Drafts",
      "Payroll Corrections",
    ]) {
      expect(sidebar).toContain(label);
    }
    expect(sidebar).not.toContain("Payment Execution");
    expect(sidebar).not.toContain("Tax Submission");
    expect(sidebar).not.toContain("Journal Posting");
  });
});
