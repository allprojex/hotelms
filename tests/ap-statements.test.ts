import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePermission, type PermissionGrant, type PropertyRole } from "@/lib/permissions";
import { AP_PERMISSIONS, ACCOUNTING_AP_ROLES } from "@/lib/accounting/permissions";

const root = resolve(__dirname, "..");
// Normalizes CRLF -> LF so literal multi-line `.toContain()` assertions
// don't depend on the working tree's checkout line-ending state.
function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const statementFns = read(resolve(root, "src/lib/accounting/ap-statements.functions.ts"));
const statementCalc = read(resolve(root, "src/lib/accounting/ap-statement-calc.ts"));
const statementPdfFns = read(resolve(root, "src/lib/accounting/ap-statement-pdf.functions.ts"));
const pdfRenderServer = read(resolve(root, "src/lib/admin/pdf-render.server.ts"));
const statementView = read(
  resolve(root, "src/components/accounting/ap-supplier-statement-view.tsx"),
);
const apPage = read(resolve(root, "src/routes/_authenticated/accounting.ap.tsx"));
const settingsPage = read(resolve(root, "src/routes/_authenticated/inventory.settings.tsx"));
const auditServer = read(resolve(root, "src/lib/audit.server.ts"));

const PROPERTY_ID = "00000000-0000-4000-8000-00000000000a";

function roleRow(
  role: PropertyRole["role"],
  propertyId: string | null = PROPERTY_ID,
): PropertyRole[] {
  return [{ role, property_id: propertyId }];
}

const request = {
  propertyId: PROPERTY_ID,
  ...AP_PERMISSIONS.suppliersView,
  defaultRoles: ACCOUNTING_AP_ROLES,
};

