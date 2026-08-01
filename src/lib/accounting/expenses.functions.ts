/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 6A tables await generated database types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertServerPermission } from "@/lib/permissions.server";
import { captureAuditEvent } from "@/lib/audit.server";
import { pageRange } from "@/lib/query-state";
import { ACCOUNTING_ADMIN_ROLES, EXPENSE_PERMISSIONS } from "@/lib/accounting/permissions";
import { uuid, optionalUuid, reasonText } from "@/lib/accounting/domain";

const EXPENSE_SELECT =
  "*,vendor:vendor_id(id,name,vendor_code),category:category_id(id,name,code,receipt_required),cost_centre:cost_centre_id(id,name,code),creator:created_by(id,full_name)";

function filterTerm(value: string): string {
  return value
    .replace(/[%_(),.*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const createInput = (d: {
  propertyId: string;
  expenseDate: string;
  vendorId?: string | null;
  categoryId: string;
  costCentreId?: string | null;
  departmentId?: string | null;
  currency: string;
  amountBeforeTax: number;
  taxAmount?: number;
  description?: string;
  businessPurpose?: string;
  paymentMethod?: string;
  paymentReference?: string;
}) => ({
  propertyId: uuid(d.propertyId),
  expenseDate: String(d.expenseDate ?? ""),
  vendorId: optionalUuid(d.vendorId),
  categoryId: uuid(d.categoryId),
  costCentreId: optionalUuid(d.costCentreId),
  departmentId: optionalUuid(d.departmentId),
  currency: String(d.currency ?? "")
    .trim()
    .toUpperCase()
    .slice(0, 8),
  amountBeforeTax: Number(d.amountBeforeTax),
  taxAmount: Number(d.taxAmount ?? 0),
  description: d.description?.trim().slice(0, 500) || null,
  businessPurpose: d.businessPurpose?.trim().slice(0, 500) || null,
  paymentMethod: d.paymentMethod?.trim().slice(0, 60) || null,
  paymentReference: d.paymentReference?.trim().slice(0, 120) || null,
});

export const createExpenseDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(createInput)
  .handler(async ({ data, context }) => {
    const result = await (context.supabase as any).rpc("expense_create", {
      _property_id: data.propertyId,
      _expense_date: data.expenseDate,
      _vendor_id: data.vendorId,
      _category_id: data.categoryId,
      _cost_centre_id: data.costCentreId,
      _department_id: data.departmentId,
      _currency: data.currency,
      _amount_before_tax: data.amountBeforeTax,
      _tax_amount: data.taxAmount,
      _description: data.description,
      _business_purpose: data.businessPurpose,
      _payment_method: data.paymentMethod,
      _payment_reference: data.paymentReference,
    });
    if (result.error) throw new Error(result.error.message);
    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "accounting",
      action: "expense.created",
      resourceType: "expense",
      resourceId: result.data?.id ?? null,
      newValues: {
        amountBeforeTax: data.amountBeforeTax,
        taxAmount: data.taxAmount,
        currency: data.currency,
      },
    });
    return result.data;
  });

export const updateExpenseDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: any) => ({ ...createInput(d), id: uuid(d.id) }))
  .handler(async ({ data, context }) => {
    const result = await (context.supabase as any).rpc("expense_update_draft", {
      _expense_id: data.id,
      _expense_date: data.expenseDate,
      _vendor_id: data.vendorId,
      _category_id: data.categoryId,
      _cost_centre_id: data.costCentreId,
      _department_id: data.departmentId,
      _amount_before_tax: data.amountBeforeTax,
      _tax_amount: data.taxAmount,
      _description: data.description,
      _business_purpose: data.businessPurpose,
      _payment_method: data.paymentMethod,
      _payment_reference: data.paymentReference,
    });
    if (result.error) throw new Error(result.error.message);
    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "accounting",
      action: "expense.updated",
      resourceType: "expense",
      resourceId: data.id,
      newValues: { amountBeforeTax: data.amountBeforeTax, taxAmount: data.taxAmount },
    });
    return result.data;
  });

export const submitExpense = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; id: string }) => ({
    propertyId: uuid(d.propertyId),
    id: uuid(d.id),
  }))
  .handler(async ({ data, context }) => {
    const result = await (context.supabase as any).rpc("expense_submit", { _expense_id: data.id });
    if (result.error) throw new Error(result.error.message);
    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "accounting",
      action: "expense.submitted",
      resourceType: "expense",
      resourceId: data.id,
    });
    return result.data;
  });

