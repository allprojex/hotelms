import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// This test suite has no jsdom/React Testing Library setup (vitest.config.ts
// runs with environment: "node" and no other test in this repo renders a
// component) — see tests/accounting-nav-hierarchy.test.ts for the existing,
// established precedent of asserting UI/wiring correctness by reading and
// pattern-matching the component source instead of rendering it. These
// tests follow that same convention for the new dashboard search feature,
// on top of the pure-function coverage in tests/search-filter.test.ts.

const searchComponent = readFileSync(
  resolve(__dirname, "../src/components/dashboard-search.tsx"),
  "utf8",
);
const dashboardRoute = readFileSync(
  resolve(__dirname, "../src/routes/_authenticated/dashboard.tsx"),
  "utf8",
);

describe("Dashboard search — property scoping (no unauthorized/cross-property leakage)", () => {
  it("scopes every query it makes to the active property, same as the existing list pages", () => {
    // Mirrors reservations.index.tsx / guests.index.tsx / rooms.index.tsx's
    // own .eq("property_id", propertyId) convention exactly — a user can
    // only ever see rows their existing RLS + list pages already show them.
    expect(searchComponent).toMatch(
      /\.from\("reservations"\)[\s\S]{0,200}\.eq\("property_id",\s*propertyId\)/,
    );
    expect(searchComponent).toMatch(
      /\.from\("guests"\)[\s\S]{0,200}\.eq\("property_id",\s*propertyId\)/,
    );
    expect(searchComponent).toMatch(
      /\.from\("rooms"\)[\s\S]{0,200}\.eq\("property_id",\s*propertyId\)/,
    );
  });

  it("does not query with the service role or bypass RLS in any way", () => {
    expect(searchComponent).not.toMatch(/service_role/i);
    expect(searchComponent).not.toMatch(/SUPABASE_SERVICE_ROLE/);
  });

  it("reuses the same React Query cache keys as the existing reservations/guests/rooms list pages", () => {
    // Deliberate reuse, not a new search backend: opening the dialog after
    // visiting /reservations or /guests hits warm cache instead of a new
    // query, and the underlying permission/RLS surface is identical.
    expect(searchComponent).toContain('queryKey: ["guests", propertyId]');
    expect(searchComponent).toContain('queryKey: ["rooms", propertyId]');
    expect(searchComponent).toMatch(/queryKey:\s*\["reservations",\s*propertyId/);
  });

  it("only fetches once the dialog is open and a property is active (no eager unscoped fetch)", () => {
    expect(searchComponent).toMatch(/enabled:\s*open\s*&&\s*!!propertyId/);
  });
});

describe("Dashboard search — UI requirements", () => {
  it("is keyboard accessible via a Ctrl/Cmd+K shortcut", () => {
    expect(searchComponent).toMatch(/e\.metaKey\s*\|\|\s*e\.ctrlKey/);
    expect(searchComponent).toMatch(/key\.toLowerCase\(\)\s*===\s*"k"/);
  });

  it("uses the existing Command/Dialog design-system primitives rather than inventing new ones", () => {
    expect(searchComponent).toMatch(/from "@\/components\/ui\/command"/);
    expect(searchComponent).toContain("CommandDialog");
    expect(searchComponent).toContain("CommandInput");
    expect(searchComponent).toContain("CommandEmpty");
  });

  it("has a loading state and a no-results empty state", () => {
    expect(searchComponent).toMatch(/isLoading/);
    expect(searchComponent).toContain("CommandEmpty");
  });

  it("navigates results to real, existing routes (no fabricated detail pages)", () => {
    // guests/$id and reservations/$id both exist as real routes in this
    // repo; rooms has no per-room detail route, so room results correctly
    // link to the rooms list rather than a made-up detail page.
    expect(searchComponent).toContain('to: "/reservations/$id"');
    expect(searchComponent).toContain('to: "/guests/$id"');
    expect(searchComponent).toContain('to: "/rooms"');
  });

  it("is wired into the dashboard page", () => {
    expect(dashboardRoute).toContain(
      'import { DashboardSearch } from "@/components/dashboard-search"',
    );
    expect(dashboardRoute).toMatch(/<DashboardSearch propertyId={propertyId}\s*\/>/);
  });

  it("regression: CommandItem value is built from human-matchable search text, not an opaque id-only string", () => {
    // cmdk's Command primitive does its OWN internal filtering of
    // CommandItems based on their `value` prop (independent of our own
    // matchesSearch() pre-filter above). A live production check confirmed
    // that setting value={`reservation-${r.id}`} (an opaque UUID string
    // that never contains what a human types) made cmdk silently hide every
    // item for every query — the dialog rendered blank instead of results
    // OR a "no results" message, because our own hasResults check (based on
    // the correct pre-filtered arrays) suppressed CommandEmpty while cmdk's
    // separate filter hid the actual CommandItems. Fixed by building value
    // from the same search-text helpers matchesSearch() itself uses, with
    // the id appended only to keep it unique — never a bare id-based value.
    expect(searchComponent).toMatch(/value=\{`\$\{reservationSearchText\(r\)\} \$\{r\.id\}`\}/);
    expect(searchComponent).toMatch(/value=\{`\$\{guestSearchText\(g\)\} \$\{g\.id\}`\}/);
    expect(searchComponent).toMatch(/value=\{`\$\{roomSearchText\(r\)\} \$\{r\.id\}`\}/);
    expect(searchComponent).not.toMatch(/value=\{`reservation-\$\{r\.id\}`\}/);
    expect(searchComponent).not.toMatch(/value=\{`guest-\$\{g\.id\}`\}/);
    expect(searchComponent).not.toMatch(/value=\{`room-\$\{r\.id\}`\}/);
  });
});
