import {
  Users,
  Building2,
  IdCard,
  FileText,
  Activity,
  CalendarClock,
  ShieldCheck,
  CalendarDays,
  CalendarHeart,
  Settings2,
  BarChart3,
  ClipboardList,
  SlidersHorizontal,
  Megaphone,
  BriefcaseBusiness,
  Wallet,
  Boxes,
  ScrollText,
  Upload,
  Lock,
  RotateCcw,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Single source of truth for the Human Resource Management workspace:
 * which routes exist, which group they belong to, and which permission
 * key (see useHrmVisibility) gates their visibility. Consumed by both
 * the collapsed sidebar entry and the in-workspace section nav so the
 * two never drift out of sync.
 */
export type HrmNavKey =
  | "dashboard"
  | "employees"
  | "departments"
  | "designations"
  | "documents"
  | "attendance"
  | "timeClock"
  | "biometricDevices"
  | "leave"
  | "leaveCalendar"
  | "leaveBalances"
  | "leaveTypes"
  | "roster"
  | "shifts"
  | "holidays"
  | "workforceSettings"
  | "announcements"
  | "payroll";

export type HrmNavItem = {
  key: HrmNavKey;
  title: string;
  to: string;
  icon: LucideIcon;
  description: string;
};

export type HrmNavGroup = {
  label: string;
  items: HrmNavItem[];
};

export const HRM_NAV_GROUPS: HrmNavGroup[] = [
  {
    label: "Overview",
    items: [
      {
        key: "dashboard",
        title: "HRM Dashboard",
        to: "/hrm",
        icon: BriefcaseBusiness,
        description: "Employee and HR operations overview.",
      },
    ],
  },
  {
    label: "People",
    items: [
      {
        key: "employees",
        title: "Employees",
        to: "/hrm/employees",
        icon: Users,
        description: "Employee records and professional profiles.",
      },
      {
        key: "departments",
        title: "Departments",
        to: "/hrm/departments",
        icon: Building2,
        description: "Property department structure.",
      },
      {
        key: "designations",
        title: "Designations",
        to: "/hrm/designations",
        icon: IdCard,
        description: "Job titles, levels, and department alignment.",
      },
      {
        key: "documents",
        title: "Employee Documents",
        to: "/hrm/documents",
        icon: FileText,
        description: "Private employee document records.",
      },
    ],
  },
  {
    label: "Time and Attendance",
    items: [
      {
        key: "attendance",
        title: "Attendance",
        to: "/hrm/attendance",
        icon: Activity,
        description: "Attendance review, adjustments, approvals, and reports.",
      },
      {
        key: "timeClock",
        title: "Time Clock",
        to: "/hrm/time-clock",
        icon: CalendarClock,
        description: "Record your own work and break events.",
      },
      {
        key: "biometricDevices",
        title: "Biometric Devices",
        to: "/hrm/biometric-devices",
        icon: ShieldCheck,
        description: "Vendor-neutral device integration architecture.",
      },
    ],
  },
  {
    label: "Leave",
    items: [
      {
        key: "leave",
        title: "Leave Management",
        to: "/hrm/leave",
        icon: CalendarDays,
        description: "Request, review, and approve employee leave.",
      },
      {
        key: "leaveCalendar",
        title: "Leave Calendar",
        to: "/hrm/leave/calendar",
        icon: CalendarHeart,
        description: "Approved property leave calendar.",
      },
      {
        key: "leaveBalances",
        title: "Leave Balances",
        to: "/hrm/leave/balances",
        icon: BarChart3,
        description: "Employee leave entitlement balances.",
      },
      {
        key: "leaveTypes",
        title: "Leave Types",
        to: "/hrm/leave/types",
        icon: Settings2,
        description: "Configure property leave policies.",
      },
    ],
  },
  {
    label: "Workforce",
    items: [
      {
        key: "roster",
        title: "Duty Roster",
        to: "/hrm/roster",
        icon: ClipboardList,
        description: "Assign and publish employee duty schedules.",
      },
      {
        key: "shifts",
        title: "Shift Scheduling",
        to: "/hrm/shifts",
        icon: CalendarClock,
        description: "Reusable shift templates and working hours.",
      },
      {
        key: "holidays",
        title: "Holiday Calendar",
        to: "/hrm/holidays",
        icon: CalendarHeart,
        description: "Property and department holiday dates.",
      },
      {
        key: "workforceSettings",
        title: "Workforce Settings",
        to: "/hrm/workforce-settings",
        icon: SlidersHorizontal,
        description: "Timezone and workforce time rules.",
      },
    ],
  },
  {
    label: "Communication",
    items: [
      {
        key: "announcements",
        title: "Staff Announcements",
        to: "/hrm/announcements",
        icon: Megaphone,
        description: "Internal property staff notices.",
      },
    ],
  },
  {
    label: "Payroll",
    items: [
      {
        key: "payroll",
        title: "Payroll",
        to: "/hrm/payroll",
        icon: Wallet,
        description: "Payroll setup, compensation, processing, and reporting.",
      },
    ],
  },
];

export const HRM_NAV_ITEMS: HrmNavItem[] = HRM_NAV_GROUPS.flatMap((g) => g.items);

/**
 * Pure route-matching logic behind the workspace section nav's active state.
 * Exported standalone (no router/DOM dependency) so it's directly unit
 * testable. Picks the longest `to` match so /hrm/leave/calendar activates
 * "Leave Calendar", not the broader "Leave Management" (/hrm/leave) it's
 * also a prefix of.
 */
export function resolveActiveHrmKey(pathname: string): HrmNavKey | null {
  const matches = HRM_NAV_ITEMS.filter((item) => {
    if (pathname === item.to) return true;
    // "/hrm" itself is the workspace root, not a prefix every other HRM
    // route falls under — only its own descendants should fall back to it.
    if (item.to === "/hrm") return false;
    return pathname.startsWith(`${item.to}/`);
  });
  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.to.length - a.to.length)[0].key;
}

