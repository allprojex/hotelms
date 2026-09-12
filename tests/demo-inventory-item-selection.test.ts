import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const selector = read("src/components/inventory/inventory-item-select.tsx");
const adjustments = read("src/routes/_authenticated/inventory.adjustments.tsx");
const purchaseOrders = read("src/routes/_authenticated/inventory.purchase-orders.tsx");
const transfers = read("src/routes/_authenticated/inventory.transfers.tsx");
const posMenu = read("src/routes/_authenticated/pos.menu.tsx");
const reservation = read("src/routes/_authenticated/reservations.$id.tsx");

describe("Demo inventory item selection UX", () => {
  it("searches the catalogue by human-readable product name, SKU/code and partial text", () => {
    expect(selector).toContain("inventoryItemSearchText");
    expect(selector).toContain("matchesSearch");
    expect(selector).toContain('placeholder="Search name, SKU or code…"');
    expect(selector).toContain("shouldFilter={false}");
    expect(selector).toContain(".slice(0, 100)");
  });

  it.each([
    ["stock adjustments", adjustments],
    ["purchase orders", purchaseOrders],
    ["stock transfers", transfers],
    ["POS linked stock", posMenu],
  ])("uses the shared searchable selector for %s", (_name, source) => {
    expect(source).toContain('from "@/components/inventory/inventory-item-select"');
    expect(source).toContain("<InventoryItemSelect");
  });

  it("preserves the purchase-order cost default when a searched item is selected", () => {
    expect(purchaseOrders).toContain("c[i].unit_cost = Number(it.cost)");
  });

  it("supports clearing the optional POS inventory link", () => {
    expect(posMenu).toContain("allowNone");
    expect(posMenu).toContain('noneLabel="Not linked"');
  });

  it("retains the existing searchable reservation item picker", () => {
    expect(reservation).toContain("function ItemDistributionPicker");
    expect(reservation).toContain("inventoryItemSearchText");
    expect(reservation).toContain("shouldFilter={false}");
  });
});
