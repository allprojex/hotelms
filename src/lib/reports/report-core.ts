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
