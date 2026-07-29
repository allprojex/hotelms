import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(__dirname, "../supabase/migrations/20260729190000_attendance_management.sql"),
  "utf8",
);
const server = readFileSync(resolve(__dirname, "../src/lib/hrm/attendance.functions.ts"), "utf8");
const sidebar = readFileSync(resolve(__dirname, "../src/components/app-sidebar.tsx"), "utf8");
const routePermissions = readFileSync(
  resolve(__dirname, "../src/lib/admin/route-permissions.ts"),
  "utf8",
);

describe("Phase 3B integrity and authorization", () => {
  it("makes original event rows immutable and retains recalculation evidence", () => {
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON public.hr_attendance_events");
    expect(migration).toContain("Attendance events are immutable");
    expect(migration).toContain("hr_attendance_calculation_runs");
    expect(migration).not.toMatch(/DELETE FROM public\.hr_attendance_events/i);
  });

  it("uses database server time, property timezone, roster windows, and idempotency", () => {
    expect(migration).toContain("now_value timestamptz := clock_timestamp()");
    expect(migration).toContain("AT TIME ZONE COALESCE(settings.timezone");
    expect(migration).toContain("now_value BETWEEN starts_at - interval '6 hours'");
    expect(migration).toContain("hr_attendance_events_request_uniq");
    expect(migration).toContain(
      "WHERE property_id = _property_id AND created_by = auth.uid() AND request_id = _request_id",
    );
  });

  it("enforces one authoritative property-scoped daily summary", () => {
    expect(migration).toContain("UNIQUE (property_id, employee_id, business_date)");
    expect(migration).toContain("ON CONFLICT (property_id, employee_id, business_date) DO UPDATE");
  });

  it("restricts own records and time clock to the linked active employee", () => {
    expect(migration).toContain("'attendance_own', 'read'");
    expect(migration).toContain("own.staff_user_id = auth.uid()");
    expect(migration).toContain("staff_user_id = auth.uid()");
    expect(migration).toContain("Account must be linked to exactly one active employee");
  });

  it("requires audited adjustments, prevents self-approval, and recalculates only after approval", () => {
    expect(migration).toContain("Attendance adjustments cannot be self-approved");
    expect(migration).toMatch(
      /IF _decision = 'approved' THEN[\s\S]*recalculate_hr_attendance_summary/,
    );
    expect(server).toContain('"hr_attendance_adjustment"');
    expect(server).toContain("await audit(");
  });

  it("enforces export and print permissions before returning property-scoped data", () => {
    expect(server).toContain("HRM_PERMISSIONS.attendanceExport");
    expect(server).toContain("HRM_PERMISSIONS.attendancePrint");
    expect(server).toContain('.eq("property_id", data.propertyId)');
    expect(server).toContain('"attendance_report"');
  });

  it("adds only Attendance and Time Clock navigation for Phase 3B", () => {
    expect(sidebar).toContain('to: "/hrm/attendance"');
    expect(sidebar).toContain('to: "/hrm/time-clock"');
    expect(sidebar).not.toMatch(/to: "\/hrm\/payroll\/(payslips|payments|submissions|journals)/);
    expect(routePermissions).toContain('{ prefix: "/hrm/time-clock", roles: STAFF }');
  });

  it("contains no biometric ingestion, leave, payroll, or raw fingerprint storage", () => {
    expect(migration).not.toMatch(/CREATE TABLE public\.(biometric|leave|payroll)/i);
    expect(migration).toContain("- 'fingerprint' - 'userAgent'");
  });
});
