import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Source-level checks on the migration itself, mirroring the established
// convention in this repo (see tests/inventory-batch-expiration-migration.test.ts)
// for pinning safety-critical SQL properties that live-database validation
// (run manually against a local disposable Postgres, see the PR
// description) already confirmed behaviorally.

const migration = readFileSync(
  resolve(__dirname, "../supabase/migrations/20260823150000_inventory_import_rpc.sql"),
  "utf8",
);

describe("import_inventory_item — purely additive, no destructive rewrite", () => {
  it("never DROPs, TRUNCATEs, or ALTERs an existing column/table other than the documented status CHECK widening", () => {
    expect(migration).not.toMatch(/DROP TABLE/i);
    expect(migration).not.toMatch(/DROP COLUMN/i);
    expect(migration).not.toMatch(/TRUNCATE/i);
    // The only DROP in this file is the named CHECK constraint being
    // replaced by a strictly wider one (adds 'processing', removes nothing).
    const drops = migration.match(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT)\b/gi) ?? [];
    expect(drops.length).toBe(1);
    expect(migration).toContain("DROP CONSTRAINT data_uploads_status_check");
  });

  it("widens data_uploads.status to add 'processing' without removing any existing allowed value", () => {
    expect(migration).toMatch(
      /CHECK \(status IN \('pending','processing','approved','rejected','imported'\)\)/,
    );
  });
});

describe("import_inventory_item — role check and property scoping", () => {
  it("requires an admin-tier role scoped to the target property before doing anything else", () => {
    expect(migration).toMatch(
      /IF NOT public\.has_any_role\(auth\.uid\(\), ARRAY\['super_admin','hotel_owner','general_manager'\]::app_role\[\], _property_id\) THEN/,
    );
  });

  it("is SECURITY DEFINER with a hardened search_path, same as every other guarded inventory RPC", () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.import_inventory_item[\s\S]{0,400}SECURITY DEFINER/);
    expect(migration).toContain("SET search_path = public");
  });

  it("grants EXECUTE only to authenticated, after revoking from PUBLIC", () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.import_inventory_item\([\s\S]{0,150}\) FROM PUBLIC/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.import_inventory_item\([\s\S]{0,150}\) TO authenticated/);
  });
});

describe("import_inventory_item — validation guards", () => {
  it("rejects blank name and blank sku", () => {
    expect(migration).toMatch(/_name IS NULL OR btrim\(_name\) = ''/);
    expect(migration).toMatch(/_sku IS NULL OR btrim\(_sku\) = ''/);
  });

  it("rejects negative cost, sale_price, reorder_level, and opening_quantity", () => {
    expect(migration).toMatch(/_cost IS NULL OR _cost < 0/);
    expect(migration).toMatch(/_sale_price IS NULL OR _sale_price < 0/);
    expect(migration).toMatch(/_reorder_level IS NULL OR _reorder_level < 0/);
    expect(migration).toMatch(/_opening_quantity IS NOT NULL AND _opening_quantity < 0/);
  });

  it("never auto-creates a stock location from spreadsheet text -- an unknown location name is a hard failure", () => {
    expect(migration).toMatch(/RAISE EXCEPTION 'Unknown stock location: %', _location_name/);
    expect(migration).not.toMatch(/INSERT INTO public\.stock_locations/);
  });

  it("enforces quantity-without-location and expiry-without-quantity/location as hard failures", () => {
    expect(migration).toMatch(/_opening_quantity IS NOT NULL AND _opening_quantity > 0 AND _location_id IS NULL/);
    expect(migration).toMatch(/RAISE EXCEPTION 'Opening quantity requires a valid stock location'/);
    expect(migration).toMatch(
      /_expiry_date IS NOT NULL AND \(_opening_quantity IS NULL OR _opening_quantity <= 0 OR _location_id IS NULL\)/,
    );
    expect(migration).toMatch(/RAISE EXCEPTION 'Expiry date requires an opening quantity and a stock location'/);
  });
});

describe("import_inventory_item — duplicate SKU never overwrites an existing item", () => {
  it("an existing SKU for this property is reported back as skipped, not merged/updated into", () => {
    expect(migration).toMatch(
      /SELECT id INTO _existing_id FROM public\.inventory_items\s+WHERE property_id = _property_id AND sku = btrim\(_sku\)/,
    );
    expect(migration).toContain(
      "jsonb_build_object('created', false, 'skipped', true, 'reason', 'duplicate_sku', 'item_id', _existing_id)",
    );
    expect(migration).not.toMatch(/UPDATE public\.inventory_items/);
  });
});

describe("import_inventory_item — expiry belongs to batches only, item_stock stays the single quantity source of truth", () => {
  it("never writes expiry anywhere on inventory_items", () => {
    const createFnStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.import_inventory_item");
    const insertItemsMatch = migration.slice(createFnStart).match(/INSERT INTO public\.inventory_items\([^)]*\)/);
    expect(insertItemsMatch).not.toBeNull();
    expect(insertItemsMatch![0]).not.toMatch(/expiry/i);
  });

  it("uses apply_stock_delta() as the sole quantity-mutation path (never writes item_stock.quantity directly)", () => {
    expect(migration).toMatch(/PERFORM public\.apply_stock_delta\(_property_id, _item_id, _location_id, _opening_quantity\)/);
    expect(migration).not.toMatch(/UPDATE public\.item_stock/);
    expect(migration).not.toMatch(/INSERT INTO public\.item_stock/);
  });

  it("creates one inventory_stock_batches row per row only when quantity+location are present, carrying the expiry there", () => {
    expect(migration).toMatch(
      /INSERT INTO public\.inventory_stock_batches\(\s*property_id, item_id, location_id, received_quantity, expiry_date, notes, created_by\s*\)/,
    );
  });
});
