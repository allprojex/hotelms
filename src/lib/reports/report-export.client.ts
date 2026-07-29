import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";
import { openPrintView, renderTable } from "@/lib/admin/print-html";
import {
  reportFileName,
  reportRows,
  reportSubtitle,
  reportToCsv,
  reportToSheetRows,
  type ReportDefinition,
  type ReportFormat,
} from "@/lib/reports/report-core";

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

export function exportReport<Row>(
  definition: ReportDefinition<Row>,
  format: ReportFormat,
): { filename: string } {
  const filename = reportFileName({
    slug: definition.slug,
    format,
    propertyName: definition.propertyName,
    dateRange: definition.dateRange,
    generatedAt: definition.generatedAt,
  });

  if (format === "csv") {
    downloadBlob(
      new Blob([reportToCsv(definition)], {
        type: "text/csv;charset=utf-8",
      }),
      filename,
    );
    return { filename };
  }

  if (format === "xlsx") {
    const worksheet = XLSX.utils.aoa_to_sheet(reportToSheetRows(definition));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Report");
    XLSX.writeFile(workbook, filename, { compression: true });
    return { filename };
  }

  if (format === "pdf") {
    const document = new jsPDF({ orientation: "landscape", unit: "pt" });
    document.setFontSize(16);
    document.text(definition.title, 40, 40);
    document.setFontSize(9);
    document.text(reportSubtitle(definition), 40, 56);
    autoTable(document, {
      startY: 70,
      head: [definition.columns.map((column) => column.label)],
      body:
        definition.rows.length > 0
          ? reportRows(definition).map((row) => row.map((value) => String(value ?? "")))
          : [["No results", ...definition.columns.slice(1).map(() => "")]],
      styles: { fontSize: 8, cellPadding: 4 },
    });
    document.save(filename);
    return { filename };
  }

  const bodyHtml =
    definition.rows.length > 0
      ? renderTable(
          definition.columns.map((column) => ({
            label: column.label,
            key: column.value,
          })),
          [...definition.rows],
        )
      : '<p class="muted">No results for the selected filters.</p>';
  openPrintView({
    title: definition.title,
    subtitle: reportSubtitle(definition),
    bodyHtml,
    landscape: true,
  });
  return { filename };
}
