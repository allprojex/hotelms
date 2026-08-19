/* eslint-disable @typescript-eslint/no-explicit-any -- ap_bills/suppliers await generated database types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertServerPermission } from "@/lib/permissions.server";
import { captureAuditEvent } from "@/lib/audit.server";
import { ACCOUNTING_AP_ROLES, AP_PERMISSIONS } from "@/lib/accounting/permissions";
import { uuid, isValidCurrencyCode } from "@/lib/accounting/domain";
import { pageRange } from "@/lib/query-state";

const AP_BILL_STATUSES = ["draft", "open", "paid", "void"] as readonly string[];

function clean(value: unknown, max: number): string | null {
  const result = String(value ?? "")
    .trim()
    .slice(0, max);
  return result || null;
}

function isoDateOrNull(value: unknown): string | null {
  const text = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

async function authorize(
  context: any,
  propertyId: string,
  permission: (typeof AP_PERMISSIONS)[keyof typeof AP_PERMISSIONS],
) {
  await assertServerPermission(context, {
    propertyId,
    ...permission,
    defaultRoles: ACCOUNTING_AP_ROLES,
  });
}

/**
 * Lists historical AP bills for manual supplier-mapping review. Defaults to
 * unmapped-only (supplier_id IS NULL) and is always bounded/paginated —
 * this never loads the full bill table into the browser. Purely a read;
 * viewing requires only AP view access, not the manage capability that
 * gates the actual assignment below.
 */
export const listUnmappedApBills = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      propertyId: string;
      unmappedOnly?: boolean;
      code?: string;
      supplierName?: string;
      from?: string;
      to?: string;
      currency?: string;
      status?: string;
      page?: number;
      pageSize?: number;
    }) => ({
      propertyId: uuid(d.propertyId),
      unmappedOnly: d.unmappedOnly !== false,
      code: clean(d.code, 60),
      supplierName: clean(d.supplierName, 160),
      from: isoDateOrNull(d.from),
      to: isoDateOrNull(d.to),
      currency: isValidCurrencyCode(d.currency) ? String(d.currency).trim().toUpperCase() : null,
      status: AP_BILL_STATUSES.includes(String(d.status ?? "")) ? String(d.status) : null,
      page: Math.max(1, Math.trunc(Number(d.page) || 1)),
      pageSize: [10, 25, 50, 100].includes(Number(d.pageSize)) ? Number(d.pageSize) : 25,
    }),
  )
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, AP_PERMISSIONS.suppliersView);
    const { from, to } = pageRange(data.page, data.pageSize);
    let query = (context.supabase as any)
      .from("ap_bills")
      .select(
        "id,code,bill_date,due_date,supplier_name,reference,currency,total,status,supplier_id",
        { count: "exact" },
      )
      .eq("property_id", data.propertyId)
      .order("bill_date", { ascending: false })
      .range(from, to);
    if (data.unmappedOnly) query = query.is("supplier_id", null);
    if (data.code) query = query.ilike("code", `%${data.code}%`);
    if (data.supplierName) query = query.ilike("supplier_name", `%${data.supplierName}%`);
    if (data.from) query = query.gte("bill_date", data.from);
    if (data.to) query = query.lte("bill_date", data.to);
    if (data.currency) query = query.eq("currency", data.currency);
    if (data.status) query = query.eq("status", data.status);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

/**
 * Lists this property's active suppliers for the mapping/statement pickers.
 * Read-only, gated by the same AP view capability as the bill list above.
 */
export const listActiveSuppliers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string }) => ({ propertyId: uuid(d.propertyId) }))
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, AP_PERMISSIONS.suppliersView);
    const { data: rows, error } = await (context.supabase as any)
      .from("suppliers")
      .select("id,name,contact_name,email,phone,address,active")
      .eq("property_id", data.propertyId)
      .eq("active", true)
      .order("name");
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

/**
 * Assigns a stable supplier to exactly one historical bill via the atomic
 * assign_ap_bill_supplier() RPC (property/supplier/active/still-unmapped
 * checks all happen server-side inside that function, under a row lock, so
 * a concurrent assignment of the same bill fails cleanly instead of
 * racing). Requires the AP manage capability, not mere view. Only
 * supplier_id changes — nothing else about the bill is touched.
 */
export const assignApBillSupplier = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; billId: string; supplierId: string }) => ({
    propertyId: uuid(d.propertyId),
    billId: uuid(d.billId),
    supplierId: uuid(d.supplierId),
  }))
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, AP_PERMISSIONS.billsMapSupplier);
    const supabase = context.supabase as any;

    const rpcResult = await supabase.rpc("assign_ap_bill_supplier", {
      _property_id: data.propertyId,
      _bill_id: data.billId,
      _supplier_id: data.supplierId,
    });
    if (rpcResult.error) throw new Error(rpcResult.error.message);

    // Re-fetch authoritative values for the audit event rather than
    // trusting client-supplied display strings.
    const [{ data: bill }, { data: supplier }] = await Promise.all([
      supabase
        .from("ap_bills")
        .select("id,code")
        .eq("id", data.billId)
        .eq("property_id", data.propertyId)
        .single(),
      supabase
        .from("suppliers")
        .select("name")
        .eq("id", data.supplierId)
        .eq("property_id", data.propertyId)
        .single(),
    ]);

    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "accounting",
      action: "ap_bill.supplier_mapped",
      resourceType: "ap_bill",
      resourceId: data.billId,
      oldValues: { supplierId: null },
      newValues: {
        billCode: bill?.code ?? null,
        supplierId: data.supplierId,
        supplierName: supplier?.name ?? null,
      },
    });

    return {
      id: data.billId,
      billCode: bill?.code ?? null,
      supplierName: supplier?.name ?? null,
    };
  });
