import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Source-convention tests (see tests/dashboard-search.test.ts's header for
// why: no jsdom/RTL in this repo's test setup). These confirm the POS order
// screen and POS menu management screen got a search box added WITHOUT
// touching any of the existing query scoping, cart/add-item behavior,
// category grouping, or active/inactive filtering.

const orderScreen = readFileSync(
  resolve(__dirname, "../src/routes/_authenticated/pos.order.$id.tsx"),
  "utf8",
);
const menuScreen = readFileSync(
  resolve(__dirname, "../src/routes/_authenticated/pos.menu.tsx"),
  "utf8",
);

describe("POS order screen (product picker) — search added without regressing existing behavior", () => {
  it("still scopes the menu-item query to the order's outlet and to active items only", () => {
    expect(orderScreen).toContain('.eq("outlet_id", order.data.outlet_id).eq("active", true)');
  });

  it("adds a client-side search box using the shared search-filter helper (no fabricated fields like sku/barcode)", () => {
    expect(orderScreen).toContain(
      'import { matchesSearch, menuItemSearchText } from "@/lib/search-filter"',
    );
    expect(orderScreen).toContain("const [menuQuery, setMenuQuery] = useState");
    expect(orderScreen).toMatch(/matchesSearch\(menuItemSearchText\(m\),\s*menuQuery\)/);
  });

  it("derives the filtered list from the query result without mutating it (so clearing the search restores the full list)", () => {
    expect(orderScreen).toMatch(/const filteredMenu = \(menu\.data \?\? \[\]\)\.filter/);
    // Category grouping is built FROM the filtered list, not the raw list,
    // and the raw menu.data itself is never reassigned/mutated.
    expect(orderScreen).toMatch(/filteredMenu\.forEach/);
  });

  it("selecting a product after searching still uses the existing addItem cart workflow (no new/duplicate add path)", () => {
    expect(orderScreen).toMatch(/async function addItem\(m: any\)/);
    expect(orderScreen).toMatch(/onClick=\{\(\) => addItem\(m\)\}/);
    // Only one insert into pos_order_items exists in the whole file — the
    // search feature didn't introduce a second/duplicate cart-add path.
    const insertCount = (orderScreen.match(/\("pos_order_items"\)\.insert\(/g) ?? []).length;
    expect(insertCount).toBe(1);
  });

  it("has a distinct empty state for 'no items at all' vs 'no items match the search'", () => {
    expect(orderScreen).toContain("No menu items for this outlet");
    expect(orderScreen).toMatch(/No menu items match/);
  });
});

describe("POS menu management screen — search added without regressing existing behavior", () => {
  it("still scopes categories/items/inventory queries by outlet/property exactly as before", () => {
    expect(menuScreen).toContain('.eq("outlet_id", outlet.id).order("sort")');
    expect(menuScreen).toContain('.eq("outlet_id", outlet.id).order("name")');
    expect(menuScreen).toContain('.eq("property_id", propertyId).eq("active", true).order("name")');
  });

  it("adds a client-side search box using the shared search-filter helper", () => {
    expect(menuScreen).toContain(
      'import { matchesSearch, menuItemSearchText } from "@/lib/search-filter"',
    );
    expect(menuScreen).toContain("const [itemQuery, setItemQuery] = useState");
    expect(menuScreen).toMatch(
      /const filteredItems = \(items\.data \?\? \[\]\)\.filter\(\(it: any\) => matchesSearch\(menuItemSearchText\(it\), itemQuery\)\)/,
    );
  });

  it("renders the filtered list in the table, and the create/edit item dialogs are untouched", () => {
    expect(menuScreen).toContain("{filteredItems.map((it: any) =>");
    // ItemDialog save() still does exactly one insert/update, unchanged.
    expect(menuScreen).toMatch(
      /\("pos_menu_items"\)\.update\(payload\)\.eq\("id", existing\.id\) : \(supabase\.from as any\)\("pos_menu_items"\)\.insert\(payload\)/,
    );
  });

  it("has a distinct empty state for 'no items yet' vs 'no items match the search'", () => {
    expect(menuScreen).toContain("No items yet.");
    expect(menuScreen).toMatch(/No items match/);
  });

  it("regression: the search input is always visible, not conditionally hidden when the selected outlet has zero items", () => {
    // A live production audit found the search box was gated behind
    // `(items.data?.length ?? 0) > 0`, so an outlet with no items yet (e.g.
    // the alphabetically-first outlet, auto-selected by default even when
    // a different outlet has all the real data) hid the search affordance
    // entirely — a real user had no way to discover search exists at all
    // on this page. Fixed by rendering the search input unconditionally;
    // the existing "No items yet." / "No items match" empty states already
    // handle the zero-items case underneath it.
    expect(menuScreen).not.toMatch(
      /\{\(items\.data\?\.length \?\? 0\) > 0 && \(\s*<div className="relative">\s*<Search/,
    );
    expect(menuScreen).toMatch(
      /<div className="relative">\s*<Search className="absolute left-2 top-1\/2 h-4 w-4 -translate-y-1\/2 text-muted-foreground" \/>\s*<Input placeholder="Search items…"/,
    );
  });
});
