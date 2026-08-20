/* eslint-disable @typescript-eslint/no-explicit-any -- properties/admin_log await generated database types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { uuid } from "@/lib/accounting/domain";
import { loadArCustomerStatement } from "@/lib/accounting/ar-statements.functions";

/**
 * Records the print the same way every other admin-generated PDF does
 * (folio/bill/invoice/po/receipt in pdf.functions.ts) — via the admin_log
 * RPC, only after the PDF has actually been built. This mirrors that
 * module's own established audit policy for PDF prints rather than
 * inventing a new one.
 */
async function logStatementPrint(
  context: any,
  propertyId: string,
  customerId: string,
  accountCode: string,
): Promise<void> {
  const { data, error } = await context.supabase.rpc("admin_log", {
    _property_id: propertyId,
    _entity_type: "ar_customer_statement",
    _entity_id: customerId,
    _action: "print",
    _before: null,
    _after: { accountCode },
    _memo: null,
  });
  if (error) throw new Error(`Failed to record print audit: ${error.message}`);
  if (!data) throw new Error("Failed to record print audit");
}

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

export const renderArCustomerStatementPdf = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; customerId: string; from: string; to: string }) => ({
    propertyId: uuid(d.propertyId),
    customerId: uuid(d.customerId),
    from: isoDate(d.from),
    to: isoDate(d.to),
  }))
  .handler(async ({ data, context }) => {
    if (data.from > data.to) throw new Error("From date must not be after To date");

    // Same permission check, same data, same calculation as the on-screen
    // statement — the PDF can never show numbers the viewer couldn't
    // already see, and never trusts anything the client supplied beyond
    // which customer/period to render.
    const statement = await loadArCustomerStatement(context, data);

    const { data: property } = await context.supabase
      .from("properties")
      .select("name,address,phone,email")
      .eq("id", data.propertyId)
      .maybeSingle();
    const anyP = property as any;

    const { buildStatementPdf, toBase64 } = await import("@/lib/admin/pdf-render.server");
    const brand = await fetchDocBranding(context, data.propertyId);
    const bytes = await buildStatementPdf({
      filename: `statement-${statement.customer.accountCode}-${data.from}-to-${data.to}.pdf`,
      title: "Customer Statement",
      code: statement.customer.accountCode,
      fromBlock: [anyP?.name, anyP?.address, anyP?.phone, anyP?.email].filter(Boolean),
      toBlock: [
        statement.customer.name,
        statement.customer.email,
        statement.customer.phone,
        statement.customer.address,
      ].filter((value): value is string => Boolean(value)),
      meta: [
        { label: "Period", value: `${data.from} to ${data.to}` },
        { label: "Customer", value: statement.customer.accountCode },
      ],
      sections: statement.sections,
      brand,
    });
    const base64 = toBase64(bytes);

    await logStatementPrint(
      context,
      data.propertyId,
      data.customerId,
      statement.customer.accountCode,
    );

    return {
      filename: `statement-${statement.customer.accountCode}-${data.from}-to-${data.to}.pdf`,
      mime: "application/pdf",
      base64,
      bytes: bytes.length,
    };
  });
