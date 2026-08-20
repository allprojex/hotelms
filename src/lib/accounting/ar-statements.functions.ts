/* eslint-disable @typescript-eslint/no-explicit-any -- ar_invoices/ar_customers/ar_receipts await generated database types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertServerPermission } from "@/lib/permissions.server";
import { ACCOUNTING_AR_ROLES, AR_PERMISSIONS } from "@/lib/accounting/permissions";
import { uuid } from "@/lib/accounting/domain";
import {
  computeArCustomerStatement,
  type ArStatementAllocationRow,
  type ArStatementCreditNoteRow,
  type ArStatementCurrencySection,
  type ArStatementInvoiceRow,
} from "@/lib/accounting/ar-statement-calc";

function isoDate(value: unknown): string {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("A valid date (YYYY-MM-DD) is required");
  return text;
}

async function authorizeStatementView(context: any, propertyId: string): Promise<void> {
  await assertServerPermission(context, {
    propertyId,
    ...AR_PERMISSIONS.customersView,
    defaultRoles: ACCOUNTING_AR_ROLES,
  });
}

export type ArCustomerStatementResult = {
  customer: {
    id: string;
    accountCode: string;
    name: string;
    email: string | null;
    phone: string | null;
    address: string | null;
  };
  propertyId: string;
  from: string;
  to: string;
  sections: ArStatementCurrencySection[];
};

/**
 * Fetches this customer's own invoices and receipt allocations, scoped
 * strictly to the given property, and hands them to the pure calculator.
 * All authorization and property/customer ownership checks happen here;
 * computeArCustomerStatement() itself has no data access and trusts
 * whatever it's given, so this function is the actual security boundary.
 */
