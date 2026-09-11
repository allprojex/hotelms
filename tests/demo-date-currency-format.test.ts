import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n");

describe("Demo date and Ghana Cedi display", () => {
  it("uses day/month/year ordering on representative operational screens", () => {
    expect(read("src/routes/_authenticated/reservations.index.tsx")).toContain('format(new Date(r.check_in), "dd/MM/yyyy")');
    expect(read("src/components/hrm/announcements-page.tsx")).toContain('toLocaleDateString("en-GB")');
    expect(read("src/routes/_authenticated/admin_.audit.tsx")).toContain('format(new Date(r.created_at), "dd/MM/yyyy HH:mm:ss")');
    expect(read("src/lib/reports/report-core.ts")).toContain('toLocaleString("en-GB")');
  });

  it("preserves ISO storage values for database payloads and date controls", () => {
    expect(read("src/routes/_authenticated/accounting.ar.tsx")).toContain('issue_date: format(new Date(), "yyyy-MM-dd")');
    expect(read("src/routes/_authenticated/accounting.journal.tsx")).toContain('useState(format(new Date(), "yyyy-MM-dd"))');
  });

  it("uses GHS and the Cedi symbol for Ghana-valued fallbacks and samples", () => {
    const payroll = read("src/components/hrm/payroll-pages.tsx");
    expect(payroll).toContain('currency = "GHS"');
    expect(payroll).toContain('base_currency ?? "GHS"');
    expect(payroll).not.toContain('currency = "USD"');
    expect(payroll).not.toContain('base_currency ?? "USD"');
    expect(read("src/routes/_authenticated/admin_.printers.tsx")).toContain('price: "₵0.00"');
  });
});
