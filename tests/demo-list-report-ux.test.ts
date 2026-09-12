import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from "@/lib/query-state";

const root = resolve(__dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n");

describe("Demo list and report UX", () => {
  it("defaults server-backed lists to 20 rows", () => {
    expect(DEFAULT_PAGE_SIZE).toBe(20);
    expect(PAGE_SIZE_OPTIONS).toContain(20);
  });

  it("provides complete pagination and fast smooth-scroll controls", () => {
    const controls = read("src/components/shared/data-query-controls.tsx");
    for (const label of ["First", "Previous", "Next", "Last"]) {
      expect(controls).toContain(label);
    }
    expect(controls).toContain('aria-current={pageNumber === currentPage ? "page" : undefined}');
    expect(controls).toContain('behavior: "smooth"');
    expect(controls).toContain('aria-label="Scroll to top"');
    expect(controls).toContain('aria-label="Scroll to bottom"');
  });

  it("keeps long announcement forms inside a smooth scrollable dialog", () => {
    const announcements = read("src/components/hrm/announcements-page.tsx");
    expect(announcements).toContain('className="max-h-[90vh] max-w-2xl overflow-hidden"');
    expect(announcements).toContain("overflow-y-auto overscroll-contain");
    expect(announcements).toContain("scroll-smooth");
  });

  it("creates real DOCX reports through the shared exporter", () => {
    const core = read("src/lib/reports/report-core.ts");
    const exporter = read("src/lib/reports/report-export.client.ts");
    expect(core).toContain('"docx"');
    expect(exporter).toContain('from "docx"');
    expect(exporter).toContain('if (format === "docx")');
    expect(exporter).toContain("await Packer.toBlob(document)");
  });
});
