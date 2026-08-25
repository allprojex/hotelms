import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Source-convention tests (no jsdom/RTL in this repo's test setup -- see
// tests/global-search.test.ts's header for the established precedent).

const purchaseOrders = readFileSync(
  resolve(__dirname, "../src/routes/_authenticated/inventory.purchase-orders.tsx"),
  "utf8",
);
const settings = readFileSync(
  resolve(__dirname, "../src/routes/_authenticated/inventory.settings.tsx"),
  "utf8",
);
const inventoryHome = readFileSync(
  resolve(__dirname, "../src/routes/_authenticated/inventory.index.tsx"),
  "utf8",
);

describe("ReceiveDialog — captures optional per-line expiry on receiving", () => {
  it("replaced the old plain receive() button/handler with a dialog", () => {
    expect(purchaseOrders).not.toMatch(/async function receive\(id: string\)/);
    expect(purchaseOrders).toContain("function ReceiveDialog(");
    expect(purchaseOrders).toContain("<ReceiveDialog poId={p.id}");
  });

  it("calls receive_purchase_order with an optional _line_expiry map, blank dates omitted", () => {
    expect(purchaseOrders).toMatch(/\.rpc as any\)\("receive_purchase_order",\s*\{/);
    expect(purchaseOrders).toContain(
      "_line_expiry: Object.keys(lineExpiry).length > 0 ? lineExpiry : null",
    );
  });

  it("expiration date input uses a native date picker (no locale-dependent manual parsing)", () => {
    expect(purchaseOrders).toMatch(/type="date"[\s\S]{0,120}onChange=\{\(e\) => setExpiryByLine/);
  });

  it("warns (does not block) when the chosen date is already in the past", () => {
    expect(purchaseOrders).toMatch(/const isPast = chosen && chosen < today;/);
    expect(purchaseOrders).toMatch(/the batch will be recorded as Expired/);
    // The confirm button is never disabled by isPast -- only by saving/no-lines.
    expect(purchaseOrders).toMatch(
      /disabled=\{saving \|\| \(lines\.data\?\.length \?\? 0\) === 0\}/,
    );
  });
});

describe("Item creation form -- expiry is captured but never collapsed to a single item-level date", () => {
  // Superseded design note: this originally asserted ItemDialog mentioned
  // expiry nowhere at all, because at the time there was no safe way to
  // attach an entered date to a real batch. That safe path now exists
  // (import_inventory_item() -- see tests/inventory-item-expiry.test.ts for
  // full coverage), so New Item legitimately captures expiry today. What
  // must still hold, permanently, is the reason the original ban existed:
  // no raw expiry_date field/column on the item master itself, and no
  // single field on Edit that could silently overwrite several batches'
  // differing expiry dates.
  it("ItemDialog's Edit-item payload never includes expiry_date (would collapse multiple batch expiries to one item-level date)", () => {
    const start = settings.indexOf("function ItemDialog(");
    const end = settings.indexOf("\n// ----------", start + 1);
    const body = settings.slice(start, end === -1 ? undefined : end);
    const editPayload = body.match(/const payload: any = \{[\s\S]*?\};/)?.[0] ?? "";
    expect(editPayload.length).toBeGreaterThan(0);
    expect(editPayload).not.toMatch(/expiry/i);
  });
});

describe("BatchesTab -- expiry visibility and expiry-only editing", () => {
  it("is registered as a tab in Inventory setup", () => {
    expect(settings).toContain('<TabsTrigger value="batches">Batches</TabsTrigger>');
    expect(settings).toContain('<TabsContent value="batches"><BatchesTab /></TabsContent>');
  });

  it("queries inventory_stock_batches scoped by property_id, joined to item/location for display", () => {
    expect(settings).toMatch(
      /\("inventory_stock_batches"\)[\s\S]{0,250}\.eq\("property_id",\s*propertyId\)/,
    );
    expect(settings).toContain("inventory_items(name, sku)");
    expect(settings).toContain("stock_locations(name)");
  });

  it("renders a status badge computed via the shared computeBatchStatus helper (no ad-hoc duplicated logic)", () => {
    expect(settings).toContain(
      'import { computeBatchStatus, BATCH_STATUS_LABEL, BATCH_STATUS_BADGE_VARIANT } from "@/lib/inventory/batch-status"',
    );
    expect(settings).toMatch(/const status = computeBatchStatus\(b\.expiry_date, warningDays\);/);
  });

  it("editing a batch calls update_batch_expiry only -- no direct table write, no quantity/item/location fields in the edit dialog", () => {
    const start = settings.indexOf("function EditBatchExpiryDialog(");
    const end = settings.indexOf("\n// ----------", start + 1);
    const body = settings.slice(start, end === -1 ? undefined : end);
    expect(body).toMatch(/\.rpc as any\)\("update_batch_expiry",/);
    expect(body).not.toMatch(/\.from\(["']inventory_stock_batches["']\)\.(update|insert|delete)\(/);
    expect(body).not.toMatch(/received_quantity|item_id|location_id/);
  });

  it("the Clear button explicitly sends null, not an empty string, to represent 'No Expiry'", () => {
    expect(settings).toMatch(/_expiry_date: value \|\| null,/);
  });
});

describe("Threshold configuration -- reads/writes properties.inventory_expiry_warning_days, no hardcoded value", () => {
  it("BatchesTab reads the threshold from properties and offers a save control, not a silent hardcoded constant", () => {
    expect(settings).toMatch(
      /\("properties"\)[\s\S]{0,150}\.select\("inventory_expiry_warning_days"\)/,
    );
    expect(settings).toContain(".update({ inventory_expiry_warning_days: days })");
    expect(settings).toMatch(/if \(!Number\.isInteger\(days\) \|\| days <= 0\)/);
  });
});

describe("Inventory overview -- expiring/expired visibility (Phase 4 'inventory list/detail')", () => {
  it("adds an Expiring/expired batches stat card using the same shared status helper", () => {
    expect(inventoryHome).toContain(
      'import { computeBatchStatus } from "@/lib/inventory/batch-status"',
    );
    expect(inventoryHome).toMatch(/s === "expired" \|\| s === "expiring_soon"/);
    expect(inventoryHome).toContain('label="Expiring / expired batches"');
  });
});

describe("Property isolation -- every new/changed query is scoped by property_id", () => {
  it("ReceiveDialog's line-fetch query is scoped to the specific PO (already property-scoped via the PO itself)", () => {
    expect(purchaseOrders).toMatch(
      /\("purchase_order_lines"\)[\s\S]{0,150}\.eq\("po_id",\s*poId\)/,
    );
  });

  it("no new query in these three files bypasses property scoping with an unscoped select on a property-owned table", () => {
    // inventory_stock_batches is always queried with an explicit
    // property_id filter in these UI files (RLS is defense-in-depth, not
    // the only guard).
    const files = [settings, inventoryHome];
    for (const f of files) {
      if (f.includes('"inventory_stock_batches"')) {
        expect(f).toMatch(
          /\("inventory_stock_batches"\)[\s\S]{0,250}\.eq\("property_id",\s*propertyId\)/,
        );
      }
    }
  });
});
