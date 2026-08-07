import { usePermission } from "@/hooks/use-permission";
import { useActiveProperty } from "@/hooks/use-active-property";
import { HRM_ADMIN_ROLES } from "@/lib/hrm/permissions";
import type { HrmNavKey } from "@/lib/hrm/nav-config";

export type HrmVisibility = Record<HrmNavKey, boolean>;

/**
 * Single source of truth for which HRM sections the signed-in user may see.
 * Shared by the collapsed sidebar entry (visible if any key is true) and the
 * in-workspace section nav (each item gated by its own key) so the two
 * checks can never drift apart.
 */
export function useHrmVisibility(): { visibility: HrmVisibility; loading: boolean } {
  const propertyId = useActiveProperty();
  const dashboard = usePermission({
    propertyId,
    module: "hrm_dashboard",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const employees = usePermission({
    propertyId,
    module: "employees",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const departments = usePermission({
    propertyId,
    module: "departments",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const designations = usePermission({
    propertyId,
    module: "designations",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const documents = usePermission({
    propertyId,
    module: "employee_documents",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const announcements = usePermission({
    propertyId,
    module: "staff_announcements",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const shifts = usePermission({
    propertyId,
    module: "shift_templates",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const roster = usePermission({
    propertyId,
    module: "duty_roster",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const holidays = usePermission({
    propertyId,
    module: "holidays",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const workforceSettings = usePermission({
    propertyId,
    module: "workforce_settings",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const attendance = usePermission({
    propertyId,
    module: "attendance",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const timeClock = usePermission({
    propertyId,
    module: "time_clock",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const leave = usePermission({
    propertyId,
    module: "leave_own",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const leaveCalendar = usePermission({
    propertyId,
    module: "leave_calendar",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const leaveTypes = usePermission({
    propertyId,
    module: "leave_settings",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const leaveBalances = usePermission({
    propertyId,
    module: "leave_balances",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const biometricDevices = usePermission({
    propertyId,
    module: "biometric_devices",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });

  const checks = [
    dashboard,
    employees,
    departments,
    designations,
    documents,
    announcements,
    shifts,
    roster,
    holidays,
    workforceSettings,
    attendance,
    timeClock,
    leave,
    leaveCalendar,
    leaveTypes,
    leaveBalances,
    biometricDevices,
  ];

  return {
    visibility: {
      dashboard: dashboard.allowed,
      employees: employees.allowed,
      departments: departments.allowed,
      designations: designations.allowed,
      documents: documents.allowed,
      announcements: announcements.allowed,
      shifts: shifts.allowed,
      roster: roster.allowed,
      holidays: holidays.allowed,
      workforceSettings: workforceSettings.allowed,
      attendance: attendance.allowed,
      timeClock: timeClock.allowed,
      leave: leave.allowed,
      leaveCalendar: leaveCalendar.allowed,
      leaveTypes: leaveTypes.allowed,
      leaveBalances: leaveBalances.allowed,
      biometricDevices: biometricDevices.allowed,
    },
    loading: checks.some((c) => c.loading),
  };
}
