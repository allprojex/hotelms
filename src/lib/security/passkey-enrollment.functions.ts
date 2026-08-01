/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 5 tables await generated database types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertServerPermission, hasServerPermission } from "@/lib/permissions.server";
import { captureAuditEvent } from "@/lib/audit.server";
import { PASSKEY_PERMISSIONS } from "@/lib/security/passkey-permissions";

const uuid = (value: unknown): string => {
  const v = String(value ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v)) throw new Error("Valid identifier required");
  return v;
};
const reasonText = (value: unknown, min: number, max = 500): string => {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length < min) throw new Error(`A reason of at least ${min} characters is required`);
  return trimmed.slice(0, max);
};

/** Self-service: request enrollment approval. Creates no credential. */
export const requestPasskeyEnrollment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string }) => ({ propertyId: uuid(d.propertyId) }))
  .handler(async ({ data, context }) => {
    const result = await (context.supabase as any).rpc("passkey_request_enrollment", {
      _property_id: data.propertyId,
    });
    if (result.error) throw new Error(result.error.message);
    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "passkeys",
      action: "passkey.enrollment.requested",
      resourceType: "passkey_enrollment",
      resourceId: result.data?.id ?? null,
    });
    return result.data;
  });

/** Own enrollment status + own credential summary for the /security/passkeys page. */
export const getOwnPasskeyEnrollment = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string }) => ({ propertyId: uuid(d.propertyId) }))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await (context.supabase as any)
      .from("passkey_enrollments")
      .select(
        "id,status,enrollment_allowed,requested_at,approved_at,rejected_at,rejection_reason,revoked_at,revocation_reason",
      )
      .eq("property_id", data.propertyId)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return row ?? { status: "not_requested", enrollment_allowed: false };
  });

/** Admin: list enrollment requests/status for a property, optionally filtered. */
export const listPasskeyEnrollments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; status?: string }) => ({
    propertyId: uuid(d.propertyId),
    status: d.status,
  }))
  .handler(async ({ data, context }) => {
    await assertServerPermission(context as any, {
      propertyId: data.propertyId,
      ...PASSKEY_PERMISSIONS.enrollmentRequestsView,
      defaultRoles: ["super_admin", "hotel_owner", "general_manager"],
    });
    let query = (context.supabase as any)
      .from("passkey_enrollments")
      .select(
        "id,user_id,employee_id,status,enrollment_allowed,requested_at,approved_at,rejected_at,rejection_reason,revoked_at,revocation_reason,profiles:user_id(full_name,identifier)",
      )
      .eq("property_id", data.propertyId)
      .order("requested_at", { ascending: false, nullsFirst: false });
    if (data.status) query = query.eq("status", data.status);
    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

/** Admin: enrollment history for one user (auditable trail). */
export const listPasskeyEnrollmentHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; targetUserId: string }) => ({
    propertyId: uuid(d.propertyId),
    targetUserId: uuid(d.targetUserId),
  }))
  .handler(async ({ data, context }) => {
    await assertServerPermission(context as any, {
      propertyId: data.propertyId,
      ...PASSKEY_PERMISSIONS.enrollmentRequestsView,
      defaultRoles: ["super_admin", "hotel_owner", "general_manager"],
    });
    const { data: rows, error } = await (context.supabase as any)
      .from("passkey_enrollment_history")
      .select("id,action,reason,actor_id,created_at")
      .eq("property_id", data.propertyId)
      .eq("user_id", data.targetUserId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

async function decide(
  context: any,
  data: { propertyId: string; targetUserId: string; decision: string; reason: string | null },
) {
  const isDestructive = data.decision === "revoked" || data.decision === "reset";
  const permission = isDestructive
    ? PASSKEY_PERMISSIONS.enrollmentRevoke
    : PASSKEY_PERMISSIONS.enrollmentApprove;
  await assertServerPermission(context, {
    propertyId: data.propertyId,
    ...permission,
    defaultRoles: ["super_admin", "hotel_owner", "general_manager"],
  });
  const result = await (context.supabase as any).rpc("passkey_enrollment_decide", {
    _property_id: data.propertyId,
    _target_user_id: data.targetUserId,
    _decision: data.decision,
    _reason: data.reason,
  });
  if (result.error) throw new Error(result.error.message);
  await captureAuditEvent(context, {
    propertyId: data.propertyId,
    sourceModule: "passkeys",
    action: `passkey.enrollment.${data.decision}`,
    resourceType: "passkey_enrollment",
    resourceId: data.targetUserId,
    memo: data.reason ?? undefined,
  });
  return result.data;
}

export const approvePasskeyEnrollment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; targetUserId: string }) => ({
    propertyId: uuid(d.propertyId),
    targetUserId: uuid(d.targetUserId),
  }))
  .handler(({ data, context }) => decide(context, { ...data, decision: "approved", reason: null }));

export const rejectPasskeyEnrollment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; targetUserId: string; reason: string }) => ({
    propertyId: uuid(d.propertyId),
    targetUserId: uuid(d.targetUserId),
    reason: reasonText(d.reason, 5),
  }))
  .handler(({ data, context }) => decide(context, { ...data, decision: "rejected" }));

export const revokePasskeyEnrollment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; targetUserId: string; reason: string }) => ({
    propertyId: uuid(d.propertyId),
    targetUserId: uuid(d.targetUserId),
    reason: reasonText(d.reason, 5),
  }))
  .handler(({ data, context }) => decide(context, { ...data, decision: "revoked" }));

export const resetPasskeyEnrollment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; targetUserId: string; reason: string }) => ({
    propertyId: uuid(d.propertyId),
    targetUserId: uuid(d.targetUserId),
    reason: reasonText(d.reason, 5),
  }))
  .handler(({ data, context }) => decide(context, { ...data, decision: "reset" }));

export async function currentUserHasPermission(
  context: any,
  propertyId: string,
  permission: { module: string; capability: any },
) {
  return hasServerPermission(context, {
    propertyId,
    ...permission,
    defaultRoles: ["super_admin", "hotel_owner", "general_manager"],
  });
}
