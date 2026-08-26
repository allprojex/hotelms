import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  filterScopeKey,
  pageRange,
  scopedPage,
  type ScopedPage,
} from "@/lib/query-state";

// Production defect (found during the PR #79 release verification): on page 2,
// changing a filter that shrank the result set issued ONE request for the old
// page-2 range before the page reset to 1. PostgREST answered 416 Range Not
// Satisfiable. The UI recovered, but the request should never have gone out.
//
// These tests model the request stream a render pass produces -- every
// (filter scope, page) pair that reaches a query key becomes one recorded
// request with its concrete .range(from, to) -- and assert on those ranges.
// They do not assert that "setPage(1)" appears in the source: the OLD design
// contained exactly that call and still shipped the bug, which is why the
// legacy model below is included and proven to fail.

type Filters = {
  propertyId: string;
  search: string;
  status: string;
  checkInFrom: string | null;
  checkInTo: string | null;
};

type Request = { scope: string; page: number; from: number; to: number };

const BASE: Filters = {
  propertyId: "prop-a",
  search: "",
  status: "all",
  checkInFrom: null,
  checkInTo: null,
};

const scopeOf = (f: Filters) =>
  filterScopeKey([f.propertyId, f.search, f.status, f.checkInFrom, f.checkInTo]);

/**
 * The SHIPPED design: the page is stored with the scope it was chosen in and
 * read back through scopedPage(), so a filter change resets it by derivation
 * during the same render.
 */
class ScopedList {
  requests: Request[] = [];
  private state: ScopedPage = { scope: "", page: 1 };
  private lastKey = "";

  /** One React render with the given filters; records any request it issues. */
  render(filters: Filters): number {
    const scope = scopeOf(filters);
    const page = scopedPage(this.state, scope);
    const key = `${scope}#${page}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      const { from, to } = pageRange(page, DEFAULT_PAGE_SIZE);
      this.requests.push({ scope, page, from, to });
    }
    return page;
  }

  /** A pagination click, then the re-render it causes. */
  goToPage(filters: Filters, page: number): void {
    this.state = { scope: scopeOf(filters), page };
    this.render(filters);
  }

  get last(): Request {
    return this.requests[this.requests.length - 1];
  }
}

/**
 * The LEGACY design, kept only as a control: the page was its own state and a
 * useEffect reset it AFTER the render that had already queried. Modelled
 * faithfully -- render first (request goes out), effects afterwards.
 */
class EffectResetList {
  requests: Request[] = [];
  private page = 1;
  private lastScopeSeenByEffect = "";
  private lastKey = "";

  render(filters: Filters): void {
    const scope = scopeOf(filters);
    const key = `${scope}#${this.page}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      const { from, to } = pageRange(this.page, DEFAULT_PAGE_SIZE);
      this.requests.push({ scope, page: this.page, from, to });
    }
    // Effects run after the commit above.
    if (scope !== this.lastScopeSeenByEffect) {
      this.lastScopeSeenByEffect = scope;
      if (this.page !== 1) {
        this.page = 1;
        this.render(filters); // the corrective re-render
      }
    }
  }

  goToPage(filters: Filters, page: number): void {
    this.page = page;
    this.render(filters);
  }
}

const PAGE_1 = { from: 0, to: 24 };
const PAGE_2 = { from: 25, to: 49 };
const PAGE_3 = { from: 50, to: 74 };

/** Every request whose page is not 1 but whose scope differs from the previous request's. */
function staleScopeRequests(requests: Request[]): Request[] {
  return requests.filter((r, i) => i > 0 && r.scope !== requests[i - 1].scope && r.page !== 1);
}

describe("the legacy effect-based reset — control, reproduces the production 416", () => {
  it("issues one request for the OLD page range under the NEW filters", () => {
    const list = new EffectResetList();
    list.render(BASE);
    list.goToPage(BASE, 2);
    list.render({ ...BASE, search: "Mr" }); // user types a search while on page 2

    const stale = staleScopeRequests(list.requests);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ page: 2, ...PAGE_2 });
    // That is the 416: range 25-49 requested against a 13-row result set.
    expect(stale[0].scope).toContain("Mr");
  });
});

describe("A. page 2 -> search change", () => {
  it("the first request under the new search uses the page-1 range", () => {
    const list = new ScopedList();
    list.render(BASE);
    list.goToPage(BASE, 2);
    expect(list.last).toMatchObject({ page: 2, ...PAGE_2 });

    const filters = { ...BASE, search: "Mr" };
    expect(list.render(filters)).toBe(1);
    expect(list.last).toMatchObject({ page: 1, ...PAGE_1 });
    expect(list.last.scope).toBe(scopeOf(filters));
    expect(staleScopeRequests(list.requests)).toEqual([]);
  });
});

describe("B. page 3 -> status change", () => {
  it("the first request under the new status uses the page-1 range", () => {
    const list = new ScopedList();
    list.render(BASE);
    list.goToPage(BASE, 3);
    expect(list.last).toMatchObject({ page: 3, ...PAGE_3 });

    expect(list.render({ ...BASE, status: "checked_out" })).toBe(1);
    expect(list.last).toMatchObject({ page: 1, ...PAGE_1 });
    expect(staleScopeRequests(list.requests)).toEqual([]);
  });
});

