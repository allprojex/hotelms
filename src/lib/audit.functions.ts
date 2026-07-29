import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { captureAuditEvent } from "@/lib/audit.server";

function sourceModule(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(normalized) ? normalized : `module_${normalized || "unknown"}`;
}

export const logAuditEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      propertyId: string | null;
      entityType: string;
      entityId?: string;
      action: string;
      before?: unknown;
      after?: unknown;
      memo?: string;
      ip?: string;
      userAgent?: string;
      os?: string;
      browser?: string;
      fingerprint?: string;
      sessionId?: string;
      success?: boolean;
      remarks?: string;
      sourceModule?: string;
      correlationId?: string;
      required?: boolean;
    }) => data,
  )
  .handler(async ({ data, context }) => {
    return captureAuditEvent(
      context,
      {
        propertyId: data.propertyId,
        resourceType: data.entityType,
        resourceId: data.entityId,
        action: data.action,
        oldValues: data.before,
        newValues: data.after,
        memo: data.memo,
        ip: data.ip,
        userAgent: data.userAgent,
        os: data.os,
        browser: data.browser,
        deviceFingerprint: data.fingerprint,
        sessionId: data.sessionId,
        success: data.success,
        remarks: data.remarks,
        sourceModule: sourceModule(data.sourceModule ?? data.entityType),
        correlationId: data.correlationId,
      },
      { required: data.required },
    );
  });

export const purgeAuditLogs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId?: string | null; before?: string | null }) => data)
  .handler(async ({ data, context }): Promise<{ purged: number }> => {
    const { data: purged, error } = await context.supabase.rpc("audit_purge", {
      _property_id: data.propertyId ?? null,
      _before: data.before ?? null,
    } as never);
    if (error) throw new Error(error.message);
    return { purged: (purged as number | null) ?? 0 };
  });
