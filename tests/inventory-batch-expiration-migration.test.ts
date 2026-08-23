import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Source-level checks on the migration itself, mirroring the established
// convention in this repo (see tests/reservation-payment-*.test.ts) for
// pinning safety-critical SQL properties that live-database validation
// (run manually against a local disposable Postgres, see the PR
// description) already confirmed behaviorally.

const migration = readFileSync(
  resolve(__dirname, "../supabase/migrations/20260823130000_inventory_batch_expiration.sql"),
  "utf8",
);

describe("inventory_stock_batches — schema", () => {
  it("creates the table with item/property/location/quantity/received_date/expiry_date/source columns", () => {
    expect(migration).toContain("CREATE TABLE public.inventory_stock_batches");
    expect(migration).toMatch(/property_id UUID NOT NULL REFERENCES public\.properties\(id\)/);
    expect(migration).toMatch(/item_id UUID NOT NULL REFERENCES public\.inventory_items\(id\)/);
    expect(migration).toMatch(/location_id UUID NOT NULL REFERENCES public\.stock_locations\(id\)/);
    expect(migration).toMatch(
      /received_quantity NUMERIC\(14,3\) NOT NULL CHECK \(received_quantity > 0\)/,
    );
    expect(migration).toMatch(/received_date DATE NOT NULL DEFAULT CURRENT_DATE/);
    expect(migration).toMatch(/^\s*expiry_date DATE,?\s*$/m);
    expect(migration).toContain("source_po_id UUID REFERENCES public.purchase_orders(id)");
    expect(migration).toContain(
      "source_po_line_id UUID REFERENCES public.purchase_order_lines(id)",
    );
  });

  it("does NOT add expiry_date directly to inventory_items (would collapse multiple batches to one date)", () => {
    expect(migration).not.toMatch(/ALTER TABLE public\.inventory_items[\s\S]{0,200}expiry/i);
  });

  it("regression: no 'expiry_date >= received_date' CONSTRAINT exists (comments explaining its deliberate absence are fine)", () => {
    // A live-database test caught this: the naive version of this
    // constraint incorrectly rejected recording an already-expired
    // product on receipt, contradicting the documented "allow + warn"
    // decision (Phase 5). Checked against actual CHECK/IF code shapes,
    // not bare substrings -- this file's own comments legitimately
    // mention the phrase while explaining that it was removed.
    expect(migration).not.toMatch(/CHECK\s*\(expiry_date[\s\S]{0,10}received_date\)/);
    expect(migration).not.toMatch(/IF\s+_expiry_date[\s\S]{0,10}<\s*b\.received_date THEN/);
  });

  it("does not create a duplicate source of truth for quantity: item_stock/apply_stock_delta are never touched", () => {
    expect(migration).not.toMatch(/ALTER TABLE public\.item_stock/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.apply_stock_delta/);
  });

  it("has no accounting/journal linkage (inventory has zero GL impact in this schema, confirmed by audit)", () => {
    expect(migration).not.toMatch(/journal_entries|journal_lines|post_journal/);
  });
});

describe("inventory_stock_batches — RLS and grants (RPC-only mutation)", () => {
  it("grants SELECT only to authenticated -- no direct INSERT/UPDATE/DELETE", () => {
    expect(migration).toContain("GRANT SELECT ON public.inventory_stock_batches TO authenticated;");
    expect(migration).not.toMatch(
      /GRANT[^;]*INSERT[^;]*ON public\.inventory_stock_batches TO authenticated/,
    );
    expect(migration).not.toMatch(
      /GRANT[^;]*UPDATE[^;]*ON public\.inventory_stock_batches TO authenticated/,
    );
    expect(migration).not.toMatch(
      /GRANT[^;]*DELETE[^;]*ON public\.inventory_stock_batches TO authenticated/,
    );
  });

  it("has a property-scoped read policy", () => {
    expect(migration).toMatch(
      /CREATE POLICY inv_stock_batches_read ON public\.inventory_stock_batches FOR SELECT TO authenticated\s*\n\s*USING \(public\.can_access_property\(auth\.uid\(\), property_id\)\)/,
    );
  });
});

