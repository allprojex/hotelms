import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HRM_NAV_GROUPS,
  HRM_NAV_ITEMS,
  PAYROLL_NAV_GROUPS,
  PAYROLL_NAV_ITEMS,
  findHrmGroupForKey,
  findPayrollGroupForKey,
  resolveActiveHrmKey,
  resolveActivePayrollKey,
} from "../src/lib/hrm/nav-config";

const workspaceShell = readFileSync(
  resolve(__dirname, "../src/components/hrm/hrm-workspace-nav.tsx"),
  "utf8",
);

describe("primary HRM row shows only the 7 major sections", () => {
  it("has exactly 7 groups, one representative link each", () => {
    expect(HRM_NAV_GROUPS).toHaveLength(7);
    expect(HRM_NAV_GROUPS.map((g) => g.label)).toEqual([
      "Overview",
      "People",
      "Time and Attendance",
      "Leave",
      "Workforce",
      "Communication",
      "Payroll",
    ]);
  });

  it("shell computes one primary link per group (never all 18 items flat)", () => {
    // Regression guard for the exact bug reported: the old shell rendered
    // every group's every item in one flat row. The rewrite must build its
    // primary row from one representative per group, not group.items.flat().
    expect(workspaceShell).toContain("group.items[0]");
    expect(workspaceShell).not.toMatch(/groups\.map[\s\S]*?group\.items\.map/);
  });
});

describe("HRM child links are grouped correctly under their section", () => {
  const expected: Record<string, string[]> = {
    People: ["Employees", "Departments", "Designations", "Employee Documents"],
    "Time and Attendance": ["Attendance", "Time Clock", "Biometric Devices"],
    Leave: ["Leave Management", "Leave Calendar", "Leave Balances", "Leave Types"],
    Workforce: ["Duty Roster", "Shift Scheduling", "Holiday Calendar", "Workforce Settings"],
    Communication: ["Staff Announcements"],
  };

  for (const [label, titles] of Object.entries(expected)) {
    it(`${label} contains exactly its own pages`, () => {
      const group = HRM_NAV_GROUPS.find((g) => g.label === label);
      expect(group?.items.map((i) => i.title)).toEqual(titles);
    });
  }
});

describe("Payroll secondary row shows only the 5 major groups", () => {
  it("has exactly 5 groups", () => {
    expect(PAYROLL_NAV_GROUPS).toHaveLength(5);
    expect(PAYROLL_NAV_GROUPS.map((g) => g.label)).toEqual([
      "Overview",
      "Payroll Setup",
      "Employee Compensation",
      "Payroll Processing",
      "Payments & Reporting",
    ]);
  });

  it("all 19 payroll destinations are still reachable through those 5 groups", () => {
    expect(PAYROLL_NAV_ITEMS).toHaveLength(19);
    const expected: Record<string, string[]> = {
      Overview: ["Payroll Overview"],
      "Payroll Setup": [
        "Payroll Settings",
        "Pay Calendars",
        "Salary Structures",
        "Pay Components",
        "Statutory Rules",
      ],
      "Employee Compensation": ["Employee Compensation", "Payment Details", "Opening Balances"],
      "Payroll Processing": [
        "Draft Payroll Runs",
        "Manual Payroll Inputs",
        "Payroll Approvals",
        "Finalized Payroll",
        "Payroll Corrections",
      ],
      "Payments & Reporting": [
        "Payslips",
        "Payment Preparation",
        "Payment Export Templates",
        "Statutory Liabilities",
        "Journal Drafts",
      ],
    };
    for (const [label, titles] of Object.entries(expected)) {
      const group = PAYROLL_NAV_GROUPS.find((g) => g.label === label);
      expect(group?.items.map((i) => i.title)).toEqual(titles);
    }
  });
});

