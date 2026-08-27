export type ReportFormat = "csv" | "xlsx" | "pdf" | "print";

export type ReportDateRange = {
  from: string;
  to: string;
};

export type ReportColumn<Row> = {
  key: string;
  label: string;
  value: (row: Row) => unknown;
};

export type ReportDefinition<Row> = {
  title: string;
  slug: string;
  columns: readonly ReportColumn<Row>[];
  rows: readonly Row[];
  propertyName?: string | null;
  dateRange?: ReportDateRange | null;
  generatedAt?: Date;
};

const FORMULA_PREFIX = /^[\t\r ]*[=+\-@]/;

export function neutralizeSpreadsheetFormula(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

export function csvCell(value: unknown): string {
  const safe = neutralizeSpreadsheetFormula(value);
  const text = safe == null ? "" : String(safe);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function reportRows<Row>(
  definition: Pick<ReportDefinition<Row>, "columns" | "rows">,
): unknown[][] {
  return definition.rows.map((row) =>
    definition.columns.map((column) => neutralizeSpreadsheetFormula(column.value(row))),
  );
}

export function reportToCsv<Row>(
  definition: Pick<ReportDefinition<Row>, "columns" | "rows">,
): string {
  const header = definition.columns.map((column) => csvCell(column.label));
  const body = reportRows(definition).map((row) => row.map(csvCell).join(","));
  return [header.join(","), ...body].join("\r\n");
}

export function reportToSheetRows<Row>(
  definition: Pick<ReportDefinition<Row>, "columns" | "rows">,
): unknown[][] {
  return [definition.columns.map((column) => column.label), ...reportRows(definition)];
}

/**
 * PDF's standard-14 fonts -- jsPDF's default Helvetica, which every export in
 * this app uses -- can only carry WinAnsi (Latin-1) characters. Hand one a
 * character outside that set and jsPDF re-emits the whole string as UTF-16BE
 * into a font the reader still decodes one byte at a time, so
 * "GH₵1,284,532.75" reaches the page as "GH" + 0x20 0xB5 + ... and renders as
 * "GH µ1,284,532.75": 0xB5 is WinAnsi's micro sign, the low byte of U+20B5.
 * That is the reported "GH₵ becomes GHµ". The euro sign fares worse -- U+20AC
 * has no WinAnsi slot in jsPDF's table at all and is dropped outright, so a
 * EUR report has been printing bare numbers.
 *
 * Embedding a Unicode TTF would fix it, but a subsetted face is hundreds of KB
 * of base64 in the export chunk and it restyles every PDF the app produces.
 * The cheaper and more legible answer for a document is the ISO 4217 code:
 * PDF output renders "GHS 1,284,532.75" while the browser and the HTML Print
 * view keep the narrow symbol.
 *
 * The symbol -> code table is derived from Intl at first use rather than
 * hand-written, so the codes are the runtime's real ones and no symbol is
 * guessed. Two guards keep it honest:
 *   - only symbols that actually contain a non-Latin-1 character are listed,
 *     so "$", "£", "¥" and "€"-free Latin-1 text is returned untouched and an
 *     AUD or USD report is byte-identical to before;
 *   - a symbol owned by more than one currency (₩ is both KRW and KPW) is
 *     left alone. A mangled glyph is better than a confidently wrong code.
 *
 * Characters outside Latin-1 that are not currency symbols (a non-Latin outlet
 * or guest name, say) are deliberately left as they are: this is a currency
 * display fix, not a licence to rewrite report data.
 */
function isLatin1(text: string): boolean {
  for (const character of text) {
    if (character.codePointAt(0)! > 0xff) return false;
  }
  return true;
}

let currencySymbolCodes: [string, string][] | null = null;

function unencodableCurrencySymbols(): [string, string][] {
  if (currencySymbolCodes) return currencySymbolCodes;
  const owners = new Map<string, Set<string>>();
  const codes =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : [];
  for (const code of codes) {
    let symbol = "";
    try {
      symbol =
        new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: code,
          currencyDisplay: "narrowSymbol",
        })
          .formatToParts(1)
          .find((part) => part.type === "currency")?.value ?? "";
    } catch {
      continue;
    }
    if (!symbol || isLatin1(symbol)) continue;
    if (!owners.has(symbol)) owners.set(symbol, new Set());
    owners.get(symbol)!.add(code);
  }
  currencySymbolCodes = [...owners]
    .filter(([, set]) => set.size === 1)
    .map(([symbol, set]): [string, string] => [symbol, [...set][0]])
    // Longest first, so "GH₵" is replaced whole and never leaves a stray "GH".
    .sort((a, b) => b[0].length - a[0].length);
  return currencySymbolCodes;
}

/** Rewrite one cell for the PDF writer. Latin-1 text is returned unchanged. */
export function pdfSafeText(value: unknown): string {
  const text = value == null ? "" : String(value);
  if (isLatin1(text)) return text;
  let out = text;
  for (const [symbol, code] of unencodableCurrencySymbols()) {
    if (out.includes(symbol)) out = out.split(symbol).join(code + " ");
  }
  // Intl also reaches for thin/narrow no-break spaces as separators in some
  // locales; neither survives WinAnsi either.
  return out.replace(/[\u2009\u202f]/g, " ").trim();
}

export function safeReportSlug(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "report";
}

export function reportFileName(input: {
  slug: string;
  format: ReportFormat;
  propertyName?: string | null;
  dateRange?: ReportDateRange | null;
  generatedAt?: Date;
}): string {
  const parts = [safeReportSlug(input.slug)];
  if (input.propertyName) parts.push(safeReportSlug(input.propertyName));
  if (input.dateRange) {
    parts.push(input.dateRange.from, input.dateRange.to);
  } else {
    parts.push((input.generatedAt ?? new Date()).toISOString().slice(0, 10));
  }
  const extension = input.format === "print" ? "html" : input.format;
  return `${parts.join("_")}.${extension}`;
}

export function reportSubtitle<Row>(definition: ReportDefinition<Row>): string {
  const parts: string[] = [];
  if (definition.propertyName) parts.push(definition.propertyName);
  if (definition.dateRange) {
    parts.push(`${definition.dateRange.from} to ${definition.dateRange.to}`);
  }
  parts.push(`Generated ${(definition.generatedAt ?? new Date()).toLocaleString()}`);
  return parts.join(" · ");
}

function validIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function filterReportRows<Row>(input: {
  rows: readonly Row[];
  search?: string;
  searchValues?: (row: Row) => readonly unknown[];
  dateRange?: ReportDateRange | null;
  dateValue?: (row: Row) => string | null | undefined;
}): Row[] {
  const search = input.search?.trim().toLocaleLowerCase() ?? "";
  if (
    input.dateRange &&
    (!validIsoDate(input.dateRange.from) ||
      !validIsoDate(input.dateRange.to) ||
      input.dateRange.from > input.dateRange.to)
  ) {
    throw new Error("Invalid report date range");
  }

  return input.rows.filter((row) => {
    if (search && input.searchValues) {
      const matches = input.searchValues(row).some((value) =>
        String(value ?? "")
          .toLocaleLowerCase()
          .includes(search),
      );
      if (!matches) return false;
    }
    if (input.dateRange && input.dateValue) {
      const date = input.dateValue(row);
      if (!date || date < input.dateRange.from || date > input.dateRange.to) {
        return false;
      }
    }
    return true;
  });
}