describe("C. page 2 -> single check-in date", () => {
  it("the first request under the new date uses the page-1 range", () => {
    const list = new ScopedList();
    list.render(BASE);
    list.goToPage(BASE, 2);

    // A single-day selection sends the same value as from and to.
    const filters = { ...BASE, checkInFrom: "2026-08-25", checkInTo: "2026-08-25" };
    expect(list.render(filters)).toBe(1);
    expect(list.last).toMatchObject({ page: 1, ...PAGE_1 });
    expect(staleScopeRequests(list.requests)).toEqual([]);
  });
});

describe("D. page 2 -> check-in date range", () => {
  it("the first request under the new range uses the page-1 range", () => {
    const list = new ScopedList();
    list.render(BASE);
    list.goToPage(BASE, 2);

    expect(list.render({ ...BASE, checkInFrom: "2026-08-20", checkInTo: "2026-08-25" })).toBe(1);
    expect(list.last).toMatchObject({ page: 1, ...PAGE_1 });
    expect(staleScopeRequests(list.requests)).toEqual([]);
  });

  it("widening an existing range from a deep page also restarts at page 1", () => {
    const list = new ScopedList();
    const narrow = { ...BASE, checkInFrom: "2026-08-24", checkInTo: "2026-08-25" };
    list.render(narrow);
    list.goToPage(narrow, 2);

    expect(list.render({ ...BASE, checkInFrom: "2026-08-01", checkInTo: "2026-08-25" })).toBe(1);
    expect(list.last).toMatchObject({ page: 1, ...PAGE_1 });
  });
});

describe("E. page 2 -> Clear date", () => {
  it("the first request after Clear uses the page-1 range", () => {
    const list = new ScopedList();
    const filtered = { ...BASE, checkInFrom: "2026-08-25", checkInTo: "2026-08-25" };
    list.render(filtered);
    list.goToPage(filtered, 2);
    expect(list.last).toMatchObject({ page: 2, ...PAGE_2 });

    expect(list.render(BASE)).toBe(1); // Clear -> both bounds back to null
    expect(list.last).toMatchObject({ page: 1, ...PAGE_1 });
    expect(staleScopeRequests(list.requests)).toEqual([]);
  });
});

describe("F. page 2 -> active property switch", () => {
  it("the new property's first request starts at page 1", () => {
    const list = new ScopedList();
    list.render(BASE);
    list.goToPage(BASE, 2);

    const other = { ...BASE, propertyId: "prop-b" };
    expect(list.render(other)).toBe(1);
    expect(list.last).toMatchObject({ page: 1, ...PAGE_1 });
    expect(list.last.scope).toContain("prop-b");
    expect(staleScopeRequests(list.requests)).toEqual([]);
  });

  it("no request is ever issued for prop-b at a page chosen under prop-a", () => {
    const list = new ScopedList();
    list.render(BASE);
    list.goToPage(BASE, 3);
    list.render({ ...BASE, propertyId: "prop-b" });

    const propB = list.requests.filter((r) => r.scope.startsWith("prop-b"));
    expect(propB).toHaveLength(1);
    expect(propB[0].page).toBe(1);
  });
});

describe("G. normal pagination with no filter change", () => {
  it("still issues the correct page-2 and page-3 ranges", () => {
    const list = new ScopedList();
    list.render(BASE);
    expect(list.last).toMatchObject({ page: 1, ...PAGE_1 });

    list.goToPage(BASE, 2);
    expect(list.last).toMatchObject({ page: 2, ...PAGE_2 });

    list.goToPage(BASE, 3);
    expect(list.last).toMatchObject({ page: 3, ...PAGE_3 });

    list.goToPage(BASE, 2); // Previous
    expect(list.last).toMatchObject({ page: 2, ...PAGE_2 });

    expect(list.requests.map((r) => r.page)).toEqual([1, 2, 3, 2]);
    expect(staleScopeRequests(list.requests)).toEqual([]);
  });

  it("a page stays put across re-renders that do not change the filters", () => {
    const list = new ScopedList();
    list.render(BASE);
    list.goToPage(BASE, 2);
    list.render(BASE);
    list.render(BASE);
    expect(list.requests).toHaveLength(2); // no duplicate page-2 request
    expect(list.last).toMatchObject({ page: 2, ...PAGE_2 });
  });
});

describe("H. search debounce", () => {
  it("intermediate keystrokes issue nothing; only the debounced value queries", () => {
    const list = new ScopedList();
    list.render(BASE);
    list.goToPage(BASE, 2);
    const before = list.requests.length;

    // The debounced value is what reaches the scope. Keystrokes "M", "Mr",
    // "Mrs" that all settle on "Mrs" produce ONE new scope.
    const settled = { ...BASE, search: "Mrs" };
    list.render(settled);
    list.render(settled);
    list.render(settled);

    expect(list.requests.length - before).toBe(1);
    expect(list.last).toMatchObject({ page: 1, ...PAGE_1 });
  });

  it("clearing the search back to empty returns to the unfiltered scope once", () => {
    const list = new ScopedList();
    list.render(BASE);
    list.render({ ...BASE, search: "Mrs" });
    const n = list.requests.length;
    list.render(BASE);
    list.render(BASE);
    expect(list.requests.length - n).toBe(1);
    expect(list.last.scope).toBe(scopeOf(BASE));
  });

  it("distinct debounced terms each query exactly once, always from page 1", () => {
    const list = new ScopedList();
    list.render(BASE);
    for (const term of ["Mr", "Mrs", "Ms"]) {
      list.render({ ...BASE, search: term });
      expect(list.last).toMatchObject({ page: 1, ...PAGE_1 });
    }
    expect(list.requests).toHaveLength(4);
  });
});

describe("no filter transition can ever emit a stale page range", () => {
  const transitions: Filters[] = [
    BASE,
    { ...BASE, search: "Mr" },
    { ...BASE, search: "Mr", status: "checked_out" },
    {
      ...BASE,
      search: "Mr",
      status: "checked_out",
      checkInFrom: "2026-08-25",
      checkInTo: "2026-08-25",
    },
    { ...BASE, status: "cancelled" },
    { ...BASE, checkInFrom: "2026-08-01", checkInTo: "2026-08-31" },
    { ...BASE, propertyId: "prop-b" },
    BASE,
  ];

  it("walks every transition from a deep page and never leaves page 1 on a new scope", () => {
    const list = new ScopedList();
    for (const filters of transitions) {
      list.render(filters);
      expect(list.last.page).toBe(1); // every new scope starts at page 1
      list.goToPage(filters, 3); // user pages deep before the next change
      expect(list.last).toMatchObject({ page: 3, ...PAGE_3 });
    }
    expect(staleScopeRequests(list.requests)).toEqual([]);
    // Every request is either page 1 on a fresh scope, or a deliberate click.
    expect(list.requests.every((r) => r.from >= 0 && r.to === r.from + DEFAULT_PAGE_SIZE - 1)).toBe(
      true,
    );
  });
});

describe("scopedPage()/filterScopeKey() unit behaviour", () => {
  it("returns the stored page only for its own scope", () => {
    expect(scopedPage({ scope: "a", page: 4 }, "a")).toBe(4);
    expect(scopedPage({ scope: "a", page: 4 }, "b")).toBe(1);
  });

  it("clamps nonsense page values instead of producing a negative range", () => {
    expect(scopedPage({ scope: "a", page: 0 }, "a")).toBe(1);
    expect(scopedPage({ scope: "a", page: -3 }, "a")).toBe(1);
    expect(scopedPage({ scope: "a", page: 2.7 }, "a")).toBe(2);
    expect(pageRange(scopedPage({ scope: "a", page: -3 }, "a"), DEFAULT_PAGE_SIZE)).toEqual(PAGE_1);
  });

  it("distinguishes null from empty string so a cleared filter is its own scope", () => {
    expect(filterScopeKey(["p", null, "all"])).not.toBe(filterScopeKey(["p", "", "all"]));
    expect(filterScopeKey(["p", "a|b"])).not.toBe(filterScopeKey(["p", "a", "b"]));
  });

  it("is stable for identical inputs", () => {
    expect(filterScopeKey(["p", "Mr", "all", null, null])).toBe(
      filterScopeKey(["p", "Mr", "all", null, null]),
    );
  });
});

describe("the route wires the derived page, not an effect-based reset", () => {
  const source = readFileSync(
    resolve(__dirname, "../src/routes/_authenticated/reservations.index.tsx"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("derives the page from the current filter scope", () => {
    expect(source).toContain(
      "const filterScope = filterScopeKey([propertyId, debouncedQ, status, checkInFrom, checkInTo]);",
    );
    expect(source).toContain("const page = scopedPage(pageState, filterScope);");
    expect(source).toContain("setPageState({ scope: filterScope, page: next })");
  });

  it("no longer resets the page from an effect", () => {
    expect(source).not.toMatch(
      /useEffect\(\(\) => \{\s*setPage\(1\);\s*\}, \[propertyId, debouncedQ, status, checkInFrom, checkInTo\]\)/,
    );
    // The only remaining effect is the search debounce.
    expect(source.match(/useEffect\(/g) ?? []).toHaveLength(1);
  });

  it("still sends the derived page through pageRange() into .range()", () => {
    expect(source).toContain("const { from, to } = pageRange(page, DEFAULT_PAGE_SIZE);");
    expect(source).toContain(".range(from, to)");
    expect(source).toContain(
      'queryKey: ["reservations-report", propertyId, debouncedQ, status, checkInFrom, checkInTo, page]',
    );
  });

  it("keeps the PR2 invariants this fix must not disturb", () => {
    expect(source).toContain('count: "exact"'); // exact totals
    expect(source).toContain('"search_reservations"'); // server-side search
    expect(source).toContain("EXPORT_ROW_CAP"); // full-dataset export cap
    expect(source).toContain("setDebouncedQ(q.trim())"); // debounce unchanged
  });
});
