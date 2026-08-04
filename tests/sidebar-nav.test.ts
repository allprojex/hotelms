/**
 * Regression guard: two sidebar nav items ("Reports" and "Expense Reports")
 * both pointed to /accounting/reports, which React renders as sibling
 * <SidebarMenuItem key={item.to}> elements - triggering a duplicate-key
 * warning on every authenticated page (the sidebar is always mounted) and
 * making one of the two entries effectively dead. Every nav item's `to`
 * path must be unique.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(__dirname, "../src/components/app-sidebar.tsx"), "utf8");

describe("app-sidebar nav items", () => {
  it("has no two items pointing to the same route", () => {
    const paths = [...src.matchAll(/\bto:\s*"([^"]+)"/g)].map((m) => m[1]);
    // Sanity check the extraction itself still finds a realistic number of items.
    expect(paths.length).toBeGreaterThan(50);

    const seen = new Map<string, number>();
    for (const p of paths) seen.set(p, (seen.get(p) ?? 0) + 1);
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1);

    expect(duplicates).toEqual([]);
  });
});
