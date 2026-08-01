/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 6A tables await generated database types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertServerPermission } from "@/lib/permissions.server";
import { captureAuditEvent } from "@/lib/audit.server";
import { pageRange } from "@/lib/query-state";
import { ACCOUNTING_ADMIN_ROLES, EXPENSE_PERMISSIONS } from "@/lib/accounting/permissions";
import { uuid, optionalUuid, reasonText } from "@/lib/accounting/domain";

function filterTerm(value: string): string {
  return value
    .replace(/[%_(),.*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const listInput = (d: {
  propertyId: string;
  search?: string;
  status?: "active" | "archived" | "all";
  page?: number;
  pageSize?: number;
}) => ({
  propertyId: uuid(d.propertyId),
  search: (d.search ?? "").trim().slice(0, 200),
  status: d.status ?? "active",
  page: Math.max(1, Math.trunc(d.page ?? 1)),
  pageSize: [10, 25, 50, 100].includes(d.pageSize ?? 25) ? (d.pageSize as number) : 25,
});

async function applyListFilters(
  query: any,
  data: ReturnType<typeof listInput>,
  searchCols: string[],
) {
  let q = query
    .eq("property_id", data.propertyId)
    .order("name")
    .range(...(Object.values(pageRange(data.page, data.pageSize)) as [number, number]));
  if (data.search) {
    const term = filterTerm(data.search);
    if (term) q = q.or(searchCols.map((c) => `${c}.ilike.%${term}%`).join(","));
  }
  if (data.status === "archived") q = q.not("archived_at", "is", null);
  else if (data.status === "active") q = q.is("archived_at", null);
  return q;
}

// ============ EXPENSE CATEGORIES ============
export const listExpenseCategories = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    await assertServerPermission(context as any, {
      propertyId: data.propertyId,
      ...EXPENSE_PERMISSIONS.categoriesView,
      defaultRoles: ACCOUNTING_ADMIN_ROLES,
    });
    const base = (context.supabase as any)
      .from("expense_categories")
      .select("*", { count: "exact" });
    const query = await applyListFilters(base, data, ["name", "code"]);
    if (query.error) throw new Error(query.error.message);
    return { rows: query.data ?? [], total: query.count ?? 0 };
  });

export const saveExpenseCategory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      id?: string;
      propertyId: string;
      name: string;
      code: string;
      description?: string;
      defaultCostCentreId?: string | null;
      accountingMappingAccountId?: string | null;
      approvalThreshold?: number | null;
      receiptRequired: boolean;
    }) => ({
      id: optionalUuid(d.id),
      propertyId: uuid(d.propertyId),
      name: String(d.name ?? "")
        .trim()
        .slice(0, 160),
      code: String(d.code ?? "")
        .trim()
        .slice(0, 40),
      description: d.description?.trim() || null,
      defaultCostCentreId: optionalUuid(d.defaultCostCentreId),
      accountingMappingAccountId: optionalUuid(d.accountingMappingAccountId),
      approvalThreshold: d.approvalThreshold ?? null,
      receiptRequired: !!d.receiptRequired,
    }),
  )
  .handler(async ({ data, context }) => {
    await assertServerPermission(context as any, {
      propertyId: data.propertyId,
      ...EXPENSE_PERMISSIONS.categoriesManage,
      defaultRoles: ACCOUNTING_ADMIN_ROLES,
    });
    const payload = {
      property_id: data.propertyId,
      name: data.name,
      code: data.code,
      description: data.description,
      default_cost_centre_id: data.defaultCostCentreId,
      accounting_mapping_account_id: data.accountingMappingAccountId,
      approval_threshold: data.approvalThreshold,
      receipt_required: data.receiptRequired,
    };
    const db = context.supabase as any;
    const result = data.id
      ? await db.from("expense_categories").update(payload).eq("id", data.id).select().single()
      : await db.from("expense_categories").insert(payload).select().single();
    if (result.error) throw new Error(result.error.message);
    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "accounting",
      action: data.id ? "expense_category.updated" : "expense_category.created",
      resourceType: "expense_category",
      resourceId: result.data.id,
      newValues: payload,
    });
    return result.data;
  });

