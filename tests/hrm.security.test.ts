import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { redactAuditValue } from "../src/lib/audit-conventions";

const migration = readFileSync(
  resolve(__dirname, "../supabase/migrations/20260729161000_hrm_foundation.sql"),
  "utf8",
);
const server = readFileSync(resolve(__dirname, "../src/lib/hrm/hrm.functions.ts"), "utf8");

describe("HRM database isolation", () => {
  it("scopes unique department, designation, and employee codes by property", () => {
    expect(migration).toMatch(/UNIQUE\s*\(property_id,\s*code\)/g);
    expect(migration).toContain("UNIQUE (property_id, employee_number)");
  });

  it("allows the same scoped code in another property by avoiding global uniqueness", () => {
    expect(migration).not.toMatch(/code\s+text\s+UNIQUE/i);
    expect(migration).not.toMatch(/employee_number\s+text\s+UNIQUE/i);
  });

  it("enables RLS on every HRM table and checks authoritative permissions", () => {
    const tables = [
      "hr_departments",
      "hr_designations",
      "hr_employees",
      "hr_employee_private",
      "hr_employee_documents",
      "hr_staff_announcements",
      "hr_announcement_departments",
      "hr_announcement_designations",
      "hr_announcement_employees",
    ];
    for (const table of tables) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
    }
    expect(migration).toContain("public.has_hrm_permission(auth.uid(), property_id");
    expect(server).toContain("assertServerPermission");
    expect(server).toContain("assertPropertyRecord");
  });

  it("separates sensitive employee data and confidential document access", () => {
    expect(migration).toContain("CREATE TABLE public.hr_employee_private");
    expect(migration).toContain("'employees_sensitive', 'read'");
    expect(migration).toContain("'confidential_employee_documents', 'read'");
    expect(server).toContain("HRM_PERMISSIONS.sensitiveEmployeeView");
    expect(server).toContain("HRM_PERMISSIONS.confidentialDocumentView");
  });

  it("prevents duplicate active staff account links", () => {
    expect(migration).toMatch(
      /UNIQUE INDEX hr_employees_active_staff_user_uniq[\s\S]*WHERE staff_user_id IS NOT NULL AND archived_at IS NULL/,
    );
    expect(server).toContain("already linked to an active employee");
  });

  it("archives rather than destructively deleting domain records", () => {
    expect(server).toContain("archived_at: new Date().toISOString()");
    expect(server).not.toMatch(/from\("hr_(departments|designations|employees)"\)\.delete/);
  });

  it("restricts announcement audiences and active windows in RLS", () => {
    expect(migration).toContain("audience_type = 'departments'");
    expect(migration).toContain("audience_type = 'designations'");
    expect(migration).toContain("audience_type = 'employees'");
    expect(migration).toContain("expiry_date > now()");
    expect(migration).toContain("publication_status = 'published'");
  });

  it("keeps file contents out of document audit records", () => {
    expect(server).not.toMatch(/newValues:\s*\{[^}]*fileContent/s);
    expect(redactAuditValue({ documentContent: "private bytes", title: "Contract" })).toEqual({
      documentContent: "[REDACTED]",
      title: "Contract",
    });
  });
});
