import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { pdfSafeText, reportRows, type ReportDefinition } from "../src/lib/reports/report-core";
import { execMoney } from "../src/lib/analytics-format";
import { formatMoney } from "../src/lib/accounting/domain";

const root = resolve(__dirname, "..");

function readSource(relPath: string): string {
  return readFileSync(resolve(root, relPath), "utf8").replace(/\r\n/g, "\n");
}

const posPage = readSource("src/routes/_authenticated/analytics_.pos.tsx");
const shell = readSource("src/routes/_authenticated/route.tsx");
const exportClient = readSource("src/lib/reports/report-export.client.ts");
const reportCore = readSource("src/lib/reports/report-core.ts");

/* ------------------------------------------------------------------ layout */

describe("POS analytics — horizontal overflow containment", () => {
  it("clamps the shell content column so a wide region cannot widen the document", () => {
    // The column is a flex item. Without min-w-0 its automatic minimum size is
    // the min-content width of the whole page, so a table inside its own
    // overflow-x-auto stretches the column past the viewport and the DOCUMENT
    // scrolls sideways instead of the table scrolling inside itself.
    // Measured at 375px: 271px of page overflow without this, 0 with it.
    expect(shell).toContain('<div className="flex min-w-0 flex-1 flex-col">');
    expect(shell).not.toContain('<div className="flex flex-1 flex-col">');
  });

  it("keeps the shell change to containment only — no structural rewrite", () => {
    // The sidebar/header/main structure must be untouched; only min-w-0 moved.
    expect(shell).toContain('<div className="flex min-h-screen w-full bg-background">');
    expect(shell).toContain('<main className="flex-1 p-4 sm:p-6">');
    expect(shell).toContain("<AppSidebar />");
    expect(shell).toContain("<SidebarProvider>");
  });

  it("drops to a single KPI column on a phone instead of forcing two", () => {
    // At 375px a two-column grid gave each card a ~278px min-content floor
    // (a GHS money string at text-xl is ~244px wide), i.e. 568px of grid in
    // 360px of viewport.
    expect(posPage).toContain('className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"');
    expect(posPage).toContain('className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"');
    expect(posPage).not.toContain('className="grid gap-3 grid-cols-2 lg:grid-cols-4"');
    expect(posPage).not.toContain('className="grid gap-3 grid-cols-2 lg:grid-cols-3"');
  });

  it("lets a KPI card shrink and its money value wrap", () => {
    // At 1024px the sidebar is expanded and lg:grid-cols-4 applies, leaving
    // ~155px per track; without these the value painted outside the card.
    expect(posPage).toContain('<Card className="min-w-0">');
    expect(posPage).toContain('className="text-xl font-semibold mt-1 tabular-nums break-words"');
    expect(posPage).toContain(
      'className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"',
    );
    expect(posPage).toContain('<span className="truncate">{label}</span>');
    expect(posPage).toContain("inline-flex shrink-0 items-center");
  });

  it("clamps the page root, the header block and the two-up bottom grid", () => {
    expect(posPage).toContain('<div className="p-4 md:p-6 space-y-4 min-w-0">');
    expect(posPage).toContain('<div className="min-w-0">');
    expect(posPage).toContain('<section aria-labelledby="pos-staff" className="min-w-0">');
    expect(posPage).toContain('<section aria-labelledby="pos-items" className="min-w-0">');
  });

  it("preserves the per-table scroll containers rather than removing them", () => {
    // Containment is what makes these work: before the fix they never scrolled,
    // they widened the page. A wide table must still be reachable by scrolling
    // inside its own box.
    expect(posPage.match(/className="overflow-x-auto"/g) ?? []).toHaveLength(3);
    expect(posPage).toContain('className="overflow-x-auto mt-2"');
    expect(posPage).not.toContain("overflow-x-hidden");
    expect(posPage).not.toContain("overflow-hidden");
  });

  it("does not reach for a truncation or clipping shortcut on money", () => {
    // truncate on a money value would hide digits; the fix wraps instead.
    expect(posPage).not.toContain("tabular-nums truncate");
    expect(posPage).not.toMatch(/text-xl font-semibold mt-1 tabular-nums truncate/);
  });
});

/* ------------------------------------------------------------- empty state */

