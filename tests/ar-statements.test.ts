import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePermission, type PermissionGrant, type PropertyRole } from "@/lib/permissions";
import { AR_PERMISSIONS, ACCOUNTING_AR_ROLES } from "@/lib/accounting/permissions";

const root = resolve(__dirname, "..");
// Normalizes CRLF -> LF so literal multi-line `.toContain()` assertions
// don't depend on the working tree's checkout line-ending state.
function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const statementFns = read(resolve(root, "src/lib/accounting/ar-statements.functions.ts"));
const statementCalc = read(resolve(root, "src/lib/accounting/ar-statement-calc.ts"));
const statementPdfFns = read(resolve(root, "src/lib/accounting/ar-statement-pdf.functions.ts"));
const pdfRenderServer = read(resolve(root, "src/lib/admin/pdf-render.server.ts"));
const statementView = read(
  resolve(root, "src/components/accounting/ar-customer-statement-view.tsx"),
);
const customerManager = read(resolve(root, "src/components/accounting/ar-customer-manager.tsx"));
const arPage = read(resolve(root, "src/routes/_authenticated/accounting.ar.tsx"));
const navConfig = read(resolve(root, "src/lib/accounting/nav-config.ts"));

const PROPERTY_ID = "00000000-0000-4000-8000-00000000000a";

function roleRow(
  role: PropertyRole["role"],
  propertyId: string | null = PROPERTY_ID,
): PropertyRole[] {
  return [{ role, property_id: propertyId }];
}

const request = {
  propertyId: PROPERTY_ID,
  ...AR_PERMISSIONS.customersView,
  defaultRoles: ACCOUNTING_AR_ROLES,
};

