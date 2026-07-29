import type { AppRole } from "@/hooks/use-user-roles";
import type { Database } from "@/integrations/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolvePermission,
  STORED_ACTION_FOR_CAPABILITY,
  type PermissionGrant,
  type PermissionRequest,
  type PropertyRole,
} from "@/lib/permissions";

export type PermissionContext = {
  userId: string;
  supabase: SupabaseClient<Database>;
};

export class PermissionDeniedError extends Error {
  constructor() {
    super("Not authorized for this property");
    this.name = "PermissionDeniedError";
  }
}

export async function hasServerPermission(
  context: PermissionContext,
  request: PermissionRequest,
): Promise<boolean> {
  const rolesResult = await context.supabase
    .from("user_roles")
    .select("role,property_id")
    .eq("user_id", context.userId);
  if (rolesResult.error) throw new Error(rolesResult.error.message);

  const roles = (rolesResult.data ?? []) as PropertyRole[];
  if (roles.some((row) => row.role === "super_admin")) return true;

  const heldRoles = [...new Set(roles.map((row) => row.role))] as AppRole[];
  if (heldRoles.length === 0) return false;

  const grantsResult = await context.supabase
    .from("role_permissions")
    .select("role,property_id,module,action,allowed")
    .eq("module", request.module)
    .eq("action", STORED_ACTION_FOR_CAPABILITY[request.capability])
    .in("role", heldRoles);
  if (grantsResult.error) throw new Error(grantsResult.error.message);

  return resolvePermission({
    roles,
    grants: (grantsResult.data ?? []) as PermissionGrant[],
    request,
  });
}

export async function assertServerPermission(
  context: PermissionContext,
  request: PermissionRequest,
): Promise<void> {
  if (!(await hasServerPermission(context, request))) {
    throw new PermissionDeniedError();
  }
}
