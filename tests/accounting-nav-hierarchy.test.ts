import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_NAV_GROUPS,
  ACCOUNTING_NAV_ITEMS,
  findAccountingGroupForKey,
  resolveActiveAccountingKey,
} from "../src/lib/accounting/nav-config";
import { requiredRolesFor } from "../src/lib/admin/route-permissions";

const sidebar = readFileSync(resolve(__dirname, "../src/components/app-sidebar.tsx"), "utf8");
const routeTree = readFileSync(resolve(__dirname, "../src/routeTree.gen.ts"), "utf8");
const workspaceShell = readFileSync(
  resolve(__dirname, "../src/components/accounting/accounting-workspace-nav.tsx"),
  "utf8",
);
const visibilityHook = readFileSync(
  resolve(__dirname, "../src/hooks/use-accounting-visibility.ts"),
  "utf8",
);

// The 17 sidebar-registered Accounting routes, plus their 2 detail/create
// sub-routes (expenses/new, expenses/$expenseId) that are reachable by
// drilling into a list but aren't separate nav links.
const ALL_ACCOUNTING_ROUTE_FILES = [
  "accounting.index.tsx",
  "accounting.accounts.tsx",
  "accounting.journal.tsx",
  "accounting.posting-rules.tsx",
  "accounting.fx.tsx",
  "accounting.periods.tsx",
  "accounting.night-audit.tsx",
  "accounting.sync.tsx",
  "accounting.reports.tsx",
  "accounting.ar.tsx",
  "accounting.ap.tsx",
  "accounting.expenses.tsx",
  "accounting.expenses.new.tsx",
  "accounting.expenses.$expenseId.tsx",
  "accounting.approvals.tsx",
  "accounting.expense-categories.tsx",
  "accounting.vendors.tsx",
  "accounting.cost-centres.tsx",
  "accounting.corrections.tsx",
];

describe("Accounting consolidated into one global sidebar entry", () => {
  it("has exactly one Accounting entry", () => {
    const matches = [...sidebar.matchAll(/title:\s*"Accounting"/g)];
    expect(matches).toHaveLength(1);
  });

  it("removed the old flat 17-item Accounting submodule list", () => {
    expect(sidebar).not.toContain('title: "Chart of Accounts"');
    expect(sidebar).not.toContain('title: "Expense Categories"');
    expect(sidebar).not.toContain('title: "Expense Corrections"');
    expect(sidebar).not.toContain("accountingPermission");
  });

  it("the single entry links to the Accounting overview", () => {
    expect(sidebar).toMatch(/title:\s*"Accounting",\s*\n\s*to:\s*"\/accounting"/);
  });
});

