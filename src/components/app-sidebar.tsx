import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { BrandMark } from "@/components/brand-mark";
import {
  LayoutDashboard,
  CalendarDays,
  BedDouble,
  DoorOpen,
  Users,
  Tag,
  Sparkles,
  BarChart3,
  Building2,
  UserCog,
  Settings,
  ClipboardList,
  Lock,
  ShoppingCart,
  Radio,
  Package,
  Wallet,
  TrendingUp,
  Utensils,
  Truck,
  ArrowLeftRight,
  Boxes,
  AlertTriangle,
  FileText,
  Moon,
  Settings2,
  Share2,
  ShieldCheck,
  Search,
  Bell,
  Upload,
  ScrollText,
  Wifi,
  Grid3x3,
  IdCard,
  PackageOpen,
  HardDriveDownload,
  ShieldAlert,
  Printer,
  Recycle,
  LifeBuoy,
  Activity,
  BriefcaseBusiness,
  Megaphone,
  CalendarClock,
  CalendarHeart,
  SlidersHorizontal,
  RotateCcw,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useUserRoles, EXEC_ROLES, SYNC_ROLES, type AppRole } from "@/hooks/use-user-roles";
import { useActiveProperty } from "@/hooks/use-active-property";
import { ADMIN_ROLES } from "@/lib/admin/permissions";
import { usePermission } from "@/hooks/use-permission";
import { HRM_ADMIN_ROLES, PAYROLL_SENSITIVE_ROLES } from "@/lib/hrm/permissions";

type NavItem = {
  title: string;
  to: string;
  icon: LucideIcon;
  description: string;
  requireRoles?: AppRole[];
  hrmPermission?:
    | "dashboard"
    | "employees"
    | "departments"
    | "designations"
    | "documents"
    | "announcements"
    | "shifts"
    | "roster"
    | "holidays"
    | "workforceSettings"
    | "attendance"
    | "timeClock"
    | "leave"
    | "leaveCalendar"
    | "leaveTypes"
    | "leaveBalances"
    | "biometricDevices"
    | "payrollOverview"
    | "payrollSettings"
    | "payCalendars"
    | "salaryStructures"
    | "payComponents"
    | "employeeCompensation"
    | "paymentDetails"
    | "statutoryRules"
    | "openingBalances"
    | "payrollRuns"
    | "payrollManualInputs"
    | "payrollApprovals"
    | "finalizedPayroll"
    | "payslips"
    | "paymentBatches"
    | "paymentTemplates"
    | "statutoryLiabilities"
    | "journalDrafts"
    | "payrollCorrections";
};

// One accent hue per nav group; the token itself is defined in src/styles.css
// (both light and dark) so switching themes rebalances the palette automatically.
const GROUP_ACCENT: Record<string, string> = {
  Home: "var(--nav-home)",
  "Front Office": "var(--nav-front-office)",
  "Rooms & Rates": "var(--nav-rooms-rates)",
  "Point of Sale": "var(--nav-pos)",
  Inventory: "var(--nav-inventory)",
  Distribution: "var(--nav-distribution)",
  "Human Resources": "var(--nav-hrm)",
  "HRM Payroll": "var(--nav-hrm)",
  Accounting: "var(--nav-accounting)",
  Insights: "var(--nav-insights)",
  Administration: "var(--nav-administration)",
};

