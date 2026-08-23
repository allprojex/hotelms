import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Source-convention tests (see accounting-nav-hierarchy.test.ts for the
// established precedent — this repo's vitest runs with environment: "node",
// no jsdom/React Testing Library, so UI/wiring correctness is verified by
// reading and pattern-matching component source rather than rendering it).
// Complements the pure-function coverage in tests/search-filter.test.ts.
//
// This search was originally mounted inside the Dashboard page itself
// (tests/dashboard-search.test.ts, now removed) and has been moved to
// TopBar so it's reachable from every authenticated page, not just
// /dashboard — see the "HOTEL PMS — FINISH SEARCH REQUIREMENT COMPLETELY"
// Phase B audit finding.

const searchComponent = readFileSync(
  resolve(__dirname, "../src/components/global-search.tsx"),
  "utf8",
);
const topBar = readFileSync(resolve(__dirname, "../src/components/top-bar.tsx"), "utf8");
const dashboardRoute = readFileSync(
  resolve(__dirname, "../src/routes/_authenticated/dashboard.tsx"),
  "utf8",
);

describe("Global search — mounted in TopBar (every authenticated page), not just Dashboard", () => {
  it("TopBar imports and renders GlobalSearch", () => {
    expect(topBar).toContain('import { GlobalSearch } from "@/components/global-search"');
    expect(topBar).toMatch(/<GlobalSearch\s*\/>/);
  });

  it("the dashboard-local search trigger has been removed (one clear global trigger, not two)", () => {
    expect(dashboardRoute).not.toContain("DashboardSearch");
    expect(dashboardRoute).not.toContain("dashboard-search");
  });

  it("only one keydown listener is registered for the Ctrl/Cmd+K shortcut in the whole component (no duplicate handlers)", () => {
    const addListenerCount = (searchComponent.match(/addEventListener\("keydown"/g) ?? []).length;
    expect(addListenerCount).toBe(1);
    const removeListenerCount = (searchComponent.match(/removeEventListener\("keydown"/g) ?? [])
      .length;
    expect(removeListenerCount).toBe(1);
  });

  it("is keyboard accessible via a Ctrl/Cmd+K shortcut", () => {
    expect(searchComponent).toMatch(/e\.metaKey\s*\|\|\s*e\.ctrlKey/);
    expect(searchComponent).toMatch(/key\.toLowerCase\(\)\s*===\s*"k"/);
  });
});

describe("Global search — property scoping (no unauthorized/cross-property leakage)", () => {
  it("reads the active property itself via useActiveProperty(), reacting to property switches anywhere in the app", () => {
    // Self-contained: no propertyId prop threaded in from TopBar. Since
    // useActiveProperty() listens for the same "iti-property-changed"/
    // "storage" events TopBar's own property switcher dispatches, switching
    // property from the TopBar automatically rescopes search results —
    // without this component needing any extra wiring.
    expect(searchComponent).toContain(
      'import { useActiveProperty } from "@/hooks/use-active-property"',
    );
    expect(searchComponent).toContain("const propertyId = useActiveProperty();");
  });

  it("scopes every query it makes to the active property, same as the existing list pages", () => {
    expect(searchComponent).toMatch(
      /\.from\("reservations"\)[\s\S]{0,200}\.eq\("property_id",\s*propertyId!\)/,
    );
    expect(searchComponent).toMatch(
      /\.from\("guests"\)[\s\S]{0,200}\.eq\("property_id",\s*propertyId!\)/,
    );
    expect(searchComponent).toMatch(
      /\.from\("rooms"\)[\s\S]{0,200}\.eq\("property_id",\s*propertyId!\)/,
    );
  });

  it("does not query with the service role or bypass RLS in any way", () => {
    expect(searchComponent).not.toMatch(/service_role/i);
    expect(searchComponent).not.toMatch(/SUPABASE_SERVICE_ROLE/);
  });

  it("reuses the same React Query cache keys as the existing reservations/guests/rooms list pages", () => {
    expect(searchComponent).toContain('queryKey: ["guests", propertyId]');
    expect(searchComponent).toContain('queryKey: ["rooms", propertyId]');
    expect(searchComponent).toMatch(/queryKey:\s*\["reservations",\s*propertyId/);
  });

  it("only fetches once the dialog is open and a property is active (no eager unscoped fetch)", () => {
    expect(searchComponent).toMatch(/enabled:\s*open\s*&&\s*!!propertyId/);
  });

  it("shows a clear message rather than silently empty results when no property is active yet", () => {
    expect(searchComponent).toMatch(/!propertyId[\s\S]{0,150}Select a property first/);
  });
});

describe("Global search — UI requirements", () => {
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
    expect(searchComponent).toContain('to: "/reservations/$id"');
    expect(searchComponent).toContain('to: "/guests/$id"');
    expect(searchComponent).toContain('to: "/rooms"');
  });

  it("CommandItem value is built from human-matchable search text, not an opaque id-only string (cmdk internal-filter regression)", () => {
    expect(searchComponent).toMatch(/value=\{`\$\{reservationSearchText\(r\)\} \$\{r\.id\}`\}/);
    expect(searchComponent).toMatch(/value=\{`\$\{guestSearchText\(g\)\} \$\{g\.id\}`\}/);
    expect(searchComponent).toMatch(/value=\{`\$\{roomSearchText\(r\)\} \$\{r\.id\}`\}/);
  });

  it("is responsive: an icon-only trigger below the sm breakpoint, full button with label at sm+, keyboard-shortcut hint only at md+", () => {
    expect(searchComponent).toMatch(/className="text-muted-foreground sm:hidden"/);
    expect(searchComponent).toMatch(
      /className="hidden gap-2 text-muted-foreground sm:inline-flex"/,
    );
    expect(searchComponent).toMatch(/md:inline-flex/);
  });

  it("does not clutter the TopBar — exactly one Search-triggering element pair (icon + labeled button), not a whole new toolbar section", () => {
    const buttonCount = (searchComponent.match(/<Button/g) ?? []).length;
    expect(buttonCount).toBe(2); // icon-only (mobile) + labeled (desktop) variants of the same trigger
  });
});

describe("Global search — TopBar's other controls are preserved", () => {
  it("still renders the property selector, notifications, theme toggle, and user menu", () => {
    expect(topBar).toContain("Select property");
    expect(topBar).toContain("NotificationBell");
    expect(topBar).toContain('aria-label="Toggle theme"');
    expect(topBar).toContain("Sign out");
  });
});