async function setArchiveState(
  context: any,
  table: string,
  data: { propertyId: string; id: string; reason?: string },
  archived: boolean,
) {
  await assertServerPermission(context, {
    propertyId: data.propertyId,
    ...(table === "expense_categories"
      ? EXPENSE_PERMISSIONS.categoriesManage
      : table === "cost_centres"
        ? EXPENSE_PERMISSIONS.costCentresManage
        : EXPENSE_PERMISSIONS.vendorsManage),
    defaultRoles: ACCOUNTING_ADMIN_ROLES,
  });
  const payload = archived
    ? {
        active: false,
        archived_at: new Date().toISOString(),
        archived_by: context.userId,
        archive_reason: reasonText(data.reason),
      }
    : { active: true, archived_at: null, archived_by: null, archive_reason: null };
  const result = await context.supabase
    .from(table)
    .update(payload)
    .eq("id", data.id)
    .eq("property_id", data.propertyId)
    .select()
    .single();
  if (result.error) throw new Error(result.error.message);
  await captureAuditEvent(context, {
    propertyId: data.propertyId,
    sourceModule: "accounting",
    action: `${table}.${archived ? "archived" : "restored"}`,
    resourceType: table,
    resourceId: data.id,
    memo: data.reason,
  });
  return result.data;
}

export const archiveExpenseCategory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; id: string; reason: string }) => ({
    propertyId: uuid(d.propertyId),
    id: uuid(d.id),
    reason: reasonText(d.reason),
  }))
  .handler(({ data, context }) => setArchiveState(context, "expense_categories", data, true));

export const restoreExpenseCategory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; id: string }) => ({
    propertyId: uuid(d.propertyId),
    id: uuid(d.id),
  }))
  .handler(({ data, context }) => setArchiveState(context, "expense_categories", data, false));

// ============ VENDORS ============
export const listVendors = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    await assertServerPermission(context as any, {
      propertyId: data.propertyId,
      ...EXPENSE_PERMISSIONS.vendorsView,
      defaultRoles: ACCOUNTING_ADMIN_ROLES,
    });
    const base = (context.supabase as any)
      .from("suppliers")
      .select(
        "id,property_id,name,vendor_code,vendor_type,contact_name,email,phone,address,tax_reference,preferred_payment_method,bank_detail_reference,notes,active,archived_at,created_at,updated_at",
        { count: "exact" },
      );
    const query = await applyListFilters(base, data, ["name", "vendor_code", "email"]);
    if (query.error) throw new Error(query.error.message);
    return { rows: query.data ?? [], total: query.count ?? 0 };
  });

export const saveVendor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      id?: string;
      propertyId: string;
      name: string;
      vendorCode?: string;
      vendorType?: string;
      contactName?: string;
      email?: string;
      phone?: string;
      address?: string;
      taxReference?: string;
      preferredPaymentMethod?: string;
      bankDetailReference?: string;
      notes?: string;
    }) => ({
      id: optionalUuid(d.id),
      propertyId: uuid(d.propertyId),
      name: String(d.name ?? "")
        .trim()
        .slice(0, 160),
      vendorCode: d.vendorCode?.trim().slice(0, 40) || null,
      vendorType: d.vendorType?.trim().slice(0, 60) || null,
      contactName: d.contactName?.trim() || null,
      email: d.email?.trim() || null,
      phone: d.phone?.trim() || null,
      address: d.address?.trim() || null,
      taxReference: d.taxReference?.trim() || null,
      preferredPaymentMethod: d.preferredPaymentMethod?.trim() || null,
      bankDetailReference: d.bankDetailReference?.trim() || null,
      notes: d.notes?.trim() || null,
    }),
  )
  .handler(async ({ data, context }) => {
    await assertServerPermission(context as any, {
      propertyId: data.propertyId,
      ...EXPENSE_PERMISSIONS.vendorsManage,
      defaultRoles: ACCOUNTING_ADMIN_ROLES,
    });
    const payload = {
      property_id: data.propertyId,
      name: data.name,
      vendor_code: data.vendorCode,
      vendor_type: data.vendorType,
      contact_name: data.contactName,
      email: data.email,
      phone: data.phone,
      address: data.address,
      tax_reference: data.taxReference,
      preferred_payment_method: data.preferredPaymentMethod,
      bank_detail_reference: data.bankDetailReference,
      notes: data.notes,
    };
    const db = context.supabase as any;
    const result = data.id
      ? await db.from("suppliers").update(payload).eq("id", data.id).select().single()
      : await db.from("suppliers").insert(payload).select().single();
    if (result.error) throw new Error(result.error.message);
    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "accounting",
      action: data.id ? "vendor.updated" : "vendor.created",
      resourceType: "vendor",
      resourceId: result.data.id,
      newValues: { ...payload, bank_detail_reference: undefined },
    });
    return result.data;
  });

