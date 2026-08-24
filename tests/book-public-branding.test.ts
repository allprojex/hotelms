import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Regression coverage for "Public Booking Branding Integration" (Phase 1
// follow-up bug fix): the five public booking routes previously hardcoded
// the literal string "ThesKwoff Hotel" in their header and page title,
// even though the booking flow lets a shopper pick between multiple
// properties, and even though book.confirmation.$code.tsx already showed
// the real booked property's name a few lines below the hardcoded header.
//
// This suite follows the same structural (source-text) convention as
// tests/branding-phase1.test.ts and tests/ar-credit-notes-ui.test.ts —
// there is no jsdom/rendering environment in this repo's vitest config
// (see vitest.config.ts: environment: "node"), so behavioral claims are
// proven by inspecting the exact expressions each route evaluates, not by
// mounting components. Cross-property isolation is proven the same way
// branding-phase1.test.ts proves storage RLS isolation: by showing the
// displayed value is read from a query scoped by the differentiating key
// (propertyId, or confirmation code+email) rather than from any shared/
// global cache entry — live behavioral proof of RLS/query-cache isolation
// itself is out of scope for a source-level test.

const root = resolve(__dirname, "..");
function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const bookIndex = read(resolve(root, "src/routes/book.index.tsx"));
const bookResults = read(resolve(root, "src/routes/book.results.tsx"));
const bookCheckout = read(resolve(root, "src/routes/book.checkout.$roomTypeId.tsx"));
const bookManage = read(resolve(root, "src/routes/book.manage.tsx"));
const bookConfirmation = read(resolve(root, "src/routes/book.confirmation.$code.tsx"));
const authRoute = read(resolve(root, "src/routes/auth.tsx"));

const ALL_ROUTES: Record<string, string> = {
  "book.index.tsx": bookIndex,
  "book.results.tsx": bookResults,
  "book.checkout.$roomTypeId.tsx": bookCheckout,
  "book.manage.tsx": bookManage,
  "book.confirmation.$code.tsx": bookConfirmation,
};

describe("Public booking branding — no unconditional hardcoded hotel name remains", () => {
  it("none of the five routes' static head() title contains a hardcoded tenant name (mirrors the auth.tsx precedent of a neutral pre-hydration title)", () => {
    for (const [name, source] of Object.entries(ALL_ROUTES)) {
      const headBlock = source.match(/head: \(\) => \(\{[\s\S]*?\}\),/)?.[0] ?? "";
      expect(headBlock, `${name} has no head() block`).not.toBe("");
      expect(headBlock, `${name} head() still hardcodes a tenant name`).not.toMatch(
        /ThesKwoff Hotel/,
      );
    }
  });

  it("none of the five routes has an unconditional (non-fallback) hardcoded 'ThesKwoff Hotel' JSX text node in the header — the only remaining occurrences are the final literal fallback of a resolution chain, exactly like auth.tsx's own `brand?.app_name || \"ThesKwoff Hotel\"`", () => {
    for (const [name, source] of Object.entries(ALL_ROUTES)) {
      // An unconditional hardcode would appear as raw JSX text directly
      // inside a tag, e.g. >ThesKwoff Hotel< with no preceding `||`
      // fallback-chain expression on the same logical value.
      expect(source, `${name} still has an unconditional hardcoded header string`).not.toMatch(
        />ThesKwoff Hotel</,
      );
      // Every remaining literal mention must be the last link of a
      // `someExpr || "ThesKwoff Hotel"` fallback chain (this also matches
      // the pre-existing, already-tested auth.tsx and brand-mark.tsx
      // pattern, so this isn't a new convention).
      const mentions = source.match(/[^\n]*ThesKwoff Hotel[^\n]*/g) ?? [];
      for (const line of mentions) {
        expect(line, `${name}: "${line.trim()}" is not a fallback-chain expression`).toMatch(
          /\|\|\s*"ThesKwoff Hotel"/,
        );
      }
    }
  });

  it("the fallback-chain convention used here matches the one already established (and tested) on the login page", () => {
    expect(authRoute).toContain('brand?.app_name || "ThesKwoff Hotel"');
  });
});

describe("Public booking branding — book.index.tsx (stage 1: no property known)", () => {
  it("imports and calls useBrandSettings (organisation-wide, property-agnostic — matches the login page's own justification for using this hook rather than useEffectiveBranding)", () => {
    expect(bookIndex).toContain('import { useBrandSettings } from "@/hooks/use-brand-settings";');
    expect(bookIndex).toContain("const { data: brand } = useBrandSettings();");
  });

  it("never imports or calls useEffectiveBranding — there is no active authenticated property context on this page", () => {
    expect(bookIndex).not.toMatch(/useEffectiveBranding/);
  });

  it("renders the header name from the global brand fallback chain", () => {
    expect(bookIndex).toContain('{brand?.app_name || "ThesKwoff Hotel"}');
  });
});

describe("Public booking branding — book.results.tsx and book.checkout.$roomTypeId.tsx (stage 2: property known via the public properties row already fetched on the page)", () => {
  const cases: Array<[string, string]> = [
    ["book.results.tsx", bookResults],
    ["book.checkout.$roomTypeId.tsx", bookCheckout],
  ];

  it("both still fetch the property row from the public, anon-readable properties table (properties_public_read RLS), scoped by the route's own propertyId — no new query/table introduced", () => {
    for (const [name, source] of cases) {
      expect(source, name).toContain('.from("properties")');
      expect(source, name).toContain('.eq("id", propertyId)');
      expect(source, name).toContain('queryKey: ["public-prop", propertyId]');
    }
  });

  it("both resolve the header name as property name -> global brand -> literal fallback, in that order, and never call useEffectiveBranding (no authenticated property context exists on a public route)", () => {
    for (const [name, source] of cases) {
      expect(source, name).toContain(
        '{property.data?.name || brand?.app_name || "ThesKwoff Hotel"}',
      );
      expect(source, name).not.toMatch(/useEffectiveBranding/);
    }
  });

  it("both import useBrandSettings for the pre-load/fallback stage", () => {
    for (const [name, source] of cases) {
      expect(source, name).toContain(
        'import { useBrandSettings } from "@/hooks/use-brand-settings";',
      );
    }
  });
});

describe("Public booking branding — book.manage.tsx and book.confirmation.$code.tsx (stage 3: property known only once a specific booking is looked up)", () => {
  const cases: Array<[string, string]> = [
    ["book.manage.tsx", bookManage],
    ["book.confirmation.$code.tsx", bookConfirmation],
  ];

  it("both resolve the header name from booking.data.property_name -> global brand -> literal fallback, never a fabricated or generic property source", () => {
    for (const [name, source] of cases) {
      expect(source, name).toContain(
        '{booking.data?.property_name || brand?.app_name || "ThesKwoff Hotel"}',
      );
    }
  });

  it("both source booking.data from a query keyed by the confirmation code AND email together — a different booking (different code/email) is structurally a different cache entry, so one booking's resolved property name cannot leak into another's render", () => {
    expect(bookManage).toContain('queryKey: ["manage-lookup", code, email]');
    expect(bookConfirmation).toContain('queryKey: ["booking-lookup", code, email]');
  });

  it("both call the existing public booking_lookup RPC — no new query, table, or branding source was introduced for this stage", () => {
    for (const [name, source] of cases) {
      expect(source, name).toContain('.rpc("booking_lookup"');
    }
  });
});

describe("Public booking branding — confirmation-page header/body consistency (the specific bug named in the audit)", () => {
  it("the header and the 'Hotel' detail row read the exact same field (booking.data.property_name) from the exact same query result — they cannot disagree because there is only one value, read twice", () => {
    const propertyNameMentions = (bookConfirmation.match(/booking\.data\??\.property_name/g) ?? [])
      .length;
    // One in the header fallback chain (booking.data?.property_name), one
    // in the "Hotel" detail row (booking.data.property_name — no `?.`
    // there since it's already inside a `{booking.data && (...)}` guard).
    expect(propertyNameMentions).toBeGreaterThanOrEqual(2);
    expect(bookConfirmation).toContain(
      '<span className="text-muted-foreground">Hotel</span><span>{booking.data.property_name}</span>',
    );
  });

  it("no second, independent hotel-name source exists on the confirmation page (e.g. a global brand name rendered unconditionally alongside the property name) that could disagree with it", () => {
    // The only other name source is the fallback chain itself, which only
    // ever applies before booking.data has loaded — not a competing value
    // shown at the same time as the resolved property name.
    const headerLine =
      bookConfirmation.match(
        /<span className="font-display font-semibold text-sm">[\s\S]*?<\/span>/,
      )?.[0] ?? "";
    expect(headerLine).toContain("booking.data?.property_name");
  });
});

describe("Public booking branding — logo stays the existing global BrandMark (unchanged, not a new per-property logo source)", () => {
  it("every route still renders BrandMark with no override props — this fix only corrects the adjacent name text, it does not introduce property-specific logo switching on public routes (get_effective_branding is not anon-executable)", () => {
    for (const [name, source] of Object.entries(ALL_ROUTES)) {
      expect(source, name).toMatch(/<BrandMark className="h-7 w-auto" \/>/);
      expect(source, name).not.toMatch(/<BrandMark[^>]*logoUrl=/);
    }
  });
});

describe("Public booking branding — no new source of truth introduced", () => {
  it("none of the five routes reference property_branding, get_effective_branding, or useEffectiveBranding — the fix reuses only the pre-existing global brand hook and each page's own already-loaded public property/booking data", () => {
    for (const [name, source] of Object.entries(ALL_ROUTES)) {
      expect(source, name).not.toMatch(/property_branding/);
      expect(source, name).not.toMatch(/get_effective_branding/);
      expect(source, name).not.toMatch(/useEffectiveBranding/);
    }
  });
});
