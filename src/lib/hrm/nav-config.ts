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
  | "announcements";

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
    // route (including ones outside this nav, like /hrm/payroll) falls
    // under — only its own descendants should ever fall back to it.
    if (item.to === "/hrm") return false;
    return pathname.startsWith(`${item.to}/`);
  });
  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.to.length - a.to.length)[0].key;
}
