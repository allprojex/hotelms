/* eslint-disable @typescript-eslint/no-explicit-any -- properties await generated database types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { captureAuditEvent } from "@/lib/audit.server";
import { uuid } from "@/lib/accounting/domain";
import { loadApSupplierStatement } from "@/lib/accounting/ap-statements.functions";

function isoDate(value: unknown): string {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("A valid date (YYYY-MM-DD) is required");
  return text;
}

/**
 * Best-effort effective branding lookup (property override -> global
 * default). Never throws — a branding failure must never block printing
 * the actual statement; buildStatementPdf falls back to its prior
 * hardcoded behavior when `brand` is undefined.
 */
async function fetchDocBranding(
  context: any,
  propertyId: string,
): Promise<import("@/lib/admin/pdf-render.server").DocBranding | undefined> {
  try {
    const { data, error } = await context.supabase.rpc("get_effective_branding", {
      _property_id: propertyId,
    });
    if (error || !data) return undefined;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return undefined;
    return {
      name: row.effective_name || row.org_app_name || undefined,
      logoUrl: row.logo_url ?? null,
      primaryColor: row.primary_color ?? null,
    };
  } catch {
    return undefined;
  }
}

/**
 * Records the print via captureAuditEvent() (audit_capture RPC), NOT the
 * admin_log() RPC that ar-statement-pdf.functions.ts uses. This is a
 * deliberate departure from that otherwise-parallel file: admin_log()'s own
 * internal role check is hardcoded to
 * super_admin/hotel_owner/general_manager, excluding 'accountant' — and
 * 08f7468 already diagnosed exactly this gap for reverse_ar_invoice(),
 * where an accountant-authorized action silently produced no audit row
 * because of that same hardcoded check. AP's accountant role is not a
 * peripheral case here: post_ap_bill/post_ap_payment/suppliers_write and
 * this PR's own assign_ap_bill_supplier() all treat accountant as a normal
 * AP-admin role, and ap-payments.functions.ts (recordApPayment) already
 * uses captureAuditEvent for exactly this reason. Using admin_log() here
 * would reintroduce, in brand-new code, the identical bug class that was
 * just fixed elsewhere — so this file follows the AP module's own
 * established captureAuditEvent convention instead of AR's admin_log one.
 * captureAuditEvent's own gate (can_access_property) already covers every
 * role permitted to view the statement in the first place.
 */
async function logStatementPrint(
  context: any,
  propertyId: string,
  supplierId: string,
  supplierName: string,
): Promise<void> {
  const result = await captureAuditEvent(
    context,
    {
      propertyId,
      sourceModule: "accounting",
      action: "ap_supplier_statement.print",
      resourceType: "ap_supplier_statement",
      resourceId: supplierId,
      newValues: { supplierName },
    },
    { required: true },
  );
  if (!result.logged) throw new Error("Failed to record print audit");
}

export const renderApSupplierStatementPdf = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; supplierId: string; from: string; to: string }) => ({
    propertyId: uuid(d.propertyId),
    supplierId: uuid(d.supplierId),
    from: isoDate(d.from),
    to: isoDate(d.to),
  }))
  .handler(async ({ data, context }) => {
    if (data.from > data.to) throw new Error("From date must not be after To date");

    // Same permission check, same data, same calculation as the on-screen
    // statement — the PDF can never show numbers the viewer couldn't
    // already see, and never trusts anything the client supplied beyond
    // which supplier/period to render.
    const statement = await loadApSupplierStatement(context, data);

    const { data: property } = await context.supabase
      .from("properties")
      .select("name,address,phone,email")
      .eq("id", data.propertyId)
      .maybeSingle();
    const anyP = property as any;

    const { buildStatementPdf, toBase64 } = await import("@/lib/admin/pdf-render.server");
    const brand = await fetchDocBranding(context, data.propertyId);
    const filename = `supplier-statement-${statement.supplier.name.replace(/[^a-z0-9]+/gi, "-")}-${data.from}-to-${data.to}.pdf`;
    const bytes = await buildStatementPdf({
      filename,
      title: "Supplier Statement",
      fromBlock: [anyP?.name, anyP?.address, anyP?.phone, anyP?.email].filter(Boolean),
      toBlock: [
        statement.supplier.name,
        statement.supplier.contactName,
        statement.supplier.email,
        statement.supplier.phone,
        statement.supplier.address,
      ].filter((value): value is string => Boolean(value)),
      meta: [
        { label: "Period", value: `${data.from} to ${data.to}` },
        { label: "Supplier", value: statement.supplier.name },
      ],
      sections: statement.sections,
      brand,
    });
    const base64 = toBase64(bytes);

    await logStatementPrint(context, data.propertyId, data.supplierId, statement.supplier.name);

    return {
      filename,
      mime: "application/pdf",
      base64,
      bytes: bytes.length,
    };
  });