async function decide(
  context: any,
  data: { propertyId: string; id: string; decision: string; reason: string | null },
) {
  // Approve/reject/return are always admin-gated. Cancel is conditional (the
  // owner of a draft may cancel it themselves; the RPC itself is authoritative
  // for that ownership-or-permission check, so no blanket pre-check is applied here).
  if (data.decision !== "cancelled") {
    const permission =
      data.decision === "approved"
        ? EXPENSE_PERMISSIONS.expensesApprove
        : EXPENSE_PERMISSIONS.expensesReject;
    await assertServerPermission(context, {
      propertyId: data.propertyId,
      ...permission,
      defaultRoles: ACCOUNTING_ADMIN_ROLES,
    });
  }
  const result = await context.supabase.rpc("expense_decide", {
    _expense_id: data.id,
    _decision: data.decision,
    _reason: data.reason,
  });
  if (result.error) throw new Error(result.error.message);
  await captureAuditEvent(context, {
    propertyId: data.propertyId,
    sourceModule: "accounting",
    action: `expense.${data.decision}`,
    resourceType: "expense",
    resourceId: data.id,
    memo: data.reason ?? undefined,
  });
  return result.data;
}

export const approveExpense = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; id: string }) => ({
    propertyId: uuid(d.propertyId),
    id: uuid(d.id),
  }))
  .handler(({ data, context }) => decide(context, { ...data, decision: "approved", reason: null }));

export const rejectExpense = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; id: string; reason: string }) => ({
    propertyId: uuid(d.propertyId),
    id: uuid(d.id),
    reason: reasonText(d.reason),
  }))
  .handler(({ data, context }) => decide(context, { ...data, decision: "rejected" }));

export const returnExpense = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; id: string; reason: string }) => ({
    propertyId: uuid(d.propertyId),
    id: uuid(d.id),
    reason: reasonText(d.reason),
  }))
  .handler(({ data, context }) => decide(context, { ...data, decision: "returned" }));

export const cancelExpense = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; id: string; reason: string }) => ({
    propertyId: uuid(d.propertyId),
    id: uuid(d.id),
    reason: reasonText(d.reason),
  }))
  .handler(({ data, context }) => decide(context, { ...data, decision: "cancelled" }));

export const getExpense = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; id: string }) => ({
    propertyId: uuid(d.propertyId),
    id: uuid(d.id),
  }))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await (context.supabase as any)
      .from("expenses")
      .select(EXPENSE_SELECT)
      .eq("id", data.id)
      .eq("property_id", data.propertyId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Expense not found");
    return row;
  });

export const listExpenseStatusHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; expenseId: string }) => ({
    propertyId: uuid(d.propertyId),
    expenseId: uuid(d.expenseId),
  }))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await (context.supabase as any)
      .from("expense_status_history")
      .select("*,actor:actor_id(id,full_name)")
      .eq("property_id", data.propertyId)
      .eq("expense_id", data.expenseId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const listExpenses = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      propertyId: string;
      search?: string;
      status?: string;
      vendorId?: string;
      categoryId?: string;
      costCentreId?: string;
      from?: string;
      to?: string;
      mine?: boolean;
      missingReceipt?: boolean;
      page?: number;
      pageSize?: number;
    }) => ({
      propertyId: uuid(d.propertyId),
      search: (d.search ?? "").trim().slice(0, 200),
      status: d.status ?? "",
      vendorId: optionalUuid(d.vendorId),
      categoryId: optionalUuid(d.categoryId),
      costCentreId: optionalUuid(d.costCentreId),
      from: d.from && /^\d{4}-\d{2}-\d{2}$/.test(d.from) ? d.from : null,
      to: d.to && /^\d{4}-\d{2}-\d{2}$/.test(d.to) ? d.to : null,
      mine: !!d.mine,
      missingReceipt: !!d.missingReceipt,
      page: Math.max(1, Math.trunc(d.page ?? 1)),
      pageSize: [10, 25, 50, 100].includes(d.pageSize ?? 25) ? (d.pageSize as number) : 25,
    }),
  )
  .handler(async ({ data, context }) => {
    const { from, to } = pageRange(data.page, data.pageSize);
    let query = (context.supabase as any)
      .from("expenses")
      .select(EXPENSE_SELECT, { count: "exact" })
      .eq("property_id", data.propertyId)
      .order("expense_date", { ascending: false })
      .range(from, to);
    if (data.mine) query = query.eq("created_by", context.userId);
    if (data.status) query = query.eq("status", data.status);
    if (data.vendorId) query = query.eq("vendor_id", data.vendorId);
    if (data.categoryId) query = query.eq("category_id", data.categoryId);
    if (data.costCentreId) query = query.eq("cost_centre_id", data.costCentreId);
    if (data.missingReceipt) query = query.eq("receipt_status", "missing");
    if (data.from) query = query.gte("expense_date", data.from);
    if (data.to) query = query.lte("expense_date", data.to);
    if (data.search) {
      const term = filterTerm(data.search);
      if (term) query = query.or(`expense_number.ilike.%${term}%,description.ilike.%${term}%`);
    }
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });
