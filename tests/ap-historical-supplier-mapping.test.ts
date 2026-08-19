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
  path.join(root, "supabase/migrations/20260818110000_ap_supplier_identity_foundation.sql"),
);
const apFoundationMigration = read(
  path.join(root, "supabase/migrations/20260705040642_e2695ffa-2a90-4433-bfeb-059363c7aa85.sql"),
);
const paymentIntegrityMigration = read(
  path.join(root, "supabase/migrations/20260807120000_ar_ap_payment_integrity.sql"),
);
const functions = read(path.join(root, "src/lib/accounting/ap-bill-mapping.functions.ts"));
const mappingUi = read(path.join(root, "src/components/accounting/ap-historical-bill-mapping.tsx"));
const apPage = read(path.join(root, "src/routes/_authenticated/accounting.ap.tsx"));
const permissions = read(path.join(root, "src/lib/accounting/permissions.ts"));

function fn(source: string, name: string): string {
  const match = source.match(
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\$\\$;`),
  )?.[0];
  if (!match) throw new Error(`Could not find function ${name} in source`);
  return match;
}

describe("AP supplier identity foundation — architecture finding", () => {
  it("confirms suppliers and ap_bills.supplier_id already existed before this PR — this is not a from-scratch identity model like AR's ar_customers", () => {
    expect(apFoundationMigration).toContain("CREATE TABLE public.ap_bills");
    expect(apFoundationMigration).toContain("supplier_id UUID REFERENCES public.suppliers(id)");
  });

  it("adds no new table and no new column — only the one index the mapping list needs and the one mapping RPC", () => {
    expect(migration).not.toMatch(/CREATE TABLE|ALTER TABLE.*ADD COLUMN/i);
    expect(migration).toContain("CREATE INDEX ap_bills_property_supplier");
  });

  it("does not reach into ap_payments at all — that index/lookup belongs to the follow-on statements PR, not this identity foundation (the header comment's prose explaining the split is fine; no executable SQL referencing ap_payments)", () => {
    expect(migration).not.toMatch(/CREATE INDEX[^;]*ap_payments|public\.ap_payments\b/);
  });

  it("does not edit the historical AP/payment-integrity migrations", () => {
    expect(apFoundationMigration).not.toContain("assign_ap_bill_supplier");
    expect(paymentIntegrityMigration).not.toContain("assign_ap_bill_supplier");
  });
});

describe("Historical AP supplier mapping — RPC security", () => {
  it("is SECURITY DEFINER with search_path pinned", () => {
    const body = fn(migration, "assign_ap_bill_supplier");
    expect(body).toContain("LANGUAGE plpgsql SECURITY DEFINER SET search_path=public");
  });

  it("checks role/property authorization internally, using the exact AP-admin role set post_ap_bill/post_ap_payment already require (no front_desk)", () => {
    const body = fn(migration, "assign_ap_bill_supplier");
    expect(body).toContain(
      "public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id)",
    );
    expect(body).toContain("Not permitted to assign AP suppliers");
  });

  it("revokes PUBLIC and anon execution", () => {
    expect(migration).toContain(
      "REVOKE EXECUTE ON FUNCTION public.assign_ap_bill_supplier(uuid, uuid, uuid) FROM PUBLIC, anon;",
    );
  });

  it("grants execution to authenticated only", () => {
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.assign_ap_bill_supplier(uuid, uuid, uuid) TO authenticated;",
    );
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.assign_ap_bill_supplier\([^;]*\) TO anon/,
    );
  });

  it("does not swallow failures with a catch-all handler", () => {
    const body = fn(migration, "assign_ap_bill_supplier");
    expect(body).not.toMatch(/WHEN\s+OTHERS/);
  });
});

describe("Historical AP supplier mapping — assignment validation", () => {
  const body = fn(migration, "assign_ap_bill_supplier");

  it("rejects a missing/cross-property bill", () => {
    expect(body).toContain("WHERE id = _bill_id AND property_id = _property_id FOR UPDATE");
    expect(body).toContain("Bill not found for this property");
  });

  it("rejects a missing/cross-property supplier", () => {
    expect(body).toContain("WHERE id = _supplier_id AND property_id = _property_id");
    expect(body).toContain("Supplier not found for this property");
  });

  it("rejects an inactive supplier", () => {
    expect(body).toContain("IF NOT _supplier.active THEN");
    expect(body).toContain("Inactive suppliers cannot be assigned to bills");
  });

  it("rejects an already-mapped bill — no reassignment in this version", () => {
    expect(body).toContain(
      "WHERE id = _bill_id AND property_id = _property_id AND supplier_id IS NULL",
    );
    expect(body).toContain("Bill already has an assigned supplier");
  });

  it("protects concurrent double-assignment with a row lock ahead of the guarded UPDATE", () => {
    expect(body).toMatch(/FOR UPDATE[\s\S]*supplier_id IS NULL/);
  });

  it("only ever sets supplier_id — no other column is written", () => {
    const setClauses = body.match(/UPDATE public\.ap_bills\s+SET[\s\S]*?WHERE/)?.[0] ?? "";
    expect(setClauses).toContain("SET supplier_id = _supplier_id");
    expect(setClauses).not.toMatch(
      /supplier_name|bill_date|due_date|total|subtotal|tax|status|posted_entry_id/,
    );
  });

  it("does not reference any other table — no journals, postings, or payments touched", () => {
    expect(body).not.toMatch(
      /journal_entries|journal_lines|post_journal|ap_payments|posted_entry_id/,
    );
  });
});

describe("Historical AP supplier mapping — no automatic inference", () => {
  it("the assignment RPC contains no fuzzy/automatic name-matching logic (ILIKE/similarity/levenshtein) — it only ever assigns the exact supplier id a caller names", () => {
    const body = fn(migration, "assign_ap_bill_supplier");
    expect(body).not.toMatch(/ILIKE|similarity\(|levenshtein/i);
  });

  it("the RPC's only reference to supplier_name is the comment documenting that it is deliberately NOT written", () => {
    const body = fn(migration, "assign_ap_bill_supplier");
    const mentions = body.match(/supplier_name/gi) ?? [];
    expect(mentions.length).toBeLessThanOrEqual(1);
  });

  it("the UI never auto-saves a suggestion — assignment always requires an explicit user click", () => {
    expect(mappingUi).not.toMatch(/auto.?assign|auto.?map|fuzzy|similarity|levenshtein/i);
    expect(mappingUi).toContain("Confirm assignment");
    expect(mappingUi).toContain("disabled={!selectedSupplierId || assign.isPending}");
  });

  it("ships no bulk/heuristic mapping action", () => {
    expect(mappingUi).not.toMatch(/map all|bulk|select all/i);
    expect(functions).not.toMatch(/bulkAssign|mapAll/i);
  });
});

describe("Historical AP supplier mapping — server function layer", () => {
  it("lists bills unmapped-only by default, bounded and paginated", () => {
    expect(functions).toContain("export const listUnmappedApBills");
    expect(functions).toContain("unmappedOnly: d.unmappedOnly !== false");
    expect(functions).toContain('if (data.unmappedOnly) query = query.is("supplier_id", null)');
    expect(functions).toContain("pageRange(data.page, data.pageSize)");
    expect(functions).toContain('{ count: "exact" }');
    expect(functions).toContain(".range(from, to)");
  });

  it("scopes the list query to the requested property", () => {
    expect(functions).toContain('.eq("property_id", data.propertyId)');
  });

  it("supports the required review filters", () => {
    for (const filter of ["code", "supplierName", "from", "to", "currency", "status"]) {
      expect(functions).toContain(filter);
    }
  });

  it("viewing (list bills, list suppliers) requires AP view access; assigning requires the AP manage capability", () => {
    expect(functions).toContain("AP_PERMISSIONS.suppliersView");
    expect(functions).toContain("AP_PERMISSIONS.billsMapSupplier");
    expect(permissions).toContain(
      'billsMapSupplier: { module: "accounts_payable", capability: "manage_settings" }',
    );
  });

  it("calls the atomic assignment RPC rather than a direct table update", () => {
    expect(functions).toContain('supabase.rpc("assign_ap_bill_supplier"');
    expect(functions).not.toMatch(/\.from\("ap_bills"\)\s*\.update\(\{\s*supplier_id/);
  });

  it("captures an audit event only after the RPC succeeds", () => {
    const handlerStart = functions.indexOf("export const assignApBillSupplier");
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    const rpcErrorCheck = functions.indexOf("if (rpcResult.error) throw", handlerStart);
    const auditCall = functions.indexOf("captureAuditEvent", handlerStart);
    expect(rpcErrorCheck).toBeGreaterThan(handlerStart);
    expect(auditCall).toBeGreaterThan(rpcErrorCheck);
  });

  it("audits the property, bill id/code, old/new supplier identity — no free-text supplier_name PII beyond the resolved supplier's own name", () => {
    expect(functions).toContain('action: "ap_bill.supplier_mapped"');
    expect(functions).toContain('resourceType: "ap_bill"');
    expect(functions).toContain("resourceId: data.billId");
    expect(functions).toContain("oldValues: { supplierId: null }");
    expect(functions).toContain("supplierId: data.supplierId");
  });

  it("re-fetches the bill code and supplier name server-side rather than trusting client display data", () => {
    expect(functions).toContain('.from("ap_bills")\n        .select("id,code")');
    expect(functions).toContain('.from("suppliers")\n        .select("name")');
  });

  it("only offers active suppliers in the picker", () => {
    expect(functions).toContain('.eq("active", true)');
  });
});

describe("Historical AP supplier mapping — UI", () => {
  it("adds a clearly-labelled entry point inside the AP workspace, not a new page", () => {
    expect(apPage).toContain("Map historical bills");
    expect(apPage).toContain("ApHistoricalBillMapping");
    expect(apPage).toContain('createFileRoute("/_authenticated/accounting/ap")');
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

  it("shows the selected supplier's name, email, and active status before confirming", () => {
    expect(mappingUi).toContain("chosenSupplier.name");
    expect(mappingUi).toContain("chosenSupplier.active");
  });

  it("disables the assign action for a row that is already mapped", () => {
    expect(mappingUi).toContain("disabled={!!bill.supplier_id}");
  });

  it("refreshes the list on a conflict instead of leaving a stale row", () => {
    expect(mappingUi).toContain("onError: (error: Error) => {");
    expect(mappingUi).toContain("list.refetch()");
  });

  it("fixes the pre-existing bill-creation bug: the supplier <Select> now sets supplier_id (an id), not just supplier_name", () => {
    expect(apPage).toContain('value={form.supplier_id ?? ""}');
    expect(apPage).toContain('setForm({ ...form, supplier_id: id, supplier_name: s?.name ?? "" })');
  });

  it("the free-text fallback (no suppliers on file) explicitly clears supplier_id rather than leaving it stale", () => {
    expect(apPage).toContain(
      "setForm({ ...form, supplier_id: null, supplier_name: e.target.value })",
    );
  });

  it("does not change how existing bills render in the main list", () => {
    expect(apPage).toContain("{b.supplier_name}");
  });
});
