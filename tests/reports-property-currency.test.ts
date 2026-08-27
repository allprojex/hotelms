import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { execCurrency, execMoney, execNumber, EXEC_EMPTY } from "../src/lib/analytics-format";
import { formatMoney } from "../src/lib/accounting/domain";

const root = resolve(__dirname, "..");

function readSource(relPath: string): string {
  return readFileSync(resolve(root, relPath), "utf8").replace(/\r\n/g, "\n");
}

const reportsPage = readSource("src/routes/_authenticated/reports.tsx");

// The three KPI cards that regressed in production: bare `.toFixed(2)` output
// with no currency at all (Revenue 83300.00, ADR 355.98, RevPAR 185.94).
const MONETARY_KPIS = ["totalRev", "adr", "revpar"] as const;

describe("reports page — currency source", () => {
  it("resolves money from the active property's base_currency", () => {
    expect(reportsPage).toContain('.from("properties")');
    expect(reportsPage).toContain('.select("name, base_currency")');
    expect(reportsPage).toContain('.eq("id", propertyId!)');
    expect(reportsPage).toContain("execCurrency(property.data?.base_currency)");
  });

  it("keys the currency query by property so switching property refetches", () => {
    expect(reportsPage).toContain('queryKey: ["reports-property-currency", propertyId]');
    expect(reportsPage).toContain("enabled: !!propertyId");
  });

  it("reuses the shared analytics formatters rather than inventing new ones", () => {
    expect(reportsPage).toContain(
      'import { execCurrency, execMoney, execNumber } from "@/lib/analytics-format";',
    );
    expect(reportsPage).not.toContain("new Intl.NumberFormat");
  });

  it("does not introduce a second currency setting", () => {
    expect(reportsPage).not.toMatch(/currency_code|report_currency|display_currency/);
  });

  it("hardcodes no currency symbol or code anywhere on the surface", () => {
    expect(reportsPage).not.toMatch(/GH₵|€|£|¥|₵/);
    expect(reportsPage).not.toMatch(/["'`](GHS|USD|AUD|EUR|GBP)["'`]/);
    expect(reportsPage).not.toMatch(/currency: ?["'](GHS|USD|AUD)["']/);
  });
});

describe("reports page — monetary KPIs", () => {
  it.each(MONETARY_KPIS)("renders %s through the property-currency formatter", (metric) => {
    expect(reportsPage).toContain("value={money(d?." + metric + ")}");
  });

  it("no longer renders any monetary KPI as a bare number", () => {
    // This is the exact regression: `(d?.totalRev ?? 0).toFixed(2)` and friends.
    for (const metric of MONETARY_KPIS) {
      expect(reportsPage).not.toContain("d?." + metric + " ?? 0).toFixed(2)");
      expect(reportsPage).not.toContain("d?." + metric + ").toFixed");
    }
    expect(reportsPage).not.toContain(".toFixed(2)");
  });

  it("routes money through execMoney and never through toLocaleString directly", () => {
    expect(reportsPage).toContain("execMoney(value, currency)");
    expect(reportsPage).not.toContain("toLocaleString");
  });
});

describe("reports page — non-monetary values stay currency-free", () => {
  it("renders average occupancy as a plain percentage", () => {
    expect(reportsPage).toContain('value={execNumber(d?.avgOcc, "%")}');
    expect(reportsPage).not.toContain("money(d?.avgOcc)");
  });

  it("formats the occupancy chart tooltip with the non-monetary helper", () => {
    expect(reportsPage).toContain('<Tooltip formatter={(v: number) => execNumber(v, "%")}');
  });

  it("keeps the occupancy axis a percentage axis", () => {
    expect(reportsPage).toContain('unit="%"');
  });
});

describe("reports page — charts and tooltips", () => {
  it("formats the daily revenue tooltip in the property currency", () => {
    expect(reportsPage).toContain("<Tooltip formatter={(v: number) => money(v)}");
  });

  it("labels the revenue chart with the resolved currency, not a literal", () => {
    expect(reportsPage).toContain("Daily revenue ({currency})");
  });

  it("leaves exactly one money tooltip and one percentage tooltip", () => {
    expect(reportsPage.match(/formatter=\{\(v: number\) => money\(v\)\}/g) ?? []).toHaveLength(1);
    expect(
      reportsPage.match(/formatter=\{\(v: number\) => execNumber\(v, "%"\)\}/g) ?? [],
    ).toHaveLength(1);
  });

  it("has no untouched raw Tooltip left on a monetary series", () => {
    // Every <Tooltip> on this page must carry an explicit formatter.
    const tooltips = reportsPage.match(/<Tooltip\b[^>]*/g) ?? [];
    expect(tooltips).toHaveLength(2);
    for (const tag of tooltips) expect(tag).toContain("formatter=");
  });
});

describe("reports page — export surfaces", () => {
  it("has no CSV/XLSX/PDF/print export to format (guards a future one)", () => {
    // If an export is ever added here it must go through the shared report
    // pipeline and the same `money` helper — this test fails loudly first.
    expect(reportsPage).not.toContain("report-export.client");
    expect(reportsPage).not.toContain("ReportDefinition");
    expect(reportsPage).not.toContain("window.print");
    expect(reportsPage).not.toContain("toCsv");
  });
});

describe("reports page — multi-property currency behaviour", () => {
  // Theskwoff Hotel (TH-0001) is configured GHS; ThesKwoff Bar is configured AUD.
  // The three figures below are the exact production values that regressed.
  it("renders the reported KPIs in the GHS property's currency", () => {
    expect(execMoney(83300, "GHS")).toBe("GH₵83,300.00");
    expect(execMoney(355.98, "GHS")).toBe("GH₵355.98");
    expect(execMoney(185.94, "GHS")).toBe("GH₵185.94");
  });

  // Asserted against formatMoney rather than a literal symbol: a narrow symbol
  // is locale-dependent, and pinning one would make this a locale test rather
  // than a currency-routing test.
  it.each(["AUD", "USD", "EUR"])("renders the reported KPIs in %s", (currency) => {
    for (const value of [83300, 355.98, 185.94]) {
      expect(execMoney(value, currency)).toBe(formatMoney(value, currency));
    }
  });

  it("produces a different rendering per property currency", () => {
    expect(execMoney(83300, "GHS")).not.toBe(execMoney(83300, "AUD"));
    expect(execMoney(83300, "AUD")).not.toContain("GH₵");
    expect(execMoney(83300, "GHS")).not.toBe(execMoney(83300, "EUR"));
  });

  it("never emits a bare number for a monetary value", () => {
    for (const currency of ["GHS", "AUD", "USD", "EUR"]) {
      const rendered = execMoney(83300, currency);
      expect(rendered).not.toBe("83300.00");
      expect(rendered).toMatch(/[^\d.,\s-]/); // carries a symbol or code
    }
  });

  it("falls back safely when a property has no base_currency", () => {
    expect(execCurrency(undefined)).toBe("GHS");
    expect(execCurrency("aud")).toBe("AUD");
    expect(execCurrency("not a code")).toBe("GHS");
  });

  it("shows a placeholder rather than a wrong-currency figure while loading", () => {
    expect(reportsPage).toContain("property.isPending ? execMoney(null, currency)");
    expect(execMoney(null, "GHS")).toBe(EXEC_EMPTY);
  });

  it("keeps occupancy free of any currency in every currency", () => {
    expect(execNumber(62, "%")).toBe("62%");
    expect(execNumber(62, "%")).not.toMatch(/[$€₵]|GHS|AUD/);
  });

  it("keeps the shared helper itself currency-agnostic", () => {
    const helper = readSource("src/lib/analytics-format.ts");
    expect(helper).not.toMatch(/currency: ?"(GHS|USD|AUD)"/);
    expect(helper).not.toContain("GH₵");
  });
});
