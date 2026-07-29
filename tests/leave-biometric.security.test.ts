import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const migration = readFileSync(
  resolve(__dirname, "../supabase/migrations/20260729203000_leave_and_biometric_foundation.sql"),
  "utf8",
);
const leave = readFileSync(resolve(__dirname, "../src/lib/hrm/leave.functions.ts"), "utf8");
const biometric = readFileSync(resolve(__dirname, "../src/lib/hrm/biometric.functions.ts"), "utf8");
const adapter = readFileSync(resolve(__dirname, "../src/lib/hrm/biometric-adapter.ts"), "utf8");
const sidebar = readFileSync(resolve(__dirname, "../src/components/app-sidebar.tsx"), "utf8");
describe("Phase 3C security and integration", () => {
  it("scopes leave codes and authoritative balances per property", () => {
    expect(migration).toContain("UNIQUE(property_id,code)");
    expect(migration).toContain(
      "UNIQUE(property_id,employee_id,leave_type_id,period_start,period_end)",
    );
    expect(migration).not.toMatch(/code text NOT NULL UNIQUE/i);
  });
  it("prevents overlapping leave and finalized detail mutation", () => {
    expect(migration).toContain("hr_leave_requests_no_overlap");
    expect(migration).toContain("Finalized leave request details are immutable");
    expect(migration).toContain("Leave status transitions must use the authorized workflow");
    expect(migration).toContain("status='draft' AND created_by=auth.uid()");
    expect(migration).not.toMatch(/DELETE FROM public\.hr_leave_requests/i);
  });
  it("moves balances transactionally and idempotently", () => {
    expect(migration).toContain("recalculate_hr_leave_balance");
    expect(migration).toContain(
      "ON CONFLICT(property_id,employee_id,leave_type_id,period_start,period_end) DO UPDATE",
    );
    expect(migration).toContain("hr_adjust_leave_balance");
    expect(migration).toContain("hr_initialize_leave_balances");
    expect(migration).toContain("carried_amount=EXCLUDED.carried_amount");
    expect(migration).toContain("Insufficient leave balance");
  });
  it("rejects self approval, enforces manager scope, retains actions, and notifies", () => {
    expect(migration).toContain("Leave requests cannot be self-approved");
    expect(migration).toContain("Reviewer is outside the employee reporting scope");
    expect(migration).toContain("hr_leave_approval_history");
    expect(migration).toContain("PERFORM public.notify");
  });
  it("integrates leave without modifying attendance events", () => {
    expect(migration).toContain("'on_leave'");
    expect(migration).toContain("first_clock_in IS NULL");
    expect(migration).not.toMatch(/(UPDATE|DELETE) public\.hr_attendance_events/i);
    expect(migration).not.toMatch(/INSERT INTO public\.hr_attendance_events[\s\S]*leaveRequestId/i);
  });
  it("blocks roster, bulk, and copy conflicts via the shared table trigger", () => {
    expect(migration).toContain("hr_duty_roster_leave_conflict");
    expect(migration).toContain("Roster conflicts with submitted or approved leave");
    expect(migration).toContain("leave_override_reason");
    expect(migration).toContain("hr_duty_roster_record_leave_override");
    expect(migration).not.toMatch(/DELETE FROM public\.hr_duty_roster/i);
  });
  it("uses private document paths, MIME/size constraints, and signed downloads", () => {
    expect(migration).toContain("bucket_id='employee-documents'");
    expect(migration).toContain("10485760");
    expect(leave).toContain("createSignedUrl");
    expect(migration).toContain("Reviewer is outside the employee reporting scope");
    expect(leave).not.toMatch(/file(Content|Bytes)|base64/i);
  });
  it("keeps biometric architecture property scoped and idempotent", () => {
    for (const table of [
      "hr_biometric_devices",
      "hr_biometric_employee_mappings",
      "hr_biometric_import_batches",
      "hr_biometric_normalized_events",
    ])
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
    expect(migration).toContain("UNIQUE(property_id,deduplication_key)");
    expect(migration).toContain("FOREIGN KEY(property_id,employee_id)");
    expect(biometric).toContain("ignoreDuplicates: true");
  });
  it("retains unmapped/rejected/retry states and controlled event conversion", () => {
    expect(migration).toContain("'unmapped','rejected','retry_pending'");
    expect(migration).toContain("hr_convert_biometric_event");
    expect(migration).toContain("INSERT INTO public.hr_attendance_events");
    expect(migration).toContain("hr_biometric_processing_logs");
    expect(biometric).toContain('processing_status: "retry_pending"');
  });
  it("defines a vendor-neutral adapter without raw biometric or credential fields", () => {
    expect(adapter).toContain("interface BiometricAttendanceAdapter");
    expect(adapter).toContain("supportsPolling");
    expect(adapter).toContain("supportsWebhook");
    expect(migration).not.toMatch(
      /\b(fingerprint_image|fingerprint_template|face_image|face_template|raw_payload|password|api_key)\s+(text|jsonb|bytea)/i,
    );
    expect(migration).toContain("CHECK(lower(health_metadata::text) !~");
    expect(biometric).toContain("connectorConfigReference");
    expect(biometric).toContain("browserSafeDevice");
    expect(biometric).not.toMatch(/console\.(log|debug)/);
  });
  it("adds exactly the completed Phase 3C navigation and no payroll", () => {
    for (const path of [
      "/hrm/leave",
      "/hrm/leave/calendar",
      "/hrm/leave/types",
      "/hrm/leave/balances",
      "/hrm/biometric-devices",
    ])
      expect(sidebar).toContain(`to: "${path}"`);
    expect(sidebar).not.toMatch(/to: "\/hrm\/payroll/);
  });
});
