import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type AppRole = Database["public"]["Enums"]["app_role"];

const CURRENT_USER_ID_QUERY_KEY = ["auth-user-id"] as const;

/**
 * Shares one cached auth.getUser() result across every call site via React
 * Query. Previously this was a plain useState/useEffect, so each of the
 * dozens of usePermission()/useUserRoles() call sites in the sidebar fired
 * its own independent getUser() network request on mount - up to 30-40 per
 * page load, saturating the browser's per-host connection limit and
 * starving out the actual data queries behind them.
 */
export function useCurrentUserId(): string | null {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: CURRENT_USER_ID_QUERY_KEY,
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      qc.setQueryData(CURRENT_USER_ID_QUERY_KEY, s?.user?.id ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, [qc]);
  return q.data ?? null;
}

/** Fetches the current user's role rows (global + property-scoped). */
export function useUserRoles() {
  const uid = useCurrentUserId();
  return useQuery({
    queryKey: ["user-roles", uid],
    enabled: !!uid,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("role, property_id")
        .eq("user_id", uid!);
      if (error) throw error;
      return (data ?? []) as { role: AppRole; property_id: string | null }[];
    },
  });
}

/** True if the current user holds any of `roles`, either globally (super_admin / null scope)
 *  or scoped to `propertyId`. */
export function useHasAnyRole(roles: AppRole[], propertyId: string | null): {
  allowed: boolean; loading: boolean;
} {
  const q = useUserRoles();
  if (q.isLoading) return { allowed: false, loading: true };
  const rows = q.data ?? [];
  const allowed = rows.some((r) =>
    r.role === "super_admin" ||
    (roles.includes(r.role) && (r.property_id === null || r.property_id === propertyId))
  );
  return { allowed, loading: false };
}

export const EXEC_ROLES: AppRole[] = ["super_admin", "hotel_owner", "general_manager", "accountant"];
export const SYNC_ROLES: AppRole[] = ["super_admin", "hotel_owner", "general_manager", "accountant"];