export const archiveVendor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; id: string; reason: string }) => ({
    propertyId: uuid(d.propertyId),
    id: uuid(d.id),
    reason: reasonText(d.reason),
  }))
  .handler(({ data, context }) => setArchiveState(context, "suppliers", data, true));

export const restoreVendor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; id: string }) => ({
    propertyId: uuid(d.propertyId),
    id: uuid(d.id),
  }))
  .handler(({ data, context }) => setArchiveState(context, "suppliers", data, false));

// ============ COST CENTRES ============
export const listCostCentres = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    await assertServerPermission(context as any, {
      propertyId: data.propertyId,
      ...EXPENSE_PERMISSIONS.costCentresView,
      defaultRoles: ACCOUNTING_ADMIN_ROLES,
    });
    const base = (context.supabase as any)
      .from("cost_centres")
      .select("*,parent:parent_cost_centre_id(id,name)", { count: "exact" });
    const query = await applyListFilters(base, data, ["name", "code"]);
    if (query.error) throw new Error(query.error.message);
    return { rows: query.data ?? [], total: query.count ?? 0 };
  });

export const saveCostCentre = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      id?: string;
      propertyId: string;
      name: string;
      code: string;
      description?: string;
      parentCostCentreId?: string | null;
      departmentId?: string | null;
      managerId?: string | null;
    }) => ({
      id: optionalUuid(d.id),
      propertyId: uuid(d.propertyId),
      name: String(d.name ?? "")
        .trim()
        .slice(0, 160),
      code: String(d.code ?? "")
        .trim()
        .slice(0, 40),
      description: d.description?.trim() || null,
      parentCostCentreId: optionalUuid(d.parentCostCentreId),
      departmentId: optionalUuid(d.departmentId),
      managerId: optionalUuid(d.managerId),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertServerPermission(context as any, {
      propertyId: data.propertyId,
      ...EXPENSE_PERMISSIONS.costCentresManage,
      defaultRoles: ACCOUNTING_ADMIN_ROLES,
    });
    if (data.id && data.parentCostCentreId === data.id) {
      throw new Error("A cost centre cannot be its own parent");
    }
    const payload = {
      property_id: data.propertyId,
      name: data.name,
      code: data.code,
      description: data.description,
      parent_cost_centre_id: data.parentCostCentreId,
      department_id: data.departmentId,
      manager_id: data.managerId,
    };
    const db = context.supabase as any;
    const result = data.id
      ? await db.from("cost_centres").update(payload).eq("id", data.id).select().single()
      : await db.from("cost_centres").insert(payload).select().single();
    if (result.error) throw new Error(result.error.message);
    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "accounting",
      action: data.id ? "cost_centre.updated" : "cost_centre.created",
      resourceType: "cost_centre",
      resourceId: result.data.id,
      newValues: payload,
    });
    return result.data;
  });

export const archiveCostCentre = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; id: string; reason: string }) => ({
    propertyId: uuid(d.propertyId),
    id: uuid(d.id),
    reason: reasonText(d.reason),
  }))
  .handler(({ data, context }) => setArchiveState(context, "cost_centres", data, true));

export const restoreCostCentre = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; id: string }) => ({
    propertyId: uuid(d.propertyId),
    id: uuid(d.id),
  }))
  .handler(({ data, context }) => setArchiveState(context, "cost_centres", data, false));
