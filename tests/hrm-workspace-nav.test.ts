import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HRM_NAV_GROUPS, HRM_NAV_ITEMS, resolveActiveHrmKey } from "../src/lib/hrm/nav-config";
import { requiredRolesFor } from "../src/lib/admin/route-permissions";

const sidebar = readFileSync(resolve(__dirname, "../src/components/app-sidebar.tsx"), "utf8");
const visibilityHook = readFileSync(
  resolve(__dirname, "../src/hooks/use-hrm-visibility.ts"),
  "utf8",
);
const workspaceShell = readFileSync(
  resolve(__dirname, "../src/components/hrm/hrm-workspace-nav.tsx"),
  "utf8",
);

const ROUTE_FILES: Record<string, string> = {
  "/hrm": "hrm.index.tsx",
  "/hrm/employees": "hrm.employees.index.tsx",
  "/hrm/departments": "hrm.departments.tsx",
  "/hrm/designations": "hrm.designations.tsx",
  "/hrm/documents": "hrm.documents.tsx",
  "/hrm/attendance": "hrm.attendance.tsx",
  "/hrm/time-clock": "hrm.time-clock.tsx",
  "/hrm/biometric-devices": "hrm.biometric-devices.tsx",
  "/hrm/leave": "hrm.leave.tsx",
  "/hrm/leave/calendar": "hrm.leave.calendar.tsx",
  "/hrm/leave/balances": "hrm.leave.balances.tsx",
  "/hrm/leave/types": "hrm.leave.types.tsx",
  "/hrm/roster": "hrm.roster.tsx",
  "/hrm/shifts": "hrm.shifts.tsx",
  "/hrm/holidays": "hrm.holidays.tsx",
  "/hrm/workforce-settings": "hrm.workforce-settings.tsx",
  "/hrm/announcements": "hrm.announcements.tsx",
};

describe("HRM sidebar collapse", () => {
  it("lists only one Human Resource Management item in the main sidebar", () => {
    const matches = [...sidebar.matchAll(/title:\s*"Human Resource Management"/g)];
    expect(matches).toHaveLength(1);
  });

  it("no longer lists HRM submodules individually in the main sidebar", () => {
    const removedTitles = [
      "HRM Dashboard",
      "Departments",
      "Designations",
      "Employee Documents",
      "Staff Announcements",
      "Shift Scheduling",
      "Duty Roster",
      "Holiday Calendar",
      "Workforce Settings",
      "Time Clock",
      "Leave Management",
      "Leave Calendar",
      "Leave Types",
      "Leave Balances",
      "Biometric Devices",
    ];
    for (const title of removedTitles) {
      expect(sidebar).not.toContain(`title: "${title}"`);
    }
  });

  it("shows the single entry when the user has any HRM permission, not just one", () => {
    expect(sidebar).toContain("hrmAnyAccess");
    expect(sidebar).toContain("hasAnyHrmAccess");
    expect(sidebar).toContain(".filter((it) => !it.hrmAnyAccess || hasAnyHrmAccess)");
  });
});

describe("HRM workspace nav config", () => {
  it("has no duplicate labels or links", () => {
    const links = HRM_NAV_ITEMS.map((i) => i.to);
    expect(new Set(links).size).toBe(links.length);
    const titles = HRM_NAV_ITEMS.map((i) => i.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("every internal nav link points to a route file that still exists", () => {
    expect(Object.keys(ROUTE_FILES).sort()).toEqual([...HRM_NAV_ITEMS.map((i) => i.to)].sort());
    for (const item of HRM_NAV_ITEMS) {
      const file = ROUTE_FILES[item.to];
      expect(file, `no route file mapped for ${item.to}`).toBeTruthy();
      const src = readFileSync(resolve(__dirname, `../src/routes/_authenticated/${file}`), "utf8");
      expect(src).toContain("HrmWorkspaceShell");
    }
  });

  it("groups routes as specified (Overview, People, Time and Attendance, Leave, Workforce, Communication)", () => {
    const labels = HRM_NAV_GROUPS.map((g) => g.label);
    expect(labels).toEqual([
      "Overview",
      "People",
      "Time and Attendance",
      "Leave",
      "Workforce",
      "Communication",
    ]);
  });

  it("keeps route permission guards unchanged for every HRM route", () => {
    for (const to of Object.keys(ROUTE_FILES)) {
      const roles = requiredRolesFor(to);
      if (roles) {
        expect(roles).toContain("hr");
      }
    }
  });
});

describe("HRM active-section resolution", () => {
  it("activates the dashboard for the workspace root", () => {
    expect(resolveActiveHrmKey("/hrm")).toBe("dashboard");
  });

  it("activates the more specific leave sub-route over the broader leave route", () => {
    expect(resolveActiveHrmKey("/hrm/leave")).toBe("leave");
    expect(resolveActiveHrmKey("/hrm/leave/calendar")).toBe("leaveCalendar");
    expect(resolveActiveHrmKey("/hrm/leave/balances")).toBe("leaveBalances");
    expect(resolveActiveHrmKey("/hrm/leave/types")).toBe("leaveTypes");
  });

  it("activates employees for the nested employee profile route", () => {
    expect(resolveActiveHrmKey("/hrm/employees/abc-123")).toBe("employees");
  });

  it("returns null for routes outside the HRM workspace", () => {
    expect(resolveActiveHrmKey("/dashboard")).toBeNull();
    expect(resolveActiveHrmKey("/hrm/payroll")).toBeNull();
  });
});

describe("HRM workspace visibility", () => {
  it("filters the in-workspace nav per item, not just once for the whole workspace", () => {
    expect(workspaceShell).toContain("visibility[item.key]");
  });

  it("permission hook covers every non-payroll HRM nav key exactly once", () => {
    const keys = HRM_NAV_ITEMS.map((i) => i.key);
    for (const key of keys) {
      const occurrences = visibilityHook.split(`${key}: ${key}.allowed`).length - 1;
      expect(occurrences, `${key} should be returned exactly once`).toBe(1);
    }
  });
});
