import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Source-convention tests for the Data Uploads admin page (no jsdom/RTL in
// this repo's test setup -- see tests/global-search.test.ts's header for
// the established precedent).

const source = readFileSync(
  resolve(__dirname, "../src/routes/_authenticated/admin_.uploads.tsx"),
  "utf8",
);

describe("Inventory template — final supported columns (test 18/19: same template feeds both CSV and XLSX)", () => {
  it("the inventory target's template is INVENTORY_TEMPLATE_COLUMNS, not the old 4-column list", () => {
    expect(source).toContain('{ value: "inventory", label: "Inventory items", template: [...INVENTORY_TEMPLATE_COLUMNS] }');
  });

  it("XLSX.read is used unconditionally for both file types -- one parser, one set of validation rules for CSV and XLSX alike", () => {
    expect(source).toContain("XLSX.read(buf, { type: \"array\" })");
    // Only one parsing code path exists in this file (no separate
    // Papa.parse/csv-only branch that could drift from the XLSX rules).
    expect(source.match(/XLSX\.read\(/g)?.length).toBe(1);
  });
});

describe("Inventory template — example row cannot be accidentally imported (per EXPIRATION RULE / TEMPLATE requirements)", () => {
  it("downloadTemplate appends an example row only for the inventory target, built from the shared EXAMPLE_ROW", () => {
    expect(source).toContain('kind === "inventory"');
    expect(source).toContain("(EXAMPLE_ROW as Record<string, string | number>)[c]");
  });
});

describe("Preview performs zero writes (test 20)", () => {
  it("onFile() only ever calls .select() against Supabase -- no .insert/.update/.upsert/.delete before Queue/Import is clicked", () => {
    const start = source.indexOf("async function onFile(");
    const end = source.indexOf("async function submit(");
    const body = source.slice(start, end);
    expect(body).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
    expect(body).toContain('.select("sku")');
    expect(body).toContain('.select("name")');
  });
});

describe("Oversized upload rejected before parsing (security: oversized uploads)", () => {
  it("checks file size against MAX_UPLOAD_BYTES before ever calling XLSX.read", () => {
    const start = source.indexOf("async function onFile(");
    const sizeCheckIdx = source.indexOf("f.size > MAX_UPLOAD_BYTES", start);
    const parseIdx = source.indexOf("XLSX.read(buf", start);
    expect(sizeCheckIdx).toBeGreaterThan(start);
    expect(sizeCheckIdx).toBeLessThan(parseIdx);
  });

  it("malformed file parsing is caught and reported, not left to throw an unhandled error", () => {
    const start = source.indexOf("async function onFile(");
    const end = source.indexOf("async function submit(");
    const body = source.slice(start, end);
    expect(body).toContain("catch {");
    expect(body).toContain("Could not read this file");
  });
});

describe("Duplicate policy is an explicit user-selected mode (test: duplicate policy)", () => {
  it("offers exactly skip and reject modes, defaulting to skip", () => {
    expect(source).toContain('useState<"skip" | "reject">("skip")');
    expect(source).toContain('<SelectItem value="skip">Skip that row');
    expect(source).toContain('<SelectItem value="reject">Reject the whole file');
  });

  it("states plainly that existing items are never overwritten by either mode", () => {
    expect(source).toMatch(/Existing items are never overwritten/);
  });
});

describe("Import blocked when there is nothing valid to import", () => {
  it("the Import/Queue button is disabled when inventory validation found zero valid rows", () => {
    expect(source).toMatch(/isInventory && !!inventoryValidation && inventoryValidation\.totals\.valid === 0/);
  });

  it("submit() itself also refuses client-side before ever calling the server, not just via a disabled button", () => {
    const start = source.indexOf("async function submit(");
    const end = source.indexOf("async function submit(") + 700;
    const body = source.slice(start, end);
    expect(body).toContain("No valid rows to import");
  });
});

describe("Per-row status is shown in the live Preview before confirmation (valid/invalid/duplicate/row-specific errors)", () => {
  it("renders an InventoryRowStatusCell distinguishing example/blank/duplicate-in-file/already-exists/error/valid", () => {
    expect(source).toContain("function InventoryRowStatusCell(");
    expect(source).toContain("row.isExample");
    expect(source).toContain("row.isBlank");
    expect(source).toContain("row.isDuplicateInFile");
    expect(source).toContain("row.isDuplicateInProperty");
    expect(source).toContain("row.errors.length > 0");
  });

  it("shows aggregate totals (valid/invalid/duplicate counts) above the row-by-row preview", () => {
    expect(source).toMatch(/inventoryValidation\.totals\.valid/);
    expect(source).toMatch(/inventoryValidation\.totals\.invalid/);
    expect(source).toMatch(/inventoryValidation\.totals\.duplicateInFile/);
    expect(source).toMatch(/inventoryValidation\.totals\.duplicateInProperty/);
  });
});

describe("Confirm -> Import -> Result summary is one continuous action for inventory (vs. the existing two-visit queue+approve flow for other targets)", () => {
  it("submit() calls approve() immediately after create() only when isInventory", () => {
    const start = source.indexOf("async function submit(");
    const body = source.slice(start, start + 1600);
    expect(body).toMatch(/if \(isInventory\) \{[\s\S]{0,300}await approve\(/);
    expect(body).toContain("Imported ${r.imported} • ${r.errors} row(s) had errors");
  });

  it("non-inventory targets keep the original 'Queue for approval' wording and do not auto-approve", () => {
    expect(source).toContain("Queued ${rows.length} rows • ${res.duplicates} duplicates flagged");
  });
});
