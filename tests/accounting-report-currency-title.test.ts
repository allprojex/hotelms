import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatMoney, safeCurrencyCode } from "../src/lib/accounting/domain";
import {
  reportToCsv,
  reportToSheetRows,
  type ReportDefinition,
} from "../src/lib/reports/report-core";

const root = resolve(__dirname, "..");
const reportsPage = readFileSync(
  resolve(root, "src/routes/_authenticated/accounting.reports.tsx"),
  "utf8",
);
const expensesTab = readFileSync(
  resolve(root, "src/components/accounting/expense-reports-tab.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Behavioral fixtures: rebuild the exact column pipeline the page ships, so the
// screen value, the print/PDF value and the CSV/XLSX value are all produced by
// one formatter -- the property's base currency -- and can be asserted as one.
// ---------------------------------------------------------------------------
type PlRow = { code: string; name: string; type: string; amount: number };
type TbRow = {
  code: string;
  name: string;
  type: string;
  debit_total: number;
  credit_total: number;
  balance: number;
};

const money = (currency: string) => (n: number) => formatMoney(n, currency);

function plDefinition(currency: string): ReportDefinition<PlRow> {
  const m = money(currency);
  return {
    title: "Profit & Loss",
    slug: "profit-loss",
    dateRange: { from: "2026-01-01", to: "2026-08-25" },
    columns: [
      { key: "code", label: "Code", value: (r) => r.code },
      { key: "account", label: "Account", value: (r) => r.name },
      { key: "type", label: "Type", value: (r) => r.type },
      { key: "amount", label: "Amount", value: (r) => m(Number(r.amount)) },
    ],
    rows: [
      { code: "4000", name: "Room Revenue", type: "revenue", amount: 13676 },
      { code: "6000", name: "Operating Expenses", type: "expense", amount: 0 },
    ],
  };
}

function tbDefinition(currency: string): ReportDefinition<TbRow> {
  const m = money(currency);
  return {
    title: "Trial Balance",
    slug: "trial-balance",
    dateRange: { from: "2026-01-01", to: "2026-08-25" },
    columns: [
      { key: "code", label: "Code", value: (r) => r.code },
      { key: "account", label: "Account", value: (r) => r.name },
      { key: "type", label: "Type", value: (r) => r.type },
      { key: "debit", label: "Debit", value: (r) => m(Number(r.debit_total)) },
      { key: "credit", label: "Credit", value: (r) => m(Number(r.credit_total)) },
      { key: "balance", label: "Balance", value: (r) => m(Number(r.balance)) },
    ],
    rows: [
      {
        code: "1000",
        name: "Cash",
        type: "asset",
        debit_total: 13676,
        credit_total: 0,
        balance: 13676,
      },
    ],
  };
}

describe("accounting reports — currency source", () => {
  it("reads the active property's base_currency, not a literal", () => {
    expect(reportsPage).toContain('.select("name, base_currency")');
    expect(reportsPage).toContain('.eq("id", propertyId!)');
    expect(reportsPage).toContain("safeCurrencyCode(property.data?.base_currency)");
    expect(reportsPage).toContain(
      'import { formatMoney, safeCurrencyCode } from "@/lib/accounting/domain"',
    );
  });

  it("no longer defines the bare-number formatter that caused the defect", () => {
    // The old `fmt` produced "13,676.00" with no currency at all.
    expect(reportsPage).not.toContain("const fmt = (n: number) =>");
    expect(reportsPage).not.toMatch(/\bfmt\(/);
  });

  it("does not hardcode any currency or introduce a second setting", () => {
    expect(reportsPage).not.toContain("GH₵");
    expect(reportsPage).not.toMatch(/["'](GHS|USD|EUR)["']/);
    expect(reportsPage).not.toMatch(/currency_code|report_currency|display_currency/);
    expect(reportsPage).not.toContain("new Intl.NumberFormat");
  });

  it("falls back safely when base_currency is missing or malformed", () => {
    expect(safeCurrencyCode(undefined)).toBe("GHS");
    expect(safeCurrencyCode("")).toBe("GHS");
    expect(safeCurrencyCode("not a code")).toBe("GHS");
    expect(safeCurrencyCode("eur")).toBe("EUR");
  });
});

describe("accounting reports — Profit & Loss", () => {
  it("formats revenue and expense amounts in the property currency", () => {
    expect(reportsPage).toContain("value: (r: any) => money(Number(r.amount))");
    const rows = plDefinition("GHS").rows;
    const amount = plDefinition("GHS").columns.find((c) => c.key === "amount")!;
    expect(amount.value(rows[0])).toBe("GH₵13,676.00");
    expect(amount.value(rows[1])).toBe("GH₵0.00");
  });

  it("formats Net Income and section totals in the property currency", () => {
    expect(reportsPage).toContain("money(totalRev - totalExp)");
    expect(reportsPage).toContain(
      '<Section title="Revenue" rows={plRev} total={totalRev} currency={currency} />',
    );
    expect(reportsPage).toContain(
      '<Section title="Expenses" rows={plExp} total={totalExp} currency={currency} />',
    );
    expect(formatMoney(13676, "GHS")).toBe("GH₵13,676.00");
  });
});

describe("accounting reports — Balance Sheet", () => {
  it("formats asset, liability and equity balances in the property currency", () => {
    expect(reportsPage).toContain("value: (r: any) => money(Number(r.balance))");
    for (const section of ["Assets", "Liabilities", "Equity"]) {
      expect(reportsPage).toContain(`<SectionBS title="${section}"`);
    }
    expect(reportsPage.match(/<SectionBS [^>]*currency=\{currency\} \/>/g) ?? []).toHaveLength(3);
  });

  it("formats Total Assets / Total L + E in the property currency", () => {
    expect(reportsPage).toContain("money(totalLiab + totalEq)");
    // SectionBS renders "Total {title}" through its own currency-aware money().
    expect(reportsPage).toContain(
      "function SectionBS({ title, rows, total, currency }: { title: string; rows: any[]; total: number; currency: string }) {",
    );
    expect(reportsPage).toContain("const money = (n: number) => formatMoney(n, currency);");
  });
});

describe("accounting reports — Trial Balance", () => {
  it("formats Debit, Credit and Balance in the property currency", () => {
    const def = tbDefinition("GHS");
    const row = def.rows[0];
    expect(def.columns.find((c) => c.key === "debit")!.value(row)).toBe("GH₵13,676.00");
    expect(def.columns.find((c) => c.key === "credit")!.value(row)).toBe("GH₵0.00");
    expect(def.columns.find((c) => c.key === "balance")!.value(row)).toBe("GH₵13,676.00");
    expect(reportsPage).toContain("value: (r: any) => money(Number(r.debit_total))");
    expect(reportsPage).toContain("value: (r: any) => money(Number(r.credit_total))");
  });

  it("formats the Debit/Credit/Balance totals row in the property currency", () => {
    expect(reportsPage).toContain("money(tbDr)");
    expect(reportsPage).toContain("money(tbCr)");
    expect(reportsPage).toContain("money(tbDr - tbCr)");
  });
});

describe("accounting reports — screen / print / CSV / XLSX consistency", () => {
  it("sends the same formatted string to print, CSV and XLSX", () => {
    const def = tbDefinition("GHS");
    const balance = def.columns.find((c) => c.key === "balance")!.value(def.rows[0]);
    expect(balance).toBe("GH₵13,676.00");
    expect(reportToCsv(def)).toContain("GH₵13,676.00");
    const sheet = reportToSheetRows(def);
    expect(sheet[1]).toContain("GH₵13,676.00");
  });

  it("does not add a currency symbol to codes, account names, types or counts", () => {
    const def = tbDefinition("GHS");
    const row = def.rows[0];
    for (const key of ["code", "account", "type"]) {
      const rendered = String(def.columns.find((c) => c.key === key)!.value(row));
      expect(rendered).not.toMatch(/[$€₵]|GHS|USD/);
    }
    expect(String(def.columns.find((c) => c.key === "code")!.value(row))).toBe("1000");
  });

  it("keeps the export pipeline reading from the same rows the screen renders", () => {
    // Unchanged invariant from Reporting PR1 -- guard against regression.
    expect(reportsPage).toContain("rows: pl.data ?? []");
    expect(reportsPage).toContain("rows: bs.data ?? []");
    expect(reportsPage).toContain("rows: tb.data ?? []");
  });
});

describe("accounting reports — multi-currency", () => {
  it.each([
    ["GHS", "GH₵13,676.00"],
    ["USD", "$13,676.00"],
    ["EUR", "€13,676.00"],
  ])("renders %s balances as %s", (currency, expected) => {
    const def = tbDefinition(currency);
    expect(def.columns.find((c) => c.key === "balance")!.value(def.rows[0])).toBe(expected);
    expect(reportToCsv(def)).toContain(expected);
  });

  it("changes P&L output when the property currency changes", () => {
    const amountOf = (c: string) => {
      const d = plDefinition(c);
      return d.columns.find((col) => col.key === "amount")!.value(d.rows[0]);
    };
    expect(amountOf("GHS")).not.toBe(amountOf("EUR"));
    expect(amountOf("EUR")).toBe("€13,676.00");
    expect(amountOf("EUR")).not.toContain("GH₵");
  });

  it("emits no hardcoded dollar sign for a GHS property", () => {
    expect(reportToCsv(tbDefinition("GHS"))).not.toContain("$");
    expect(reportToCsv(plDefinition("GHS"))).not.toContain("$");
  });
});

// ---------------------------------------------------------------------------
// Expense report titles
// ---------------------------------------------------------------------------
const EXPENSE_REPORT_TYPES = [
  { value: "register", label: "Expense register" },
  { value: "by-category", label: "By category" },
  { value: "by-vendor", label: "By vendor" },
  { value: "by-cost-centre", label: "By cost centre" },
  { value: "by-department", label: "By department" },
  { value: "by-payment-method", label: "By payment method" },
  { value: "approved", label: "Approved expenses" },
  { value: "rejected", label: "Rejected expenses" },
  { value: "cancelled", label: "Cancelled expenses" },
  { value: "missing-receipts", label: "Missing receipts" },
  { value: "approval-history", label: "Approval history" },
  { value: "corrections-reversals", label: "Corrections & reversals" },
] as const;
const GROUPED_TYPES = new Set([
  "by-category",
  "by-vendor",
  "by-cost-centre",
  "by-department",
  "by-payment-method",
]);

/** Mirrors the shipped title derivation in buildDefinition(). */
function titleFor(reportType: string): string {
  const label = EXPENSE_REPORT_TYPES.find((r) => r.value === reportType)?.label ?? reportType;
  return GROUPED_TYPES.has(reportType) ? `Expenses ${label.toLocaleLowerCase()}` : label;
}

describe("expense report titles", () => {
  it("no longer duplicates the word Expense", () => {
    expect(titleFor("register")).toBe("Expense register");
    expect(titleFor("register")).not.toBe("Expense Expense register");
    for (const { value } of EXPENSE_REPORT_TYPES) {
      expect(titleFor(value)).not.toMatch(/\bExpense\s+Expense\b/i);
      expect(titleFor(value)).not.toMatch(/^Expense (Approved|Rejected|Cancelled|Missing)/);
    }
  });

  it("reads naturally for every report type", () => {
    expect(titleFor("by-category")).toBe("Expenses by category");
    expect(titleFor("by-vendor")).toBe("Expenses by vendor");
    expect(titleFor("by-cost-centre")).toBe("Expenses by cost centre");
    expect(titleFor("by-department")).toBe("Expenses by department");
    expect(titleFor("by-payment-method")).toBe("Expenses by payment method");
    expect(titleFor("approved")).toBe("Approved expenses");
    expect(titleFor("rejected")).toBe("Rejected expenses");
    expect(titleFor("cancelled")).toBe("Cancelled expenses");
    expect(titleFor("missing-receipts")).toBe("Missing receipts");
    expect(titleFor("approval-history")).toBe("Approval history");
    expect(titleFor("corrections-reversals")).toBe("Corrections & reversals");
  });

  it("produces a non-empty title for every declared report type", () => {
    for (const { value } of EXPENSE_REPORT_TYPES) {
      const t = titleFor(value);
      expect(t.trim().length).toBeGreaterThan(0);
      expect(t).not.toContain("undefined");
    }
  });

  it("derives every branch's title from one source, with no prefixed literals", () => {
    expect(expensesTab).toContain("const reportTitle = GROUPED_TYPES.has(reportType)");
    expect(expensesTab).toContain("`Expenses ${reportLabel.toLocaleLowerCase()}`");
    expect(expensesTab.match(/title: reportTitle,/g) ?? []).toHaveLength(4);
    expect(expensesTab).not.toContain("title: `Expense ${reportLabel}`");
    expect(expensesTab).not.toContain("title: `Expenses ${reportLabel}`");
    expect(expensesTab).not.toContain('title: "Expense approval history"');
  });

  it("leaves the expense rows' own per-record currency handling untouched", () => {
    // Expenses carry their own currency column; that path is unchanged.
    expect(expensesTab).toContain("formatMoney(r.total, r.currency)");
    expect(expensesTab).toContain("formatMoney(r.total_amount, r.currency)");
  });
});

describe("no mutation behavior introduced", () => {
  it("the reports page still only reads", () => {
    for (const forbidden of [".insert(", ".update(", ".delete(", ".upsert("]) {
      expect(reportsPage).not.toContain(forbidden);
      expect(expensesTab).not.toContain(forbidden);
    }
    // The only new database access is a scoped, single-property SELECT.
    expect(reportsPage).toContain('.from("properties")');
    expect(reportsPage).toContain(".maybeSingle()");
  });
});
