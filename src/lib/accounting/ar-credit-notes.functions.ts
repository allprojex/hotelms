import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertServerPermission } from "@/lib/permissions.server";
import { ACCOUNTING_ADMIN_ROLES, AR_PERMISSIONS } from "@/lib/accounting/permissions";
import { uuid, reasonText } from "@/lib/accounting/domain";

/**
 * Thin, type-validating wrapper around create_ar_credit_note()
 * (20260819120000_ar_credit_notes_pr1.sql) — mirrors createArInvoice's own
 * shape exactly (both are "create with a lines array" RPCs). Every
 * accounting decision (invoice eligibility, per-line quantity capacity,
 * unit_price/tax_rate/revenue_account_id copy-from-source, subtotal/tax/
 * total computation) is enforced only inside the SECURITY DEFINER RPC —
 * this handler performs no accounting math, only request shape/type
 * validation and the same app-level authorize() layer createArInvoice/
 * createArReceipt already use.
 *
 * post_ar_credit_note() has no equivalent wrapper here — like
 * post_ar_invoice()/reverse_ar_invoice(), it takes only an id and is
 * called directly via supabase.rpc() from the client component.
 */
export const createArCreditNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      propertyId: string;
      invoiceId: string;
      issueDate: string;
      reason: string;
      lines: Array<{ sourceInvoiceLineId: string; quantity: number }>;
    }) => ({
      propertyId: uuid(d.propertyId),
      invoiceId: uuid(d.invoiceId),
      issueDate: String(d.issueDate ?? ""),
      reason: reasonText(d.reason),
      lines: Array.isArray(d.lines)
        ? d.lines.map((line) => ({
            sourceInvoiceLineId: uuid(line.sourceInvoiceLineId),
            quantity: Number(line.quantity),
          }))
        : [],
    }),
  )
  .handler(async ({ data, context }) => {
    await assertServerPermission(context, {
      propertyId: data.propertyId,
      ...AR_PERMISSIONS.creditNotesCreate,
      defaultRoles: ACCOUNTING_ADMIN_ROLES,
    });
    if (data.lines.length === 0) throw new Error("At least one credit note line is required");

    // create_ar_credit_note is not yet in the generated Database types,
    // matching the established (context.supabase as any).rpc precedent in
    // ar-customers.functions.ts's own createArInvoice.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (context.supabase as any).rpc("create_ar_credit_note", {
      _property_id: data.propertyId,
      _invoice_id: data.invoiceId,
      _issue_date: data.issueDate,
      _reason: data.reason,
      _lines: data.lines.map((line) => ({
        source_invoice_line_id: line.sourceInvoiceLineId,
        quantity: line.quantity,
      })),
    });
    if (result.error) throw new Error(result.error.message);
    return { id: result.data as string };
  });
