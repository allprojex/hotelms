import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { requiredRolesFor } from "../src/lib/admin/route-permissions";
import { HRM_NAV_ITEMS } from "../src/lib/hrm/nav-config";

const sidebar = readFileSync(resolve(__dirname, "../src/components/app-sidebar.tsx"), "utf8");
const routeTree = readFileSync(resolve(__dirname, "../src/routeTree.gen.ts"), "utf8");

describe("HRM routes and navigation", () => {
  it("collapses the sidebar to a single Human Resource Management entry", () => {
    expect(sidebar).toContain('to: "/hrm"');
    expect(sidebar).toContain("Human Resource Management");
    // The 16 submodule paths must no longer be individually listed as
    // top-level sidebar entries — they live in the HRM workspace nav now.
    for (const item of HRM_NAV_ITEMS) {
      if (item.to === "/hrm") continue;
      expect(sidebar).not.toContain(`to: "${item.to}"`);
    }
    expect(sidebar).not.toMatch(/recruitment/i);
  });

  it("keeps every HRM workspace route registered in the route tree", () => {
    for (const item of HRM_NAV_ITEMS) {
      expect(routeTree).toContain(`'${item.to}': typeof`);
    }
  });

  it("keeps the authenticated route guard scoped to HRM administrators", () => {
    const roles = requiredRolesFor("/hrm/employees");
    expect(roles).toContain("hr");
    expect(roles).toContain("general_manager");
    expect(roles).not.toContain("guest");
    expect(roles).not.toContain("front_desk");
  });

  it("supplements route roles with fine-grained permission visibility", () => {
    expect(sidebar).toContain("useHrmVisibility");
    expect(sidebar).toContain("usePayrollVisibility");
  });
});