describe("Accounting workspace config", () => {
  it("covers exactly the 17 known accounting nav routes, grouped by actual purpose", () => {
    expect(ACCOUNTING_NAV_ITEMS).toHaveLength(17);
    const labels = ACCOUNTING_NAV_GROUPS.map((g) => g.label);
    expect(labels).toEqual([
      "Overview",
      "Expenses",
      "Receivables",
      "Payables",
      "General Ledger",
      "Periods & Controls",
      "Reports",
    ]);
  });

  it("has no duplicate labels or links", () => {
    const links = ACCOUNTING_NAV_ITEMS.map((i) => i.to);
    expect(new Set(links).size).toBe(links.length);
    const titles = ACCOUNTING_NAV_ITEMS.map((i) => i.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("groups child links correctly under their section", () => {
    const expected: Record<string, string[]> = {
      Overview: ["Overview"],
      Expenses: [
        "Expenses",
        "Expense Categories",
        "Cost Centres",
        "Vendors",
        "Expense Approvals",
        "Expense Corrections",
      ],
      Receivables: ["Accounts Receivable"],
      Payables: ["Accounts Payable"],
      "General Ledger": ["Chart of Accounts", "Journal", "Posting Rules", "FX & Currencies"],
      "Periods & Controls": ["Financial Periods", "Night Audit", "External Sync"],
      Reports: ["Reports"],
    };
    for (const [label, titles] of Object.entries(expected)) {
      const group = ACCOUNTING_NAV_GROUPS.find((g) => g.label === label);
      expect(group?.items.map((i) => i.title)).toEqual(titles);
    }
  });

  it("every accounting route (including the 2 detail/create sub-routes) still exists and is wrapped in the shell", () => {
    for (const file of ALL_ACCOUNTING_ROUTE_FILES) {
      const src = readFileSync(resolve(__dirname, `../src/routes/_authenticated/${file}`), "utf8");
      expect(src, `${file} missing AccountingWorkspaceShell`).toContain("AccountingWorkspaceShell");
    }
  });

  it("kept every accounting path exactly as it was — no route renamed or relocated", () => {
    for (const item of ACCOUNTING_NAV_ITEMS) {
      expect(routeTree).toContain(`'${item.to}': typeof`);
    }
  });
});

describe("route-derived parent highlighting", () => {
  it("resolves a top-level Expenses link to the Expenses group", () => {
    const key = resolveActiveAccountingKey("/accounting/expenses");
    expect(key).toBe("expenses");
    expect(findAccountingGroupForKey(key)?.label).toBe("Expenses");
  });

  it("resolves every accounting destination to its correct group (deep-link coverage)", () => {
    const expectedGroupOf: Record<string, string> = {
      "/accounting": "Overview",
      "/accounting/expenses": "Expenses",
      "/accounting/expense-categories": "Expenses",
      "/accounting/cost-centres": "Expenses",
      "/accounting/vendors": "Expenses",
      "/accounting/approvals": "Expenses",
      "/accounting/corrections": "Expenses",
      "/accounting/ar": "Receivables",
      "/accounting/ap": "Payables",
      "/accounting/accounts": "General Ledger",
      "/accounting/journal": "General Ledger",
      "/accounting/posting-rules": "General Ledger",
      "/accounting/fx": "General Ledger",
      "/accounting/periods": "Periods & Controls",
      "/accounting/night-audit": "Periods & Controls",
      "/accounting/sync": "Periods & Controls",
      "/accounting/reports": "Reports",
    };
    expect(Object.keys(expectedGroupOf)).toHaveLength(17);
    for (const [path, groupLabel] of Object.entries(expectedGroupOf)) {
      const key = resolveActiveAccountingKey(path);
      expect(key, `${path} should resolve a key`).not.toBeNull();
      expect(findAccountingGroupForKey(key)?.label, `${path} -> group`).toBe(groupLabel);
    }
  });

  it("resolves nested detail/create routes to the same parent group as their list page", () => {
    expect(
      findAccountingGroupForKey(resolveActiveAccountingKey("/accounting/expenses/new"))?.label,
    ).toBe("Expenses");
    expect(
      findAccountingGroupForKey(resolveActiveAccountingKey("/accounting/expenses/abc-123"))?.label,
    ).toBe("Expenses");
  });

  it("does not treat /accounting itself as a prefix of every other accounting route", () => {
    expect(resolveActiveAccountingKey("/accounting/expenses")).not.toBe("overview");
    expect(resolveActiveAccountingKey("/accounting")).toBe("overview");
  });
});

describe("no empty groups, no duplicate visible entries", () => {
  it("every declared group has at least one item", () => {
    for (const group of ACCOUNTING_NAV_GROUPS) {
      expect(group.items.length, `${group.label} must not be empty`).toBeGreaterThan(0);
    }
  });

  it("primary-row representatives (one per group) all point to distinct pages", () => {
    const representatives = ACCOUNTING_NAV_GROUPS.map((g) => g.items[0].to);
    expect(new Set(representatives).size).toBe(representatives.length);
  });

  it("no duplicate titles within any single group", () => {
    for (const group of ACCOUNTING_NAV_GROUPS) {
      const titles = group.items.map((i) => i.title);
      expect(new Set(titles).size, `${group.label} has a duplicate title`).toBe(titles.length);
    }
  });
});

describe("mobile-friendly row sizes", () => {
  it("no single row can ever need more than 7 buttons", () => {
    expect(ACCOUNTING_NAV_GROUPS.length).toBeLessThanOrEqual(7);
    for (const group of ACCOUNTING_NAV_GROUPS) {
      expect(group.items.length, `${group.label} row too wide for mobile`).toBeLessThanOrEqual(7);
    }
  });

  it("uses wrapping, not horizontal scroll, as the layout strategy", () => {
    expect(workspaceShell).toContain("flex-wrap");
    expect(workspaceShell).not.toContain("overflow-x-auto");
  });

  it("collapses a single-item group's child row instead of showing a redundant one-button row", () => {
    expect(workspaceShell).toMatch(/activeGroupItems\.length > 1/);
  });
});

describe("permission-filtered groups", () => {
  it("shell filters groups by the visibility map before rendering", () => {
    expect(workspaceShell).toContain("useAccountingVisibility");
    expect(workspaceShell).toContain("visibility[item.key]");
    expect(workspaceShell).toMatch(/\.filter\(\(group\) => group\.items\.length > 0\)/);
  });
});

describe("Accounting permission model preserved exactly", () => {
  it("gates the 6 Phase 6A expense-workspace items with the same EXPENSE_PERMISSIONS + ACCOUNTING_ADMIN_ROLES the pre-refactor sidebar used", () => {
    const expectedModuleFor: Record<string, string> = {
      expenses: "EXPENSE_PERMISSIONS.expensesView",
      expenseApprovals: "EXPENSE_PERMISSIONS.expensesApprove",
      expenseCategories: "EXPENSE_PERMISSIONS.categoriesView",
      vendors: "EXPENSE_PERMISSIONS.vendorsView",
      costCentres: "EXPENSE_PERMISSIONS.costCentresView",
      financialPeriods: "EXPENSE_PERMISSIONS.periodsView",
      expenseCorrections: "EXPENSE_PERMISSIONS.correctionsView",
    };
    for (const [key, permission] of Object.entries(expectedModuleFor)) {
      expect(visibilityHook, `${key} should use ${permission}`).toContain(`...${permission}`);
    }
    expect(visibilityHook).toContain("ACCOUNTING_ADMIN_ROLES");
  });

  it("keeps External Sync gated by SYNC_ROLES, not the broader ACCOUNTING_ADMIN_ROLES", () => {
    expect(visibilityHook).toContain("SYNC_ROLES");
    expect(visibilityHook).toContain("canSeeSync");
  });

  it("does not add new gating to the routes that had none in the pre-refactor sidebar", () => {
    // Overview, Chart of Accounts, Journal, AR, AP, Night Audit, Posting
    // Rules and Reports had no requireRoles/accountingPermission before —
    // the outer /accounting route guard (ACCOUNTING roles) was and remains
    // the only gate. Inventing nav-level gating for them would be a
    // behavior change, not a consolidation.
    expect(visibilityHook).toMatch(/overview:\s*true/);
    expect(visibilityHook).toMatch(/chartOfAccounts:\s*true/);
    expect(visibilityHook).toMatch(/journal:\s*true/);
    expect(visibilityHook).toMatch(/accountsReceivable:\s*true/);
    expect(visibilityHook).toMatch(/accountsPayable:\s*true/);
    expect(visibilityHook).toMatch(/nightAudit:\s*true/);
    expect(visibilityHook).toMatch(/postingRules:\s*true/);
    expect(visibilityHook).toMatch(/fx:\s*true/);
    expect(visibilityHook).toMatch(/reports:\s*true/);
  });

  it("keeps the outer /accounting route guard (ACCOUNTING roles) unchanged and authoritative", () => {
    const roles = requiredRolesFor("/accounting/accounts");
    expect(roles).toContain("accountant");
    expect(roles).toContain("auditor");
    expect(roles).not.toContain("front_desk");
  });

  it("keeps the stricter SYNC_ROLES guard on /accounting/sync specifically", () => {
    const roles = requiredRolesFor("/accounting/sync");
    expect(roles).not.toContain("auditor");
  });
});

describe("HRM and Payroll navigation unaffected", () => {
  it("still shows exactly one Human Resource Management entry", () => {
    const matches = [...sidebar.matchAll(/title:\s*"Human Resource Management"/g)];
    expect(matches).toHaveLength(1);
  });

  it("did not reintroduce the old flat Payroll submodule list", () => {
    expect(sidebar).not.toContain('label: "HRM Payroll"');
    expect(sidebar).not.toContain("Draft Payroll Runs");
  });
});
