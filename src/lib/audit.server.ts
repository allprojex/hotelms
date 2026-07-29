import {
  auditMetadataRemarks,
  normalizeAuditMetadata,
  redactAuditText,
  redactAuditValue,
  type AuditAction,
  type AuditMetadata,
} from "@/lib/audit-conventions";
import type { Database, Json } from "@/integrations/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";

export type AuditContext = {
  userId: string;
  supabase: SupabaseClient<Database>;
};

export type AuditEvent = AuditMetadata & {
  propertyId: string | null;
  action: AuditAction | string;
  resourceType: string;
  resourceId?: string | null;
  oldValues?: unknown;
  newValues?: unknown;
  memo?: string | null;
  success?: boolean;
  remarks?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  os?: string | null;
  browser?: string | null;
  deviceFingerprint?: string | null;
  sessionId?: string | null;
};

export type AuditResult =
  { logged: true; id: string | null } | { logged: false; id: null; error: string };

async function assertAuditScope(context: AuditContext, propertyId: string | null): Promise<void> {
  if (propertyId) {
    const result = await context.supabase.rpc("can_access_property", {
      _user_id: context.userId,
      _property_id: propertyId,
    });
    if (result.error) throw new Error(result.error.message);
    if (!result.data) {
      throw new Error("Not authorized to record audit events for this property");
    }
    return;
  }

  const result = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "super_admin",
  });
  if (result.error) throw new Error(result.error.message);
  if (!result.data) {
    throw new Error("Only super_admin may record system-level audit events");
  }
}

export async function captureAuditEvent(
  context: AuditContext,
  event: AuditEvent,
  options: { required?: boolean } = {},
): Promise<AuditResult> {
  await assertAuditScope(context, event.propertyId);
  const metadata = normalizeAuditMetadata(event);

  const result = await context.supabase.rpc("audit_capture", {
    _property_id: event.propertyId,
    _entity_type: event.resourceType,
    _entity_id: event.resourceId ?? null,
    _action: event.action,
    _before: redactAuditValue(event.oldValues ?? null) as Json,
    _after: redactAuditValue(event.newValues ?? null) as Json,
    _memo: event.memo ? redactAuditText(event.memo).slice(0, 1000) : null,
    _ip: event.ip ?? null,
    _user_agent: event.userAgent ?? null,
    _os: event.os ?? null,
    _browser: event.browser ?? null,
    _fingerprint: event.deviceFingerprint ?? null,
    _session_id: event.sessionId ?? null,
    _success: event.success ?? true,
    _remarks: auditMetadataRemarks(metadata, event.remarks),
  } as never);

  if (result.error) {
    if (options.required) throw new Error(result.error.message);
    return { logged: false, id: null, error: result.error.message };
  }
  return { logged: true, id: result.data ?? null };
}