/**
 * Which HRM_NAV_GROUPS group a given active key belongs to. Drives the
 * workspace shell's secondary row: a group is expanded into its own child
 * links only while one of its items is active.
 */
export function findHrmGroupForKey(key: HrmNavKey | null): HrmNavGroup | null {
  if (!key) return null;
  return HRM_NAV_GROUPS.find((group) => group.items.some((item) => item.key === key)) ?? null;
}

/**
 * Second-level workspace nested inside the HRM workspace's "Payroll" tab.
 * Kept as its own key/group/resolver set (mirroring HrmNavKey above) rather
 * than folded into HRM_NAV_GROUPS, so Payroll's 19 routes never spill into
 * the top-level HRM tab bar as a single long row.
 */
export type PayrollNavKey =
  | "payrollOverview"
  | "payrollSettings"
  | "payCalendars"
  | "salaryStructures"
  | "payComponents"
  | "statutoryRules"
  | "employeeCompensation"
  | "paymentDetails"
  | "openingBalances"
  | "payrollRuns"
  | "payrollManualInputs"
  | "payrollApprovals"
  | "finalizedPayroll"
  | "payrollCorrections"
  | "payslips"
  | "paymentBatches"
  | "paymentTemplates"
  | "statutoryLiabilities"
  | "journalDrafts";

export type PayrollNavItem = {
  key: PayrollNavKey;
  title: string;
  to: string;
  icon: LucideIcon;
  description: string;
};

export type PayrollNavGroup = {
  label: string;
  items: PayrollNavItem[];
};