describe("POS analytics — empty state honesty", () => {
  it("separates 'the query returned nothing' from 'the query never ran'", () => {
    expect(posPage).toContain("const RANGE_NOT_REQUESTED =");
    expect(posPage).toContain("notRequested?: boolean;");
    expect(posPage).toContain(
      'if (notRequested)\n    return <p className="text-sm text-muted-foreground py-6 text-center">{RANGE_NOT_REQUESTED}</p>;',
    );
  });

  it("checks notRequested before empty, so the wrong claim can never win", () => {
    const body = posPage.slice(posPage.indexOf("function SectionState"));
    const notRequestedAt = body.indexOf("if (notRequested)");
    const emptyAt = body.indexOf("if (empty)");
    expect(notRequestedAt).toBeGreaterThan(-1);
    expect(emptyAt).toBeGreaterThan(-1);
    expect(notRequestedAt).toBeLessThan(emptyAt);
  });

  it("derives the flag from the same condition that disables every query", () => {
    expect(posPage).toContain("const rangeRequested = from <= to;");
    expect(posPage).toContain("const enabled = !!propertyId && allowed && rangeRequested;");
  });

  it("stops Departments claiming the property has no outlets on an inverted range", () => {
    // The RPC returns every pos_outlets row for the property regardless of the
    // date range, so an empty result really would mean "no outlets" -- but only
    // if the query ran. With from > to it never runs.
    const departments = posPage.slice(posPage.indexOf('aria-labelledby="pos-departments"'));
    const state = departments.slice(0, departments.indexOf("</SectionState>"));
    expect(state).toContain("notRequested={!rangeRequested}");
    expect(state).toContain('emptyText="This property has no POS outlets."');
  });

  it("passes the flag to every section, not just Departments", () => {
    expect(posPage.match(/notRequested=\{!rangeRequested\}/g) ?? []).toHaveLength(5);
  });

  it("keeps the inline range warning on the filter card", () => {
    expect(posPage).toContain("The start date is after the end date — adjust the range to load");
  });
});

/* ---------------------------------------------------------------- headings */

describe("POS analytics — section heading semantics", () => {
  it("gives every section a real heading instead of a styled div", () => {
    // CardTitle renders a <div>, so none of these were in the heading outline.
    expect(posPage).not.toContain("CardTitle");
    expect(posPage).toContain(
      'import { Card, CardContent, CardHeader } from "@/components/ui/card"',
    );
    for (const id of ["pos-trend", "pos-departments", "pos-staff", "pos-items"]) {
      expect(posPage).toContain(
        `<h2 id="${id}" className="text-sm font-semibold leading-none tracking-tight">`,
      );
      expect(posPage).toContain(`aria-labelledby="${id}"`);
    }
  });

  it("nests Payment methods as an h3 under the Key figures h2", () => {
    expect(posPage).toContain('<h3 className="text-sm font-semibold leading-none tracking-tight">');
    expect(posPage).toContain('<h2 id="pos-kpis" className="sr-only">');
    expect(posPage).toContain('<section aria-labelledby="pos-kpis">');
  });

  it("keeps exactly one h1 and no heading level skips", () => {
    expect(posPage.match(/<h1\b/g) ?? []).toHaveLength(1);
    expect(posPage.match(/<h2\b/g) ?? []).toHaveLength(5);
    expect(posPage.match(/<h3\b/g) ?? []).toHaveLength(1);
    expect(posPage).not.toMatch(/<h4\b|<h5\b|<h6\b/);
  });

  it("does not modify the shared Card component to get there", () => {
    const card = readSource("src/components/ui/card.tsx");
    expect(card).toContain("const CardTitle = React.forwardRef");
    expect(card).not.toContain("asChild");
    expect(card).not.toContain("Slot");
  });
});

/* --------------------------------------------------------------------- PDF */

const CEDI = "₵";
const MICRO = "µ";

const NUL_BYTE = String.fromCharCode(0);

/** The text literals jsPDF wrote, ignoring the rest of the PDF container. */
function textLiterals(pdf: string): string[] {
  return pdf.match(/\((?:[^()\\]|\\.)*\)\s*Tj/g) ?? [];
}

/**
 * What a Latin-1 PDF reader actually shows: when jsPDF falls back to UTF-16BE
 * it pads each character to two bytes, and a WinAnsi font renders the NUL
 * padding as nothing.
 */
function asRendered(pdf: string): string {
  // Split rather than a regex: an escaped NUL inside a literal regex trips
  // no-control-regex, and the padding byte is what we are removing.
  return textLiterals(pdf).join(" ").split(NUL_BYTE).join("");
}

function pdfBytes(lines: string[]): string {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt" });
  doc.setFontSize(9);
  lines.forEach((line, i) => doc.text(line, 40, 40 + i * 16));
  return Buffer.from(new Uint8Array(doc.output("arraybuffer"))).toString("latin1");
}

function pdfTableBytes(definition: ReportDefinition<Record<string, unknown>>): string {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt" });
  doc.setFontSize(16);
  doc.text(pdfSafeText(definition.title), 40, 40);
  autoTable(doc, {
    startY: 70,
    head: [definition.columns.map((column) => pdfSafeText(column.label))],
    body: reportRows(definition).map((row) => row.map((value) => pdfSafeText(value))),
    styles: { fontSize: 8, cellPadding: 4 },
  });
  return Buffer.from(new Uint8Array(doc.output("arraybuffer"))).toString("latin1");
}