describe("route-derived parent highlighting", () => {
  it("resolves HRM section -> group for a deep People link", () => {
    const key = resolveActiveHrmKey("/hrm/departments");
    expect(key).toBe("departments");
    expect(findHrmGroupForKey(key)?.label).toBe("People");
  });

  it("resolves the exact three-level example from spec: /hrm/payroll/payslips", () => {
    const hrmKey = resolveActiveHrmKey("/hrm/payroll/payslips");
    expect(hrmKey).toBe("payroll");
    expect(findHrmGroupForKey(hrmKey)?.label).toBe("Payroll");

    const payrollKey = resolveActivePayrollKey("/hrm/payroll/payslips");
    expect(payrollKey).toBe("payslips");
    expect(findPayrollGroupForKey(payrollKey)?.label).toBe("Payments & Reporting");
  });

  it("resolves every payroll destination to its correct group (deep-link coverage)", () => {
    const expectedGroupOf: Record<string, string> = {
      "/hrm/payroll": "Overview",
      "/hrm/payroll/settings": "Payroll Setup",
      "/hrm/payroll/calendars": "Payroll Setup",
      "/hrm/payroll/salary-structures": "Payroll Setup",
      "/hrm/payroll/pay-components": "Payroll Setup",
      "/hrm/payroll/statutory-rules": "Payroll Setup",
      "/hrm/payroll/compensation": "Employee Compensation",
      "/hrm/payroll/payment-details": "Employee Compensation",
      "/hrm/payroll/opening-balances": "Employee Compensation",
      "/hrm/payroll/runs": "Payroll Processing",
      "/hrm/payroll/manual-inputs": "Payroll Processing",
      "/hrm/payroll/approvals": "Payroll Processing",
      "/hrm/payroll/finalized": "Payroll Processing",
      "/hrm/payroll/corrections": "Payroll Processing",
      "/hrm/payroll/payslips": "Payments & Reporting",
      "/hrm/payroll/payment-batches": "Payments & Reporting",
      "/hrm/payroll/payment-templates": "Payments & Reporting",
      "/hrm/payroll/statutory-liabilities": "Payments & Reporting",
      "/hrm/payroll/journals": "Payments & Reporting",
    };
    expect(Object.keys(expectedGroupOf)).toHaveLength(19);
    for (const [path, groupLabel] of Object.entries(expectedGroupOf)) {
      const key = resolveActivePayrollKey(path);
      expect(key, `${path} should resolve a key`).not.toBeNull();
      expect(findPayrollGroupForKey(key)?.label, `${path} -> group`).toBe(groupLabel);
    }
  });

  it("resolves nested detail routes to the same parent group as their list page", () => {
    expect(
      findPayrollGroupForKey(resolveActivePayrollKey("/hrm/payroll/runs/abc-123"))?.label,
    ).toBe("Payroll Processing");
    expect(
      findPayrollGroupForKey(resolveActivePayrollKey("/hrm/payroll/finalized/xyz-1"))?.label,
    ).toBe("Payroll Processing");
    expect(findHrmGroupForKey(resolveActiveHrmKey("/hrm/employees/emp-1"))?.label).toBe("People");
  });
});

describe("no empty groups, no duplicate visible entries", () => {
  it("every declared group has at least one item", () => {
    for (const group of [...HRM_NAV_GROUPS, ...PAYROLL_NAV_GROUPS]) {
      expect(group.items.length, `${group.label} must not be empty`).toBeGreaterThan(0);
    }
  });

  it("primary-row representatives (one per HRM group) all point to distinct pages", () => {
    const representatives = HRM_NAV_GROUPS.map((g) => g.items[0].to);
    expect(new Set(representatives).size).toBe(representatives.length);
  });

  it("payroll-group-row representatives (one per Payroll group) all point to distinct pages", () => {
    const representatives = PAYROLL_NAV_GROUPS.map((g) => g.items[0].to);
    expect(new Set(representatives).size).toBe(representatives.length);
  });

  it("no duplicate titles within any single group", () => {
    for (const group of [...HRM_NAV_GROUPS, ...PAYROLL_NAV_GROUPS]) {
      const titles = group.items.map((i) => i.title);
      expect(new Set(titles).size, `${group.label} has a duplicate title`).toBe(titles.length);
    }
  });
});

describe("mobile-friendly row sizes", () => {
  it("no single row can ever need more than 7 buttons", () => {
    // Primary row: 7 groups. Every group's own child row and every Payroll
    // group's child row must also stay small — this is what actually
    // prevents the 15-20-button rows the refinement was asked to remove.
    expect(HRM_NAV_GROUPS.length).toBeLessThanOrEqual(7);
    expect(PAYROLL_NAV_GROUPS.length).toBeLessThanOrEqual(7);
    for (const group of [...HRM_NAV_GROUPS, ...PAYROLL_NAV_GROUPS]) {
      expect(group.items.length, `${group.label} row too wide for mobile`).toBeLessThanOrEqual(7);
    }
  });

  it("uses wrapping, not horizontal scroll, as the layout strategy", () => {
    expect(workspaceShell).toContain("flex-wrap");
    expect(workspaceShell).not.toContain("overflow-x-auto");
  });

  it("collapses a single-item group's child row instead of showing a redundant one-button row", () => {
    expect(workspaceShell).toMatch(/activeHrmGroupItems\.length > 1/);
    expect(workspaceShell).toMatch(/activePayrollGroupItems\.length > 1/);
  });
});

describe("permission-filtered groups", () => {
  it("shell filters both HRM and Payroll groups by their own visibility map before rendering", () => {
    expect(workspaceShell).toContain("visibility[item.key]");
    expect(workspaceShell).toContain("payrollVisibility[item.key]");
    expect(workspaceShell).toMatch(/\.filter\(\(group\) => group\.items\.length > 0\)/);
  });
});
