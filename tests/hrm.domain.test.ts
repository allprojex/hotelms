import { describe, expect, it } from "vitest";
import {
  announcementIsActive,
  announcementTargetsEmployee,
  assertNoDepartmentCycle,
  assertPropertyRecord,
  employeeDocumentStoragePath,
  employeeProfileCompleteness,
  normalizeHrmCode,
  safeStorageSegment,
  validateEmployeeDates,
  validateEmployeeDocument,
} from "../src/lib/hrm/domain";

const UUIDS = {
  property: "11111111-1111-4111-8111-111111111111",
  employee: "22222222-2222-4222-8222-222222222222",
  document: "33333333-3333-4333-8333-333333333333",
};

describe("HRM validation", () => {
  it("normalizes property-scoped codes without imposing a global numbering format", () => {
    expect(normalizeHrmCode(" front office ")).toBe("FRONT-OFFICE");
  });

  it("rejects cross-property records", () => {
    expect(() => assertPropertyRecord({ property_id: "other" }, UUIDS.property)).toThrow(
      /this property/i,
    );
  });

  it("detects direct and transitive department cycles", () => {
    expect(() => assertNoDepartmentCycle("a", "a", new Map())).toThrow(/own parent/i);
    expect(() =>
      assertNoDepartmentCycle(
        "a",
        "b",
        new Map([
          ["b", "c"],
          ["c", "a"],
        ]),
      ),
    ).toThrow(/cycle/i);
    expect(() =>
      assertNoDepartmentCycle(
        "a",
        "b",
        new Map([
          ["b", "c"],
          ["c", null],
        ]),
      ),
    ).not.toThrow();
  });

  it("validates employment date ordering", () => {
    expect(() =>
      validateEmployeeDates({ hireDate: "2026-07-20", confirmationDate: "2026-07-19" }),
    ).toThrow(/before hire date/i);
    expect(() =>
      validateEmployeeDates({ hireDate: "2026-07-20", confirmationDate: "2026-08-20" }),
    ).not.toThrow();
  });

  it("calculates profile completeness without fabricating values", () => {
    expect(
      employeeProfileCompleteness({
        first_name: "Ama",
        last_name: "Mensah",
        work_email: "ama@example.test",
        primary_phone: "0200000000",
        department_id: "d",
        designation_id: "g",
        employment_type: "full_time",
        hire_date: "2026-07-20",
        emergency_contact_name: "Kojo",
        emergency_contact_phone: "0200000001",
      }),
    ).toBe(100);
    expect(employeeProfileCompleteness({ first_name: "Ama", last_name: "Mensah" })).toBe(20);
  });
});

describe("employee documents", () => {
  it("accepts approved file types and rejects unsafe type or size", () => {
    expect(() => validateEmployeeDocument({ type: "application/pdf", size: 1024 })).not.toThrow();
    expect(() => validateEmployeeDocument({ type: "text/html", size: 1024 })).toThrow(
      /unsupported/i,
    );
    expect(() => validateEmployeeDocument({ type: "application/pdf", size: 10_485_761 })).toThrow(
      /10 MB/i,
    );
  });

  it("creates property and employee scoped traversal-safe paths", () => {
    expect(safeStorageSegment("../../contract final.pdf")).not.toContain("..");
    const path = employeeDocumentStoragePath({
      propertyId: UUIDS.property,
      employeeId: UUIDS.employee,
      documentId: UUIDS.document,
      fileName: "../../contract final.pdf",
    });
    expect(path).toMatch(
      /^11111111-1111-4111-8111-111111111111\/employees\/22222222-2222-4222-8222-222222222222\/documents\//,
    );
    expect(path).not.toContain("..");
  });
});

describe("announcement audience and expiry", () => {
  const now = new Date("2026-07-29T12:00:00Z");

  it("excludes unpublished, expired, and archived announcements", () => {
    expect(
      announcementIsActive(
        {
          publication_status: "published",
          publish_date: "2026-07-28T00:00:00Z",
          expiry_date: "2026-07-30T00:00:00Z",
        },
        now,
      ),
    ).toBe(true);
    expect(
      announcementIsActive(
        {
          publication_status: "published",
          publish_date: "2026-07-20T00:00:00Z",
          expiry_date: "2026-07-29T11:00:00Z",
        },
        now,
      ),
    ).toBe(false);
    expect(
      announcementIsActive(
        { publication_status: "draft", publish_date: "2026-07-20T00:00:00Z" },
        now,
      ),
    ).toBe(false);
  });

  it("enforces department, designation, and employee audiences", () => {
    const employee = { id: "e1", department_id: "d1", designation_id: "g1" };
    expect(announcementTargetsEmployee({ audience_type: "all_staff" }, employee)).toBe(true);
    expect(
      announcementTargetsEmployee(
        { audience_type: "departments", department_ids: ["d2"] },
        employee,
      ),
    ).toBe(false);
    expect(
      announcementTargetsEmployee(
        { audience_type: "designations", designation_ids: ["g1"] },
        employee,
      ),
    ).toBe(true);
    expect(
      announcementTargetsEmployee({ audience_type: "employees", employee_ids: ["e2"] }, employee),
    ).toBe(false);
  });
});