export async function loadArCustomerStatement(
  context: any,
  input: { propertyId: string; customerId: string; from: string; to: string },
): Promise<ArCustomerStatementResult> {
  await authorizeStatementView(context, input.propertyId);

  const { data: customer, error: customerError } = await context.supabase
    .from("ar_customers")
    .select("id,property_id,account_code,name,email,phone,address")
    .eq("id", input.customerId)
    .eq("property_id", input.propertyId)
    .maybeSingle();
  if (customerError) throw new Error(customerError.message);
  if (!customer) throw new Error("AR customer not found for this property");

  const { data: invoiceRows, error: invoiceError } = await context.supabase
    .from("ar_invoices")
    .select("id,code,issue_date,status,total,currency")
    .eq("property_id", input.propertyId)
    .eq("customer_id", input.customerId)
    .in("status", ["sent", "paid"])
    .lte("issue_date", input.to);
  if (invoiceError) throw new Error(invoiceError.message);

  const invoices: ArStatementInvoiceRow[] = (invoiceRows ?? []).map((row: any) => ({
    id: row.id,
    code: row.code,
    issueDate: row.issue_date,
    status: row.status,
    total: Number(row.total),
    currency: row.currency,
  }));

  let allocations: ArStatementAllocationRow[] = [];
  if (invoices.length > 0) {
    const invoiceIds = invoices.map((inv) => inv.id);
    const invoicesById = new Map(invoices.map((inv) => [inv.id, inv]));

    // ar_receipt_allocations carries both a plain invoice_id/receipt_id FK
    // and a composite (property_id, invoice_id)/(property_id, receipt_id)
    // FK to ar_invoices/ar_receipts, so a bare PostgREST embed here would
    // be ambiguous (the same class of issue already fixed for HRM in
    // 20260803160000_hrm_fk_ambiguity_fix.sql, and already worked around
    // the same way in pdf.functions.ts's receipt branch). Load
    // allocations and receipts as flat queries and join client-side.
    const { data: allocRows, error: allocError } = await context.supabase
      .from("ar_receipt_allocations")
      .select("receipt_id,invoice_id,amount")
      .eq("property_id", input.propertyId)
      .in("invoice_id", invoiceIds);
    if (allocError) throw new Error(allocError.message);

    const receiptIds = [...new Set((allocRows ?? []).map((row: any) => row.receipt_id))];
    let receiptsById = new Map<string, any>();
    if (receiptIds.length > 0) {
      const { data: receiptRows, error: receiptError } = await context.supabase
        .from("ar_receipts")
        .select("id,code,receipt_date,currency,status")
        .eq("property_id", input.propertyId)
        .in("id", receiptIds)
        .lte("receipt_date", input.to);
      if (receiptError) throw new Error(receiptError.message);
      receiptsById = new Map((receiptRows ?? []).map((row: any) => [row.id, row]));
    }

    allocations = (allocRows ?? [])
      .map((row: any) => {
        const receipt = receiptsById.get(row.receipt_id);
        if (!receipt) return null; // receipt filtered out by the `to` bound above
        const invoice = invoicesById.get(row.invoice_id);
        return {
          invoiceId: row.invoice_id,
          amount: Number(row.amount),
          receiptCode: receipt.code,
          receiptDate: receipt.receipt_date,
          // The allocation's own currency is always the invoice's currency
          // (post_ar_receipt enforces this at posting time); falling back
          // to the receipt's own currency only if the invoice was somehow
          // not in our fetched set.
          currency: invoice?.currency ?? receipt.currency,
          // Carried through so the pure calculator can exclude a reversed
          // receipt's allocations (see ArStatementAllocationRow's own doc
          // comment) — this fetch itself is not filtered to status='posted'
          // at the query level (unlike credit notes below), because a
          // voided receipt's allocation must still be visible here for the
          // calculator to make that exclusion decision explicitly, the
          // same "filter in the pure function, not silently in the query"
          // posture already used for invoice status via eligibleInvoiceIds.
          receiptStatus: receipt.status,
        } satisfies ArStatementAllocationRow;
      })
      .filter(
        (row: ArStatementAllocationRow | null): row is ArStatementAllocationRow => row !== null,
      );
  }

  let creditNotes: ArStatementCreditNoteRow[] = [];
  if (invoices.length > 0) {
    const invoiceIds = invoices.map((inv) => inv.id);
    // Filtering to status='posted' here is the real security/correctness
    // boundary (this function's own doc comment above) — the pure
    // calculator independently re-filters to 'posted' too, but only as
    // defensive redundancy, the same pattern already used for invoice
    // status. Filtering by issue_date <= to mirrors the receipt/invoice
    // fetch above: rows strictly after `to` cannot affect this statement.
    const { data: creditNoteRows, error: creditNoteError } = await context.supabase
      .from("ar_credit_notes")
      .select("invoice_id,code,total,issue_date,currency,status")
      .eq("property_id", input.propertyId)
      .in("invoice_id", invoiceIds)
      .eq("status", "posted")
      .lte("issue_date", input.to);
    if (creditNoteError) throw new Error(creditNoteError.message);

    creditNotes = (creditNoteRows ?? []).map((row: any) => ({
      invoiceId: row.invoice_id,
      code: row.code,
      total: Number(row.total),
      issueDate: row.issue_date,
      currency: row.currency,
      status: row.status,
    }));
  }

  const sections = computeArCustomerStatement({
    from: input.from,
    to: input.to,
    invoices,
    allocations,
    creditNotes,
  });

  return {
    customer: {
      id: customer.id,
      accountCode: customer.account_code,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      address: customer.address,
    },
    propertyId: input.propertyId,
    from: input.from,
    to: input.to,
    sections,
  };
}

export const getArCustomerStatement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; customerId: string; from: string; to: string }) => ({
    propertyId: uuid(d.propertyId),
    customerId: uuid(d.customerId),
    from: isoDate(d.from),
    to: isoDate(d.to),
  }))
  .handler(async ({ data, context }) => {
    if (data.from > data.to) throw new Error("From date must not be after To date");
    return loadArCustomerStatement(context, data);
  });
