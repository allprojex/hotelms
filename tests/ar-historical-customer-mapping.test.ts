import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
// Normalizes CRLF -> LF so literal multi-line `.toContain()` assertions
// below don't depend on the working tree's checkout line-ending state
// (git's core.autocrlf can rewrite tracked/restored files to CRLF on
// Windows).
function read(filePath: string): string {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}
const migration = read(
  path.join(root, "supabase/migrations/20260813180000_ar_historical_customer_mapping.sql"),
);
const foundationMigration = read(
  path.join(root, "supabase/migrations/20260812120000_ar_customer_account_foundation.sql"),
);
const hardeningMigration = read(
  path.join(root, "supabase/migrations/20260812130000_ar_customer_function_acl_hardening.sql"),
);
const functions = read(
  path.join(root, "src/lib/accounting/ar-invoice-mapping.functions.ts"),
);
const mappingUi = read(
  path.join(root, "src/components/accounting/ar-historical-invoice-mapping.tsx"),
);
const arPage = read(
  path.join(root, "src/routes/_authenticated/accounting.ar.tsx"),
);
const permissions = read(
  path.join(root, "src/lib/accounting/permissions.ts"),
);

function fn(source: string, name: string): string {
  const match = source.match(
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\$\\$;`),
  )?.[0];
  if (!match) throw new Error(`Could not find function ${name} in source`);
  return match;
}

describe("Historical AR customer mapping — migration scope", () => {
  it("adds exactly one new function and does not edit the PR #23/#24 migrations", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.assign_ar_invoice_customer(");
    expect(foundationMigration).not.toContain("assign_ar_invoice_customer");
    expect(hardeningMigration).not.toContain("assign_ar_invoice_customer");
  });

  it("touches no table, column, RLS policy, or unrelated grant", () => {
    expect(migration).not.toMatch(/CREATE TABLE|ALTER TABLE|CREATE POLICY|DROP POLICY|CREATE INDEX/i);
    const grants = migration.match(/^(GRANT|REVOKE)[\s\S]*?;$/gm) ?? [];
    for (const line of grants) expect(line).toContain("assign_ar_invoice_customer");
  });
});

describe("Historical AR customer mapping — RPC security", () => {
  it("is SECURITY DEFINER with search_path pinned", () => {
    const body = fn(migration, "assign_ar_invoice_customer");
    expect(body).toContain("LANGUAGE plpgsql SECURITY DEFINER SET search_path=public");
  });

  it("checks role/property authorization internally, matching the other AR RPCs", () => {
    const body = fn(migration, "assign_ar_invoice_customer");
    expect(body).toContain(
      "public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant','front_desk']::app_role[], _property_id)",
    );
    expect(body).toContain("Not permitted to assign AR customers");
  });

  it("revokes PUBLIC and anon execution, matching the 20260812130000 hardening convention", () => {
    expect(migration).toContain(
      "REVOKE EXECUTE ON FUNCTION public.assign_ar_invoice_customer(uuid, uuid, uuid) FROM PUBLIC, anon;",
    );
  });

  it("grants execution to authenticated only", () => {
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.assign_ar_invoice_customer(uuid, uuid, uuid) TO authenticated;",
    );
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.assign_ar_invoice_customer\([^;]*\) TO anon/,
    );
  });

  it("does not swallow failures with a catch-all handler", () => {
    const body = fn(migration, "assign_ar_invoice_customer");
    expect(body).not.toMatch(/WHEN\s+OTHERS/);
  });
});

describe("Historical AR customer mapping — assignment validation", () => {
  const body = fn(migration, "assign_ar_invoice_customer");

  it("rejects a missing/cross-property invoice", () => {
    expect(body).toContain("WHERE id = _invoice_id AND property_id = _property_id FOR UPDATE");
    expect(body).toContain("Invoice not found for this property");
  });

  it("rejects a missing/cross-property customer", () => {
    expect(body).toContain("WHERE id = _customer_id AND property_id = _property_id");
    expect(body).toContain("AR customer not found for this property");
  });

  it("rejects an inactive customer", () => {
    expect(body).toContain("IF NOT _customer.active THEN");
    expect(body).toContain("Inactive AR customers cannot be assigned to invoices");
  });

  it("rejects an already-mapped invoice — no reassignment in this version", () => {
    expect(body).toContain(
      "WHERE id = _invoice_id AND property_id = _property_id AND customer_id IS NULL",
    );
    expect(body).toContain("Invoice already has an assigned customer");
  });

  it("protects concurrent double-assignment with a row lock ahead of the guarded UPDATE", () => {
    expect(body).toMatch(/FOR UPDATE[\s\S]*customer_id IS NULL/);
  });

  it("only ever sets customer_id — no other column is written", () => {
    const setClauses = body.match(/UPDATE public\.ar_invoices\s+SET[\s\S]*?WHERE/)?.[0] ?? "";
    expect(setClauses).toContain("SET customer_id = _customer_id");
    expect(setClauses).not.toMatch(/bill_to_name|bill_to_email|bill_to_address|issue_date|due_date|total|subtotal|tax|status|posted_entry_id/);
  });

  it("does not reference any other table — no journals, postings, or allocations touched", () => {
    expect(body).not.toMatch(/journal_entries|journal_lines|post_journal|ar_receipt_allocations|posted_entry_id/);
  });
});

describe("Historical AR customer mapping — no automatic inference", () => {
  it("the assignment RPC contains no name/email/phone/reservation matching logic", () => {
    const body = fn(migration, "assign_ar_invoice_customer");
    expect(body).not.toMatch(/bill_to_name|bill_to_email|bill_to_address|reservation_id/i);
  });

  it("the migration as a whole never joins bill_to_* or reservation_id against customer identity", () => {
    expect(migration).not.toMatch(/bill_to_(name|email|address)[\s\S]*customer_id/i);
    expect(migration).not.toMatch(/reservation_id[\s\S]*customer_id/i);
  });

  it("the UI never auto-saves a suggestion — assignment always requires an explicit user click", () => {
    expect(mappingUi).not.toMatch(/auto.?assign|auto.?map|fuzzy|similarity|levenshtein/i);
    expect(mappingUi).toContain("Confirm assignment");
    expect(mappingUi).toContain("disabled={!selectedCustomerId || assign.isPending}");
  });

  it("ships no bulk/heuristic mapping action", () => {
    expect(mappingUi).not.toMatch(/map all|bulk|select all/i);
    expect(functions).not.toMatch(/bulkAssign|mapAll/i);
  });
});

describe("Historical AR customer mapping — server function layer", () => {
  it("lists invoices unmapped-only by default, bounded and paginated", () => {
    expect(functions).toContain("export const listUnmappedArInvoices");
    expect(functions).toContain("unmappedOnly: d.unmappedOnly !== false");
    expect(functions).toContain('if (data.unmappedOnly) query = query.is("customer_id", null)');
    expect(functions).toContain("pageRange(data.page, data.pageSize)");
    expect(functions).toContain('{ count: "exact" }');
    expect(functions).toContain(".range(from, to)");
  });

  it("scopes the list query to the requested property", () => {
    expect(functions).toContain('.eq("property_id", data.propertyId)');
  });

  it("supports the required review filters", () => {
    for (const filter of ["code", "billToName", "billToEmail", "from", "to", "currency", "status"]) {
      expect(functions).toContain(filter);
    }
  });

  it("selects the read-only snapshot columns the reviewer needs, including reservation_id", () => {
    expect(functions).toContain(
      "id,code,issue_date,due_date,bill_to_name,bill_to_email,bill_to_address,currency,total,status,reservation_id,customer_id",
    );
  });

  it("viewing requires AR view access; assigning requires the AR manage capability", () => {
    expect(functions).toContain("AR_PERMISSIONS.customersView");
    expect(functions).toContain("AR_PERMISSIONS.invoicesMapCustomer");
    expect(permissions).toContain(
      "invoicesMapCustomer: { module: \"accounts_receivable\", capability: \"manage_settings\" }",
    );
  });

  it("calls the atomic assignment RPC rather than a direct table update", () => {
    expect(functions).toContain('supabase.rpc("assign_ar_invoice_customer"');
    expect(functions).not.toMatch(/\.from\("ar_invoices"\)\s*\.update\(\{\s*customer_id/);
  });

  it("captures an audit event only after the RPC succeeds", () => {
    const handlerStart = functions.indexOf("export const assignArInvoiceCustomer");
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    const rpcErrorCheck = functions.indexOf("if (rpcResult.error) throw", handlerStart);
    const auditCall = functions.indexOf("captureAuditEvent", handlerStart);
    expect(rpcErrorCheck).toBeGreaterThan(handlerStart);
    expect(auditCall).toBeGreaterThan(rpcErrorCheck);
  });

  it("audits the property, invoice id/code, old/new customer identity, and account code — no bill_to_* PII", () => {
    expect(functions).toContain('action: "ar_invoice.customer_mapped"');
    expect(functions).toContain('resourceType: "ar_invoice"');
    expect(functions).toContain("resourceId: data.invoiceId");
    expect(functions).toContain("oldValues: { customerId: null }");
    expect(functions).toContain("customerId: data.customerId");
    expect(functions).toContain("customerAccountCode: customer?.account_code");
    expect(functions).not.toMatch(/newValues:\s*\{[^}]*bill_to/);
  });

  it("re-fetches the invoice code and customer account code server-side rather than trusting client display data", () => {
    expect(functions).toContain('.from("ar_invoices")\n        .select("id,code")');
    expect(functions).toContain('.from("ar_customers")\n        .select("account_code,name")');
  });
});

describe("Historical AR customer mapping — UI", () => {
  it("adds a clearly-labelled entry point inside the AR workspace, not a new page", () => {
    expect(arPage).toContain("Map historical invoices");
    expect(arPage).toContain("ArHistoricalInvoiceMapping");
    expect(arPage).toContain('createFileRoute("/_authenticated/accounting/ar")');
  });

  it("defaults to unmapped-only review", () => {
    expect(mappingUi).toContain("useState(true)");
    expect(mappingUi).toContain("unmappedOnly");
  });

  it("shows pagination controls rather than loading the whole table", () => {
    expect(mappingUi).toContain("totalPages(total, PAGE_SIZE)");
    expect(mappingUi).toContain("Previous");
    expect(mappingUi).toContain("Next");
  });

  it("shows the selected customer's account code, name, email, and active status before confirming", () => {
    expect(mappingUi).toContain("chosenCustomer.account_code");
    expect(mappingUi).toContain("chosenCustomer.name");
    expect(mappingUi).toContain("chosenCustomer.email");
    expect(mappingUi).toContain("chosenCustomer.active");
  });

  it("only offers active customers in the assignment picker", () => {
    // listArCustomers defaults includeInactive to false; the mapping picker
    // calls it with only { propertyId }, matching that default.
    expect(mappingUi).toContain("customersFn({ data: { propertyId } })");
  });

  it("disables the assign action for a row that is already mapped", () => {
    expect(mappingUi).toContain("disabled={!!invoice.customer_id}");
  });

  it("refreshes the list on a conflict instead of leaving a stale row", () => {
    expect(mappingUi).toContain("onError: (error: Error) => {");
    expect(mappingUi).toContain("list.refetch()");
  });

  it("does not alter the existing new-invoice creation flow", () => {
    expect(arPage).toContain('if (!customerId) throw new Error("Select an AR customer")');
    expect(arPage).toContain("createInvoiceFn");
  });

  it("does not change how existing invoices render in the main list", () => {
    expect(arPage).toContain("{i.bill_to_name}");
  });
});
