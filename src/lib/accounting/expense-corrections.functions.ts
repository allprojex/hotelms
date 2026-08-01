/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 6A tables await generated database types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertServerPermission } from "@/lib/permissions.server";
import { captureAuditEvent } from "@/lib/audit.server";
import { pageRange } from "@/lib/query-state";
import { ACCOUNTING_ADMIN_ROLES, EXPENSE_PERMISSIONS } from "@/lib/accounting/permissions";
import { uuid, optionalUuid, reasonText } from "@/lib/accounting/domain";

export const requestExpenseCorrection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; expenseId: string; reason: string }) => ({
    propertyId: uuid(d.propertyId),
    expenseId: uuid(d.expenseId),
    reason: reasonText(d.reason),
  }))
  .handler(async ({ data, context }) => {
    await assertServerPermission(context as any, {
      propertyId: data.propertyId,
      ...EXPENSE_PERMISSIONS.correctionsCreate,
      defaultRoles: ACCOUNTING_ADMIN_ROLES,
    });
    const result = await (context.supabase as any).rpc("expense_correction_request", {
      _expense_id: data.expenseId,
      _reason: data.reason,
    });
    if (result.error) throw new Error(result.error.message);
    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "accounting",
      action: "expense_correction.requested",
      resourceType: "expense_correction",
      resourceId: result.data?.id ?? null,
      memo: data.reason,
    });
    return result.data;
  });

export const reviewExpenseCorrection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      propertyId: string;
      correctionId: string;
      decision: "approved" | "rejected";
      notes: string;
    }) => ({
      propertyId: uuid(d.propertyId),
      correctionId: uuid(d.correctionId),
      decision: d.decision === "approved" ? "approved" : "rejected",
      notes: reasonText(d.notes),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertServerPermission(context as any, {
      propertyId: data.propertyId,
      ...EXPENSE_PERMISSIONS.correctionsApprove,
      defaultRoles: ACCOUNTING_ADMIN_ROLES,
    });
    const result = await (context.supabase as any).rpc("expense_correction_review", {
      _correction_id: data.correctionId,
      _decision: data.decision,
      _review_notes: data.notes,
    });
    if (result.error) throw new Error(result.error.message);
    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "accounting",
      action: `expense_correction.${data.decision}`,
      resourceType: "expense_correction",
      resourceId: data.correctionId,
      memo: data.notes,
    });
    return result.data;
  });

export const reverseExpense = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { propertyId: string; expenseId: string; reason: string; correctionId?: string }) => ({
      propertyId: uuid(d.propertyId),
      expenseId: uuid(d.expenseId),
      reason: reasonText(d.reason),
      correctionId: optionalUuid(d.correctionId),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertServerPermission(context as any, {
      propertyId: data.propertyId,
      ...EXPENSE_PERMISSIONS.reversalsExecute,
      defaultRoles: ACCOUNTING_ADMIN_ROLES,
    });
    const result = await (context.supabase as any).rpc("expense_reverse", {
      _expense_id: data.expenseId,
      _reason: data.reason,
      _correction_id: data.correctionId,
    });
    if (result.error) throw new Error(result.error.message);
    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "accounting",
      action: "expense.reversed",
      resourceType: "expense",
      resourceId: data.expenseId,
      memo: data.reason,
      newValues: { reversalExpenseId: result.data?.id ?? null },
    });
    return result.data;
  });

export const listExpenseCorrections = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { propertyId: string; status?: string; page?: number; pageSize?: number }) => ({
      propertyId: uuid(d.propertyId),
      status: d.status ?? "",
      page: Math.max(1, Math.trunc(d.page ?? 1)),
      pageSize: [10, 25, 50, 100].includes(d.pageSize ?? 25) ? (d.pageSize as number) : 25,
    }),
  )
  .handler(async ({ data, context }) => {
    const { from, to } = pageRange(data.page, data.pageSize);
    let query = (context.supabase as any)
      .from("expense_corrections")
      .select(
        "*,expense:expense_id(id,expense_number,total_amount,currency),requester:requested_by(id,full_name),reviewer:reviewed_by(id,full_name)",
        { count: "exact" },
      )
      .eq("property_id", data.propertyId)
      .order("requested_at", { ascending: false })
      .range(from, to);
    if (data.status) query = query.eq("status", data.status);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });
