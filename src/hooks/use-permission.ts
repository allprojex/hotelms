import { useQuery } from "@tanstack/react-query";
import type { AppRole } from "@/hooks/use-user-roles";
import { useUserRoles } from "@/hooks/use-user-roles";
import { supabase } from "@/integrations/supabase/client";
import {
  resolvePermission,
  STORED_ACTION_FOR_CAPABILITY,
  type PermissionCapability,
  type PermissionGrant,
} from "@/lib/permissions";

/**
 * UI convenience only. Mutations and sensitive reads must repeat this check
 * with assertServerPermission and rely on RLS.
 */
export function usePermission(input: {
  propertyId: string | null;
  module: string;
  capability: PermissionCapability;
  defaultRoles?: readonly AppRole[];
}) {
  const roles = useUserRoles();
  const heldRoles = [...new Set((roles.data ?? []).map((row) => row.role))].sort();
  const grants = useQuery({
    queryKey: ["permission", input.propertyId, input.module, input.capability, heldRoles],
    enabled: !roles.isLoading && heldRoles.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const result = await supabase
        .from("role_permissions")
        .select("role,property_id,module,action,allowed")
        .eq("module", input.module)
        .eq("action", STORED_ACTION_FOR_CAPABILITY[input.capability])
        .in("role", heldRoles);
      if (result.error) throw result.error;
      return (result.data ?? []) as PermissionGrant[];
    },
  });

  return {
    allowed: resolvePermission({
      roles: roles.data ?? [],
      grants: grants.data ?? [],
      request: input,
    }),
    loading: roles.isLoading || grants.isLoading,
    error: roles.error ?? grants.error ?? null,
  };
}
