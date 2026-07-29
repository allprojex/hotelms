import type { AppRole } from "@/hooks/use-user-roles";
import { EXEC_ROLES, SYNC_ROLES } from "@/hooks/use-user-roles";
import { ADMIN_ROLES } from "@/lib/admin/permissions";

/**
 * Route-prefix → required roles. Longest prefix wins.
 * Missing entry ⇒ open to any authenticated user.
 */
const FRONT_OFFICE: AppRole[] = [...ADMIN_ROLES, "front_desk", "reservations", "guest_relations"];
const HOUSEKEEPING: AppRole[] = [...ADMIN_ROLES, "housekeeping_supervisor", "housekeeping"];
const ACCOUNTING: AppRole[] = [...ADMIN_ROLES, "accountant", "auditor"];
const POS: AppRole[] = [
  ...ADMIN_ROLES,
  "cashier",
  "front_desk",
  "restaurant_manager",
  "waiter",
  "kitchen",
];
const INVENTORY: AppRole[] = [...ADMIN_ROLES, "accountant", "storekeeper"];

const REPORTS: AppRole[] = [...EXEC_ROLES, "auditor"];
const HRM: AppRole[] = [...ADMIN_ROLES, "hr"];

export const ROUTE_ROLE_MAP: { prefix: string; roles: AppRole[] }[] = [
  { prefix: "/admin/rbac-preview", roles: ["super_admin"] },
  { prefix: "/admin/uploads", roles: ADMIN_ROLES },
  { prefix: "/admin/health", roles: ADMIN_ROLES },
  { prefix: "/admin/online-users", roles: ADMIN_ROLES },
  { prefix: "/admin/audit", roles: [...ADMIN_ROLES, "auditor"] },
  { prefix: "/admin/security", roles: [...ADMIN_ROLES, "auditor", "security"] },
  { prefix: "/admin/esl", roles: ADMIN_ROLES },
  { prefix: "/admin/printers", roles: ADMIN_ROLES },
  { prefix: "/admin/system-updates", roles: ADMIN_ROLES },
  { prefix: "/admin/backup", roles: ["super_admin"] },
  { prefix: "/admin/recycle-bin", roles: ADMIN_ROLES },
  { prefix: "/admin", roles: [...ADMIN_ROLES, "hr"] },
  { prefix: "/settings/roles-matrix", roles: ADMIN_ROLES },
  { prefix: "/settings/roles", roles: [...ADMIN_ROLES, "hr"] },
  { prefix: "/settings/guest-id-types", roles: ADMIN_ROLES },
  { prefix: "/properties", roles: ADMIN_ROLES },
  { prefix: "/hrm", roles: HRM },
  { prefix: "/accounting/sync", roles: SYNC_ROLES },
  { prefix: "/accounting", roles: ACCOUNTING },
  { prefix: "/analytics", roles: REPORTS },
  { prefix: "/reports", roles: REPORTS },
  { prefix: "/channels", roles: [...ADMIN_ROLES, "reservations"] },
  { prefix: "/inventory", roles: INVENTORY },
  { prefix: "/pos", roles: POS },
  { prefix: "/rooms", roles: [...FRONT_OFFICE, ...HOUSEKEEPING, "security", "maintenance"] },
  { prefix: "/rates", roles: [...ADMIN_ROLES, "reservations"] },
  { prefix: "/housekeeping", roles: [...HOUSEKEEPING, "maintenance"] },
  { prefix: "/reservations", roles: FRONT_OFFICE },
  {
    prefix: "/calendar",
    roles: [...FRONT_OFFICE, "housekeeping_supervisor", "housekeeping", "security"],
  },
  { prefix: "/guests", roles: FRONT_OFFICE },
];

export function requiredRolesFor(path: string): AppRole[] | null {
  const match = ROUTE_ROLE_MAP.filter(
    (e) => path === e.prefix || path.startsWith(e.prefix + "/"),
  ).sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return match?.roles ?? null;
}

export function isAllowed(
  path: string,
  rows: { role: AppRole; property_id: string | null }[],
  propertyId: string | null,
): boolean {
  const required = requiredRolesFor(path);
  if (!required) return true;
  return rows.some(
    (r) =>
      r.role === "super_admin" ||
      (required.includes(r.role) && (r.property_id === null || r.property_id === propertyId)),
  );
}
