import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { AppRole } from "@/hooks/use-user-roles";
import type { PermissionContext } from "@/lib/permissions.server";
import { authorizeReportAction } from "@/lib/reports/report-access.server";
import { z } from "zod";

const EXEC_ROLES = [
  "super_admin",
  "hotel_owner",
  "general_manager",
  "accountant",
] as const satisfies readonly AppRole[];

async function assertPropertyAccess(context: PermissionContext, propertyId: string) {
  const { data, error } = await context.supabase.rpc("has_any_role", {
    _user_id: context.userId,
    _roles: [...EXEC_ROLES],
    _property_id: propertyId,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Not authorized for this property");
}

/** Server-side authorization gate for CSV/PDF export requests. */
export const assertExecExportAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ propertyId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await authorizeReportAction(context, {
      propertyId: data.propertyId,
      reportKey: "analytics",
      title: "Executive Analytics",
      action: "export",
      defaultRoles: EXEC_ROLES,
      sensitive: true,
    });
    return { allowed: true };
  });

/** Server-side authorization gate for print requests. */
export const assertExecPrintAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ propertyId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await authorizeReportAction(context, {
      propertyId: data.propertyId,
      reportKey: "analytics",
      title: "Executive Analytics",
      action: "print",
      defaultRoles: EXEC_ROLES,
      sensitive: true,
    });
    return { allowed: true };
  });

const ScheduleSchema = z.object({
  propertyId: z.string().uuid(),
  name: z.string().min(1).max(120),
  frequency: z.enum(["daily", "weekly", "monthly"]),
  format: z.enum(["csv", "pdf", "both"]),
  recipients: z.array(z.string().email()).min(1).max(25),
  hour: z.number().int().min(0).max(23),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
  isActive: z.boolean(),
});

function computeNextRun(
  freq: string,
  hour: number,
  dow: number | null | undefined,
  dom: number | null | undefined,
): string {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0),
  );
  if (freq === "daily") {
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  } else if (freq === "weekly") {
    const targetDow = dow ?? 1;
    const diff = (targetDow - next.getUTCDay() + 7) % 7;
    next.setUTCDate(next.getUTCDate() + diff);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 7);
  } else {
    const targetDom = dom ?? 1;
    next.setUTCDate(targetDom);
    if (next <= now) next.setUTCMonth(next.getUTCMonth() + 1);
  }
  return next.toISOString();
}

export const listExportSchedules = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ propertyId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertPropertyAccess(context, data.propertyId);
    const { data: rows, error } = await context.supabase
      .from("analytics_export_schedules")
      .select("*")
      .eq("property_id", data.propertyId)
      .order("created_at");
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const upsertExportSchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    ScheduleSchema.extend({ id: z.string().uuid().optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertPropertyAccess(context, data.propertyId);
    const nextRun = computeNextRun(data.frequency, data.hour, data.dayOfWeek, data.dayOfMonth);
    const payload = {
      property_id: data.propertyId,
      name: data.name,
      frequency: data.frequency,
      format: data.format,
      recipients: data.recipients,
      hour: data.hour,
      day_of_week: data.frequency === "weekly" ? (data.dayOfWeek ?? 1) : null,
      day_of_month: data.frequency === "monthly" ? (data.dayOfMonth ?? 1) : null,
      is_active: data.isActive,
      next_run_at: nextRun,
    };
    if (data.id) {
      const { error } = await context.supabase
        .from("analytics_export_schedules")
        .update(payload)
        .eq("id", data.id);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: inserted, error } = await context.supabase
      .from("analytics_export_schedules")
      .insert({ ...payload, created_by: context.userId })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: inserted.id };
  });

export const deleteExportSchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), propertyId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertPropertyAccess(context, data.propertyId);
    const { error } = await context.supabase
      .from("analytics_export_schedules")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listExportRuns = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ propertyId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertPropertyAccess(context, data.propertyId);
    const { data: rows, error } = await context.supabase
      .from("analytics_export_runs")
      .select(
        "id, schedule_id, period_from, period_to, format, recipients, status, error, sent_at, created_at",
      )
      .eq("property_id", data.propertyId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

/** Triggers a scheduled export immediately (server-side dispatch via cron endpoint). */
export const runExportScheduleNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ scheduleId: z.string().uuid(), propertyId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertPropertyAccess(context, data.propertyId);
    // Reuse cron logic by dynamic import to avoid duplication.
    const { runScheduledExport } = await import("./analytics-exports.server");
    return runScheduledExport(data.scheduleId, { expectedPropertyId: data.propertyId });
  });