describe("receive_purchase_order — extended, backward compatible", () => {
  it("drops the old 1-arg overload before creating the 2-arg version (avoids ambiguous-call errors)", () => {
    const dropIdx = migration.indexOf(
      "DROP FUNCTION IF EXISTS public.receive_purchase_order(UUID);",
    );
    const createIdx = migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.receive_purchase_order(_po_id UUID, _line_expiry JSONB DEFAULT NULL)",
    );
    expect(dropIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(dropIdx);
  });

  it("the new parameter defaults to NULL, so existing single-argument callers are unaffected", () => {
    expect(migration).toContain("_line_expiry JSONB DEFAULT NULL");
  });

  it("preserves the exact pre-existing manager-only role check and PO/location guards", () => {
    expect(migration).toMatch(
      /IF NOT public\.has_any_role\(auth\.uid\(\), ARRAY\['super_admin','hotel_owner','general_manager'\]::app_role\[\], p\.property_id\) THEN\s*\n\s*RAISE EXCEPTION 'Not permitted';/,
    );
    expect(migration).toContain("RAISE EXCEPTION 'PO not found'");
    expect(migration).toContain("RAISE EXCEPTION 'PO has no destination location'");
  });

  it("still calls apply_stock_delta with the same arguments as before this migration (item_stock logic unchanged)", () => {
    expect(migration).toMatch(
      /PERFORM public\.apply_stock_delta\(p\.property_id, r\.item_id, p\.location_id, _received\)/,
    );
  });

  it("creates a batch row for every received line, with a NULL expiry when none was supplied for that line", () => {
    expect(migration).toContain("INSERT INTO public.inventory_stock_batches(");
    expect(migration).toMatch(/_expiry := NULL;/);
  });

  it("invalid expiry input raises a clear error naming the offending line, inside an exception handler", () => {
    expect(migration).toMatch(
      /EXCEPTION WHEN OTHERS THEN\s*\n\s*RAISE EXCEPTION 'Invalid expiry date for purchase order line/,
    );
  });

  it("still marks the PO received and sets received_at exactly as before", () => {
    expect(migration).toContain(
      "UPDATE public.purchase_orders SET status = 'received', received_at = now() WHERE id = _po_id;",
    );
  });
});

describe("update_batch_expiry — expiry-only mutation", () => {
  it("exists as a SECURITY DEFINER function with its own permission check", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION public.update_batch_expiry(_batch_id UUID, _expiry_date DATE)",
    );
    expect(migration).toContain("SECURITY DEFINER");
  });

  it("uses the broader operational role set (matches item_stock's write policy), not the stricter inventory_items manager-only set", () => {
    expect(migration).toMatch(
      /update_batch_expiry[\s\S]{0,400}ARRAY\['super_admin','hotel_owner','general_manager','front_desk','cashier','housekeeping_supervisor'\]::app_role\[\]/,
    );
  });

  it("the UPDATE statement touches ONLY expiry_date and updated_at -- never quantity, item, location, or cost", () => {
    const updateMatch = migration.match(
      /UPDATE public\.inventory_stock_batches\s*\n\s*SET ([^;]+);/,
    );
    expect(updateMatch).not.toBeNull();
    const setClause = updateMatch![1];
    expect(setClause).toMatch(/expiry_date = _expiry_date/);
    expect(setClause).toMatch(/updated_at = now\(\)/);
    expect(setClause).not.toMatch(/received_quantity/);
    expect(setClause).not.toMatch(/item_id/);
    expect(setClause).not.toMatch(/location_id/);
    expect(setClause).not.toMatch(/cost/);
  });

  it("never touches item_stock or any inventory_items column", () => {
    const fnStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.update_batch_expiry");
    const fnEnd = migration.indexOf("$$;", fnStart);
    const fnBody = migration.slice(fnStart, fnEnd);
    expect(fnBody).not.toMatch(/item_stock/);
    expect(fnBody).not.toMatch(/inventory_items/);
  });
});

describe("properties.inventory_expiry_warning_days — configurable threshold, not hardcoded", () => {
  it("adds a nullable-with-default column rather than a new table (smallest safe extension)", () => {
    expect(migration).toMatch(
      /ALTER TABLE public\.properties\s*\n\s*ADD COLUMN IF NOT EXISTS inventory_expiry_warning_days INTEGER NOT NULL DEFAULT 30/,
    );
    expect(migration).toContain("CHECK (inventory_expiry_warning_days > 0)");
  });
});
