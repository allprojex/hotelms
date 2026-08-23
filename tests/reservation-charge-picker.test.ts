import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Source-convention tests (see tests/global-search.test.ts's header for why
// — this repo's vitest has no jsdom/RTL). Covers the Hotel reservation
// Add Charge product picker: a searchable combobox over the property's
// existing pos_menu_items catalog, embedded in the existing AddCharge
// dialog. Complements tests/search-filter.test.ts's pure-function coverage.

const reservationPage = readFileSync(
  resolve(__dirname, "../src/routes/_authenticated/reservations.$id.tsx"),
  "utf8",
);

describe("ChargeItemPicker — renders inside the existing Add Charge dialog", () => {
  it("AddCharge renders the picker, and passes it the reservation's own property id", () => {
    expect(reservationPage).toMatch(/<ChargeItemPicker\s*\n?\s*propertyId=\{propertyId\}/);
    expect(reservationPage).toContain(
      "<AddCharge reservationId={id} propertyId={res.data?.property_id}",
    );
  });

  it("uses the existing Popover+Command combobox pattern (same as ghana-region-select.tsx), not a new UI primitive", () => {
    expect(reservationPage).toContain(
      'import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"',
    );
    expect(reservationPage).toMatch(
      /import \{ Command, CommandEmpty, CommandInput, CommandItem, CommandList \} from "@\/components\/ui\/command"/,
    );
  });
});

describe("ChargeItemPicker — property isolation and catalog scoping", () => {
  it("scopes the pos_menu_items query to the reservation's own property, not the globally active property switcher", () => {
    // Deliberately takes propertyId as a prop (from the reservation row
    // itself, res.data.property_id) rather than calling useActiveProperty()
    // — a reservation belongs to one fixed property regardless of what
    // property the staff member currently has selected in the TopBar, so
    // charging it must never depend on that switcher.
    expect(reservationPage).not.toMatch(/ChargeItemPicker[\s\S]{0,400}useActiveProperty/);
    expect(reservationPage).toMatch(
      /\("pos_menu_items"\)[\s\S]{0,200}\.eq\("property_id",\s*propertyId\)/,
    );
  });

  it("only queries once the popover is open and a property id is known (no eager unscoped fetch)", () => {
    expect(reservationPage).toMatch(/queryKey:\s*\["charge-item-picker",\s*propertyId\]/);
    expect(reservationPage).toMatch(/enabled:\s*open\s*&&\s*!!propertyId/);
  });
});

describe("ChargeItemPicker — active/inactive item handling", () => {
  it("filters to active items only at the query level", () => {
    expect(reservationPage).toMatch(/\("pos_menu_items"\)[\s\S]{0,250}\.eq\("active",\s*true\)/);
  });
});

describe("ChargeItemPicker — search behavior", () => {
  it("uses the shared matchesSearch()/menuItemSearchText() helpers (same case-insensitive, partial-match semantics as POS order/menu search)", () => {
    expect(reservationPage).toContain(
      'import { matchesSearch, menuItemSearchText } from "@/lib/search-filter"',
    );
    expect(reservationPage).toMatch(
      /\.filter\(\(it: any\) => matchesSearch\(menuItemSearchText\(it\), query\)\)/,
    );
  });

  it("CommandItem value is built from real searchable text, not an opaque id (cmdk internal-filter regression guard)", () => {
    expect(reservationPage).toMatch(/value=\{`\$\{menuItemSearchText\(it\)\} \$\{it\.id\}`\}/);
    expect(reservationPage).toContain("shouldFilter={false}");
  });
});

describe("ChargeItemPicker — selecting a product populates the existing fields, never silently", () => {
  it("selecting a result calls onPick with the item's name and numeric price", () => {
    expect(reservationPage).toMatch(
      /onSelect=\{\(\) => \{ onPick\(\{ name: it\.name, price: Number\(it\.price\) \}\); setOpen\(false\); setQuery\(""\); \}\}/,
    );
  });

  it("AddCharge's onPick sets the existing desc/amount state — selection is the explicit user action that fills them, and both remain freely editable afterward", () => {
    expect(reservationPage).toMatch(
      /onPick=\{\(item\) => \{ setDesc\(item\.name\); setAmount\(String\(item\.price\)\); \}\}/,
    );
    // The Description/Amount Inputs are still plain, uncontrolled-by-picker
    // editable inputs (not readOnly/disabled) — manual freeform entry
    // remains fully available, matching the pre-existing AddCharge UX.
    expect(reservationPage).toMatch(
      /<Label>Description<\/Label><Input value=\{desc\} onChange=\{\(e\) => setDesc\(e\.target\.value\)\} \/>/,
    );
    expect(reservationPage).toMatch(
      /<Label>Amount<\/Label><Input type="number" step="0\.01" value=\{amount\} onChange=\{\(e\) => setAmount\(e\.target\.value\)\}/,
    );
  });
});

describe("ChargeItemPicker — no unintended writes", () => {
  it("the picker itself never writes to the database — it only reads pos_menu_items", () => {
    // Extract just the ChargeItemPicker function body and confirm it
    // contains no insert/update/delete/upsert calls at all.
    const start = reservationPage.indexOf("function ChargeItemPicker(");
    const nextFn = reservationPage.indexOf("\nfunction ", start + 1);
    const pickerBody = reservationPage.slice(start, nextFn === -1 ? undefined : nextFn);
    expect(pickerBody).not.toMatch(/\.insert\(/);
    expect(pickerBody).not.toMatch(/\.update\(/);
    expect(pickerBody).not.toMatch(/\.delete\(/);
    expect(pickerBody).not.toMatch(/\.upsert\(/);
  });

  it("no inventory_items write was introduced (stock deduction stays out of scope — a separate feature)", () => {
    expect(reservationPage).not.toMatch(/\("inventory_items"\)\.(insert|update|delete|upsert)\(/);
  });

  it("no pos_order_items / pos_orders write was introduced (this is not routed through the POS order/settle flow)", () => {
    expect(reservationPage).not.toMatch(/\("pos_order_items"\)\.(insert|update|delete|upsert)\(/);
    expect(reservationPage).not.toMatch(/\("pos_orders"\)\.(insert|update|delete|upsert)\(/);
  });

  it("reservation charge submission still uses the single, pre-existing insert path — no duplicate financial write", () => {
    const insertCount = (reservationPage.match(/\.from\("reservation_charges"\)\.insert\(/g) ?? [])
      .length;
    expect(insertCount).toBe(1);
    // The insert payload shape is unchanged: description/amount/posted_by
    // only, no new source-link column.
    expect(reservationPage).toMatch(
      /reservation_id: reservationId, description: desc, amount: Number\(amount\), posted_by: u\.user\?\.id,/,
    );
  });
});

describe("ChargeItemPicker — clear/cancel behavior", () => {
  it("closing the popover (selecting an item, or dismissing it) resets the search query", () => {
    expect(reservationPage).toMatch(
      /onOpenChange=\{\(v\) => \{ setOpen\(v\); if \(!v\) setQuery\(""\); \}\}/,
    );
  });
});
