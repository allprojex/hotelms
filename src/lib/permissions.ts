import type { AppRole } from "@/hooks/use-user-roles";

/**
 * Product-facing permission capabilities. They map onto the existing persisted
 * action names so current role_permissions rows remain valid.
 */
export const PERMISSION_CAPABILITIES = [
  "view",
  "create",
  "edit",
  "approve",
  "delete_or_archive",
  "export",
  "print",
  "manage_settings",
] as const;

export type PermissionCapability = (typeof PERMISSION_CAPABILITIES)[number];
export type StoredPermissionAction =
  "create" | "read" | "update" | "delete" | "approve" | "export" | "import" | "print" | "manage";

export const STORED_ACTION_FOR_CAPABILITY: Record<PermissionCapability, StoredPermissionAction> = {
  view: "read",
  create: "create",
  edit: "update",
  approve: "approve",
  delete_or_archive: "delete",
  export: "export",
  print: "print",
  manage_settings: "manage",
};

export type PropertyRole = {
  role: AppRole;
  property_id: string | null;
};

export type PermissionGrant = {
  role: AppRole;
  property_id: string | null;
  module: string;
  action: string;
  allowed: boolean;
};

export type PermissionRequest = {
  propertyId: string | null;
  module: string;
  capability: PermissionCapability;
  defaultRoles?: readonly AppRole[];
};

export function permissionKey(module: string, capability: PermissionCapability): string {
  if (!/^[a-z][a-z0-9_]*$/.test(module)) {
    throw new Error("Permission modules must use lower_snake_case");
  }
  return `${module}.${capability}`;
}

export function roleAppliesToProperty(row: PropertyRole, propertyId: string | null): boolean {
  if (row.role === "super_admin") return true;
  if (propertyId === null) return row.property_id === null;
  return row.property_id === null || row.property_id === propertyId;
}

/**
 * Resolve a permission without changing legacy role behavior:
 * - super_admin remains an unconditional override;
 * - an explicit role_permissions row overrides that role's default;
 * - absent rows fall back to the caller's existing role convention;
 * - any applicable role may grant access.
 */
export function resolvePermission(input: {
  roles: readonly PropertyRole[];
  grants?: readonly PermissionGrant[];
  request: PermissionRequest;
}): boolean {
  const { request } = input;
  const applicableRoles = input.roles.filter((row) =>
    roleAppliesToProperty(row, request.propertyId),
  );
  if (applicableRoles.some((row) => row.role === "super_admin")) return true;

  const action = STORED_ACTION_FOR_CAPABILITY[request.capability];
  return applicableRoles.some((roleRow) => {
    const matching = (input.grants ?? []).filter(
      (grant) =>
        grant.role === roleRow.role &&
        grant.module === request.module &&
        grant.action === action &&
        (grant.property_id === null || grant.property_id === request.propertyId),
    );
    const propertyGrant = matching.find((grant) => grant.property_id === request.propertyId);
    const globalGrant = matching.find((grant) => grant.property_id === null);
    const configured = propertyGrant ?? globalGrant;
    if (configured) return configured.allowed;
    return (request.defaultRoles ?? []).includes(roleRow.role);
  });
}
