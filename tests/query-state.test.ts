import { describe, expect, it } from "vitest";
import {
  clearListFilters,
  pageRange,
  parseListQuery,
  serializeListQuery,
  totalPages,
  updateListFilters,
} from "@/lib/query-state";

describe("shared list query state", () => {
  it("keeps only valid, allow-listed URL filters", () => {
    const state = parseListQuery(
      new URLSearchParams("search=guest&page=2&pageSize=50&status=active&unsafe=secret"),
      ["status"],
    );
    expect(state).toMatchObject({
      search: "guest",
      page: 2,
      pageSize: 50,
      filters: { status: "active" },
    });
    expect(serializeListQuery(state).toString()).toBe(
      "search=guest&page=2&pageSize=50&status=active",
    );
  });

  it("resets the page when filters or page size change", () => {
    const state = parseListQuery({ page: "4", pageSize: "25", status: "open" }, ["status"]);
    expect(updateListFilters(state, { search: "new" }).page).toBe(1);
    expect(updateListFilters(state, { pageSize: 100 }).page).toBe(1);
  });

  it("builds inclusive Supabase ranges and stable page counts", () => {
    expect(pageRange(1, 25)).toEqual({ from: 0, to: 24 });
    expect(pageRange(3, 25)).toEqual({ from: 50, to: 74 });
    expect(totalPages(0, 25)).toBe(1);
    expect(totalPages(51, 25)).toBe(3);
  });

  it("clears filters while preserving the selected page size", () => {
    const state = parseListQuery(
      { search: "x", from: "2026-07-01", page: "3", pageSize: "50" },
      [],
    );
    expect(clearListFilters(state)).toEqual({
      search: "",
      from: null,
      to: null,
      page: 1,
      pageSize: 50,
      filters: {},
    });
  });
});
