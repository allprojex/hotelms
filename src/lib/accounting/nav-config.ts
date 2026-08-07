import {
  Wallet,
  Receipt,
  Tags,
  Building2,
  Truck,
  ShieldCheck,
  Undo2,
  FileText,
  Boxes,
  ClipboardList,
  Settings2,
  TrendingUp,
  CalendarDays,
  Moon,
  Share2,
  BarChart3,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Single source of truth for the Accounting workspace: which routes exist,
 * which group they belong to, and which visibility key (see
 * useAccountingVisibility) gates their appearance. Consumed by both the
 * collapsed sidebar entry and the in-workspace section nav so the two never
 * drift out of sync. Mirrors src/lib/hrm/nav-config.ts.
 */
export type AccountingNavKey =
  | "overview"
  | "expenses"
  | "expenseCategories"
  | "costCentres"
  | "vendors"
  | "expenseApprovals"
  | "expenseCorrections"
  | "accountsReceivable"
  | "accountsPayable"
  | "chartOfAccounts"
  | "journal"
  | "postingRules"
  | "fx"
  | "financialPeriods"
  | "nightAudit"
  | "externalSync"
  | "reports";

export type AccountingNavItem = {
  key: AccountingNavKey;
  title: string;
  to: string;
  icon: LucideIcon;
  description: string;
};

export type AccountingNavGroup = {
  label: string;
  items: AccountingNavItem[];
};

export const ACCOUNTING_NAV_GROUPS: AccountingNavGroup[] = [
  {
    label: "Overview",
    items: [
      {
        key: "overview",
        title: "Overview",
        to: "/accounting",
        icon: Wallet,
        description: "Ledger, receivables, payables at a glance.",
      },
    ],
  },
  {
    label: "Expenses",
    items: [
      {
        key: "expenses",
        title: "Expenses",
        to: "/accounting/expenses",
        icon: Receipt,
        description: "Draft, submit and track expenses.",
      },
      {
        key: "expenseCategories",
        title: "Expense Categories",
        to: "/accounting/expense-categories",
        icon: Tags,
        description: "Classify expenses and set receipt rules.",
      },
      {
        key: "costCentres",
        title: "Cost Centres",
        to: "/accounting/cost-centres",
        icon: Building2,
        description: "Organize spend by department or unit.",
      },
      {
        key: "vendors",
        title: "Vendors",
        to: "/accounting/vendors",
        icon: Truck,
        description: "Suppliers and service providers for expenses.",
      },
      {
        key: "expenseApprovals",
        title: "Expense Approvals",
        to: "/accounting/approvals",
        icon: ShieldCheck,
        description: "Review expenses awaiting approval.",
      },
      {
        key: "expenseCorrections",
        title: "Expense Corrections",
        to: "/accounting/corrections",
        icon: Undo2,
        description: "Correction requests and reversal evidence.",
      },
    ],
  },
  {
    label: "Receivables",
    items: [
      {
        key: "accountsReceivable",
        title: "Accounts Receivable",
        to: "/accounting/ar",
        icon: FileText,
        description: "Customer invoices and receipts.",
      },
    ],
  },
  {
    label: "Payables",
    items: [
      {
        key: "accountsPayable",
        title: "Accounts Payable",
        to: "/accounting/ap",
        icon: Truck,
        description: "Supplier bills and payments.",
      },
    ],
  },
  {
    label: "General Ledger",
    items: [
      {
        key: "chartOfAccounts",
        title: "Chart of Accounts",
        to: "/accounting/accounts",
        icon: Boxes,
        description: "Ledger accounts and hierarchy.",
      },
      {
        key: "journal",
        title: "Journal",
        to: "/accounting/journal",
        icon: ClipboardList,
        description: "Manual and posted entries.",
      },
      {
        key: "postingRules",
        title: "Posting Rules",
        to: "/accounting/posting-rules",
        icon: Settings2,
        description: "Automatic mapping from operations to GL.",
      },
      {
        key: "fx",
        title: "FX & Currencies",
        to: "/accounting/fx",
        icon: TrendingUp,
        description: "Foreign exchange rate log.",
      },
    ],
  },
  {
    label: "Periods & Controls",
    items: [
      {
        key: "financialPeriods",
        title: "Financial Periods",
        to: "/accounting/periods",
        icon: CalendarDays,
        description: "Open, close, and reopen financial periods.",
      },
      {
        key: "nightAudit",
        title: "Night Audit",
        to: "/accounting/night-audit",
        icon: Moon,
        description: "Day-close postings and reconciliation.",
      },
      {
        key: "externalSync",
        title: "External Sync",
        to: "/accounting/sync",
        icon: Share2,
        description: "Push nightly summaries via HMAC webhooks.",
      },
    ],
  },
  {
    label: "Reports",
    items: [
      {
        key: "reports",
        title: "Reports",
        to: "/accounting/reports",
        icon: BarChart3,
        description: "Trial balance, P&L, balance sheet, and expense reports.",
      },
    ],
  },
];

export const ACCOUNTING_NAV_ITEMS: AccountingNavItem[] = ACCOUNTING_NAV_GROUPS.flatMap(
  (g) => g.items,
);

/**
 * Pure route-matching logic behind the workspace section nav's active state.
 * Exported standalone (no router/DOM dependency) so it's directly unit
 * testable. Picks the longest `to` match so /accounting/expenses/new
 * activates "Expenses", not a broader unrelated prefix.
 */
export function resolveActiveAccountingKey(pathname: string): AccountingNavKey | null {
  const matches = ACCOUNTING_NAV_ITEMS.filter((item) => {
    if (pathname === item.to) return true;
    // "/accounting" itself is the workspace root, not a prefix every other
    // accounting route falls under — only its own descendants (there are
    // none besides itself) should fall back to it.
    if (item.to === "/accounting") return false;
    return pathname.startsWith(`${item.to}/`);
  });
  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.to.length - a.to.length)[0].key;
}

/**
 * Which ACCOUNTING_NAV_GROUPS group a given active key belongs to. Drives
 * the workspace shell's secondary row: a group is expanded into its own
 * child links only while one of its items is active.
 */
export function findAccountingGroupForKey(key: AccountingNavKey | null): AccountingNavGroup | null {
  if (!key) return null;
  return (
    ACCOUNTING_NAV_GROUPS.find((group) => group.items.some((item) => item.key === key)) ?? null
  );
}
