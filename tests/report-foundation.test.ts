import { describe, expect, it } from "vitest";
import {
  filterReportRows,
  neutralizeSpreadsheetFormula,
  reportFileName,
  reportToCsv,
  reportToSheetRows,
} from "@/lib/reports/report-core";

type Row = { guest: string; amount: number; date: string };
const columns = [
  { key: "guest", label: "Guest", value: (row: Row) => row.guest },
  { key: "amount", label: "Amount", value: (row: Row) => row.amount },
] as const;

describe("report foundation", () => {
  it("neutralizes spreadsheet formulas in CSV and XLSX-shaped rows", () => {
    const rows: Row[] = [{ guest: '=HYPERLINK("bad")', amount: -50, date: "2026-07-01" }];
    expect(neutralizeSpreadsheetFormula("  +SUM(A1:A2)")).toBe("'  +SUM(A1:A2)");
    expect(reportToCsv({ columns, rows })).toContain('"\'=HYPERLINK(""bad"")"');
    expect(reportToSheetRows({ columns, rows })[1]).toEqual(['\'=HYPERLINK("bad")', -50]);
  });

  it("keeps headers when a report has no results", () => {
    expect(reportToCsv<Row>({ columns, rows: [] })).toBe("Guest,Amount");
    expect(reportToSheetRows<Row>({ columns, rows: [] })).toEqual([["Guest", "Amount"]]);
  });

  it("builds stable property and date scoped filenames", () => {
    expect(
      reportFileName({
        slug: "Guest Revenue",
        format: "xlsx",
        propertyName: "Accra Central Hotel",
        dateRange: { from: "2026-07-01", to: "2026-07-31" },
      }),
    ).toBe("guest-revenue_accra-central-hotel_2026-07-01_2026-07-31.xlsx");
  });

  it("applies inclusive date and text filters", () => {
    const rows: Row[] = [
      { guest: "Ama Mensah", amount: 10, date: "2026-07-01" },
      { guest: "Kofi Owusu", amount: 20, date: "2026-07-31" },
      { guest: "Other", amount: 30, date: "2026-08-01" },
    ];
    expect(
      filterReportRows({
        rows,
        search: "oWu",
        searchValues: (row) => [row.guest],
        dateRange: { from: "2026-07-01", to: "2026-07-31" },
        dateValue: (row) => row.date,
      }),
    ).toEqual([rows[1]]);
  });
});
