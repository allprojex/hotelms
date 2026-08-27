import { describe, expect, it } from "vitest";
import { buildPosExecReport } from "@/lib/pos-analytics-report";
import {
  reportToCsv,
  reportToSheetRows,
  reportFileName,
  reportSubtitle,
} from "@/lib/reports/report-core";
import type { ReportFormat } from "@/lib/reports/report-core";

// Behavioural tests for the POS Executive export: these run the REAL shared
// report pipeline over the report definition the dashboard actually builds,
// rather than asserting on source text. Fixtures mirror the live RPC column
// names and the mixed numeric/string types PostgREST returns.

const summary = {
  operational_sales: "2544.00",
  operational_sales_net: "2400.00",
  operational_tax: "144.00",
  closed_order_count: 37,
  void_order_count: 2,
  open_order_count: 3,
  open_order_line_value: "185.50",
  till_payment_count: 31,
  till_payment_amount: "2100.00",
  cash_amount: "1200.00",
  card_amount: "600.00",
  mobile_money_amount: "300.00",
  bank_transfer_amount: "0.00",
  wallet_amount: "0.00",
  other_amount: "0.00",
  folio_posted_count: 6,
  folio_posted_amount: "444.00",
};

const departments = [
  {
    outlet_id: "o1",
    outlet_name: "Main Restaurant",
    outlet_kind: "restaurant",
    operational_sales: "1800.00",
    order_count: 25,
    live_order_count: 2,
    open_order_line_value: "120.00",
  },
  // A genuinely zero-sales outlet must survive into the export.
  {
    outlet_id: "o2",
    outlet_name: "Pool Bar",
    outlet_kind: "bar",
    operational_sales: "0.00",
    order_count: 0,
    live_order_count: 0,
    open_order_line_value: "0.00",
  },
];

const users = [
  {
    user_id: "11111111-2222-3333-4444-555555555555",
    full_name: null,
    orders_created_count: 0,
    orders_created_value: "0.00",
    till_payments_received_count: 12,
    till_payments_received_value: "900.00",
  },
  {
    user_id: "66666666-7777-8888-9999-000000000000",
    full_name: "Ama Mensah",
    orders_created_count: 5,
    orders_created_value: "410.00",
    till_payments_received_count: 4,
    till_payments_received_value: "300.00",
  },
];

const topItems = [
  {
    menu_item_id: "m1",
    item_name: "Jollof Rice",
    total_quantity: 40,
    total_amount: "800.00",
    order_count: 30,
  },
  // Deliberately adversarial: a formula-looking name and an embedded comma.
  {
    menu_item_id: "m2",
    item_name: "=SUM(A1:A9), Large",
    total_quantity: 5,
    total_amount: "75.00",
    order_count: 5,
  },
];

const periods = [
  {
    period_start: "2026-08-01",
    operational_sales: "1000.00",
    order_count: 15,
    payments_received_amount: "900.00",
  },
  // A gap period the RPC fills with zeroes must render, not be dropped.
  {
    period_start: "2026-08-02",
    operational_sales: "0.00",
    order_count: 0,
    payments_received_amount: "0.00",
  },
];

function build(format: ReportFormat, currency: string, propertyName = "Theskwoff Hotel") {
  return buildPosExecReport({
    format,
    currency,
    propertyName,
    from: "2026-08-01",
    to: "2026-08-23",
    granularity: "day",
    summary,
    departments,
    users,
    topItems,
    periods,
  });
}

describe("POS executive export — completeness", () => {
  it("emits every RPC row from every section, not a truncated chart slice", () => {
    const def = build("csv", "GHS");
    const sections = def.rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.section] = (acc[r.section] ?? 0) + 1;
      return acc;
    }, {});
    // 12 money + 5 count summary lines, then one line per source row.
    expect(sections).toEqual({ Summary: 17, Outlet: 2, Staff: 2, Item: 2, Day: 2 });
    expect(def.rows).toHaveLength(25);
  });

  it("keeps a zero-sales outlet in the export", () => {
    const def = build("csv", "GHS");
    expect(def.rows.find((r) => r.a === "Pool Bar")).toBeTruthy();
  });

  it("keeps a zero-value gap period in the export", () => {
    const def = build("csv", "GHS");
    const gap = def.rows.find((r) => r.section === "Day" && r.a === "2026-08-02");
    expect(gap).toBeTruthy();
    expect(gap!.c).toBe(0);
  });

  it("labels period rows by the selected granularity", () => {
    const monthly = buildPosExecReport({
      format: "csv",
      currency: "GHS",
      propertyName: "Theskwoff Hotel",
      from: "2026-01-01",
      to: "2026-08-23",
      granularity: "month",
      summary: null,
      departments: [],
      users: [],
      topItems: [],
      periods,
    });
    expect(monthly.rows.every((r) => r.section === "Month")).toBe(true);
  });

  it("omits the summary block entirely when the RPC returned no row", () => {
    const def = buildPosExecReport({
      format: "csv",
      currency: "GHS",
      propertyName: null,
      from: "2026-08-01",
      to: "2026-08-23",
      granularity: "day",
      summary: null,
      departments: [],
      users: [],
      topItems: [],
      periods: [],
    });
    // No fabricated zero KPI rows when there is nothing to report.
    expect(def.rows).toHaveLength(0);
  });

  it("carries no Refund or Discount column or row", () => {
    const def = build("csv", "GHS");
    const csv = reportToCsv(def);
    expect(csv).not.toMatch(/refund|discount/i);
  });
});

