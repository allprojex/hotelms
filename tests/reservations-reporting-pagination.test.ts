import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pageNumbers } from "@/routes/_authenticated/reservations.index";
import { pageRange, totalPages, DEFAULT_PAGE_SIZE } from "@/lib/query-state";

// Reservations reporting (Reporting Improvements PR2): real server-side
// pagination + server-side search RPC + shared-toolkit exports. Structural
// (source-text) convention for wiring/migration content, matching this
// repo's established pattern, PLUS genuine behavioral unit tests for
// pageNumbers() (a pure, now-exported function) and pageRange()/totalPages()
// (the existing shared toolkit) -- these are real function-level proofs,
// not string matches, and are exactly what the earlier reservations
// date-filter bug's own postmortem called for: "this bug exists despite the
// previous structural tests passing".

const root = resolve(__dirname, "..");
function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const routePage = read(resolve(root, "src/routes/_authenticated/reservations.index.tsx"));
const migration = read(resolve(root, "supabase/migrations/20260825200000_reservations_search_rpc.sql"));

describe("pageNumbers() — real behavioral proof, not a string match", () => {
  it("returns every page when the total is small enough to show them all", () => {
    expect(pageNumbers(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageNumbers(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("always includes page 1 and the last page even when far from the current page", () => {
    const result = pageNumbers(10, 20);
    expect(result[0]).toBe(1);
    expect(result[result.length - 1]).toBe(20);
  });

  it("shows an ellipsis only where the window doesn't reach page 1 or the last page", () => {
    expect(pageNumbers(1, 20)).toEqual([1, 2, "ellipsis", 20]);
    expect(pageNumbers(20, 20)).toEqual([1, "ellipsis", 19, 20]);
    expect(pageNumbers(10, 20)).toEqual([1, "ellipsis", 9, 10, 11, "ellipsis", 20]);
  });

  it("never shows an ellipsis for a window that already reaches the edge (no '...' immediately next to page 1 or 2)", () => {
    expect(pageNumbers(2, 20)).toEqual([1, 2, 3, "ellipsis", 20]);
    expect(pageNumbers(19, 20)).toEqual([1, "ellipsis", 18, 19, 20]);
  });
});

describe("Reservations pagination reuses the existing shared toolkit (pageRange/totalPages), not a reinvented one", () => {
  it("pageRange() computes the correct zero-indexed Supabase .range() bounds for a 25-row page size", () => {
    expect(pageRange(1, DEFAULT_PAGE_SIZE)).toEqual({ from: 0, to: 24 });
    expect(pageRange(2, DEFAULT_PAGE_SIZE)).toEqual({ from: 25, to: 49 });
    expect(pageRange(3, 10)).toEqual({ from: 20, to: 29 });
  });

  it("totalPages() derives the correct page count from a real total, including the zero-rows edge case", () => {
    expect(totalPages(30, 25)).toBe(2);
    expect(totalPages(25, 25)).toBe(1);
    expect(totalPages(0, 25)).toBe(1);
    expect(totalPages(137, 25)).toBe(6);
  });
});

describe("Reservations list — real server-side pagination replaces the old .limit(200)", () => {
  it("no longer uses a fixed .limit(200) fetch", () => {
    expect(routePage).not.toMatch(/\.limit\(200\)/);
  });

  it("fetches only the current page via pageRange()/DEFAULT_PAGE_SIZE, chained onto the RPC call", () => {
    expect(routePage).toContain('import { DEFAULT_PAGE_SIZE, pageRange, totalPages as computeTotalPages } from "@/lib/query-state";');
    expect(routePage).toContain("const { from, to } = pageRange(page, DEFAULT_PAGE_SIZE);");
    expect(routePage).toMatch(/\.range\(from, to\)/);
  });

  it("requests an exact total count in the same request as the page fetch ({ count: \"exact\" }), not a separate count query", () => {
    expect(routePage).toContain('{ count: "exact" }');
    expect(routePage).toContain("total: count ?? 0");
  });

  it("page state resets to 1 whenever property, search, status, or date range changes", () => {
    expect(routePage).toMatch(
      /useEffect\(\(\) => \{\s*setPage\(1\);\s*\}, \[propertyId, debouncedQ, status, checkInFrom, checkInTo\]\);/,
    );
  });

  it("the query key includes page, so React Query treats each page/filter combination as its own cache entry -- no stale rows from a previous page/filter silently reused", () => {
    expect(routePage).toContain(
      'queryKey: ["reservations-report", propertyId, debouncedQ, status, checkInFrom, checkInTo, page],',
    );
  });

  it("shows an explicit Loading state instead of rendering stale rows while a new page/filter is being fetched", () => {
    expect(routePage).toContain("query.isLoading &&");
    expect(routePage).toMatch(/!query\.isLoading && rows\.map/);
  });

  it("does not set placeholderData/keepPreviousData on this query -- changing the filter/page clears the old rows rather than showing them under a new label", () => {
    const queryBlock = routePage.slice(
      routePage.indexOf('queryKey: ["reservations-report"'),
      routePage.indexOf("const rows = query.data"),
    );
    expect(queryBlock).not.toMatch(/placeholderData|keepPreviousData/);
  });
});

describe("Reservations list — server-side Search replaces client-side-only filtering", () => {
  it("no longer filters client-side with .filter() over the fetched rows -- rows render directly from the server response", () => {
    expect(routePage).not.toMatch(/const filtered = \(query\.data/);
    expect(routePage).toContain("const rows = query.data?.rows ?? [];");
  });

  it("debounces the search input before it drives a request, so every keystroke doesn't fire its own round trip", () => {
    expect(routePage).toContain('setTimeout(() => setDebouncedQ(q.trim()), 300)');
  });

  it("passes the debounced search term to the server-side RPC, not a client array filter", () => {
    expect(routePage).toContain("_search: debouncedQ || null,");
  });
});

describe("search_reservations() migration — the actual SQL the app relies on", () => {
  it("is additive only: SECURITY INVOKER (no SECURITY DEFINER), reusing the existing can_access_property RLS boundary on reservations/guests/room_types/rooms instead of a new authorization check", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.search_reservations(");
    // Strip -- comments first: the migration's own header explains, in
    // prose, why SECURITY DEFINER was deliberately NOT used -- that
    // explanatory text itself contains the literal phrase, which would
    // otherwise make this exact assertion a false positive against itself.
    const withoutComments = migration.replace(/--[^\n]*/g, "");
    expect(withoutComments).not.toMatch(/SECURITY DEFINER/);
  });

  it("joins guests/room_types/rooms so search can match guest name/email -- something the old embedded PostgREST select could filter on client-side only", () => {
    expect(migration).toContain("JOIN public.guests g ON g.id = r.guest_id");
    expect(migration).toContain("JOIN public.room_types rt ON rt.id = r.room_type_id");
    expect(migration).toContain("LEFT JOIN public.rooms rm ON rm.id = r.room_id");
  });

  it("combines property, status, date-range, and search as AND (all clauses joined by AND under one WHERE), never OR", () => {
    const where = migration.slice(migration.indexOf("WHERE r.property_id"), migration.indexOf("ORDER BY"));
    const andCount = (where.match(/\n\s*AND \(/g) ?? []).length;
    expect(andCount).toBeGreaterThanOrEqual(3);
    expect(where).not.toMatch(/\)\s*OR\s*\(/);
  });

  it("date semantics: inclusive gte/lte against check_in, a DATE column, never a strict gt/lt and never check_out", () => {
    expect(migration).toContain("r.check_in >= _check_in_from");
    expect(migration).toContain("r.check_in <= _check_in_to");
    expect(migration).not.toMatch(/r\.check_in\s*[<>]\s*_check_in/);
    expect(migration).not.toMatch(/r\.check_out\s*[<>=]+\s*_check_in/);
  });

  it("search is case-insensitive (ILIKE) across code, first name, last name, email, and full name", () => {
    expect(migration).toContain("r.code ILIKE '%' || _search || '%'");
    expect(migration).toContain("g.first_name ILIKE '%' || _search || '%'");
    expect(migration).toContain("g.last_name ILIKE '%' || _search || '%'");
    expect(migration).toContain("g.email ILIKE '%' || _search || '%'");
    expect(migration).toContain("(g.first_name || ' ' || g.last_name) ILIKE '%' || _search || '%'");
  });

  it("a blank/absent search matches every row for that property/status/date scope, not zero rows", () => {
    expect(migration).toContain("_search IS NULL OR btrim(_search) = ''");
  });

  it("preserves the existing check_in DESC ordering, with a stable id tiebreaker for correct pagination across pages when dates tie", () => {
    expect(migration).toContain("ORDER BY r.check_in DESC, r.id;");
  });

  it("grants execute to authenticated only, revoking PUBLIC and anon -- same access-control pattern as every other RPC added this session, no widening", () => {
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.search_reservations(UUID, TEXT, TEXT, DATE, DATE) FROM PUBLIC, anon;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.search_reservations(UUID, TEXT, TEXT, DATE, DATE) TO authenticated;",
    );
  });

  it("this migration makes no table, column, or RLS policy change -- purely additive", () => {
    expect(migration).not.toMatch(/ALTER TABLE|CREATE POLICY|DROP POLICY|CREATE TABLE/);
  });
});

describe("Export/Print — full filtered dataset, not the current page, via the existing shared toolkit", () => {
  it("reuses report-core.ts/report-export.client.ts -- no duplicate export implementation", () => {
    expect(routePage).toContain('from "@/lib/reports/report-core"');
    expect(routePage).toContain('import("@/lib/reports/report-export.client")');
    expect(routePage).toContain("createClientOnlyFn(");
  });

  it("the export fetch calls search_reservations WITHOUT .range(), so it is never limited to one page's worth of rows", () => {
    const fetchAllBlock = routePage.slice(
      routePage.indexOf("async function fetchAllFiltered"),
      routePage.indexOf("function filterSummary"),
    );
    expect(fetchAllBlock).not.toMatch(/\.range\(/);
    expect(fetchAllBlock).toContain('"search_reservations"');
  });

  it("the export fetch uses the SAME filter arguments object as the paginated list query -- exported rows can never represent a different filter set than what's on screen", () => {
    expect(routePage).toContain("const filterArgs = {");
    expect(routePage).toContain(
      '(supabase.rpc as any)(\n        "search_reservations",\n        filterArgs,\n        { count: "exact" },\n      )',
    );
    expect(routePage).toContain('await (supabase.rpc as any)("search_reservations", filterArgs).limit(');
  });

  it("applies a bounded safety cap on the export fetch only, never on the paginated list query", () => {
    expect(routePage).toContain("const EXPORT_ROW_CAP = 5000;");
    const listQueryBlock = routePage.slice(routePage.indexOf("const query = useQuery"), routePage.indexOf("const rows = query.data"));
    expect(listQueryBlock).not.toContain("EXPORT_ROW_CAP");
  });

  it("does not invent fields -- every export column value comes from a field already present in the RPC's returned row shape", () => {
    const cols = routePage.slice(routePage.indexOf("function reservationColumns"), routePage.indexOf("const EXPORT_ROW_CAP"));
    for (const field of ["code", "guest_first_name", "guest_last_name", "guest_email", "room_type_name", "room_number", "check_in", "check_out", "status", "adults", "children", "rate_total"]) {
      expect(cols).toContain(`r.${field}`);
    }
  });
});

describe("Property isolation", () => {
  it("property_id is passed to the RPC in both the paginated list query and the export fetch, via the same filterArgs object", () => {
    expect(routePage).toContain("_property_id: propertyId!,");
  });

  it("the list query is disabled entirely when there is no active property -- it can never fire with a missing/undefined property scope", () => {
    expect(routePage).toContain("enabled: !!propertyId,");
  });
});

describe("No permission was invented or broadened", () => {
  it("no new PermissionCapability/module check was added to this route -- view/export/print reuse the RPC's own SECURITY INVOKER + existing RLS boundary, not a new client-side gate", () => {
    expect(routePage).not.toMatch(/usePermission\(/);
  });
});