describe("shared PDF export — the GH₵ → GHµ defect", () => {
  it("reproduces the defect on raw jsPDF, proving the mechanism", () => {
    // U+20B5 has no WinAnsi slot, so jsPDF re-encodes the whole run as UTF-16BE
    // into a font the reader still decodes one byte at a time. The bytes reach
    // the page as 00 47 00 48 20 B5 ..., and WinAnsi reads 0xB5 as the micro
    // sign -- which is exactly the reported "GH₵ becomes GHµ".
    const raw = pdfBytes([`GH${CEDI}1,284,532.75`]);
    expect(raw).toContain(`\u0000G\u0000H ${MICRO}`);
    expect(asRendered(raw)).toContain(`GH ${MICRO}1,284,532.75`);
    expect(asRendered(raw)).not.toContain(CEDI);
  });

  it("emits the ISO code instead, so no micro sign reaches the page", () => {
    const safe = pdfBytes([pdfSafeText(`GH${CEDI}1,284,532.75`)]);
    expect(safe).toContain("GHS 1,284,532.75");
    expect(safe).not.toContain(`GH ${MICRO}`);
    expect(safe).not.toContain(`GH${MICRO}`);
    expect(safe).not.toContain(CEDI);
  });

  it("substitutes the whole narrow symbol, never leaving a stray prefix", () => {
    expect(pdfSafeText(`GH${CEDI}1,284,532.75`)).toBe("GHS 1,284,532.75");
    expect(pdfSafeText(`GH${CEDI}1,284,532.75`)).not.toContain("GHGHS");
    expect(pdfSafeText(`-GH${CEDI}12.50`)).toBe("-GHS 12.50");
  });

  it("rewrites a whole GHS report table with no mangled currency left", () => {
    const rows = [
      { outlet: "Poolside Bar", sales: execMoney(1284532.75, "GHS"), orders: "1,284" },
      { outlet: "Rooftop Lounge", sales: execMoney(0, "GHS"), orders: "0" },
    ];
    const bytes = pdfTableBytes({
      title: `POS report ${execMoney(1284532.75, "GHS")}`,
      slug: "pos",
      columns: [
        { key: "outlet", label: "Outlet", value: (r) => r.outlet },
        { key: "sales", label: "Operational Sales", value: (r) => r.sales },
        { key: "orders", label: "Closed Orders", value: (r) => r.orders },
      ],
      rows,
    });
    expect(bytes).toContain("GHS 1,284,532.75");
    expect(bytes).toContain("GHS 0.00");
    expect(bytes).not.toContain(MICRO);
    expect(bytes).not.toContain(CEDI);
    expect(bytes).toContain("1,284"); // counts are untouched
  });

  it("leaves an AUD report exactly as it was — $ is Latin-1", () => {
    const aud = execMoney(1284532.75, "AUD");
    expect(pdfSafeText(aud)).toBe(aud);
    // Identical text objects on the page before and after; the PDF's creation
    // timestamp is the only thing that differs between two runs.
    expect(textLiterals(pdfBytes([pdfSafeText(aud)]))).toEqual(textLiterals(pdfBytes([aud])));
    expect(asRendered(pdfBytes([pdfSafeText(aud)]))).toContain("$1,284,532.75");
    expect(asRendered(pdfBytes([pdfSafeText(aud)]))).not.toContain("AUD ");
  });

  it.each(["AUD", "USD", "GBP", "JPY"])("does not touch %s money at all", (code) => {
    const money = formatMoney(1234.5, code);
    expect(pdfSafeText(money)).toBe(money);
  });

  it("also rescues the euro sign, which jsPDF was dropping outright", () => {
    const eur = execMoney(1234.5, "EUR");
    expect(eur).toContain("€");
    const before = pdfBytes([eur]);
    expect(before).not.toContain("€");
    expect(pdfSafeText(eur)).toBe("EUR 1,234.50");
    expect(pdfBytes([pdfSafeText(eur)])).toContain("EUR 1,234.50");
  });

  it("returns plain Latin-1 text untouched, including empty and null", () => {
    expect(pdfSafeText("Poolside Bar & Grill")).toBe("Poolside Bar & Grill");
    expect(pdfSafeText("Café Terrace")).toBe("Café Terrace");
    expect(pdfSafeText("1,284")).toBe("1,284");
    expect(pdfSafeText(42)).toBe("42");
    expect(pdfSafeText(null)).toBe("");
    expect(pdfSafeText(undefined)).toBe("");
  });

  it("refuses to guess a code for a symbol more than one currency owns", () => {
    // ₩ is both KRW and KPW. A mangled glyph beats a confidently wrong code.
    expect(pdfSafeText("₩1,000")).toContain("₩");
    expect(pdfSafeText("₩1,000")).not.toContain("KRW");
    expect(pdfSafeText("₩1,000")).not.toContain("KPW");
  });

  it("resolves other unambiguous non-Latin-1 symbols from Intl, not a hand list", () => {
    expect(pdfSafeText("₦1,000")).toBe("NGN 1,000"); // naira
    expect(pdfSafeText("₹1,000")).toBe("INR 1,000"); // rupee
    expect(reportCore).not.toMatch(/"GH₵"\s*:/);
    expect(reportCore).toContain('Intl.supportedValuesOf("currency")');
  });

  it("routes every string the PDF writer receives through the helper", () => {
    expect(exportClient).toContain("document.text(pdfSafeText(definition.title), 40, 40)");
    expect(exportClient).toContain(
      "document.text(pdfSafeText(reportSubtitle(definition)), 40, 56)",
    );
    expect(exportClient).toContain(
      "head: [definition.columns.map((column) => pdfSafeText(column.label))]",
    );
    expect(exportClient).toContain(
      "reportRows(definition).map((row) => row.map((value) => pdfSafeText(value)))",
    );
    expect(exportClient).not.toContain('row.map((value) => String(value ?? ""))');
  });

  it("confines the change to the PDF branch — CSV, XLSX and Print keep the symbol", () => {
    const csvBranch = exportClient.slice(
      exportClient.indexOf('if (format === "csv")'),
      exportClient.indexOf('if (format === "pdf")'),
    );
    expect(csvBranch).not.toContain("pdfSafeText");
    const printBranch = exportClient.slice(exportClient.indexOf("const bodyHtml ="));
    expect(printBranch).not.toContain("pdfSafeText");
    expect(printBranch).toContain("openPrintView");
  });

  it("does not embed a font or otherwise grow the export bundle", () => {
    expect(exportClient).not.toContain("addFileToVFS");
    expect(exportClient).not.toContain("addFont");
    expect(exportClient).not.toContain("setFont(");
    expect(reportCore).not.toContain("addFileToVFS");
    expect(reportCore).not.toMatch(/\.ttf|data:font|atob\(/);
    expect(exportClient).not.toMatch(/\.ttf|data:font|atob\(/);
  });
});

describe("browser and print formatting are unchanged", () => {
  it("keeps the narrow cedi symbol everywhere except the PDF writer", () => {
    expect(execMoney(1284532.75, "GHS")).toBe(`GH${CEDI}1,284,532.75`);
    expect(formatMoney(1284532.75, "GHS")).toBe(`GH${CEDI}1,284,532.75`);
  });

  it("keeps the POS page rendering money through the property currency", () => {
    expect(posPage).toContain("execCurrency(property.data?.base_currency)");
    expect(posPage).toContain("const money = (v: unknown) => execMoney(v, currency);");
    expect(posPage).not.toMatch(/["'`](GHS|AUD|USD)["'`]/);
  });

  it("switches with the property, not with a hardcoded default", () => {
    expect(posPage).toContain('queryKey: ["pos-exec-property", propertyId]');
    expect(execMoney(100, "GHS")).not.toBe(execMoney(100, "AUD"));
  });
});

/* ------------------------------------------------------- no maths changed */

describe("no calculation, RPC or report semantics changed", () => {
  it("leaves the five exec_pos_* query definitions exactly as PR-A/PR-B left them", () => {
    for (const key of [
      '["pos-exec-summary", args]',
      '["pos-exec-departments", args]',
      '["pos-exec-users", args]',
      '["pos-exec-top-items", args, 10]',
      '["pos-exec-periods", args, granularity]',
    ]) {
      expect(posPage).toContain(key);
    }
    expect(posPage).toContain("const args = { propertyId: propertyId!, from, to };");
    expect(posPage).toContain("const LIVE_REFETCH_MS = 60_000;");
  });

  it("leaves the derived chart/table data untouched", () => {
    expect(posPage).toContain("sales: Number(r.operational_sales ?? 0)");
    expect(posPage).toContain("payments: Number(r.payments_received_amount ?? 0)");
    expect(posPage).toContain(".filter((d) => d.sales > 0)");
  });

  it("adds no migration and does not alter the shipped RPC SQL", () => {
    const corrections = readSource(
      "supabase/migrations/20260826133000_exec_pos_dashboard_corrections.sql",
    );
    expect(corrections).toContain("CREATE OR REPLACE FUNCTION public.exec_pos_by_department(");
    expect(corrections).toContain("FROM pos_outlets ou\n  WHERE ou.property_id = _property_id");
  });

  it("leaves the export row/CSV pipeline semantics alone", () => {
    expect(reportCore).toContain("export function reportToCsv<Row>(");
    expect(reportCore).toContain("neutralizeSpreadsheetFormula");
    expect(reportCore).toContain("const FORMULA_PREFIX = /^[\\t\\r ]*[=+\\-@]/;");
  });
});
