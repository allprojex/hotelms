/* eslint-disable @typescript-eslint/no-explicit-any -- ar_receipts/ar_receipt_allocations await generated database types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { captureAuditEvent } from "@/lib/audit.server";
import { requireValidCurrencyCode, uuid } from "@/lib/accounting/domain";

type AllocationInput = { invoiceId: string; amount: number };

function allocationsInput(value: unknown): { invoice_id: string; amount: number }[] {
  const arr = Array.isArray(value) ? (value as AllocationInput[]) : [];
  if (arr.length === 0) throw new Error("At least one allocation is required");
  return arr.map((a) => ({
    invoice_id: uuid(a.invoiceId),
    amount: Number(a.amount),
  }));
}

const createInput = (d: {
  propertyId: string;
  receiptDate?: string | null;
  method: string;
  reference?: string;
  notes?: string;
  idempotencyKey: string;
  allocations: AllocationInput[];
}) => ({
  propertyId: uuid(d.propertyId),
  receiptDate: d.receiptDate || null,
  method: String(d.method ?? "cash"),
  reference: d.reference?.trim().slice(0, 200) || null,
  notes: d.notes?.trim().slice(0, 1000) || null,
  idempotencyKey: uuid(d.idempotencyKey),
  allocations: allocationsInput(d.allocations),
});

/**
 * Posts an AR receipt via the atomic post_ar_receipt() RPC (validation,
 * over-allocation protection, and GL posting all happen server-side inside
 * that function), then looks the receipt row up by idempotency_key to audit
 * it against its actual id/code and to return it to the caller.
 */
export const createArReceipt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(createInput)
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as any;
    const invoiceIds = data.allocations.map((allocation) => allocation.invoice_id);
    const { data: invoices, error: invoiceError } = await supabase
      .from("ar_invoices")
      .select("id,currency")
      .eq("property_id", data.propertyId)
      .in("id", invoiceIds);
    if (invoiceError) throw new Error(invoiceError.message);
    if ((invoices ?? []).length !== invoiceIds.length) throw new Error("One or more invoices were not found");
    for (const invoice of invoices ?? []) requireValidCurrencyCode(invoice.currency);

    const { error: rpcError } = await supabase.rpc("post_ar_receipt", {
      _property_id: data.propertyId,
      _receipt_date: data.receiptDate,
      _method: data.method,
      _reference: data.reference,
      _notes: data.notes,
      _idempotency_key: data.idempotencyKey,
      _allocations: data.allocations,
    });
    if (rpcError) throw new Error(rpcError.message);

    const { data: receipt, error: fetchError } = await supabase
      .from("ar_receipts")
      .select("id,code,amount,currency,posted_entry_id")
      .eq("property_id", data.propertyId)
      .eq("idempotency_key", data.idempotencyKey)
      .single();
    if (fetchError) throw new Error(fetchError.message);

    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "accounting",
      action: "ar_receipt.posted",
      resourceType: "ar_receipt",
      resourceId: receipt.id,
      newValues: {
        code: receipt.code,
        amount: receipt.amount,
        currency: receipt.currency,
        method: data.method,
        allocations: data.allocations,
      },
    });

    return receipt;
  });
