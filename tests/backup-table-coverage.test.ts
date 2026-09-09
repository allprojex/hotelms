import { describe, expect, it } from "vitest";
import { BACKUP_TABLES, INTENTIONALLY_NOT_BACKED_UP } from "@/lib/backup.tables";
import publicTables from "./fixtures/public-tables.json";
import dependencies from "./fixtures/public-table-dependencies.json";

// The two fixtures are the schema's own shape, taken from a database built from
// this repository's migrations: every table in `public`, and every foreign key
// between two of them. They are what turns "we think we back everything up"
// into something a test can check.

const backedUp = new Set(BACKUP_TABLES);
const excluded = new Set(Object.keys(INTENTIONALLY_NOT_BACKED_UP));
const tables: string[] = publicTables as string[];
const edges: [string, string][] = dependencies as [string, string][];

// hr_departments.department_head_id and hr_employees.department_id point at each
// other. Departments are restored first and the head reference filled afterwards,
// so this one edge is not an ordering constraint.
const CIRCULAR_BY_DESIGN = new Set(["hr_departments|hr_employees"]);

describe("backup coverage", () => {
  it("classifies every table in the schema", () => {
    const unclassified = tables.filter((t) => !backedUp.has(t) && !excluded.has(t));
    expect(unclassified, `unclassified tables: ${unclassified.join(", ")}`).toEqual([]);
  });

  it("never both backs up and excludes the same table", () => {
    const both = [...backedUp].filter((t) => excluded.has(t));
    expect(both).toEqual([]);
  });

  it("lists no table twice", () => {
    const seen = new Set<string>();
    const duplicates = BACKUP_TABLES.filter((t) => (seen.has(t) ? true : (seen.add(t), false)));
    expect(duplicates).toEqual([]);
  });

  it("names only tables that exist", () => {
    const known = new Set(tables);
    expect(BACKUP_TABLES.filter((t) => !known.has(t))).toEqual([]);
    expect([...excluded].filter((t) => !known.has(t))).toEqual([]);
  });

  it("gives a reason for every exclusion", () => {
    for (const [table, reason] of Object.entries(INTENTIONALLY_NOT_BACKED_UP)) {
      expect(reason.length, `${table} needs a real reason`).toBeGreaterThan(20);
    }
  });
});

describe("restore order", () => {
  it("puts every parent before its children", () => {
    const position = new Map(BACKUP_TABLES.map((t, i) => [t, i]));
    const violations: string[] = [];
    for (const [child, parent] of edges) {
      if (CIRCULAR_BY_DESIGN.has(`${child}|${parent}`)) continue;
      if (!position.has(child) || !position.has(parent)) continue;
      if (position.get(parent)! > position.get(child)!) violations.push(`${parent} must come before ${child}`);
    }
    expect(violations, violations.join("; ")).toEqual([]);
  });

  it("does not back up a child whose parent is excluded", () => {
    const orphans = edges
      .filter(([child, parent]) => backedUp.has(child) && excluded.has(parent))
      .map(([child, parent]) => `${child} depends on excluded ${parent}`);
    expect(orphans, orphans.join("; ")).toEqual([]);
  });
});

describe("what the archive cannot carry", () => {
  it("still backs up the rows that point into Storage, so the references survive", () => {
    for (const table of ["gallery_images", "expense_receipts", "hr_employee_documents", "payroll_payslips"]) {
      expect(backedUp.has(table), `${table} should be backed up`).toBe(true);
    }
  });

  it("backs up the encrypted payroll payment details rather than dropping them", () => {
    expect(backedUp.has("payroll_payment_details")).toBe(true);
  });

  it("keeps the whole payroll and HR families in the archive", () => {
    const missingPayroll = tables.filter((t) => t.startsWith("payroll_") && !backedUp.has(t) && !excluded.has(t));
    const missingHr = tables.filter((t) => t.startsWith("hr_") && !backedUp.has(t) && !excluded.has(t));
    expect(missingPayroll).toEqual([]);
    expect(missingHr).toEqual([]);
  });
});