const opsGroups: { label: string; items: NavItem[] }[] = [
  // 1. Home — always first (Nielsen: recognition, immediate orientation)
  {
    label: "Home",
    items: [
      {
        title: "Dashboard",
        to: "/dashboard",
        icon: LayoutDashboard,
        description: "Real-time KPIs, arrivals, and revenue.",
      },
    ],
  },
  // 2. Front Office — highest daily-frequency tasks (Fitts' law: closest to home)
  {
    label: "Front Office",
    items: [
      {
        title: "Reservations",
        to: "/reservations",
        icon: ClipboardList,
        description: "Bookings, holds, cancellations.",
      },
      {
        title: "Calendar",
        to: "/calendar",
        icon: CalendarDays,
        description: "Availability grid across rooms and dates.",
      },
      {
        title: "Guests",
        to: "/guests",
        icon: Users,
        description: "Guest profiles, stay history, preferences.",
      },
      {
        title: "Housekeeping",
        to: "/housekeeping",
        icon: Sparkles,
        description: "Room status board and cleaning tasks.",
      },
    ],
  },
  // 3. Rooms & Rates — property-side product catalog for front office
  {
    label: "Rooms & Rates",
    items: [
      {
        title: "Rooms",
        to: "/rooms",
        icon: BedDouble,
        description: "Individual room records and status.",
      },
      {
        title: "Room Types",
        to: "/rooms/types",
        icon: DoorOpen,
        description: "Categories, capacity, base rates.",
      },
      {
        title: "Rate Plans",
        to: "/rates",
        icon: Tag,
        description: "Public and negotiated pricing.",
      },
    ],
  },
  // 4. Point of Sale
  {
    label: "Point of Sale",
    items: [
      {
        title: "POS Terminal",
        to: "/pos",
        icon: Utensils,
        description: "Take orders, print KOTs, settle checks.",
      },
      {
        title: "Menu",
        to: "/pos/menu",
        icon: ShoppingCart,
        description: "Manage outlets, items, prices.",
      },
    ],
  },
  // 5. Inventory — supply side, less frequent than POS
  {
    label: "Inventory",
    items: [
      {
        title: "Overview",
        to: "/inventory",
        icon: Boxes,
        description: "Stock levels by location.",
      },
      {
        title: "Items & Setup",
        to: "/inventory/settings",
        icon: Package,
        description: "Suppliers, categories, items.",
      },
      {
        title: "Purchase Orders",
        to: "/inventory/purchase-orders",
        icon: Truck,
        description: "Create and receive POs.",
      },
      {
        title: "Transfers",
        to: "/inventory/transfers",
        icon: ArrowLeftRight,
        description: "Move stock between locations.",
      },
      {
        title: "Adjustments",
        to: "/inventory/adjustments",
        icon: AlertTriangle,
        description: "Wastage, counts, corrections.",
      },
    ],
  },
  // 6. Distribution — channels feed operations
  {
    label: "Distribution",
    items: [
      {
        title: "Channel Manager",
        to: "/channels",
        icon: Radio,
        description: "OTA sync (Booking.com, Expedia, Airbnb).",
      },
    ],
  },
  {
    label: "Human Resources",
    items: [
      {
        title: "HRM Dashboard",
        to: "/hrm",
        icon: BriefcaseBusiness,
        description: "Employee and HR operations overview.",
        hrmPermission: "dashboard",
      },
      {
        title: "Employees",
        to: "/hrm/employees",
        icon: Users,
        description: "Employee records and professional profiles.",
        hrmPermission: "employees",
      },
      {
        title: "Departments",
        to: "/hrm/departments",
        icon: Building2,
        description: "Property department structure.",
        hrmPermission: "departments",
      },
      {
        title: "Designations",
        to: "/hrm/designations",
        icon: IdCard,
        description: "Job titles, levels, and department alignment.",
        hrmPermission: "designations",
      },
      {
        title: "Employee Documents",
        to: "/hrm/documents",
        icon: FileText,
        description: "Private employee document records.",
        hrmPermission: "documents",
      },
      {
        title: "Staff Announcements",
        to: "/hrm/announcements",
        icon: Megaphone,
        description: "Internal property staff notices.",
        hrmPermission: "announcements",
      },
      {
        title: "Shift Scheduling",
        to: "/hrm/shifts",
        icon: CalendarClock,
        description: "Reusable shift templates and working hours.",
        hrmPermission: "shifts",
      },
      {
        title: "Duty Roster",
        to: "/hrm/roster",
        icon: ClipboardList,
        description: "Assign and publish employee duty schedules.",
        hrmPermission: "roster",
      },
      {
        title: "Holiday Calendar",
        to: "/hrm/holidays",
        icon: CalendarHeart,
        description: "Property and department holiday dates.",
        hrmPermission: "holidays",
      },
      {
        title: "Workforce Settings",
        to: "/hrm/workforce-settings",
        icon: SlidersHorizontal,
        description: "Timezone and workforce time rules.",
        hrmPermission: "workforceSettings",
      },
      {
        title: "Attendance",
        to: "/hrm/attendance",
        icon: Activity,
        description: "Attendance review, adjustments, approvals, and reports.",
        hrmPermission: "attendance",
      },
      {
        title: "Time Clock",
        to: "/hrm/time-clock",
        icon: CalendarClock,
        description: "Record your own work and break events.",
        hrmPermission: "timeClock",
      },
      {
        title: "Leave Management",
        to: "/hrm/leave",
        icon: CalendarDays,
        description: "Request, review, and approve employee leave.",
        hrmPermission: "leave",
      },
      {
        title: "Leave Calendar",
        to: "/hrm/leave/calendar",
        icon: CalendarHeart,
        description: "Approved property leave calendar.",
        hrmPermission: "leaveCalendar",
      },
      {
        title: "Leave Types",
        to: "/hrm/leave/types",
        icon: Settings2,
        description: "Configure property leave policies.",
        hrmPermission: "leaveTypes",
      },
      {
        title: "Leave Balances",
        to: "/hrm/leave/balances",
        icon: BarChart3,
        description: "Employee leave entitlement balances.",
        hrmPermission: "leaveBalances",
      },
      {
        title: "Biometric Devices",
        to: "/hrm/biometric-devices",
        icon: ShieldCheck,
        description: "Vendor-neutral device integration architecture.",
        hrmPermission: "biometricDevices",
      },
    ],
  },
  {
    label: "HRM Payroll",
    items: [
      {
        title: "Payroll Overview",
        to: "/hrm/payroll",
        icon: Wallet,
        description: "Payroll configuration readiness and Phase 4A status.",
        hrmPermission: "payrollOverview",
      },
      {
        title: "Payroll Settings",
        to: "/hrm/payroll/settings",
        icon: Settings2,
        description: "Effective-dated payroll controls.",
        hrmPermission: "payrollSettings",
      },
      {
        title: "Pay Calendars",
        to: "/hrm/payroll/calendars",
        icon: CalendarDays,
        description: "Pay frequencies and planned periods.",
        hrmPermission: "payCalendars",
      },
      {
        title: "Salary Structures",
        to: "/hrm/payroll/salary-structures",
        icon: SlidersHorizontal,
        description: "Effective salary structures and grades.",
        hrmPermission: "salaryStructures",
      },
      {
        title: "Pay Components",
        to: "/hrm/payroll/pay-components",
        icon: Boxes,
        description: "Reusable earning and deduction definitions.",
        hrmPermission: "payComponents",
      },
      {
        title: "Employee Compensation",
        to: "/hrm/payroll/compensation",
        icon: BriefcaseBusiness,
        description: "Restricted effective-dated compensation.",
        hrmPermission: "employeeCompensation",
      },
      {
        title: "Payment Details",
        to: "/hrm/payroll/payment-details",
        icon: ShieldCheck,
        description: "Encrypted and masked employee payment destinations.",
        hrmPermission: "paymentDetails",
      },
      {
        title: "Statutory Rules",
        to: "/hrm/payroll/statutory-rules",
        icon: ScrollText,
        description: "Versioned jurisdiction rule configuration.",
        hrmPermission: "statutoryRules",
      },
      {
        title: "Opening Balances",
        to: "/hrm/payroll/opening-balances",
        icon: Upload,
        description: "Source-backed payroll migration staging.",
        hrmPermission: "openingBalances",
      },
      {
        title: "Draft Payroll Runs",
        to: "/hrm/payroll/runs",
        icon: ClipboardList,
        description: "Calculate and review versioned draft payroll.",
        hrmPermission: "payrollRuns",
      },
      {
        title: "Manual Payroll Inputs",
        to: "/hrm/payroll/manual-inputs",
        icon: FileText,
        description: "Source-backed one-time draft payroll inputs.",
        hrmPermission: "payrollManualInputs",
      },
      {
        title: "Payroll Approvals",
        to: "/hrm/payroll/approvals",
        icon: ShieldCheck,
        description: "Submit, approve, reject and return payroll runs.",
        hrmPermission: "payrollApprovals",
      },
      {
        title: "Finalized Payroll",
        to: "/hrm/payroll/finalized",
        icon: Lock,
        description: "Immutable finalized payroll snapshots.",
        hrmPermission: "finalizedPayroll",
      },
      {
        title: "Payslips",
        to: "/hrm/payroll/payslips",
        icon: FileText,
        description: "Generated payslip versions and publication.",
        hrmPermission: "payslips",
      },
      {
        title: "Payment Preparation",
        to: "/hrm/payroll/payment-batches",
        icon: Wallet,
        description: "Prepared payment batches and export status.",
        hrmPermission: "paymentBatches",
      },
      {
        title: "Payment Export Templates",
        to: "/hrm/payroll/payment-templates",
        icon: Settings2,
        description: "Safe bank and mobile-money file templates.",
        hrmPermission: "paymentTemplates",
      },
      {
        title: "Statutory Liabilities",
        to: "/hrm/payroll/statutory-liabilities",
        icon: ScrollText,
        description: "Finalized liability summaries, not submissions.",
        hrmPermission: "statutoryLiabilities",
      },
      {
        title: "Journal Drafts",
        to: "/hrm/payroll/journals",
        icon: ClipboardList,
        description: "Accounting journal drafts, not posted entries.",
        hrmPermission: "journalDrafts",
      },
      {
        title: "Payroll Corrections",
        to: "/hrm/payroll/corrections",
        icon: RotateCcw,
        description: "Correction, supplemental and reversal foundations.",
        hrmPermission: "payrollCorrections",
      },
    ],
  },
  // 7. Accounting — back office
  {
    label: "Accounting",
    items: [
      {
        title: "Overview",
        to: "/accounting",
        icon: Wallet,
        description: "Ledger, receivables, payables at a glance.",
      },
      {
        title: "Chart of Accounts",
        to: "/accounting/accounts",
        icon: Boxes,
        description: "Ledger accounts and hierarchy.",
      },
      {
        title: "Journal",
        to: "/accounting/journal",
        icon: ClipboardList,
        description: "Manual and posted entries.",
      },
      {
        title: "Accounts Receivable",
        to: "/accounting/ar",
        icon: FileText,
        description: "Customer invoices and receipts.",
      },
      {
        title: "Accounts Payable",
        to: "/accounting/ap",
        icon: Truck,
        description: "Supplier bills and payments.",
      },
      {
        title: "Night Audit",
        to: "/accounting/night-audit",
        icon: Moon,
        description: "Day-close postings and reconciliation.",
      },
      {
        title: "Posting Rules",
        to: "/accounting/posting-rules",
        icon: Settings2,
        description: "Automatic mapping from operations to GL.",
      },
      {
        title: "Reports",
        to: "/accounting/reports",
        icon: BarChart3,
        description: "Trial balance, P&L, balance sheet.",
      },
      {
        title: "FX & Currencies",
        to: "/accounting/fx",
        icon: TrendingUp,
        description: "Foreign exchange rate log.",
      },
      {
        title: "Periods",
        to: "/accounting/periods",
        icon: CalendarDays,
        description: "Open, close, and lock accounting periods.",
      },
      {
        title: "External Sync",
        to: "/accounting/sync",
        icon: Share2,
        description: "Push nightly summaries via HMAC webhooks.",
        requireRoles: SYNC_ROLES,
      },
    ],
  },
  // 8. Insights — read-only reporting, low frequency
  {
    label: "Insights",
    items: [
      {
        title: "Reports",
        to: "/reports",
        icon: BarChart3,
        description: "Operational and financial reports.",
      },
      {
        title: "Executive Analytics",
        to: "/analytics",
        icon: TrendingUp,
        description: "BI dashboards, exports, scheduled emails.",
        requireRoles: EXEC_ROLES,
      },
    ],
  },
  // 9. Administration — settings, least frequent, always last (Gestalt: closure)
  {
    label: "Administration",
    items: [
      {
        title: "Properties",
        to: "/properties",
        icon: Building2,
        description: "Hotels, hostels, and other properties.",
      },
      {
        title: "Roles & Permissions",
        to: "/settings/roles",
        icon: UserCog,
        description: "Invite, approve, and manage users and roles.",
        requireRoles: ADMIN_ROLES,
      },
      {
        title: "Permission Matrix",
        to: "/settings/roles-matrix",
        icon: Grid3x3,
        description: "Fine-grained module × action grid per role.",
        requireRoles: ADMIN_ROLES,
      },
      {
        title: "Data Uploads",
        to: "/admin/uploads",
        icon: Upload,
        description: "Excel & CSV bulk import for menu, inventory, prices.",
        requireRoles: ADMIN_ROLES,
      },
      {
        title: "Guest ID Types",
        to: "/settings/guest-id-types",
        icon: IdCard,
        description: "Ghana ID types + property-specific additions.",
        requireRoles: ADMIN_ROLES,
      },
      {
        title: "Online Users",
        to: "/admin/online-users",
        icon: Wifi,
        description: "Live sessions and activity.",
        requireRoles: ADMIN_ROLES,
      },
      {
        title: "Audit Trail",
        to: "/admin/audit",
        icon: ScrollText,
        description: "Every administrative action, searchable.",
        requireRoles: ADMIN_ROLES,
      },
      {
        title: "Security Center",
        to: "/admin/security",
        icon: ShieldAlert,
        description: "Threat feed, brute-force lockouts, session policy, compliance.",
        requireRoles: [...ADMIN_ROLES, "auditor", "security"],
      },
      {
        title: "ESL Dashboard",
        to: "/admin/esl",
        icon: Tag,
        description: "Electronic shelf labels: templates, product mapping, batch export.",
        requireRoles: ADMIN_ROLES,
      },
      {
        title: "Printers",
        to: "/admin/printers",
        icon: Printer,
        description: "Pair USB, Bluetooth, and cloud printers; universal document print.",
        requireRoles: ADMIN_ROLES,
      },
      {
        title: "Notifications",
        to: "/notifications",
        icon: Bell,
        description: "Full history and search of notifications.",
      },
      {
        title: "System Updates",
        to: "/admin/system-updates",
        icon: PackageOpen,
        description: "Version, release notes, updates.",
        requireRoles: ADMIN_ROLES,
      },
      {
        title: "Backup & Recovery",
        to: "/admin/backup",
        icon: HardDriveDownload,
        description: "Full logical backup and restore of all app data.",
        requireRoles: ["super_admin"],
      },
      {
        title: "Recycle Bin",
        to: "/admin/recycle-bin",
        icon: Recycle,
        description: "Restore or permanently purge deleted items.",
        requireRoles: ADMIN_ROLES,
      },
      {
        title: "RBAC Preview",
        to: "/admin/rbac-preview",
        icon: ShieldCheck,
        description: "Preview route access for any role × property scope.",
        requireRoles: ["super_admin"],
      },
      {
        title: "Admin Console",
        to: "/admin",
        icon: ShieldCheck,
        description: "System-wide CRUD, printing, audit.",
        requireRoles: ADMIN_ROLES,
      },
      {
        title: "Health Dashboard",
        to: "/admin/health",
        icon: Activity,
        description: "Live /api/public/health results with remediation steps.",
        requireRoles: ADMIN_ROLES,
      },
      {
        title: "Help & Docs",
        to: "/admin/help",
        icon: LifeBuoy,
        description: "Training guide, deployment guide, checklist, health probe.",
        requireRoles: ADMIN_ROLES,
      },
      {
        title: "Settings",
        to: "/settings",
        icon: Settings,
        description: "Profile, currency, appearance, security.",
      },
    ],
  },
];