describe("POS executive export — CSV", () => {
  it("keeps money numeric and names the unit in a Currency column", () => {
    const csv = reportToCsv(build("csv", "GHS"));
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("Currency");
    const sales = lines.find((l) => l.includes("Operational Sales"))!;
    // Numeric cell, not "GH₵2,544.00" — spreadsheets must be able to sum it.
    expect(sales).toContain("2544");
    expect(sales).toContain("GHS");
    expect(sales).not.toMatch(/GH₵|[^\w]2,544/);
  });

  it("renders counts as plain numbers with no currency attached", () => {
    const csv = reportToCsv(build("csv", "GHS"));
    const closed = csv.split("\n").find((l) => l.includes("Closed Orders"))!;
    expect(closed).toMatch(/(^|,)37(,|$)/);
  });

  it("neutralises a formula-looking item name so the cell is inert", () => {
    const csv = reportToCsv(build("csv", "GHS"));
    const line = csv.split("\n").find((l) => l.includes("SUM(A1:A9)"))!;
    expect(line).toBeTruthy();
    // The shared toolkit must not leave a bare leading '=' to be evaluated.
    expect(line).not.toMatch(/(^|,)=SUM/);
  });

  it("uses the active property's currency, whichever property is selected", () => {
    expect(reportToCsv(build("csv", "GHS"))).toContain("GHS");
    const aud = reportToCsv(build("csv", "AUD", "ThesKwoff Bar"));
    expect(aud).toContain("AUD");
    expect(aud).not.toContain("GHS");
  });
});

describe("POS executive export — XLSX sheet rows", () => {
  it("produces a header row plus one row per report row", () => {
    const def = build("xlsx", "AUD", "ThesKwoff Bar");
    const sheet = reportToSheetRows(def);
    expect(sheet).toHaveLength(def.rows.length + 1);
    expect(sheet[0]).toContain("Currency");
  });

  it("keeps amounts as real numbers so spreadsheet formulas work", () => {
    const sheet = reportToSheetRows(build("xlsx", "AUD"));
    const sales = sheet.find((r) => r.includes("Operational Sales"))!;
    expect(sales.some((c) => c === 2544)).toBe(true);
  });

  it("stamps every row with the active currency code", () => {
    const sheet = reportToSheetRows(build("xlsx", "AUD"));
    for (const row of sheet.slice(1)) expect(row[row.length - 1]).toBe("AUD");
  });
});

describe("POS executive export — PDF / Print", () => {
  it("formats money for human reading in the property's currency", () => {
    for (const fmt of ["pdf", "print"] as const) {
      const def = build(fmt, "GHS");
      const sales = def.rows.find((r) => r.a === "Operational Sales")!;
      expect(String(sales.c)).toMatch(/2,544\.00/);
      expect(String(sales.c)).not.toBe("2544");
    }
  });

  it("still leaves counts unformatted and symbol-free", () => {
    const def = build("pdf", "GHS");
    const closed = def.rows.find((r) => r.a === "Closed Orders")!;
    expect(closed.c).toBe(37);
  });

  it("renders AUD amounts for an AUD property, never a hardcoded symbol", () => {
    const def = build("pdf", "AUD", "ThesKwoff Bar");
    const sales = def.rows.find((r) => r.a === "Operational Sales")!;
    expect(String(sales.c)).not.toMatch(/GH₵|GHS/);
  });
});

describe("POS executive export — identity", () => {
  it("names the property and range in the title, subtitle and filename", () => {
    const def = build("csv", "GHS");
    expect(def.title).toContain("Theskwoff Hotel");
    expect(def.dateRange).toEqual({ from: "2026-08-01", to: "2026-08-23" });
    expect(reportSubtitle(def)).toContain("2026-08-01");
    expect(reportFileName({ slug: def.slug, format: "csv" })).toContain("pos-executive-analytics");
  });

  it("uses the staff fallback label rather than a raw UUID", () => {
    const def = build("csv", "GHS");
    const staff = def.rows.filter((r) => r.section === "Staff").map((r) => r.a);
    expect(staff).toContain("Staff 11111111");
    expect(staff).toContain("Ama Mensah");
    expect(reportToCsv(def)).not.toContain("11111111-2222-3333-4444-555555555555");
  });

  it("keeps creator value and receiver value in distinct columns", () => {
    const def = build("csv", "GHS");
    const unnamed = def.rows.find((r) => r.a === "Staff 11111111")!;
    // created 0, received 900 — never merged into one "sales" figure.
    expect(unnamed.c).toBe(0);
    expect(unnamed.d).toBe(0);
    expect(unnamed.e).toBe(900);
  });
});
