/* eslint-disable @typescript-eslint/no-explicit-any -- ap_payments awaits generated database types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { captureAuditEvent } from "@/lib/audit.server";
import { uuid } from "@/lib/accounting/domain";

const createInput = (d: {
  propertyId: string;
  billId: string;
  amount: number;
  method: string;
  reference?: string;
}) => ({
  propertyId: uuid(d.propertyId),
  billId: uuid(d.billId),
  amount: Number(d.amount),
  method: String(d.method ?? "cash"),
  reference: d.reference?.trim().slice(0, 200) || null,
});

/**
 * Records an AP payment. The insert's own AFTER INSERT trigger
 * (trg_ap_payment_autopost) synchronously runs post_ap_payment(), which
 * validates and posts the GL entry within the same transaction as this
 * insert — so a rejected payment (over-limit, wrong property, non-open
 * bill, etc.) fails the insert itself and nothing is persisted.
 */
export const recordApPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(createInput)
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as any;
    const { data: payment, error } = await supabase
      .from("ap_payments")
      .insert({
        property_id: data.propertyId,
        bill_id: data.billId,
        amount: data.amount,
        method: data.method,
        reference: data.reference,
      })
      .select("id,amount,method,posted_entry_id")
      .single();
    if (error) throw new Error(error.message);

    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "accounting",
      action: "ap_payment.recorded",
      resourceType: "ap_payment",
      resourceId: payment.id,
      newValues: {
        billId: data.billId,
        amount: payment.amount,
        method: payment.method,
      },
    });

    return payment;
  });
