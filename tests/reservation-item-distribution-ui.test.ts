import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { inventoryItemSearchText, matchesSearch } from "../src/lib/search-filter";

// Source-convention tests (no jsdom/RTL in this repo's test setup -- see
// tests/global-search.test.ts's header for the established precedent).
//
// Line endings are normalized: a Windows checkout with core.autocrlf=true
// stores this file with CRLF, which shifts every byte offset below and made a
// fixed-width slice window fall short of its target for a purely platform-
// dependent reason.
const source = readFileSync(
  resolve(__dirname, "../src/routes/_authenticated/reservations.$id.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

/**
 * Slice one component out of the route file by its own boundaries rather than
 * a fixed byte budget -- a hard-coded `start + N` silently stops covering its
 * assertion the moment the component grows (or the checkout uses CRLF), which
 * is exactly how the picker assertion below started failing while the source
 * was correct.
 */
function componentBody(name: string, nextName?: string): string {
  const start = source.indexOf(`function ${name}`);
  expect(start, `${name} not found in reservations.$id.tsx`).toBeGreaterThan(-1);
  const end = nextName ? source.indexOf(`function ${nextName}`, start) : source.length;
  return source.slice(start, end === -1 ? source.length : end);
}

describe("Room Items section — placement and check-in gating", () => {
  it("is rendered on the reservation detail page, after the Folio card", () => {
    const folioIdx = source.indexOf('<CardTitle className="text-base">Folio</CardTitle>');
    const sectionIdx = source.indexOf("<ItemDistributionSection reservation={r} />");
    expect(folioIdx).toBeGreaterThan(-1);
    expect(sectionIdx).toBeGreaterThan(folioIdx);
  });

  it("the Issue button only renders when the reservation is checked_in", () => {
    expect(source).toContain('{r.status === "checked_in" && canIssueReturn.allowed && (');
  });

  it("Return/Adjust actions are NOT gated on reservation status -- correction must remain possible after checkout", () => {
    const start = source.indexOf("function ItemDistributionSection");
    const end = source.indexOf("function IssueItemDialog");
    const body = source.slice(start, end);
    // Only the Issue button checks r.status; the per-row Return/Adjust
    // buttons are gated on outstanding > 0 and role, never on r.status.
    const statusChecks = body.match(/r\.status === "checked_in"/g) ?? [];
    expect(statusChecks.length).toBe(1);
  });
});

describe("Role gating — UI-side only, matching the RPCs' own server-side role sets", () => {
  it("issue/return uses the broader operational role set", () => {
    expect(source).toMatch(
      /const ISSUE_RETURN_ROLES = \[\s*"super_admin", "hotel_owner", "general_manager", "front_desk",\s*"housekeeping_supervisor", "housekeeping", "storekeeper",\s*\] as const;/,
    );
  });

  it("adjust uses the narrower supervisory role set, identical to the existing stock_adjustments precedent", () => {
    expect(source).toContain(
      'const ADJUST_ROLES = ["super_admin", "hotel_owner", "general_manager", "housekeeping_supervisor"] as const;',
    );
  });
});

describe("Item picker — searchable, active-only, property-scoped, avoids the known cmdk opaque-value pitfall", () => {
  it("searches inventory_items scoped to the reservation's property and active=true only", () => {
    const body = componentBody("ItemDistributionPicker", "ReturnItemDialog");
    expect(body).toMatch(/\("inventory_items"\)/);
    expect(body).toContain('.eq("property_id", propertyId)');
    expect(body).toContain('.eq("active", true)');
  });

  it("searches by name, SKU, and category via the shared inventoryItemSearchText helper", () => {
    expect(source).toContain(
      'import { matchesSearch, menuItemSearchText, inventoryItemSearchText } from "@/lib/search-filter";',
    );
    expect(source).toMatch(/matchesSearch\(inventoryItemSearchText\(it\), query\)/);
  });

  it("uses shouldFilter={false} with a human-searchable CommandItem.value (not an opaque id alone) -- the exact fix from the dashboard-search cmdk bug (PR #52)", () => {
    const body = componentBody("ItemDistributionPicker", "ReturnItemDialog");
    expect(body).toContain("shouldFilter={false}");
    expect(body).toMatch(/value=\{`\$\{inventoryItemSearchText\(it\)\} \$\{it\.id\}`\}/);
  });
});

describe("Item picker filtering — behaviour of the predicate the picker actually uses", () => {
  // The picker disables cmdk's built-in filter (shouldFilter={false}) and does
  // its own matching with matchesSearch(inventoryItemSearchText(it), query).
  // These exercise those real shipped helpers, so a regression in the matching
  // rules fails here on behaviour, not on source text.
  const items = [
    { id: "i1", name: "Bath Towel", sku: "TWL-001", item_categories: { name: "Linen" } },
    { id: "i2", name: "Hand Soap", sku: "SOAP-020", item_categories: { name: "Toiletries" } },
    { id: "i3", name: "Kettle", sku: null, item_categories: null },
  ];
  const pick = (query: string) =>
    items.filter((it) => matchesSearch(inventoryItemSearchText(it), query)).map((it) => it.id);

  it("matches on name, SKU and category", () => {
    expect(pick("towel")).toEqual(["i1"]);
    expect(pick("SOAP-020")).toEqual(["i2"]);
    expect(pick("Toiletries")).toEqual(["i2"]);
  });

  it("is case-insensitive and matches partial words", () => {
    expect(pick("BATH")).toEqual(["i1"]);
    expect(pick("twl")).toEqual(["i1"]);
    expect(pick("lin")).toEqual(["i1"]);
  });

  it("an empty query hides nothing -- every configurable item stays selectable", () => {
    expect(pick("")).toEqual(["i1", "i2", "i3"]);
    expect(pick("   ")).toEqual(["i1", "i2", "i3"]);
  });

  it("an item with no SKU or category is still searchable by name, never dropped", () => {
    expect(pick("kettle")).toEqual(["i3"]);
    expect(inventoryItemSearchText(items[2])).toBe("Kettle");
  });

  it("a non-matching query yields no rows rather than an unfiltered list", () => {
    expect(pick("no-such-item")).toEqual([]);
  });

  it("the value passed to CommandItem stays unique per item while remaining human-searchable", () => {
    const values = items.map((it) => `${inventoryItemSearchText(it)} ${it.id}`);
    expect(new Set(values).size).toBe(items.length);
    expect(values[0]).toContain("Bath Towel");
    expect(values[0]).toContain("i1");
  });
});

describe("Issue dialog — no silent default location, shows available stock", () => {
  it("the location Select has no default value and no pre-selected first option", () => {
    const start = source.indexOf("function IssueItemDialog");
    const end = source.indexOf("function ItemDistributionPicker");
    const body = source.slice(start, end);
    expect(body).toContain('const [locationId, setLocationId] = useState("");');
    expect(body).not.toMatch(/setLocationId\(locations\.data\?\.\[0\]/);
  });

  it("locations are scoped to the reservation's property", () => {
    const start = source.indexOf("function IssueItemDialog");
    const end = source.indexOf("function ItemDistributionPicker");
    const body = source.slice(start, end);
    expect(body).toMatch(/\("stock_locations"\)[\s\S]{0,80}\.eq\("property_id", propertyId\)/);
  });

  it("shows available stock for the selected item+location before issuing", () => {
    const start = source.indexOf("function IssueItemDialog");
    const end = source.indexOf("function ItemDistributionPicker");
    const body = source.slice(start, end);
    expect(body).toContain('queryKey: ["dist-available", item?.id, locationId]');
    expect(body).toContain("Available: {available.data ?? 0}");
  });

  it("calls the guarded issue_reservation_item RPC, never a direct table insert", () => {
    const start = source.indexOf("function IssueItemDialog");
    const end = source.indexOf("function ItemDistributionPicker");
    const body = source.slice(start, end);
    expect(body).toContain('(supabase.rpc as any)("issue_reservation_item"');
    expect(body).not.toMatch(/\.from\("reservation_item_distributions"\)\.insert/);
  });
});

describe("Idempotency key lifecycle — one id per open dialog session, not one per click (client requirement: retries of the same submission must not double-apply)", () => {
  it("IssueItemDialog generates a requestId lazily on mount and passes it as _request_id in the RPC call", () => {
    const start = source.indexOf("function IssueItemDialog");
    const end = source.indexOf("function ItemDistributionPicker");
    const body = source.slice(start, end);
    expect(body).toContain("useState<string>(() => crypto.randomUUID())");
    expect(body).toContain("_request_id: requestId");
  });

  it("ReturnItemDialog and AdjustItemDialog each generate their own requestId the same way", () => {
    const returnStart = source.indexOf("function ReturnItemDialog");
    const returnEnd = source.indexOf("function AdjustItemDialog");
    const returnBody = source.slice(returnStart, returnEnd);
    expect(returnBody).toContain("useState<string>(() => crypto.randomUUID())");
    expect(returnBody).toContain("_request_id: requestId");

    const adjustBody = source.slice(returnEnd);
    expect(adjustBody).toContain("useState<string>(() => crypto.randomUUID())");
    expect(adjustBody).toContain("_request_id: requestId");
  });

  it("a new requestId is only generated on close/reset, never inside the submit button's onClick before the RPC call fires — so a double-click/network-retry within one open session reuses the same key", () => {
    for (const [name, start, end] of [
      [
        "IssueItemDialog",
        source.indexOf("function IssueItemDialog"),
        source.indexOf("function ItemDistributionPicker"),
      ],
      [
        "ReturnItemDialog",
        source.indexOf("function ReturnItemDialog"),
        source.indexOf("function AdjustItemDialog"),
      ],
      ["AdjustItemDialog", source.indexOf("function AdjustItemDialog"), source.length],
    ] as const) {
      const body = source.slice(start, end);
      const onClickIdx = body.indexOf("onClick={async () => {");
      const rpcCallIdx = body.indexOf("(supabase.rpc as any)(", onClickIdx);
      expect(onClickIdx, `${name}: onClick handler not found`).toBeGreaterThan(-1);
      expect(rpcCallIdx, `${name}: RPC call not found inside onClick`).toBeGreaterThan(onClickIdx);
      const preRpcSlice = body.slice(onClickIdx, rpcCallIdx);
      expect(
        preRpcSlice,
        `${name}: requestId must not be regenerated between the click and the RPC call`,
      ).not.toContain("setRequestId(crypto.randomUUID())");
      // The regeneration call does exist -- just only in the close/reset
      // path, which is after the RPC call site (post-success cleanup) or
      // in the Dialog's own onOpenChange handler, never pre-empting this call.
      expect(body).toContain("setRequestId(crypto.randomUUID())");
    }
  });
});

describe("Return/Adjust dialogs — bounded by outstanding, guarded RPCs only", () => {
  it("the return quantity input is capped at the outstanding amount and the button is disabled beyond it", () => {
    const start = source.indexOf("function ReturnItemDialog");
    const end = source.indexOf("function AdjustItemDialog");
    const body = source.slice(start, end);
    expect(body).toContain("max={outstanding}");
    expect(body).toContain("Number(quantity) > outstanding");
    expect(body).toContain('(supabase.rpc as any)("return_reservation_item"');
  });

  it("the adjust dialog requires a non-empty reason before the Save button is enabled", () => {
    const start = source.indexOf("function AdjustItemDialog");
    const body = source.slice(start);
    expect(body).toContain("reason.trim().length === 0");
    expect(body).toContain('(supabase.rpc as any)("adjust_reservation_item_distribution"');
  });

  it("offers exactly the three documented stock directions with clear, non-jargon labels", () => {
    const start = source.indexOf("function AdjustItemDialog");
    const body = source.slice(start);
    expect(body).toContain(
      '<SelectItem value="none">Damaged / lost (no stock returned)</SelectItem>',
    );
    expect(body).toContain(
      '<SelectItem value="restore">Correction — less was actually issued (stock restored)</SelectItem>',
    );
    expect(body).toContain(
      '<SelectItem value="deduct">Correction — more was actually issued (stock deducted further)</SelectItem>',
    );
  });
});

describe("History — actor name resolved via a separate profiles lookup (existing app convention), no accounting side effects implied in the UI", () => {
  it("resolves actor names the same way the existing payment-refund history already does (separate profiles query + client-side map)", () => {
    expect(source).toContain('queryKey: ["reservation-item-distribution-actors"');
    expect(source).toMatch(/const actorName = \(userId: string \| null\) =>/);
  });

  it("shows outstanding quantity per issue row, computed via the shared outstandingFor() helper", () => {
    expect(source).toMatch(/function outstandingFor\(issueRow: any, allRows: any\[\]\): number/);
    expect(source).toContain("outstandingFor(d, rows)");
  });

  it("never renders a folio/charge amount on a distribution row -- this feature is not billing", () => {
    const start = source.indexOf("function ItemDistributionSection");
    const end = source.indexOf("function IssueItemDialog");
    const body = source.slice(start, end);
    expect(body).not.toMatch(/reservation_charges|toFixed\(2\)\s*<\/div>\s*.*currency/i);
  });
});
