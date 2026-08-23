import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Source-convention tests (no jsdom/RTL in this repo's test setup -- see
// tests/global-search.test.ts's header for the established precedent).

const source = readFileSync(
  resolve(__dirname, "../src/routes/_authenticated/reservations.$id.tsx"),
  "utf8",
);

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
    const start = source.indexOf("function ItemDistributionPicker");
    const body = source.slice(start, start + 1500);
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
    const start = source.indexOf("function ItemDistributionPicker");
    const body = source.slice(start, start + 2000);
    expect(body).toContain("shouldFilter={false}");
    expect(body).toMatch(/value=\{`\$\{inventoryItemSearchText\(it\)\} \$\{it\.id\}`\}/);
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
