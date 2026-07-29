import type { AppRole } from "@/hooks/use-user-roles";
import type { PermissionCapability } from "@/lib/permissions";

export const HRM_ADMIN_ROLES: readonly AppRole[] = [
  "super_admin",
  "hotel_owner",
  "general_manager",
  "hr",
];

export const HRM_PERMISSIONS = {
  dashboardView: { module: "hrm_dashboard", capability: "view" },
  employeeView: { module: "employees", capability: "view" },
  employeeCreate: { module: "employees", capability: "create" },
  employeeEdit: { module: "employees", capability: "edit" },
  employeeArchive: { module: "employees", capability: "delete_or_archive" },
  employeeRestore: { module: "employees", capability: "delete_or_archive" },
  sensitiveEmployeeView: { module: "employees_sensitive", capability: "view" },
  departmentView: { module: "departments", capability: "view" },
  departmentManage: { module: "departments", capability: "manage_settings" },
  designationView: { module: "designations", capability: "view" },
  designationManage: { module: "designations", capability: "manage_settings" },
  documentView: { module: "employee_documents", capability: "view" },
  documentUpload: { module: "employee_documents", capability: "create" },
  documentEdit: { module: "employee_documents", capability: "edit" },
  documentArchive: { module: "employee_documents", capability: "delete_or_archive" },
  confidentialDocumentView: {
    module: "confidential_employee_documents",
    capability: "view",
  },
  announcementView: { module: "staff_announcements", capability: "view" },
  announcementManage: { module: "staff_announcements", capability: "manage_settings" },
  announcementPublish: { module: "staff_announcements", capability: "approve" },
  workforceSettingsView: { module: "workforce_settings", capability: "view" },
  workforceSettingsManage: {
    module: "workforce_settings",
    capability: "manage_settings",
  },
  shiftView: { module: "shift_templates", capability: "view" },
  shiftManage: { module: "shift_templates", capability: "manage_settings" },
  rosterView: { module: "duty_roster", capability: "view" },
  rosterManage: { module: "duty_roster", capability: "manage_settings" },
  rosterPublish: { module: "duty_roster", capability: "approve" },
  holidayView: { module: "holidays", capability: "view" },
  holidayManage: { module: "holidays", capability: "manage_settings" },
} as const satisfies Record<string, { module: string; capability: PermissionCapability }>;
