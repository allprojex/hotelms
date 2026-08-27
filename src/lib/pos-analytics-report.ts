import { execMoney } from "@/lib/analytics-format";
import { staffLabel } from "@/lib/pos-staff-label";
import type { ReportDefinition, ReportFormat } from "@/lib/reports/report-core";

// Builds the POS Executive export from the RPC result sets. Kept out of the
// route component so the export can be exercised directly rather than only
// through a mounted dashboard.
//
// Exports carry the FULL RPC result sets for the selected property and range
// -- never a visually truncated chart slice. PDF/Print render money formatted
// in the property's currency; CSV/XLSX keep numeric cells and name the unit in
// a Currency column so spreadsheets stay usable.

/** One flattened export row: every section is emitted into this shape. */
export type ExportLine = {
  section: string;
  a: string;
  b: string;
  c: unknown;
  d: unknown;
  e: unknown;
};

export type PosReportInput = {
  format: ReportFormat;
  currency: string;
  propertyName: string | null;
  from: string;
  to: string;
  granularity: "day" | "month";
  summary: Record<string, unknown> | null;
  departments: Record<string, unknown>[];
  users: Record<string, unknown>[];
  topItems: Record<string, unknown>[];
  periods: Record<string, unknown>[];
};

const num = (v: unknown) => Number(v ?? 0);

export function buildPosExecReport(input: PosReportInput): ReportDefinition<ExportLine> {
  const { format, currency, propertyName, from, to, granularity } = input;
  const humanReadable = format === "pdf" || format === "print";
  const m = (v: unknown) => (humanReadable ? execMoney(v, currency) : num(v));

  const rows: ExportLine[] = [];
  const s = input.summary;

  if (s) {
    const amounts: [string, unknown][] = [
      ["Operational Sales", s.operational_sales],
      ["Net Sales", s.operational_sales_net],
      ["Tax", s.operational_tax],
      ["Till Payments", s.till_payment_amount],
      ["Folio Posted", s.folio_posted_amount],
      ["Live Order Value", s.open_order_line_value],
      ["Cash", s.cash_amount],
      ["Card", s.card_amount],
      ["Mobile Money", s.mobile_money_amount],
      ["Bank Transfer", s.bank_transfer_amount],
      ["Wallet", s.wallet_amount],
      ["Other", s.other_amount],
    ];
    for (const [k, v] of amounts)
      rows.push({ section: "Summary", a: k, b: "", c: m(v), d: "", e: "" });

    // Counts never receive a currency symbol, in any format.
    const counts: [string, unknown][] = [
      ["Closed Orders", s.closed_order_count],
      ["Live Orders", s.open_order_count],
      ["Void Orders", s.void_order_count],
      ["Till Payment Count", s.till_payment_count],
      ["Folio Posted Count", s.folio_posted_count],
    ];
    for (const [k, v] of counts)
      rows.push({ section: "Summary", a: k, b: "", c: num(v), d: "", e: "" });
  }

  for (const d of input.departments)
    rows.push({
      section: "Outlet",
      a: String(d.outlet_name ?? ""),
      b: String(d.outlet_kind ?? ""),
      c: m(d.operational_sales),
      d: num(d.order_count),
      e: m(d.open_order_line_value),
    });

  for (const u of input.users)
    rows.push({
      section: "Staff",
      a: staffLabel({
        full_name: (u.full_name as string | null) ?? null,
        user_id: (u.user_id as string | null) ?? null,
      }),
      b: "",
      c: m(u.orders_created_value),
      d: num(u.orders_created_count),
      e: m(u.till_payments_received_value),
    });

  for (const i of input.topItems)
    rows.push({
      section: "Item",
      a: String(i.item_name ?? ""),
      b: "",
      c: m(i.total_amount),
      d: num(i.total_quantity),
      e: num(i.order_count),
    });

  for (const p of input.periods)
    rows.push({
      section: granularity === "day" ? "Day" : "Month",
      a: String(p.period_start ?? ""),
      b: "",
      c: m(p.operational_sales),
      d: num(p.order_count),
      e: m(p.payments_received_amount),
    });

  return {
    title: `POS Executive Analytics — ${propertyName ?? "Property"}`,
    slug: "pos-executive-analytics",
    propertyName,
    dateRange: { from, to },
    columns: [
      { key: "section", label: "Section", value: (r) => r.section },
      { key: "a", label: "Name", value: (r) => r.a },
      { key: "b", label: "Type", value: (r) => r.b },
      { key: "c", label: "Amount", value: (r) => r.c },
      { key: "d", label: "Count / Quantity", value: (r) => r.d },
      { key: "e", label: "Secondary", value: (r) => r.e },
      { key: "cur", label: "Currency", value: () => currency },
    ],
    rows,
  };
}
