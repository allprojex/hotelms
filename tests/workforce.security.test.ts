import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(__dirname, "../supabase/migrations/20260729172000_workforce_scheduling.sql"),
  "utf8",
);
const server = readFileSync(resolve(__dirname, "../src/lib/hrm/workforce.functions.ts"), "utf8");
const sidebar = readFileSync(resolve(__dirname, "../src/components/app-sidebar.tsx"), "utf8");

describe("Phase 3A database and authorization", () => {
  it("creates only property-scoped Phase 3A structures with RLS", () => {
    for (const table of [
      "hr_workforce_settings",
      "hr_shift_templates",
      "hr_duty_roster",
      "hr_holidays",
      "hr_holiday_departments",
    ]) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
    }
    expect(migration).not.toMatch(/CREATE TABLE public\.(attendance|leave|payroll)/i);
  });

  it("scopes codes and records per property", () => {
    expect(migration).toContain("UNIQUE (property_id, code)");
    expect(migration).not.toMatch(/code text NOT NULL UNIQUE/i);
    expect(server).toContain("assertPropertyRecord");
    expect(server).toContain('.eq("property_id", data.propertyId)');
  });

  it("protects roster conflicts, inactive employees, archived shifts, and whole copy batches", () => {
    expect(migration).toContain("EXCLUDE USING gist");
    expect(migration).toContain("employee_row.employment_status NOT IN ('active','probation')");
    expect(migration).toContain("shift_row.archived_at IS NOT NULL");
    expect(migration).toContain("copy_hr_duty_roster_period");
    expect(server).toContain("Copy failed without changes");
  });

  it("allows staff to see only their own published roster rows", () => {
    expect(migration).toMatch(
      /publication_status = 'published'[\s\S]*employee\.staff_user_id = auth\.uid\(\)/,
    );
    expect(migration).toContain("archived_at IS NULL");
  });

  it("requires distinct publication permission and audits all mutations", () => {
    expect(server).toContain("HRM_PERMISSIONS.rosterPublish");
    expect(server).toContain('"hr_workforce_settings"');
    expect(server).toContain('"hr_shift_template"');
    expect(server).toContain('"hr_duty_roster_publication"');
    expect(server).toContain('"hr_holiday"');
    expect(server).toContain("await audit(");
  });

  it("prevents unsafe duplicate holidays and validates department conflicts", () => {
    expect(migration).toContain("hr_holidays_property_date_uniq");
    expect(migration).toContain("hr_holidays_property_recurring_uniq");
    expect(migration).toContain("Department already has an active holiday on this date");
  });

  it("exposes exactly the completed Phase 3A navigation additions", () => {
    for (const path of ["/hrm/shifts", "/hrm/roster", "/hrm/holidays", "/hrm/workforce-settings"]) {
      expect(sidebar).toContain(`to: "${path}"`);
    }
    expect(sidebar).not.toMatch(/to: "\/hrm\/(leave|biometric|payroll)/);
  });
});