export const PAYROLL_NAV_GROUPS: PayrollNavGroup[] = [
  {
    label: "Overview",
    items: [
      {
        key: "payrollOverview",
        title: "Payroll Overview",
        to: "/hrm/payroll",
        icon: Wallet,
        description: "Payroll configuration readiness and Phase 4A status.",
      },
    ],
  },
  {
    label: "Payroll Setup",
    items: [
      {
        key: "payrollSettings",
        title: "Payroll Settings",
        to: "/hrm/payroll/settings",
        icon: Settings2,
        description: "Effective-dated payroll controls.",
      },
      {
        key: "payCalendars",
        title: "Pay Calendars",
        to: "/hrm/payroll/calendars",
        icon: CalendarDays,
        description: "Pay frequencies and planned periods.",
      },
      {
        key: "salaryStructures",
        title: "Salary Structures",
        to: "/hrm/payroll/salary-structures",
        icon: SlidersHorizontal,
        description: "Effective salary structures and grades.",
      },
      {
        key: "payComponents",
        title: "Pay Components",
        to: "/hrm/payroll/pay-components",
        icon: Boxes,
        description: "Reusable earning and deduction definitions.",
      },
      {
        key: "statutoryRules",
        title: "Statutory Rules",
        to: "/hrm/payroll/statutory-rules",
        icon: ScrollText,
        description: "Versioned jurisdiction rule configuration.",
      },
    ],
  },
  {
    label: "Employee Compensation",
    items: [
      {
        key: "employeeCompensation",
        title: "Employee Compensation",
        to: "/hrm/payroll/compensation",
        icon: BriefcaseBusiness,
        description: "Restricted effective-dated compensation.",
      },
      {
        key: "paymentDetails",
        title: "Payment Details",
        to: "/hrm/payroll/payment-details",
        icon: ShieldCheck,
        description: "Encrypted and masked employee payment destinations.",
      },
      {
        key: "openingBalances",
        title: "Opening Balances",
        to: "/hrm/payroll/opening-balances",
        icon: Upload,
        description: "Source-backed payroll migration staging.",
      },
    ],
  },
  {
    label: "Payroll Processing",
    items: [
      {
        key: "payrollRuns",
        title: "Draft Payroll Runs",
        to: "/hrm/payroll/runs",
        icon: ClipboardList,
        description: "Calculate and review versioned draft payroll.",
      },
      {
        key: "payrollManualInputs",
        title: "Manual Payroll Inputs",
        to: "/hrm/payroll/manual-inputs",
        icon: FileText,
        description: "Source-backed one-time draft payroll inputs.",
      },
      {
        key: "payrollApprovals",
        title: "Payroll Approvals",
        to: "/hrm/payroll/approvals",
        icon: ShieldCheck,
        description: "Submit, approve, reject and return payroll runs.",
      },
      {
        key: "finalizedPayroll",
        title: "Finalized Payroll",
        to: "/hrm/payroll/finalized",
        icon: Lock,
        description: "Immutable finalized payroll snapshots.",
      },
      {
        key: "payrollCorrections",
        title: "Payroll Corrections",
        to: "/hrm/payroll/corrections",
        icon: RotateCcw,
        description: "Correction, supplemental and reversal foundations.",
      },
    ],
  },
  {
    label: "Payments & Reporting",
    items: [
      {
        key: "payslips",
        title: "Payslips",
        to: "/hrm/payroll/payslips",
        icon: FileText,
        description: "Generated payslip versions and publication.",
      },
      {
        key: "paymentBatches",
        title: "Payment Preparation",
        to: "/hrm/payroll/payment-batches",
        icon: Wallet,
        description: "Prepared payment batches and export status.",
      },
      {
        key: "paymentTemplates",
        title: "Payment Export Templates",
        to: "/hrm/payroll/payment-templates",
        icon: Settings2,
        description: "Safe bank and mobile-money file templates.",
      },
      {
        key: "statutoryLiabilities",
        title: "Statutory Liabilities",
        to: "/hrm/payroll/statutory-liabilities",
        icon: ScrollText,
        description: "Finalized liability summaries, not submissions.",
      },
      {
        key: "journalDrafts",
        title: "Journal Drafts",
        to: "/hrm/payroll/journals",
        icon: ClipboardList,
        description: "Accounting journal drafts, not posted entries.",
      },
    ],
  },
];

export const PAYROLL_NAV_ITEMS: PayrollNavItem[] = PAYROLL_NAV_GROUPS.flatMap((g) => g.items);

/** True for /hrm/payroll and every route beneath it. */
export function isPayrollPath(pathname: string): boolean {
  return pathname === "/hrm/payroll" || pathname.startsWith("/hrm/payroll/");
}

export function resolveActivePayrollKey(pathname: string): PayrollNavKey | null {
  const matches = PAYROLL_NAV_ITEMS.filter((item) => {
    if (pathname === item.to) return true;
    if (item.to === "/hrm/payroll") return false;
    return pathname.startsWith(`${item.to}/`);
  });
  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.to.length - a.to.length)[0].key;
}

/** Which PAYROLL_NAV_GROUPS group a given active payroll key belongs to. */
export function findPayrollGroupForKey(key: PayrollNavKey | null): PayrollNavGroup | null {
  if (!key) return null;
  return PAYROLL_NAV_GROUPS.find((group) => group.items.some((item) => item.key === key)) ?? null;
}
