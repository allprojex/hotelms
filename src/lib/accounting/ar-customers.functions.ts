/* eslint-disable @typescript-eslint/no-explicit-any -- migration-backed AR customer types are added separately. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertServerPermission } from "@/lib/permissions.server";
import { captureAuditEvent } from "@/lib/audit.server";
import { ACCOUNTING_AR_ROLES, AR_PERMISSIONS } from "@/lib/accounting/permissions";
import { requireValidCurrencyCode, uuid, optionalUuid } from "@/lib/accounting/domain";

function clean(value: unknown, max: number): string | null {
  const result = String(value ?? "")
    .trim()
    .slice(0, max);
  return result || null;
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

export const listArCustomers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; search?: string; includeInactive?: boolean }) => ({
    propertyId: uuid(d.propertyId),
    search: clean(d.search, 160),
    includeInactive: !!d.includeInactive,
  }))
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, AR_PERMISSIONS.customersView);
    let query = (context.supabase as any)
      .from("ar_customers")
      .select("id,property_id,account_code,name,email,phone,address,active,created_at,updated_at")
      .eq("property_id", data.propertyId)
      .order("name")
      .limit(200);
    if (!data.includeInactive) query = query.eq("active", true);
    if (data.search) {
      const term = data.search
        .replace(/[%_(),.*]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (term)
        query = query.or(`name.ilike.%${term}%,account_code.ilike.%${term}%,email.ilike.%${term}%`);
    }
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return result.data ?? [];
  });

export const saveArCustomer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      id?: string;
      propertyId: string;
      accountCode?: string;
      name: string;
      email?: string;
      phone?: string;
      address?: string;
    }) => ({
      id: optionalUuid(d.id),
      propertyId: uuid(d.propertyId),
      accountCode: clean(d.accountCode, 40)?.toUpperCase() ?? null,
      name: clean(d.name, 160),
      email: clean(d.email, 320),
      phone: clean(d.phone, 60),
      address: clean(d.address, 1000),
    }),
  )
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, AR_PERMISSIONS.customersManage);
    if (!data.name) throw new Error("Customer name is required");
    const payload = {
      property_id: data.propertyId,
      account_code: data.accountCode,
      name: data.name,
      email: data.email,
      phone: data.phone,
      address: data.address,
    };
    const db = context.supabase as any;
    const result = data.id
      ? await db
          .from("ar_customers")
          .update(payload)
          .eq("id", data.id)
          .eq("property_id", data.propertyId)
          .select()
          .single()
      : await db
          .from("ar_customers")
          .insert({ ...payload, created_by: context.userId })
          .select()
          .single();
    if (result.error) throw new Error(result.error.message);
    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "accounting",
      action: data.id ? "ar_customer.updated" : "ar_customer.created",
      resourceType: "ar_customer",
      resourceId: result.data.id,
      newValues: {
        account_code: result.data.account_code,
        name: result.data.name,
        active: result.data.active,
      },
    });
    return result.data;
  });

export const setArCustomerActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; id: string; active: boolean }) => ({
    propertyId: uuid(d.propertyId),
    id: uuid(d.id),
    active: !!d.active,
  }))
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, AR_PERMISSIONS.customersManage);
    const result = await (context.supabase as any)
      .from("ar_customers")
      .update({ active: data.active })
      .eq("id", data.id)
      .eq("property_id", data.propertyId)
      .select("id,account_code,name,active")
      .single();
    if (result.error) throw new Error(result.error.message);
    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "accounting",
      action: data.active ? "ar_customer.activated" : "ar_customer.deactivated",
      resourceType: "ar_customer",
      resourceId: data.id,
      newValues: {
        account_code: result.data.account_code,
        name: result.data.name,
        active: data.active,
      },
    });
    return result.data;
  });

export const createArInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      propertyId: string;
      customerId: string;
      issueDate: string;
      dueDate: string;
      currency: string;
      notes?: string;
      lines: Array<{ description: string; quantity: number; unit_price: number; tax_rate: number }>;
    }) => ({
      propertyId: uuid(d.propertyId),
      customerId: uuid(d.customerId),
      issueDate: String(d.issueDate ?? ""),
      dueDate: String(d.dueDate ?? ""),
      currency: requireValidCurrencyCode(d.currency),
      notes: clean(d.notes, 2000),
      lines: Array.isArray(d.lines) ? d.lines : [],
    }),
  )
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, AR_PERMISSIONS.invoicesCreate);
    const result = await (context.supabase as any).rpc("create_ar_invoice", {
      _property_id: data.propertyId,
      _customer_id: data.customerId,
      _issue_date: data.issueDate,
      _due_date: data.dueDate,
      _currency: data.currency,
      _notes: data.notes,
      _lines: data.lines,
    });
    if (result.error) throw new Error(result.error.message);
    return { id: result.data as string };
  });
