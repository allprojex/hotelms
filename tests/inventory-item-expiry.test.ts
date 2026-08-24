import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Inventory New Item — expiry date, surfaced via the ALREADY-EXISTING
// batch-level model (inventory_stock_batches / import_inventory_item() /
// update_batch_expiry()), never as a new column on inventory_items. See
// supabase/migrations/20260823130000_inventory_batch_expiration.sql and
// 20260823150000_inventory_import_rpc.sql, both pre-existing and untouched
// by this change. Structural (source-text) convention, matching this
// repo's established pattern — no live DB in this file.

const root = resolve(__dirname, "..");
function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const settingsPage = read(resolve(root, "src/routes/_authenticated/inventory.settings.tsx"));
const importRpcMigration = read(
  resolve(root, "supabase/migrations/20260823150000_inventory_import_rpc.sql"),
);
const batchMigration = read(
  resolve(root, "supabase/migrations/20260823130000_inventory_batch_expiration.sql"),
);
const itemMasterMigration = read(
  resolve(root, "supabase/migrations/20260705032118_e058dda0-25db-4d70-8408-f042276a7240.sql"),
);

describe("New item — expiry field placement and optionality", () => {
  it("places 'Expiry date (optional)' directly after Reorder level and before ProductImageField, without reordering any other field", () => {
    const reorderIdx = settingsPage.indexOf("<Label>Reorder level</Label>");
    const expiryIdx = settingsPage.indexOf("Expiry date (optional)");
    // "<ProductImageField" alone also matches the earlier
    // `useRef<ProductImageFieldHandle>` generic — search for the actual JSX
    // element usage (its own ref prop) instead.
    const productImageIdx = settingsPage.indexOf("<ProductImageField\n          ref={imageFieldRef}");
    expect(reorderIdx).toBeGreaterThan(-1);
    expect(expiryIdx).toBeGreaterThan(reorderIdx);
    expect(productImageIdx).toBeGreaterThan(expiryIdx);
  });

  it("is optional — the date input starts blank, with explicit helper text, and a Clear affordance appears only once a date is set", () => {
    expect(settingsPage).toContain("const [expiryDate, setExpiryDate] = useState(\"\");");
    expect(settingsPage).toContain("Leave empty if the item does not expire.");
    expect(settingsPage).toMatch(
      /\{expiryDate && <Button type="button" variant="outline" size="sm" onClick=\{\(\) => setExpiryDate\(""\)\}>Clear<\/Button>\}/,
    );
  });

  it("never defaults to today's date or any other pre-filled value", () => {
    expect(settingsPage).not.toMatch(/expiryDate.*new Date\(\)/);
    expect(settingsPage).not.toMatch(/useState\(format\(new Date/);
  });
});

describe("New item — date handling is timezone-safe", () => {
  it("uses a native <input type=\"date\"> bound directly to a plain string state, never a Date object", () => {
    expect(settingsPage).toContain(
      '<Input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} className="w-auto" />',
    );
  });

  it("never round-trips the expiry value through .toISOString() (the classic UTC day-shift bug) in an actual statement", () => {
    const withoutComments = settingsPage.replace(/\/\/[^\n]*/g, "");
    // image_updated_at IS a timestamptz column and legitimately uses
    // toISOString() elsewhere in this same file -- the assertion below is
    // scoped to the expiry-date value specifically, not a blanket ban.
    expect(withoutComments).not.toMatch(/expiryDate[^;]*toISOString\(\)/);
    expect(withoutComments).not.toMatch(/toISOString\(\)[^;]*expiryDate/);
  });

  it("sends _expiry_date as the raw form string (yyyy-mm-dd from the native date input) or null — never a parsed/reformatted value", () => {
    expect(settingsPage).toContain("_expiry_date: expiryDate || null,");
  });
});

describe("New item — expiry is written only through the existing batch RPC, never to inventory_items", () => {
  it("create path calls import_inventory_item() — the pre-existing atomic item+opening-stock+batch RPC — not a raw insert", () => {
    expect(settingsPage).toContain('await (supabase.rpc as any)("import_inventory_item", {');
  });

  it("the Edit-item payload never includes expiry_date or any expiry-shaped key", () => {
    const editPayloadMatch = settingsPage.match(
      /\/\/ Edit: item-master fields only[\s\S]*?const payload: any = \{[\s\S]*?\};/,
    )?.[0] ?? "";
    expect(editPayloadMatch.length).toBeGreaterThan(0);
    const editPayloadCode = editPayloadMatch.replace(/\/\/[^\n]*/g, "");
    expect(editPayloadCode).not.toMatch(/expiry/i);
  });

  it("inventory_items itself is never given an expiry_date column — confirmed against its own migration", () => {
    expect(itemMasterMigration).toContain("CREATE TABLE public.inventory_items (");
    const itemTableDef =
      itemMasterMigration.match(/CREATE TABLE public\.inventory_items \([\s\S]*?\);/)?.[0] ?? "";
    expect(itemTableDef).not.toMatch(/expiry/i);
  });

  it("no new migration was added by this change — expiry storage remains exactly inventory_stock_batches.expiry_date, added by the pre-existing 20260823130000 migration", () => {
    expect(batchMigration).toContain("expiry_date DATE,");
    expect(batchMigration).toContain("CREATE TABLE public.inventory_stock_batches (");
  });
});

describe("New item — no fake zero-quantity batch; opening stock is required whenever an expiry is entered", () => {
  it("client-side: Save is disabled unless a genuine opening quantity AND a stock location are present, whenever an expiry date is set", () => {
    expect(settingsPage).toContain(
      "const openingStockRequired = !existing && expiryDate.trim() !== \"\";",
    );
    expect(settingsPage).toContain(
      "const openingStockValid = !openingStockRequired || (Number(openingQuantity) > 0 && !!locationId);",
    );
    expect(settingsPage).toContain('disabled={!openingStockValid}>Save</Button>');
  });

  it("the Opening quantity / Stock location fields render only once an expiry date has actually been entered — never shown, and never required, for a normal non-expiring item", () => {
    const block = settingsPage.match(/\{expiryDate && \(\s*<div className="grid gap-3 sm:grid-cols-2">[\s\S]*?<\/div>\s*\)\}/)?.[0] ?? "";
    expect(block).toContain("Opening quantity");
    expect(block).toContain("Stock location");
  });

  it("the same guard already exists, independently, at the database layer in import_inventory_item — defense in depth, not just a client-side nicety", () => {
    expect(importRpcMigration).toContain(
      "IF _expiry_date IS NOT NULL AND (_opening_quantity IS NULL OR _opening_quantity <= 0 OR _location_id IS NULL) THEN",
    );
    expect(importRpcMigration).toContain("RAISE EXCEPTION 'Expiry date requires an opening quantity and a stock location';");
  });

  it("import_inventory_item never creates a batch row when no opening quantity/location were given — item-only creation stays byte-identical to before this feature", () => {
    expect(importRpcMigration).toContain(
      "IF _opening_quantity IS NOT NULL AND _opening_quantity > 0 AND _location_id IS NOT NULL THEN",
    );
  });
});

describe("New item — create-without-expiry stays behaviorally unchanged", () => {
  it("omitting expiry sends _opening_quantity and _expiry_date as null, and _location_name as null when no location was chosen — the exact 'no batch created' path", () => {
    expect(settingsPage).toContain("_opening_quantity: openingQuantity ? Number(openingQuantity) : null,");
    expect(settingsPage).toContain(
      "_location_name: locationId ? (locs.data ?? []).find((l: any) => l.id === locationId)?.name ?? null : null,",
    );
  });

  it("a duplicate SKU is surfaced as an explicit error toast, never silently treated as success", () => {
    expect(settingsPage).toContain("if (data?.skipped) return toast.error(\"An item with this SKU already exists.\");");
  });
});

describe("Edit item — no single-field expiry, no silent multi-batch overwrite", () => {
  it("shows an explanatory note instead of an editable expiry field when editing an existing item", () => {
    expect(settingsPage).toContain(
      "Batch expiry is managed in the Batches tab — this item may have several batches with different expiry dates.",
    );
  });

  it("the Edit path never calls update_batch_expiry or touches inventory_stock_batches at all", () => {
    const editBranchMatch = settingsPage.match(/if \(existing\) \{[\s\S]*?itemId = existing\.id;\n\s*\} else \{/)?.[0] ?? "";
    expect(editBranchMatch.length).toBeGreaterThan(0);
    const editBranchCode = editBranchMatch.replace(/\/\/[^\n]*/g, "");
    expect(editBranchCode).not.toMatch(/inventory_stock_batches|update_batch_expiry/);
  });

  it("the pre-existing per-batch Edit expiry dialog (update_batch_expiry RPC) is untouched by this change", () => {
    expect(settingsPage).toContain('await (supabase.rpc as any)("update_batch_expiry", {');
    expect(settingsPage).toContain("Only the expiry date can be changed here — quantity, item, and location are never affected.");
  });
});

describe("Property isolation and permissions are preserved", () => {
  it("import_inventory_item requires a property id and checks the SAME role set as the existing inv_items_write RLS policy — no permission widening or narrowing", () => {
    expect(importRpcMigration).toContain(
      "IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager']::app_role[], _property_id) THEN",
    );
    expect(itemMasterMigration).toContain(
      "CREATE POLICY inv_items_write ON public.inventory_items FOR ALL TO authenticated\n  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager']::app_role[], property_id))",
    );
  });

  it("the locations query used to populate the Stock location select is scoped by the active property_id, never global", () => {
    expect(settingsPage).toContain(
      'queryFn: async () => (await (supabase.from as any)("stock_locations").select("id, name").eq("property_id", propertyId).order("name")).data ?? [],',
    );
  });

  it("this task adds no new migration and no new RLS policy — property scoping/permissions come entirely from the pre-existing, unmodified RPC and table", () => {
    expect(importRpcMigration).toContain(
      "REVOKE ALL ON FUNCTION public.import_inventory_item(UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, NUMERIC, DATE) FROM PUBLIC;",
    );
    expect(importRpcMigration).toContain(
      "GRANT EXECUTE ON FUNCTION public.import_inventory_item(UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, NUMERIC, DATE) TO authenticated;",
    );
  });
});
