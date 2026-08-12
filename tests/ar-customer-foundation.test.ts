import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const migration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260812120000_ar_customer_account_foundation.sql"),
  "utf8",
);
const functions = fs.readFileSync(
  path.join(root, "src/lib/accounting/ar-customers.functions.ts"),
  "utf8",
);
const arPage = fs.readFileSync(
  path.join(root, "src/routes/_authenticated/accounting.ar.tsx"),
  "utf8",
);
const customerManager = fs.readFileSync(
  path.join(root, "src/components/accounting/ar-customer-manager.tsx"),
  "utf8",
);
const originalArMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260705040642_e2695ffa-2a90-4433-bfeb-059363c7aa85.sql"),
  "utf8",
);
const receiptMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260807120000_ar_ap_payment_integrity.sql"),
  "utf8",
);
const schemaOnly = migration.split("CREATE OR REPLACE FUNCTION public.create_ar_invoice")[0];

describe("AR customer account foundation", () => {
  it("creates the property-scoped customer master with focused contact fields", () => {
    expect(migration).toContain("CREATE TABLE public.ar_customers");
    for (const column of [
      "property_id UUID",
      "account_code TEXT",
      "name TEXT",
      "email TEXT",
      "phone TEXT",
      "address TEXT",
      "active BOOLEAN",
    ]) {
      expect(migration).toContain(column);
    }
  });

  it("enforces property-scoped account-code uniqueness", () => {
    expect(migration).toContain(
      "ar_customers_property_account_code_uniq UNIQUE (property_id, account_code)",
    );
  });

  it("provides the composite customer key required by tenant-safe foreign keys", () => {
    expect(migration).toContain("ar_customers_property_id_uniq UNIQUE (property_id, id)");
  });

  it("generates a stable human-readable AR account code when omitted", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.gen_ar_customer_code()");
    expect(migration).toContain("'AR-' || upper(substr(replace(NEW.id::text, '-', ''), 1, 10))");
  });

  it("adds customer_id as nullable for historical compatibility", () => {
    expect(migration).toContain("ALTER TABLE public.ar_invoices ADD COLUMN customer_id UUID;");
    expect(migration).not.toMatch(/customer_id UUID NOT NULL/);
    expect(migration).not.toMatch(/customer_id[\s\S]{0,80}SET NOT NULL/);
  });

  it("prevents cross-property invoice/customer links", () => {
    expect(migration).toContain("FOREIGN KEY (property_id, customer_id)");
    expect(migration).toContain("REFERENCES public.ar_customers(property_id, id)");
  });

  it("indexes customer lookups without changing historical migrations", () => {
    expect(migration).toContain("ar_customers_property_active_name");
    expect(migration).toContain("ar_invoices_property_customer");
    expect(originalArMigration).not.toContain("customer_id");
    expect(receiptMigration).not.toContain("ar_customers");
  });

  it("applies property-isolated RLS using the existing AR role set", () => {
    expect(migration).toContain("ALTER TABLE public.ar_customers ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("public.can_access_property(auth.uid(), property_id)");
    expect(migration).toContain("'accountant','front_desk'");
  });

  it("does not grant customer deletion to authenticated users", () => {
    expect(migration).toContain(
      "GRANT SELECT, INSERT, UPDATE ON public.ar_customers TO authenticated;",
    );
    expect(migration).not.toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON public.ar_customers");
  });

  it("does not auto-map historical invoices by personal data or reservation", () => {
    expect(schemaOnly).not.toMatch(/UPDATE\s+public\.ar_invoices/i);
    expect(schemaOnly).not.toMatch(/bill_to_(name|email|address)[\s\S]*customer_id/i);
    expect(schemaOnly).not.toMatch(/reservation_id[\s\S]*customer_id/i);
  });

  it("requires a customer for the new-invoice application path", () => {
    expect(functions).toContain("customerId: uuid(d.customerId)");
    expect(arPage).toContain('if (!customerId) throw new Error("Select an AR customer")');
    expect(arPage).toContain("disabled={create.isPending || !customerId}");
  });

  it("validates the customer belongs to the selected property on the server", () => {
    expect(migration).toContain("WHERE id = _customer_id AND property_id = _property_id");
    expect(migration).toContain("AR customer not found for this property");
  });

  it("rejects inactive customers for new invoices", () => {
    expect(migration).toContain("Inactive AR customers cannot be used for new invoices");
  });

  it("stores customer_id and copies customer master values into invoice snapshots", () => {
    expect(migration).toContain("property_id, customer_id, code, bill_to_name, bill_to_email");
    expect(migration).toContain("_property_id, _customer.id, '', _customer.name, _customer.email");
    expect(migration).toContain("_customer.address");
  });

  it("keeps invoice snapshots read-only in the new invoice UI", () => {
    expect(arPage).toContain("<Label>Bill-to snapshot</Label><Input readOnly");
    expect(arPage).toContain("<Label>Email snapshot</Label><Input readOnly");
    expect(arPage).toContain("<Label>Address snapshot</Label><Textarea readOnly");
  });

  it("does not dynamically join customer data for existing invoice display or PDFs", () => {
    expect(arPage).toContain("{i.bill_to_name}");
    expect(arPage).not.toContain("i.ar_customers");
  });

  it("provides list, search, create, edit, activate and deactivate behavior", () => {
    expect(functions).toContain("export const listArCustomers");
    expect(functions).toContain("export const saveArCustomer");
    expect(functions).toContain("export const setArCustomerActive");
    expect(customerManager).toContain("AR customer accounts");
    expect(customerManager).toContain('customer.active ? "Deactivate" : "Activate"');
  });

  it("audits customer create, update and status changes without contact snapshots", () => {
    for (const action of [
      "ar_customer.created",
      "ar_customer.updated",
      "ar_customer.activated",
      "ar_customer.deactivated",
    ]) {
      expect(functions).toContain(action);
    }
    expect(functions).toMatch(/newValues:\s*\{\s*account_code:/);
  });

  it("uses an atomic RPC with date, currency and line validation", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.create_ar_invoice(");
    expect(migration).toContain("Invoice dates are invalid");
    expect(migration).toContain("Currency must be a valid 3-letter code");
    expect(migration).toContain("At least one invoice line is required");
    expect(functions).toContain('.rpc("create_ar_invoice"');
    expect(migration).toContain("SET subtotal = _subtotal, tax = _tax, total = _subtotal + _tax");
  });

  it("restricts the SECURITY DEFINER invoice RPC to authenticated callers", () => {
    const signature =
      "public.create_ar_invoice(uuid, uuid, date, date, text, text, jsonb)";
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.create_ar_invoice\([\s\S]*?LANGUAGE plpgsql SECURITY DEFINER SET search_path=public/,
    );
    expect(migration).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`);
    expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO authenticated;`);
    expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.create_ar_invoice\([^;]+\) TO anon/);
    expect(migration).toContain("IF NOT public.has_any_role(auth.uid()");
    expect(migration).toContain("_property_id) THEN");
  });

  it("removes unnecessary PUBLIC execution from the trigger-only code generator", () => {
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.gen_ar_customer_code() FROM PUBLIC;",
    );
    expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.gen_ar_customer_code/);
  });

  it("leaves posting, ageing and receipt allocation logic unchanged", () => {
    expect(migration).not.toContain("post_ar_invoice");
    expect(migration).not.toContain("post_ar_receipt");
    expect(migration).not.toContain("ar_receipt_allocations");
    expect(migration).not.toContain("ar_aging");
  });
});
