import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { execCurrency, execMoney, execNumber, EXEC_EMPTY } from "../src/lib/analytics-format";
import { buildHtmlReport } from "../src/lib/analytics-exports.server";
import { formatMoney } from "../src/lib/accounting/domain";

const root = resolve(__dirname, "..");
const analyticsPage = readFileSync(
  resolve(root, "src/routes/_authenticated/analytics.tsx"),
  "utf8",
);
const exportsServer = readFileSync(resolve(root, "src/lib/analytics-exports.server.ts"), "utf8");

const KPIS = {
  revenue: 26950,
  occupancy_pct: 93.75,
  adr: 898.33,
  revpar: 842.19,
  room_revenue: 26950,
  pos_revenue: 0,
  cancellation_rate: 4.5,
  avg_los: 2.4,
};
const DAILY = [{ day: "2026-08-01", room_revenue: 1200, pos_revenue: 45.5, total: 1245.5 }];
const SOURCES = [{ source: "direct", reservations: 12, revenue: 26950 }];
const TOP = [{ room_type: "Executive Suite", nights: 30, revenue: 26950 }];

function report(currency: string) {
  return buildHtmlReport(
    "Theskwoff",
    "2026-08-01",
    "2026-08-25",
    KPIS,
    DAILY,
    SOURCES,
    TOP,
    currency,
  );
}

describe("executive report — property currency source", () => {
  it("reads the currency from the property's base_currency, not a literal", () => {
    // Dashboard reads properties.base_currency for the active property only.
    expect(analyticsPage).toContain('.select("name, base_currency").eq("id", propertyId!)');
    expect(analyticsPage).toContain("execCurrency(property.data?.base_currency)");
    // Scheduled export reads it for the schedule's own property.
    expect(exportsServer).toContain(
      '.from("properties").select("name, base_currency").eq("id", schedule.property_id)',
    );
    expect(exportsServer).toContain("base_currency)");
  });

  it("falls back safely when base_currency is missing or malformed", () => {
    expect(execCurrency(undefined)).toBe("GHS");
    expect(execCurrency("")).toBe("GHS");
    expect(execCurrency("not a code")).toBe("GHS");
    expect(execCurrency("ghs")).toBe("GHS");
    expect(execCurrency("EUR")).toBe("EUR");
  });

  it("does not introduce a second currency setting", () => {
    expect(analyticsPage).not.toMatch(/currency_code|report_currency|display_currency/);
    expect(exportsServer).not.toMatch(/currency_code|report_currency|display_currency/);
  });
});

describe("executive report — shared formatter", () => {
  it("delegates to the project-wide formatMoney", () => {
    expect(execMoney(26950, "GHS")).toBe(formatMoney(26950, "GHS"));
    expect(execMoney(26950, "GHS")).toBe("GH₵26,950.00");
  });

  it("formats zero, negatives and two decimals", () => {
    expect(execMoney(0, "GHS")).toBe("GH₵0.00");
    expect(execMoney(-12.5, "GHS")).toBe("-GH₵12.50");
    expect(execMoney(898.333, "GHS")).toBe("GH₵898.33");
  });

  it("renders missing money as a placeholder rather than a bare symbol", () => {
    expect(execMoney(null, "GHS")).toBe(EXEC_EMPTY);
    expect(execMoney(undefined, "GHS")).toBe(EXEC_EMPTY);
    expect(execMoney("abc", "GHS")).toBe(EXEC_EMPTY);
  });

  it("keeps non-monetary values free of any currency symbol", () => {
    expect(execNumber(93.75, "%")).toBe("93.75%");
    expect(execNumber(2.4, " nts")).toBe("2.4 nts");
    expect(execNumber(12)).toBe("12");
    for (const rendered of [execNumber(93.75, "%"), execNumber(2.4, " nts"), execNumber(12)]) {
      expect(rendered).not.toMatch(/[$€₵]|GHS|USD/);
    }
    expect(execNumber(null)).toBe(EXEC_EMPTY);
  });
});

