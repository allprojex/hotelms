import type { AppRole } from "@/hooks/use-user-roles";
import { captureAuditEvent, type AuditContext } from "@/lib/audit.server";
import { assertServerPermission, type PermissionContext } from "@/lib/permissions.server";

export type ReportAccessRequest = {
  propertyId: string;
  reportKey: string;
  title: string;
  action: "export" | "print";
  defaultRoles: readonly AppRole[];
  filters?: unknown;
  format?: string;
  correlationId?: string;
  sensitive?: boolean;
};

/**
 * Server-only gate. Callers define policies in trusted server code; clients
 * must never provide defaultRoles or module names directly.
 */
export async function authorizeReportAction(
  context: PermissionContext & AuditContext,
  request: ReportAccessRequest,
): Promise<void> {
  await assertServerPermission(context, {
    propertyId: request.propertyId,
    module: request.reportKey,
    capability: request.action,
    defaultRoles: request.defaultRoles,
  });

  if (!request.sensitive) return;
  await captureAuditEvent(context, {
    propertyId: request.propertyId,
    action: request.action,
    resourceType: "report",
    resourceId: request.reportKey,
    newValues: {
      title: request.title,
      format: request.format ?? request.action,
      filters: request.filters ?? null,
    },
    sourceModule: request.reportKey,
    correlationId: request.correlationId,
    memo: `${request.action === "print" ? "Printed" : "Exported"} ${request.title}`,
  });
}
