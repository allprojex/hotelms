import { describe, expect, it } from "vitest";
import {
  permissionKey,
  resolvePermission,
  STORED_ACTION_FOR_CAPABILITY,
  type PermissionGrant,
  type PropertyRole,
} from "@/lib/permissions";

const PROPERTY_A = "00000000-0000-4000-8000-00000000000a";
const PROPERTY_B = "00000000-0000-4000-8000-00000000000b";

function roles(role: PropertyRole["role"], propertyId: string | null): PropertyRole[] {
  return [{ role, property_id: propertyId }];
}

function grant(
  role: PermissionGrant["role"],
  propertyId: string | null,
  allowed: boolean,
): PermissionGrant {
  return {
    role,
    property_id: propertyId,
    module: "analytics",
    action: "export",
    allowed,
  };
}

describe("permission conventions", () => {
  it("maps product capabilities to the existing persisted actions", () => {
    expect(STORED_ACTION_FOR_CAPABILITY).toEqual({
      view: "read",
      create: "create",
      edit: "update",
      approve: "approve",
      delete_or_archive: "delete",
      export: "export",
      print: "print",
      manage_settings: "manage",
    });
    expect(permissionKey("guest_reports", "export")).toBe("guest_reports.export");
    expect(() => permissionKey("Guest Reports", "view")).toThrow("lower_snake_case");
  });

  it("retains legacy role defaults only inside the assigned property", () => {
    const request = {
      propertyId: PROPERTY_A,
      module: "analytics",
      capability: "export" as const,
      defaultRoles: ["accountant"] as const,
    };
    expect(resolvePermission({ roles: roles("accountant", PROPERTY_A), request })).toBe(true);
    expect(resolvePermission({ roles: roles("accountant", PROPERTY_B), request })).toBe(false);
  });

  it("uses explicit property grants and denials before role defaults", () => {
    const request = {
      propertyId: PROPERTY_A,
      module: "analytics",
      capability: "export" as const,
      defaultRoles: ["accountant"] as const,
    };
    expect(
      resolvePermission({
        roles: roles("accountant", PROPERTY_A),
        grants: [grant("accountant", PROPERTY_A, false)],
        request,
      }),
    ).toBe(false);
    expect(
      resolvePermission({
        roles: roles("auditor", PROPERTY_A),
        grants: [grant("auditor", PROPERTY_A, true)],
        request,
      }),
    ).toBe(true);
  });

  it("prefers property overrides and preserves the super-admin override", () => {
    const request = {
      propertyId: PROPERTY_A,
      module: "analytics",
      capability: "export" as const,
      defaultRoles: [] as const,
    };
    expect(
      resolvePermission({
        roles: roles("auditor", PROPERTY_A),
        grants: [grant("auditor", null, true), grant("auditor", PROPERTY_A, false)],
        request,
      }),
    ).toBe(false);
    expect(
      resolvePermission({
        roles: roles("super_admin", null),
        grants: [grant("super_admin", PROPERTY_A, false)],
        request,
      }),
    ).toBe(true);
  });
});
