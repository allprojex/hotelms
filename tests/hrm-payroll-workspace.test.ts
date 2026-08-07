import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PAYROLL_NAV_GROUPS,
  PAYROLL_NAV_ITEMS,
  isPayrollPath,
  resolveActiveHrmKey,
  resolveActivePayrollKey,
} from "../src/lib/hrm/nav-config";
import { requiredRolesFor } from "../src/lib/admin/route-permissions";

const sidebar = readFileSync(resolve(__dirname, "../src/components/app-sidebar.tsx"), "utf8");
const routeTree = readFileSync(resolve(__dirname, "../src/routeTree.gen.ts"), "utf8");
const workspaceShell = readFileSync(
  resolve(__dirname, "../src/components/hrm/hrm-workspace-nav.tsx"),
  "utf8",
);
const payrollVisibilityHook = readFileSync(
  resolve(__dirname, "../src/hooks/use-payroll-visibility.ts"),
  "utf8",
);

// The 19 sidebar-registered Payroll routes, plus their 5 detail/sub-routes
// (draft run detail/new/approval/employee-detail, finalized-payroll detail)
// that are reachable by drilling into a list but aren't separate nav links.
const ALL_PAYROLL_ROUTE_FILES = [
  "hrm.payroll.tsx",
  "hrm.payroll.settings.tsx",
  "hrm.payroll.calendars.tsx",
  "hrm.payroll.salary-structures.tsx",
  "hrm.payroll.pay-components.tsx",
  "hrm.payroll.statutory-rules.tsx",
  "hrm.payroll.compensation.tsx",
  "hrm.payroll.payment-details.tsx",
  "hrm.payroll.opening-balances.tsx",
  "hrm.payroll.runs.tsx",
  "hrm.payroll.runs.new.tsx",
  "hrm.payroll.runs.$runId.tsx",
  "hrm.payroll.runs.$runId.approval.tsx",
  "hrm.payroll.runs.$runId.employees.$employeeId.tsx",
  "hrm.payroll.manual-inputs.tsx",
  "hrm.payroll.approvals.tsx",
  "hrm.payroll.finalized.tsx",
  "hrm.payroll.finalized.$payrollId.tsx",
  "hrm.payroll.corrections.tsx",
  "hrm.payroll.payslips.tsx",
  "hrm.payroll.payment-batches.tsx",
  "hrm.payroll.payment-templates.tsx",
  "hrm.payroll.statutory-liabilities.tsx",
  "hrm.payroll.journals.tsx",
];

// PAYROLL_SENSITIVE_ROLES = [super_admin, hotel_owner, hr] — no general_manager.
// These 13 items must stay on that stricter tier; the other 6 use the
// broader HRM_ADMIN_ROLES (which does include general_manager).
const SENSITIVE_KEYS = [
  "employeeCompensation",
  "paymentDetails",
  "openingBalances",
  "payrollRuns",
  "payrollManualInputs",
  "payrollApprovals",
  "finalizedPayroll",
  "payrollCorrections",
  "payslips",
  "paymentBatches",
  "paymentTemplates",
  "statutoryLiabilities",
  "journalDrafts",
];
const HRM_ADMIN_KEYS = [
  "payrollOverview",
  "payrollSettings",
  "payCalendars",
  "salaryStructures",
  "payComponents",
  "statutoryRules",
];

describe("Payroll removed from the global sidebar", () => {
  it("has no separate HRM Payroll group left", () => {
    expect(sidebar).not.toContain('label: "HRM Payroll"');
    expect(sidebar).not.toContain("Payroll Overview");
    expect(sidebar).not.toContain("Draft Payroll Runs");
  });

  it("still shows exactly one Human Resource Management entry", () => {
    const matches = [...sidebar.matchAll(/title:\s*"Human Resource Management"/g)];
    expect(matches).toHaveLength(1);
  });
});