describe("AP supplier statement — permission model", () => {
  it("W/X/Y. admin (super_admin) and authorized non-admin roles (hotel_owner/general_manager/accountant) can view statements", () => {
    expect(resolvePermission({ roles: roleRow("super_admin", null), request })).toBe(true);
    for (const role of ["hotel_owner", "general_manager", "accountant"] as const) {
      expect(resolvePermission({ roles: roleRow(role), request })).toBe(true);
    }
  });

  it("V/W. an unauthorized role (including front_desk, which has no AP write footprint anywhere in RLS) cannot view statements", () => {
    expect(resolvePermission({ roles: roleRow("front_desk"), request })).toBe(false);
    expect(resolvePermission({ roles: roleRow("housekeeping"), request })).toBe(false);
    expect(resolvePermission({ roles: roleRow("guest"), request })).toBe(false);
  });

  it("removing the grant via an explicit deny overrides the role default, same as every other AP permission", () => {
    const deny: PermissionGrant = {
      role: "accountant",
      property_id: PROPERTY_ID,
      module: "accounts_payable",
      action: "read",
      allowed: false,
    };
    expect(resolvePermission({ roles: roleRow("accountant"), grants: [deny], request })).toBe(
      false,
    );
  });

  it("reuses the AP_PERMISSIONS.suppliersView entry rather than inventing a new one, and defines the AP module distinctly from accounts_receivable", () => {
    expect(statementFns).toContain("AP_PERMISSIONS.suppliersView");
    expect(AP_PERMISSIONS.suppliersView.module).toBe("accounts_payable");
  });

  it("no hardcoded admin-only gate exists anywhere in the statement code", () => {
    for (const source of [statementFns, statementPdfFns, statementView]) {
      expect(source).not.toMatch(/role\s*===\s*["']admin["']/);
      expect(source).not.toMatch(/\[\s*["']admin["']\s*,\s*["']super_admin["']\s*\]/);
    }
  });

  it("the server function asserts permission before doing any data access", () => {
    const start = statementFns.indexOf("export async function loadApSupplierStatement");
    const body = statementFns.slice(start, statementFns.indexOf("\n}", start));
    const authIdx = body.indexOf("authorizeStatementView");
    const supplierQueryIdx = body.indexOf('.from("suppliers")');
    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(authIdx).toBeLessThan(supplierQueryIdx);
  });
});

describe("AP supplier statement — property isolation", () => {
  it("U. the supplier lookup is scoped to the given property, rejecting a cross-property supplier id", () => {
    expect(statementFns).toContain('.eq("id", input.supplierId)');
    expect(statementFns).toContain('.eq("property_id", input.propertyId)');
    expect(statementFns).toContain("Supplier not found for this property");
  });

  it("V. every bill and payment query is explicitly scoped to property_id — no query reads across properties", () => {
    const fromCalls = statementFns.match(/\.from\("[a-z_]+"\)[\s\S]{0,220}/g) ?? [];
    const dataQueries = fromCalls.filter((call) => /ap_bills|ap_payments|suppliers/.test(call));
    expect(dataQueries.length).toBeGreaterThanOrEqual(3);
    for (const call of dataQueries) {
      expect(call).toContain('.eq("property_id"');
    }
  });

  it("R. only bills with a matching supplier_id are ever fetched — an unmapped (supplier_id IS NULL) historical bill can never match any supplier's statement", () => {
    expect(statementFns).toContain('.eq("supplier_id", input.supplierId)');
  });

  it("T. supplier_name (the free-text snapshot on ap_bills) is never read or used to determine supplier identity anywhere in the statement pipeline", () => {
    for (const source of [statementFns, statementCalc]) {
      expect(source).not.toMatch(/supplier_name/);
    }
  });
});

describe("AP supplier statement — data model fidelity", () => {
  it("only status IN ('open','paid') bills are fetched from the database — draft/void excluded at the query level too, not just in the pure calculator", () => {
    expect(statementFns).toContain('.in("status", ["open", "paid"])');
  });

  it("payments are attributed via ap_payments.bill_id directly — there is no allocation table for AP, unlike AR's ar_receipt_allocations", () => {
    expect(statementFns).toContain('.from("ap_payments")');
    expect(statementFns).not.toContain("ap_receipt_allocations");
  });

  it("Z/AA. bill statuses draft and void are excluded, matching ap_aging's own `status <> 'void'` convention and post_ap_bill's draft->open lifecycle", () => {
    expect(statementCalc).toContain('AP_STATEMENT_INCLUDED_STATUSES = ["open", "paid"]');
    expect(statementCalc).not.toMatch(/includedStatuses.*draft/);
  });

  it("AB. the sign convention is documented explicitly: bill credits the supplier balance, payment debits it", () => {
    expect(statementCalc).toMatch(/bill CREDITS the\s+\*?\s*supplier\s+\*?\s*balance/);
    expect(statementCalc).toMatch(/payment DEBITS it/);
    expect(statementCalc).toContain("running + row.credit - row.debit");
  });
});

describe("AP supplier statement — historical mapping compatibility", () => {
  it("Q. a historical bill mapped via assign_ap_bill_supplier becomes eligible under the exact same query — no special-casing by mapping origin", () => {
    const billQuery = statementFns.match(/\.from\("ap_bills"\)[\s\S]{0,260}/)?.[0] ?? "";
    expect(billQuery).not.toMatch(/mapped|historical|assign_ap_bill_supplier/i);
  });

  it("does not rewrite or read historical snapshot fields at all", () => {
    expect(statementFns).not.toContain(".update(");
    expect(statementFns).not.toContain(".insert(");
    expect(statementFns).not.toContain(".delete(");
  });
});

describe("AP supplier statement — date handling (paid_at is TIMESTAMPTZ, unlike bill_date/DATE)", () => {
  it("uses an explicit UTC exclusive upper bound for paid_at rather than a naive string compare, to avoid browser-timezone shifts", () => {
    expect(statementFns).toContain("exclusiveUpperBoundUtc");
    expect(statementFns).toContain('.lt("paid_at", exclusiveUpperBoundUtc(input.to))');
    expect(statementFns).toContain("Date.UTC(y, m - 1, d + 1)");
  });

  it("derives the payment's calendar date from paid_at's own UTC serialization, not local Date parsing", () => {
    expect(statementFns).toContain("String(row.paid_at).slice(0, 10)");
  });
});

describe("AP supplier statement — PDF", () => {
  it("AD. the PDF is built from the exact same loadApSupplierStatement() result as the on-screen statement — it never recomputes totals independently", () => {
    expect(statementPdfFns).toContain("loadApSupplierStatement(context, data)");
    expect(statementPdfFns).toContain("sections: statement.sections");
    expect(statementPdfFns).not.toMatch(/computeApSupplierStatement\(/);
  });

  it("AE. PDF generation never mutates data — no insert/update/delete anywhere in the render handler, only reads and the print audit call", () => {
    const handlerStart = statementPdfFns.indexOf(".handler(async");
    const body = statementPdfFns.slice(handlerStart);
    expect(body).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
  });

  it("logs the print only after the PDF bytes are actually built", () => {
    expect(statementPdfFns.indexOf("await buildStatementPdf(")).toBeLessThan(
      statementPdfFns.indexOf("await logStatementPrint("),
    );
  });

  it("uses captureAuditEvent (audit_capture), not admin_log, because admin_log's hardcoded role check excludes 'accountant' — a core AP role", () => {
    expect(statementPdfFns).toContain("captureAuditEvent(");
    expect(statementPdfFns).not.toContain('rpc("admin_log"');
    expect(auditServer).toContain('rpc("audit_capture"');
  });

  it("reuses the existing pdf-lib-based renderer rather than a second PDF framework or any AP-specific changes to it", () => {
    expect(statementPdfFns).toContain('import("@/lib/admin/pdf-render.server")');
    expect(pdfRenderServer).toContain("export async function buildStatementPdf");
  });

  it("never combines multiple currencies into one PDF total — one section per currency, each with its own opening/closing balance line (shared, unmodified renderer)", () => {
    const statementFnBody = pdfRenderServer.slice(
      pdfRenderServer.indexOf("export async function buildStatementPdf"),
    );
    expect(statementFnBody).toContain("for (const section of data.sections)");
    expect(statementFnBody).toContain("`Currency: ${section.currency}`");
  });
});

describe("AP supplier statement — UI", () => {
  it("AG. the actual production Suppliers surface (Inventory Settings -> SuppliersTab), not a new duplicate page, contains the Statement entry point", () => {
    expect(settingsPage).toContain("ApSupplierStatementView");
    expect(settingsPage).toContain("Statement");
    expect(settingsPage).toContain('createFileRoute("/_authenticated/inventory/settings")');
  });

  it("does not add a second, duplicate supplier list/CRUD surface inside the Accounting Payables page", () => {
    expect(apPage).not.toContain("ApSupplierStatementView");
    // "New supplier bill" (the existing bill-creation dialog title) is fine —
    // what must not exist is a standalone supplier create/edit/list surface.
    expect(apPage).not.toMatch(/New supplier(?! bill)\b/);
    expect(apPage).not.toContain("SupplierDialog");
  });

  it("statement calculations happen server-side — the component only ever calls the server function, never fetches raw bill/payment tables directly", () => {
    expect(statementView).toContain("getApSupplierStatement");
    expect(statementView).not.toMatch(/\.from\(["'](ap_bills|ap_payments|suppliers)["']\)/);
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

  it("does not expose internal UUIDs as the primary supplier identifier — displays name, not id (suppliers has no account_code column)", () => {
    expect(statementView).toContain("supplier.name");
    expect(statementView).not.toMatch(/\{supplier\.id\}/);
  });

  it("CSV export re-serializes the already-fetched, server-authoritative statement data — it does not call any server function of its own", () => {
    const csvFn = statementView.match(/function exportApStatementCsv\([\s\S]*?\n\}/)?.[0];
    expect(csvFn).toBeDefined();
    expect(csvFn).not.toMatch(/statementFn\(|printFn\(|await /);
  });

  it("supports the empty state — no activity in the period renders a clear message rather than nothing", () => {
    expect(statementView).toContain("No AP activity for this supplier in the selected period.");
  });
});

describe("AP supplier statement — no automatic name inference anywhere in this feature", () => {
  it("the statement pipeline never joins or filters by supplier_name/contact_name for identity purposes", () => {
    for (const source of [statementFns, statementCalc, statementPdfFns]) {
      expect(source).not.toMatch(/supplier_name/);
    }
  });
});
