/* eslint-disable @typescript-eslint/no-explicit-any -- ar_invoices/ar_customers await generated database types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertServerPermission } from "@/lib/permissions.server";
import { captureAuditEvent } from "@/lib/audit.server";
import { ACCOUNTING_AR_ROLES, AR_PERMISSIONS } from "@/lib/accounting/permissions";
import { uuid, isValidCurrencyCode } from "@/lib/accounting/domain";
import { pageRange } from "@/lib/query-state";

const AR_INVOICE_STATUSES = ["draft", "sent", "paid", "void"] as readonly string[];

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
  permission: (typeof AR_PERMISSIONS)[keyof typeof AR_PERMISSIONS],
) {
  await assertServerPermission(context, {
    propertyId,
    ...permission,
    defaultRoles: ACCOUNTING_AR_ROLES,
  });
}

/**
 * Lists historical AR invoices for manual customer-mapping review. Defaults
 * to unmapped-only (customer_id IS NULL) and is always bounded/paginated —
 * this never loads the full invoice table into the browser. Purely a read;
 * viewing requires only AR view access, not the manage capability that
 * gates the actual assignment below.
 */
export const listUnmappedArInvoices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      propertyId: string;
      unmappedOnly?: boolean;
      code?: string;
      billToName?: string;
      billToEmail?: string;
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
      billToName: clean(d.billToName, 160),
      billToEmail: clean(d.billToEmail, 320),
      from: isoDateOrNull(d.from),
      to: isoDateOrNull(d.to),
      currency: isValidCurrencyCode(d.currency) ? String(d.currency).trim().toUpperCase() : null,
      status: AR_INVOICE_STATUSES.includes(String(d.status ?? "")) ? String(d.status) : null,
      page: Math.max(1, Math.trunc(Number(d.page) || 1)),
      pageSize: [10, 25, 50, 100].includes(Number(d.pageSize)) ? Number(d.pageSize) : 25,
    }),
  )
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, AR_PERMISSIONS.customersView);
    const { from, to } = pageRange(data.page, data.pageSize);
    let query = (context.supabase as any)
      .from("ar_invoices")
      .select(
        "id,code,issue_date,due_date,bill_to_name,bill_to_email,bill_to_address,currency,total,status,reservation_id,customer_id",
        { count: "exact" },
      )
      .eq("property_id", data.propertyId)
      .order("issue_date", { ascending: false })
      .range(from, to);
    if (data.unmappedOnly) query = query.is("customer_id", null);
    if (data.code) query = query.ilike("code", `%${data.code}%`);
    if (data.billToName) query = query.ilike("bill_to_name", `%${data.billToName}%`);
    if (data.billToEmail) query = query.ilike("bill_to_email", `%${data.billToEmail}%`);
    if (data.from) query = query.gte("issue_date", data.from);
    if (data.to) query = query.lte("issue_date", data.to);
    if (data.currency) query = query.eq("currency", data.currency);
    if (data.status) query = query.eq("status", data.status);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

/**
 * Assigns a stable AR customer to exactly one historical invoice via the
 * atomic assign_ar_invoice_customer() RPC (property/customer/active/
 * still-unmapped checks all happen server-side inside that function, under
 * a row lock, so a concurrent assignment of the same invoice fails cleanly
 * instead of racing). Requires the AR manage capability, not mere view.
 * Only customer_id changes — nothing else about the invoice is touched.
 */
export const assignArInvoiceCustomer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; invoiceId: string; customerId: string }) => ({
    propertyId: uuid(d.propertyId),
    invoiceId: uuid(d.invoiceId),
    customerId: uuid(d.customerId),
  }))
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, AR_PERMISSIONS.invoicesMapCustomer);
    const supabase = context.supabase as any;

    const rpcResult = await supabase.rpc("assign_ar_invoice_customer", {
      _property_id: data.propertyId,
      _invoice_id: data.invoiceId,
      _customer_id: data.customerId,
    });
    if (rpcResult.error) throw new Error(rpcResult.error.message);

    // Re-fetch authoritative values for the audit event rather than
    // trusting client-supplied display strings.
    const [{ data: invoice }, { data: customer }] = await Promise.all([
      supabase
        .from("ar_invoices")
        .select("id,code")
        .eq("id", data.invoiceId)
        .eq("property_id", data.propertyId)
        .single(),
      supabase
        .from("ar_customers")
        .select("account_code,name")
        .eq("id", data.customerId)
        .eq("property_id", data.propertyId)
        .single(),
    ]);

    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "accounting",
      action: "ar_invoice.customer_mapped",
      resourceType: "ar_invoice",
      resourceId: data.invoiceId,
      oldValues: { customerId: null },
      newValues: {
        invoiceCode: invoice?.code ?? null,
        customerId: data.customerId,
        customerAccountCode: customer?.account_code ?? null,
      },
    });

    return {
      id: data.invoiceId,
      invoiceCode: invoice?.code ?? null,
      customerAccountCode: customer?.account_code ?? null,
    };
  });