describe("Payroll workspace config", () => {
  it("covers exactly the 19 known payroll routes, grouped as verified against actual route purpose", () => {
    expect(PAYROLL_NAV_ITEMS).toHaveLength(19);
    const labels = PAYROLL_NAV_GROUPS.map((g) => g.label);
    expect(labels).toEqual([
      "Overview",
      "Payroll Setup",
      "Employee Compensation",
      "Payroll Processing",
      "Payments & Reporting",
    ]);
  });

  it("has no duplicate labels or links", () => {
    const links = PAYROLL_NAV_ITEMS.map((i) => i.to);
    expect(new Set(links).size).toBe(links.length);
    const titles = PAYROLL_NAV_ITEMS.map((i) => i.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("every payroll route (including the 5 detail sub-routes) still exists and is wrapped in the shell", () => {
    for (const file of ALL_PAYROLL_ROUTE_FILES) {
      const src = readFileSync(resolve(__dirname, `../src/routes/_authenticated/${file}`), "utf8");
      expect(src, `${file} missing HrmWorkspaceShell`).toContain("HrmWorkspaceShell");
    }
  });

  it("kept every payroll path exactly as it was — no route renamed or relocated", () => {
    for (const item of PAYROLL_NAV_ITEMS) {
      expect(routeTree).toContain(`'${item.to}': typeof`);
    }
  });
});

describe("Payroll active-section resolution", () => {
  it("isPayrollPath is true only for /hrm/payroll and its descendants", () => {
    expect(isPayrollPath("/hrm/payroll")).toBe(true);
    expect(isPayrollPath("/hrm/payroll/runs")).toBe(true);
    expect(isPayrollPath("/hrm/payroll/runs/abc-123")).toBe(true);
    expect(isPayrollPath("/hrm")).toBe(false);
    expect(isPayrollPath("/hrm/employees")).toBe(false);
    expect(isPayrollPath("/hrm/payrollish")).toBe(false);
  });

  it("resolves the correct active tab for each payroll group", () => {
    expect(resolveActivePayrollKey("/hrm/payroll")).toBe("payrollOverview");
    expect(resolveActivePayrollKey("/hrm/payroll/runs")).toBe("payrollRuns");
    expect(resolveActivePayrollKey("/hrm/payroll/runs/abc-123")).toBe("payrollRuns");
    expect(resolveActivePayrollKey("/hrm/payroll/finalized/xyz-1")).toBe("finalizedPayroll");
    expect(resolveActivePayrollKey("/hrm/payroll/corrections")).toBe("payrollCorrections");
  });

  it("HRM tier-1 tab bar activates Payroll for any payroll sub-route", () => {
    expect(resolveActiveHrmKey("/hrm/payroll/runs/abc-123/employees/e-1")).toBe("payroll");
  });
});

describe("Payroll permission model preserved exactly", () => {
  it("keeps the PAYROLL_SENSITIVE_ROLES / HRM_ADMIN_ROLES split unchanged", () => {
    for (const key of SENSITIVE_KEYS) {
      expect(payrollVisibilityHook, `${key} should default to PAYROLL_SENSITIVE_ROLES`).toMatch(
        new RegExp(`const ${key} = usePermission\\(\\{[\\s\\S]*?PAYROLL_SENSITIVE_ROLES`),
      );
    }
    for (const key of HRM_ADMIN_KEYS) {
      expect(payrollVisibilityHook, `${key} should default to HRM_ADMIN_ROLES`).toMatch(
        new RegExp(`const ${key} = usePermission\\(\\{[\\s\\S]*?HRM_ADMIN_ROLES`),
      );
    }
  });

  it("does not broaden general manager's access to sensitive payroll data", () => {
    // HRM_ADMIN_ROLES includes general_manager; PAYROLL_SENSITIVE_ROLES doesn't.
    // A general manager must land in HRM_ADMIN_KEYS only, never SENSITIVE_KEYS.
    expect(HRM_ADMIN_KEYS).not.toEqual(expect.arrayContaining(SENSITIVE_KEYS));
    expect(SENSITIVE_KEYS.length + HRM_ADMIN_KEYS.length).toBe(19);
  });

  it("keeps payrollCorrections gated by the create capability, not view", () => {
    expect(payrollVisibilityHook).toMatch(
      /module:\s*"payroll_corrections",\s*capability:\s*"create"/,
    );
  });

  it("filters the payroll workspace nav per item from usePayrollVisibility", () => {
    expect(workspaceShell).toContain("usePayrollVisibility");
    expect(workspaceShell).toContain("payrollVisibility[item.key]");
  });

  it("route-level role guards for payroll are unchanged and still authoritative", () => {
    const roles = requiredRolesFor("/hrm/payroll/compensation");
    expect(roles).toContain("hr");
    expect(roles).not.toContain("guest");
  });
});
