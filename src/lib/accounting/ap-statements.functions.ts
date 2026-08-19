/* eslint-disable @typescript-eslint/no-explicit-any -- ap_bills/suppliers/ap_payments await generated database types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertServerPermission } from "@/lib/permissions.server";
import { ACCOUNTING_AP_ROLES, AP_PERMISSIONS } from "@/lib/accounting/permissions";
import { uuid } from "@/lib/accounting/domain";
import {
  computeApSupplierStatement,
  type ApStatementBillRow,
  type ApStatementCurrencySection,
  type ApStatementPaymentRow,
} from "@/lib/accounting/ap-statement-calc";

function isoDate(value: unknown): string {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("A valid date (YYYY-MM-DD) is required");
  return text;
}

/**
 * Exclusive upper bound (next calendar day, midnight UTC) for filtering
 * ap_payments.paid_at — a TIMESTAMPTZ, unlike ap_bills.bill_date /
 * ar_receipts.receipt_date which are plain DATE columns. Postgres/PostgREST
 * serialize timestamptz as UTC ISO8601, so treating `to` as a UTC calendar
 * boundary here (rather than trusting any browser-local interpretation) is
 * what keeps "day before/on/after To" deterministic regardless of where the
 * server or the browser happen to be running. Pure date-string arithmetic
 * via Date.UTC avoids both local-timezone reinterpretation and manual
 * month/year rollover bugs.
 */
function exclusiveUpperBoundUtc(dateIso: string): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString();
}

async function authorizeStatementView(context: any, propertyId: string): Promise<void> {
  await assertServerPermission(context, {
    propertyId,
    ...AP_PERMISSIONS.suppliersView,
    defaultRoles: ACCOUNTING_AP_ROLES,
  });
}

export type ApSupplierStatementResult = {
  supplier: {
    id: string;
    name: string;
    contactName: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
  };
  propertyId: string;
  from: string;
  to: string;
  sections: ApStatementCurrencySection[];
};

/**
 * Fetches this supplier's own bills and payments, scoped strictly to the
 * given property, and hands them to the pure calculator. All authorization
 * and property/supplier ownership checks happen here; computeApSupplierStatement()
 * itself has no data access and trusts whatever it's given, so this
 * function is the actual security boundary.
 */
export async function loadApSupplierStatement(
  context: any,
  input: { propertyId: string; supplierId: string; from: string; to: string },
): Promise<ApSupplierStatementResult> {
  await authorizeStatementView(context, input.propertyId);

  const { data: supplier, error: supplierError } = await context.supabase
    .from("suppliers")
    .select("id,property_id,name,contact_name,email,phone,address")
    .eq("id", input.supplierId)
    .eq("property_id", input.propertyId)
    .maybeSingle();
  if (supplierError) throw new Error(supplierError.message);
  if (!supplier) throw new Error("Supplier not found for this property");

  const { data: billRows, error: billError } = await context.supabase
    .from("ap_bills")
    .select("id,code,bill_date,status,total,currency")
    .eq("property_id", input.propertyId)
    .eq("supplier_id", input.supplierId)
    .in("status", ["open", "paid"])
    .lte("bill_date", input.to);
  if (billError) throw new Error(billError.message);

  const bills: ApStatementBillRow[] = (billRows ?? []).map((row: any) => ({
    id: row.id,
    code: row.code,
    billDate: row.bill_date,
    status: row.status,
    total: Number(row.total),
    currency: row.currency,
  }));

  let payments: ApStatementPaymentRow[] = [];
  if (bills.length > 0) {
    const billIds = bills.map((bill) => bill.id);
    const billsById = new Map(bills.map((bill) => [bill.id, bill]));

    // ap_payments.bill_id already ties each payment to exactly one bill
    // (no allocation table exists for AP, unlike ar_receipt_allocations) —
    // a flat query scoped to this property's already-fetched bill ids, with
    // the currency derived from the owning bill client-side, same as
    // pdf.functions.ts's own AP payment lookups do.
    const { data: paymentRows, error: paymentError } = await context.supabase
      .from("ap_payments")
      .select("id,bill_id,paid_at,amount,method,reference")
      .eq("property_id", input.propertyId)
      .in("bill_id", billIds)
      .lt("paid_at", exclusiveUpperBoundUtc(input.to));
    if (paymentError) throw new Error(paymentError.message);

    payments = (paymentRows ?? []).map((row: any) => {
      const bill = billsById.get(row.bill_id);
      return {
        billId: row.bill_id,
        amount: Number(row.amount),
        method: row.method,
        reference: row.reference ?? null,
        // paid_at is a TIMESTAMPTZ; PostgREST serializes it as a UTC
        // ISO8601 string, so slicing the first 10 characters is its UTC
        // calendar date directly — no Date parsing/reinterpretation needed.
        paidDate: String(row.paid_at).slice(0, 10),
        currency: bill?.currency ?? "GHS",
      } satisfies ApStatementPaymentRow;
    });
  }

  const sections = computeApSupplierStatement({
    from: input.from,
    to: input.to,
    bills,
    payments,
  });

  return {
    supplier: {
      id: supplier.id,
      name: supplier.name,
      contactName: supplier.contact_name,
      email: supplier.email,
      phone: supplier.phone,
      address: supplier.address,
    },
    propertyId: input.propertyId,
    from: input.from,
    to: input.to,
    sections,
  };
}

export const getApSupplierStatement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; supplierId: string; from: string; to: string }) => ({
    propertyId: uuid(d.propertyId),
    supplierId: uuid(d.supplierId),
    from: isoDate(d.from),
    to: isoDate(d.to),
  }))
  .handler(async ({ data, context }) => {
    if (data.from > data.to) throw new Error("From date must not be after To date");
    return loadApSupplierStatement(context, data);
  });