describe("executive dashboard — screen rendering", () => {
  it("renders every monetary KPI through the currency formatter", () => {
    for (const metric of ["revenue", "adr", "revpar", "room_revenue", "pos_revenue"]) {
      expect(analyticsPage).toContain(
        `value={kpis.data?.${metric}} loading={kpis.isLoading} currency={currency}`,
      );
    }
  });

  it("keeps occupancy, cancellation rate and LOS as plain numbers", () => {
    expect(analyticsPage).toContain(
      'value={kpis.data?.occupancy_pct} loading={kpis.isLoading} suffix="%"',
    );
    expect(analyticsPage).toContain(
      'value={kpis.data?.cancellation_rate} loading={kpis.isLoading} suffix="%"',
    );
    expect(analyticsPage).toContain(
      'value={kpis.data?.avg_los} loading={kpis.isLoading} suffix=" nts"',
    );
    expect(analyticsPage).not.toContain("currency={currency} suffix");
  });

  it("formats the source revenue column and chart tooltips with the same helper", () => {
    expect(analyticsPage).toContain("{money(r.revenue)}");
    expect(analyticsPage).not.toContain("Number(r.revenue).toFixed(2)");
    expect(
      analyticsPage.match(/<Tooltip formatter=\{\(v: number\) => money\(v\)\}/g) ?? [],
    ).toHaveLength(3);
  });

  it("has no hardcoded currency symbol or code left on this surface", () => {
    expect(analyticsPage).not.toContain('"GHS "');
    expect(analyticsPage).not.toMatch(/\$\$\{/);
    expect(analyticsPage).not.toMatch(/currency: ?"(USD|GHS)"/);
    expect(analyticsPage).not.toContain("new Intl.NumberFormat");
  });
});

describe("executive report — print / PDF / scheduled export", () => {
  it("uses the same currency source as the screen for the print view", () => {
    expect(analyticsPage).toContain("execCurrency(propRow?.base_currency)");
    expect(analyticsPage).toContain("const cur = (v: unknown) => execMoney(v, printCurrency);");
    expect(analyticsPage).toContain('const fmt = (v: unknown, s = "") => execNumber(v, s);');
  });

  it("renders GHS money in the exported report HTML", () => {
    const html = report("GHS");
    expect(html).toContain("GH₵26,950.00"); // total revenue / room revenue / source / top room type
    expect(html).toContain("GH₵0.00"); // POS revenue
    expect(html).toContain("GH₵1,245.50"); // daily total
    expect(html).toContain("GH₵898.33"); // ADR
    expect(html).toContain("GH₵842.19"); // RevPAR
  });

  it("no longer emits a dollar sign for a GHS property", () => {
    expect(report("GHS")).not.toContain("$");
    expect(exportsServer).not.toMatch(/\$\$\{/);
    expect(exportsServer).not.toContain("new Intl.NumberFormat");
  });

  it("keeps percentages and nights non-monetary in the exported report", () => {
    const html = report("GHS");
    expect(html).toContain("93.75%");
    expect(html).toContain("4.5%");
    expect(html).toContain("nts"); // avg LOS is expressed in nights, not money
    expect(html).toContain("<td>12</td>"); // reservation count
    expect(html).toContain("<td>30</td>"); // room nights
    expect(html).not.toContain("GH₵93.75");
    expect(html).not.toContain("GH₵2.40");
  });

  it("uses the property currency in the scheduled-export email summary", () => {
    expect(exportsServer).toContain("fmtMoney(kpis.revenue, currency)");
    expect(exportsServer).toContain("fmtMoney(kpis.revpar, currency)");
    expect(exportsServer).toContain('fmtNum(kpis.occupancy_pct, "%")');
  });

  it("passes the resolved currency into the report builder", () => {
    expect(exportsServer).toContain(
      "buildHtmlReport(propName, from, to, kpis, daily as any[], sources as any[], top as any[], currency)",
    );
  });
});

describe("executive report — multi-currency safety", () => {
  it.each([
    ["GHS", "GH₵26,950.00"],
    ["USD", "$26,950.00"],
    ["EUR", "€26,950.00"],
  ])("renders %s revenue as %s", (currency, expected) => {
    expect(execMoney(26950, currency)).toBe(expected);
    expect(report(currency)).toContain(expected);
  });

  it("changes the whole report when the property currency changes", () => {
    expect(report("GHS")).not.toBe(report("EUR"));
    expect(report("EUR")).toContain("€898.33");
    expect(report("EUR")).not.toContain("GH₵");
  });

  it("does not hardcode a single currency in the shared helper", () => {
    const helper = readFileSync(resolve(root, "src/lib/analytics-format.ts"), "utf8");
    expect(helper).not.toMatch(/currency: ?"(GHS|USD)"/);
    expect(helper).not.toContain("GH₵");
  });
});