export function AppSidebar() {
  const { state, setOpen, setOpenMobile, isMobile } = useSidebar();
  const collapsed = state === "collapsed";
  const currentPath = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (path: string) =>
    currentPath === path || (path !== "/dashboard" && currentPath.startsWith(path));
  const propertyId = useActiveProperty();
  const rolesQ = useUserRoles();
  const roleRows = rolesQ.data ?? [];
  const isSuper = roleRows.some((r) => r.role === "super_admin");
  const hrmDashboard = usePermission({
    propertyId,
    module: "hrm_dashboard",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const hrmEmployees = usePermission({
    propertyId,
    module: "employees",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const hrmDepartments = usePermission({
    propertyId,
    module: "departments",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const hrmDesignations = usePermission({
    propertyId,
    module: "designations",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const hrmDocuments = usePermission({
    propertyId,
    module: "employee_documents",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const hrmAnnouncements = usePermission({
    propertyId,
    module: "staff_announcements",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const hrmShifts = usePermission({
    propertyId,
    module: "shift_templates",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const hrmRoster = usePermission({
    propertyId,
    module: "duty_roster",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const hrmHolidays = usePermission({
    propertyId,
    module: "holidays",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const hrmWorkforceSettings = usePermission({
    propertyId,
    module: "workforce_settings",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const hrmAttendance = usePermission({
    propertyId,
    module: "attendance",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const hrmTimeClock = usePermission({
    propertyId,
    module: "time_clock",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const hrmLeave = usePermission({
    propertyId,
    module: "leave_own",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const hrmLeaveCalendar = usePermission({
    propertyId,
    module: "leave_calendar",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const hrmLeaveTypes = usePermission({
    propertyId,
    module: "leave_settings",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const hrmLeaveBalances = usePermission({
    propertyId,
    module: "leave_balances",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const hrmBiometricDevices = usePermission({
    propertyId,
    module: "biometric_devices",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const payrollOverview = usePermission({
    propertyId,
    module: "payroll_overview",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const payrollSettings = usePermission({
    propertyId,
    module: "payroll_settings",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const payCalendars = usePermission({
    propertyId,
    module: "pay_calendars",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const salaryStructures = usePermission({
    propertyId,
    module: "salary_structures",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const payComponents = usePermission({
    propertyId,
    module: "pay_components",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const employeeCompensation = usePermission({
    propertyId,
    module: "employee_compensation_sensitive",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const paymentDetails = usePermission({
    propertyId,
    module: "payment_details",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const statutoryRules = usePermission({
    propertyId,
    module: "statutory_rules",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const openingBalances = usePermission({
    propertyId,
    module: "opening_balances",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const payrollRuns = usePermission({
    propertyId,
    module: "payroll_runs",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const payrollManualInputs = usePermission({
    propertyId,
    module: "payroll_manual_inputs",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const payrollApprovals = usePermission({
    propertyId,
    module: "payroll_approvals",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const finalizedPayroll = usePermission({
    propertyId,
    module: "finalized_payroll",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const payslips = usePermission({
    propertyId,
    module: "payslips",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const paymentBatches = usePermission({
    propertyId,
    module: "payroll_payment_batches",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const paymentTemplates = usePermission({
    propertyId,
    module: "payroll_payment_templates",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const statutoryLiabilities = usePermission({
    propertyId,
    module: "payroll_statutory_liabilities",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const journalDrafts = usePermission({
    propertyId,
    module: "payroll_journal_drafts",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const payrollCorrections = usePermission({
    propertyId,
    module: "payroll_corrections",
    capability: "create",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const hrmVisibility = {
    dashboard: hrmDashboard.allowed,
    employees: hrmEmployees.allowed,
    departments: hrmDepartments.allowed,
    designations: hrmDesignations.allowed,
    documents: hrmDocuments.allowed,
    announcements: hrmAnnouncements.allowed,
    shifts: hrmShifts.allowed,
    roster: hrmRoster.allowed,
    holidays: hrmHolidays.allowed,
    workforceSettings: hrmWorkforceSettings.allowed,
    attendance: hrmAttendance.allowed,
    timeClock: hrmTimeClock.allowed,
    leave: hrmLeave.allowed,
    leaveCalendar: hrmLeaveCalendar.allowed,
    leaveTypes: hrmLeaveTypes.allowed,
    leaveBalances: hrmLeaveBalances.allowed,
    biometricDevices: hrmBiometricDevices.allowed,
    payrollOverview: payrollOverview.allowed,
    payrollSettings: payrollSettings.allowed,
    payCalendars: payCalendars.allowed,
    salaryStructures: salaryStructures.allowed,
    payComponents: payComponents.allowed,
    employeeCompensation: employeeCompensation.allowed,
    paymentDetails: paymentDetails.allowed,
    statutoryRules: statutoryRules.allowed,
    openingBalances: openingBalances.allowed,
    payrollRuns: payrollRuns.allowed,
    payrollManualInputs: payrollManualInputs.allowed,
    payrollApprovals: payrollApprovals.allowed,
    finalizedPayroll: finalizedPayroll.allowed,
    payslips: payslips.allowed,
    paymentBatches: paymentBatches.allowed,
    paymentTemplates: paymentTemplates.allowed,
    statutoryLiabilities: statutoryLiabilities.allowed,
    journalDrafts: journalDrafts.allowed,
    payrollCorrections: payrollCorrections.allowed,
  };
  const canSee = (required?: AppRole[]) => {
    if (!required) return true;
    if (isSuper) return true;
    return roleRows.some(
      (r) => required.includes(r.role) && (r.property_id === null || r.property_id === propertyId),
    );
  };

  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filteredGroups = useMemo(() => {
    return opsGroups
      .map((g) => ({
        ...g,
        items: g.items
          .filter((it) => canSee(it.requireRoles))
          .filter((it) => !it.hrmPermission || hrmVisibility[it.hrmPermission])
          .filter(
            (it) =>
              !q || it.title.toLowerCase().includes(q) || it.description.toLowerCase().includes(q),
          )
          .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" })),
      }))
      .filter((g) => g.items.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    q,
    roleRows,
    propertyId,
    hrmVisibility.dashboard,
    hrmVisibility.employees,
    hrmVisibility.departments,
    hrmVisibility.designations,
    hrmVisibility.documents,
    hrmVisibility.announcements,
    hrmVisibility.shifts,
    hrmVisibility.roster,
    hrmVisibility.holidays,
    hrmVisibility.workforceSettings,
    hrmVisibility.attendance,
    hrmVisibility.timeClock,
    hrmVisibility.leave,
    hrmVisibility.leaveCalendar,
    hrmVisibility.leaveTypes,
    hrmVisibility.leaveBalances,
    hrmVisibility.biometricDevices,
    hrmVisibility.payrollOverview,
    hrmVisibility.payrollSettings,
    hrmVisibility.payCalendars,
    hrmVisibility.salaryStructures,
    hrmVisibility.payComponents,
    hrmVisibility.employeeCompensation,
    hrmVisibility.paymentDetails,
    hrmVisibility.statutoryRules,
    hrmVisibility.openingBalances,
    hrmVisibility.payrollRuns,
    hrmVisibility.payrollManualInputs,
  ]);

  function handleNavigate() {
    // SRS §2.1: collapse after selecting a menu item to maximize workspace.
    if (isMobile) setOpenMobile(false);
    else setOpen(false);
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b px-3 py-3">
        <Link to="/dashboard" className="flex items-center gap-2" onClick={handleNavigate}>
          <BrandMark className="h-7 w-auto shrink-0" />
          {!collapsed && (
            <div className="min-w-0">
              <div className="font-display text-sm font-semibold leading-tight truncate">
                ThesKwoff Hotel
              </div>
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">PMS</div>
            </div>
          )}
        </Link>
        {!collapsed && (
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search menu…"
              className="h-8 pl-7 text-xs bg-background/60"
              aria-label="Search navigation menu"
            />
          </div>
        )}
      </SidebarHeader>

      <SidebarContent className="overflow-y-auto">
        <TooltipProvider delayDuration={300}>
          {filteredGroups.length === 0 && !collapsed && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              No menu items match “{query}”.
            </div>
          )}
          {filteredGroups.map((group) => {
            const accent = GROUP_ACCENT[group.label];
            return (
              <SidebarGroup
                key={group.label}
                style={accent ? ({ "--nav-accent": accent } as CSSProperties) : undefined}
              >
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.items.map((item) => {
                      const active = isActive(item.to);
                      return (
                        <SidebarMenuItem key={item.to}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <SidebarMenuButton
                                asChild
                                isActive={active}
                                tooltip={
                                  collapsed
                                    ? {
                                        children: (
                                          <div>
                                            <div className="font-medium">{item.title}</div>
                                            <div className="text-[10px] opacity-75 mt-0.5">
                                              {item.description}
                                            </div>
                                          </div>
                                        ),
                                      }
                                    : undefined
                                }
                                className={
                                  active
                                    ? "relative nav-tab-3d nav-tab-3d-active nav-accent-border border-l-2 rounded-md"
                                    : "nav-tab-3d rounded-md"
                                }
                              >
                                <Link
                                  to={item.to}
                                  onClick={handleNavigate}
                                  className="flex items-center gap-2 py-1.5"
                                >
                                  <item.icon
                                    className="h-4 w-4 shrink-0 nav-accent-icon"
                                    style={active ? { opacity: 1 } : { opacity: 0.85 }}
                                  />
                                  {!collapsed && (
                                    <span className="min-w-0 flex-1 truncate text-sm leading-tight">
                                      {item.title}
                                    </span>
                                  )}
                                </Link>
                              </SidebarMenuButton>
                            </TooltipTrigger>
                            {!collapsed && (
                              <TooltipContent side="right" className="max-w-xs">
                                <div className="font-medium">{item.title}</div>
                                <div className="text-xs opacity-80 mt-0.5">{item.description}</div>
                              </TooltipContent>
                            )}
                          </Tooltip>
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            );
          })}
        </TooltipProvider>
      </SidebarContent>

      <SidebarFooter className="border-t p-2 text-[10px] text-muted-foreground">
        {!collapsed && <div className="px-2">v1.2 · Auto-collapsing nav</div>}
      </SidebarFooter>
    </Sidebar>
  );
}