describe("AR customer statement — permission model", () => {
  it("W/X. admin (super_admin) and authorized non-admin roles (hotel_owner/general_manager/accountant/front_desk) can view statements", () => {
    expect(resolvePermission({ roles: roleRow("super_admin", null), request })).toBe(true);
    for (const role of ["hotel_owner", "general_manager", "accountant", "front_desk"] as const) {
      expect(resolvePermission({ roles: roleRow(role), request })).toBe(true);
    }
  });

  it("V. an unauthorized role cannot view statements", () => {
    expect(resolvePermission({ roles: roleRow("housekeeping"), request })).toBe(false);
    expect(resolvePermission({ roles: roleRow("guest"), request })).toBe(false);
  });

  it("removing the grant via an explicit deny overrides the role default, same as every other AR permission", () => {
    const deny: PermissionGrant = {
      role: "front_desk",
      property_id: PROPERTY_ID,
      module: "accounts_receivable",
      action: "read",
      allowed: false,
    };
    expect(resolvePermission({ roles: roleRow("front_desk"), grants: [deny], request })).toBe(
      false,
    );
  });

  it("reuses the existing AR_PERMISSIONS.customersView entry rather than introducing a new permission", () => {
    expect(statementFns).toContain("AR_PERMISSIONS.customersView");
    expect(statementFns).not.toMatch(/statementView:|statementsView:/);
  });

  it("no hardcoded admin-only gate exists anywhere in the statement code", () => {
    for (const source of [statementFns, statementPdfFns, statementView, customerManager]) {
      expect(source).not.toMatch(/role\s*===\s*["']admin["']/);
      expect(source).not.toMatch(/\[\s*["']admin["']\s*,\s*["']super_admin["']\s*\]/);
    }
  });

  it("the server function asserts permission before doing any data access", () => {
    const start = statementFns.indexOf("export async function loadArCustomerStatement");
    const body = statementFns.slice(start, statementFns.indexOf("\n}", start));
    const authIdx = body.indexOf("authorizeStatementView");
    const customerQueryIdx = body.indexOf('.from("ar_customers")');
    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(authIdx).toBeLessThan(customerQueryIdx);
  });
});

describe("AR customer statement — property isolation", () => {
  it("T. the customer lookup is scoped to the given property, rejecting a cross-property customer id", () => {
    expect(statementFns).toContain('.eq("id", input.customerId)');
    expect(statementFns).toContain('.eq("property_id", input.propertyId)');
    expect(statementFns).toContain("AR customer not found for this property");
  });

  it("U. every invoice and allocation query is explicitly scoped to property_id — no query reads across properties", () => {
    const fromCalls = statementFns.match(/\.from\("[a-z_]+"\)[\s\S]{0,220}/g) ?? [];
    const dataQueries = fromCalls.filter((call) =>
      /ar_invoices|ar_receipt_allocations|ar_receipts/.test(call),
    );
    expect(dataQueries.length).toBeGreaterThanOrEqual(3);
    for (const call of dataQueries) {
      expect(call).toContain('.eq("property_id"');
    }
  });

  it("R. only invoices with a matching customer_id are ever fetched — an unmapped (customer_id IS NULL) historical invoice can never match any customer's statement", () => {
    expect(statementFns).toContain('.eq("customer_id", input.customerId)');
  });

  it("S. bill_to_name/bill_to_email are never read or used to determine customer identity anywhere in the statement pipeline", () => {
    for (const source of [statementFns, statementCalc]) {
      expect(source).not.toMatch(/bill_to_name|bill_to_email|bill_to_address/);
    }
  });
});

describe("AR customer statement — data model fidelity", () => {
  it("only status IN ('sent','paid') invoices are fetched from the database — draft/void excluded at the query level too, not just in the pure calculator", () => {
    expect(statementFns).toContain('.in("status", ["sent", "paid"])');
  });

  it("credits are attributed via ar_receipt_allocations (joined to invoice ownership), never by reading a nonexistent customer_id on ar_receipts", () => {
    expect(statementFns).toContain('.from("ar_receipt_allocations")');
    expect(statementFns).not.toMatch(/ar_receipts["']\)[\s\S]{0,80}customer_id/);
  });

  it("avoids the ar_receipt_allocations/ar_invoices and .../ar_receipts PostgREST embed ambiguity the same way pdf.functions.ts already does — flat queries joined client-side, not a bare embed", () => {
    expect(statementFns).not.toContain('ar_receipt_allocations").select("*, ');
    expect(statementFns).toContain('.from("ar_receipts")');
  });

  it("does not double-count a receipt's amount independently of its allocations — only ar_receipt_allocations.amount is summed, never ar_receipts.amount", () => {
    expect(statementFns).not.toMatch(/receipt\.amount|receipts\.amount|row\.amount.*receipt/i);
  });
});

describe("AR customer statement — historical mapping compatibility", () => {
  it("Q. a historical invoice mapped via assign_ar_invoice_customer becomes eligible under the exact same query — no special-casing by mapping origin", () => {
    // The query that fetches invoices for a statement has no notion of
    // "historical" vs "normal" — any invoice with customer_id = X and an
    // included status is eligible, regardless of when or how customer_id
    // was set.
    const invoiceQuery = statementFns.match(/\.from\("ar_invoices"\)[\s\S]{0,260}/)?.[0] ?? "";
    expect(invoiceQuery).not.toMatch(/mapped|historical|assign_ar_invoice_customer/i);
  });

  it("does not rewrite or read historical snapshot fields at all", () => {
    expect(statementFns).not.toContain(".update(");
    expect(statementFns).not.toContain(".insert(");
    expect(statementFns).not.toContain(".delete(");
  });
});

describe("AR customer statement — PDF", () => {
  it("AC. the PDF is built from the exact same loadArCustomerStatement() result as the on-screen statement — it never recomputes totals independently", () => {
    expect(statementPdfFns).toContain("loadArCustomerStatement(context, data)");
    expect(statementPdfFns).toContain("sections: statement.sections");
    expect(statementPdfFns).not.toMatch(/computeArCustomerStatement\(/);
  });

  it("AD. PDF generation never mutates data — no insert/update/delete anywhere in the render handler, only reads and the print audit RPC", () => {
    const handlerStart = statementPdfFns.indexOf(".handler(async");
    const body = statementPdfFns.slice(handlerStart);
    expect(body).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
  });

  it("logs the print only after the PDF bytes are actually built, matching the established pdf.functions.ts convention (admin_log, not a bespoke audit path)", () => {
    expect(statementPdfFns.indexOf("await buildStatementPdf(")).toBeLessThan(
      statementPdfFns.indexOf("await logStatementPrint("),
    );
    expect(statementPdfFns).toContain('context.supabase.rpc("admin_log"');
    expect(statementPdfFns).not.toContain('from("admin_action_logs").insert');
  });

  it("reuses the existing pdf-lib-based renderer rather than a second PDF framework — same PDFDocument/font/fmt/drawText helpers as buildDocPdf", () => {
    expect(pdfRenderServer).toContain("export async function buildStatementPdf");
    const statementFnBody = pdfRenderServer.slice(
      pdfRenderServer.indexOf("export async function buildStatementPdf"),
    );
    expect(statementFnBody).toContain("PDFDocument.create()");
    expect(statementFnBody).toContain("drawText(page,");
    expect(statementFnBody).toContain("fmt(");
  });

  it("never combines multiple currencies into one PDF total — one section per currency, each with its own opening/closing balance line", () => {
    const statementFnBody = pdfRenderServer.slice(
      pdfRenderServer.indexOf("export async function buildStatementPdf"),
    );
    expect(statementFnBody).toContain("for (const section of data.sections)");
    expect(statementFnBody).toContain("`Currency: ${section.currency}`");
  });
});

describe("AR customer statement — UI", () => {
  it("AE. the actual production AR route (accounting.ar.tsx -> ArCustomerManager) contains the statement entry point, not a separate/duplicate page", () => {
    expect(arPage).toContain("ArCustomerManager");
    expect(customerManager).toContain("ArCustomerStatementView");
    expect(customerManager).toContain("Statement");
  });

  it("is reached via AR Customers -> select customer -> Statement, matching the navigated route in nav-config.ts", () => {
    expect(navConfig).toContain('to: "/accounting/ar"');
    expect(customerManager).toMatch(/onClick=\{\(\) => setStatementCustomer\(customer\)\}/);
  });

  it("statement calculations happen server-side — the component only ever calls the server function, never fetches raw invoice/receipt tables directly", () => {
    expect(statementView).toContain("getArCustomerStatement");
    expect(statementView).not.toMatch(
      /\.from\(["'](ar_invoices|ar_receipts|ar_receipt_allocations)["']\)/,
    );
  });

  it("PDF download does not mutate any query cache / does not trigger a save — it only opens/populates a new window", () => {
    const printFn = statementView.match(/async function handlePrint\(\)[\s\S]*?\n {2}\}/)?.[0];
    expect(printFn).toBeDefined();
    expect(printFn).not.toMatch(/\.mutate\(|invalidateQueries/);
  });

  it("date range validation rejects From after To, both client-side and server-side", () => {
    expect(statementView).toContain("const dateRangeValid = from <= to;");
    expect(statementFns).toContain("From date must not be after To date");
  });

  it("does not expose internal UUIDs as the primary customer identifier — displays account_code, not id", () => {
    expect(statementView).toContain("customer.account_code");
    expect(statementView).not.toMatch(/\{customer\.id\}/);
  });

  it("CSV export re-serializes the already-fetched, server-authoritative statement data — it does not call any server function of its own", () => {
    const csvFn = statementView.match(/function exportStatementCsv\([\s\S]*?\n\}/)?.[0];
    expect(csvFn).toBeDefined();
    expect(csvFn).not.toMatch(/statementFn\(|printFn\(|await /);
  });
});

describe("AR customer statement — posted credit notes (PR #36 blocking fix)", () => {
  it("fetches ar_credit_notes scoped to property_id and the customer's own fetched invoice ids", () => {
    const creditNoteQuery =
      statementFns.match(/\.from\("ar_credit_notes"\)[\s\S]{0,260}/)?.[0] ?? "";
    expect(creditNoteQuery).toContain('.eq("property_id", input.propertyId)');
    expect(creditNoteQuery).toContain('.in("invoice_id", invoiceIds)');
  });

  it("filters to status='posted' at the query level — this is the real security/correctness boundary, not just the pure calculator's defensive re-filter", () => {
    const creditNoteQuery =
      statementFns.match(/\.from\("ar_credit_notes"\)[\s\S]{0,260}/)?.[0] ?? "";
    expect(creditNoteQuery).toContain('.eq("status", "posted")');
  });

  it("bounds the credit note fetch by issue_date <= to, matching the invoice/receipt fetch bound", () => {
    const creditNoteQuery =
      statementFns.match(/\.from\("ar_credit_notes"\)[\s\S]{0,260}/)?.[0] ?? "";
    expect(creditNoteQuery).toContain('.lte("issue_date", input.to)');
  });

  it("passes creditNotes through to the pure calculator alongside invoices and allocations", () => {
    expect(statementFns).toContain("creditNotes,");
    const sectionsCall =
      statementFns.match(/computeArCustomerStatement\(\{[\s\S]{0,120}/)?.[0] ?? "";
    expect(sectionsCall).toContain("creditNotes");
  });

  it("U (extended). the credit note query is included among the property-scoped data queries this suite already audits", () => {
    const fromCalls = statementFns.match(/\.from\("[a-z_]+"\)[\s\S]{0,220}/g) ?? [];
    const dataQueries = fromCalls.filter((call) =>
      /ar_invoices|ar_receipt_allocations|ar_receipts|ar_credit_notes/.test(call),
    );
    expect(dataQueries.length).toBeGreaterThanOrEqual(4);
    for (const call of dataQueries) {
      expect(call).toContain('.eq("property_id"');
    }
  });
});

describe("AR customer statement — no automatic name/email inference anywhere in this feature", () => {
  it("the statement pipeline never joins or filters by bill_to_name/bill_to_email/reservation_id for identity purposes", () => {
    for (const source of [statementFns, statementCalc, statementPdfFns]) {
      expect(source).not.toMatch(/bill_to_name|bill_to_email|reservation_id/);
    }
  });
});
