import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { requiredRolesFor } from "../src/lib/admin/route-permissions";

const sidebar = readFileSync(resolve(__dirname, "../src/components/app-sidebar.tsx"), "utf8");

describe("HRM routes and navigation", () => {
  it("registers exactly the six requested navigation destinations", () => {
    for (const route of [
      "/hrm",
      "/hrm/employees",
      "/hrm/departments",
      "/hrm/designations",
      "/hrm/documents",
      "/hrm/announcements",
    ]) {
      expect(sidebar).toContain(`to: "${route}"`);
    }
    expect(sidebar).not.toMatch(/payroll|leave|recruitment|biometric/i);
  });

  it("keeps the authenticated route guard scoped to HRM administrators", () => {
    const roles = requiredRolesFor("/hrm/employees");
    expect(roles).toContain("hr");
    expect(roles).toContain("general_manager");
    expect(roles).not.toContain("guest");
    expect(roles).not.toContain("front_desk");
  });

  it("supplements route roles with Phase 1 permission visibility", () => {
    expect(sidebar).toContain("usePermission");
    expect(sidebar).toContain("hrmPermission");
    expect(sidebar).toContain("HRM_ADMIN_ROLES");
  });
});
