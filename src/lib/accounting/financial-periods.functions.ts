/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 6A tables await generated database types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertServerPermission } from "@/lib/permissions.server";
import { captureAuditEvent } from "@/lib/audit.server";
import { ACCOUNTING_ADMIN_ROLES, EXPENSE_PERMISSIONS } from "@/lib/accounting/permissions";
import { uuid, reasonText } from "@/lib/accounting/domain";

export const listFinancialPeriods = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string }) => ({ propertyId: uuid(d.propertyId) }))
  .handler(async ({ data, context }) => {
    await assertServerPermission(context as any, {
      propertyId: data.propertyId,
      ...EXPENSE_PERMISSIONS.periodsView,
      defaultRoles: ACCOUNTING_ADMIN_ROLES,
    });
    const { data: rows, error } = await (context.supabase as any)
      .from("accounting_periods")
      .select("*")
      .eq("property_id", data.propertyId)
      .order("start_date", { ascending: false });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const openFinancialPeriod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      propertyId: string;
      name: string;
      code: string;
      startDate: string;
      endDate: string;
    }) => ({
      propertyId: uuid(d.propertyId),
      name: String(d.name ?? "")
        .trim()
        .slice(0, 160),
      code: String(d.code ?? "")
        .trim()
        .slice(0, 40),
      startDate: String(d.startDate ?? ""),
      endDate: String(d.endDate ?? ""),
    }),
  )
  .handler(async ({ data, context }) => {
    const result = await (context.supabase as any).rpc("financial_period_open", {
      _property_id: data.propertyId,
      _name: data.name || null,
      _code: data.code || null,
      _start_date: data.startDate,
      _end_date: data.endDate,
    });
    if (result.error) throw new Error(result.error.message);
    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "accounting",
      action: "financial_period.opened",
      resourceType: "accounting_period",
      resourceId: result.data?.id ?? null,
      newValues: {
        name: data.name,
        code: data.code,
        startDate: data.startDate,
        endDate: data.endDate,
      },
    });
    return result.data;
  });

export const closeFinancialPeriod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; periodId: string }) => ({
    propertyId: uuid(d.propertyId),
    periodId: uuid(d.periodId),
  }))
  .handler(async ({ data, context }) => {
    const result = await (context.supabase as any).rpc("financial_period_close", {
      _period_id: data.periodId,
    });
    if (result.error) throw new Error(result.error.message);
    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "accounting",
      action: "financial_period.closed",
      resourceType: "accounting_period",
      resourceId: data.periodId,
    });
    return result.data;
  });

export const reopenFinancialPeriod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; periodId: string; reason: string }) => ({
    propertyId: uuid(d.propertyId),
    periodId: uuid(d.periodId),
    reason: reasonText(d.reason),
  }))
  .handler(async ({ data, context }) => {
    const result = await (context.supabase as any).rpc("financial_period_reopen", {
      _period_id: data.periodId,
      _reason: data.reason,
    });
    if (result.error) throw new Error(result.error.message);
    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "accounting",
      action: "financial_period.reopened",
      resourceType: "accounting_period",
      resourceId: data.periodId,
      memo: data.reason,
    });
    return result.data;
  });
