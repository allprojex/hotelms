import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Reporting Improvements PR1 — P&L/Balance Sheet/Trial Balance migrated onto
// the existing shared report toolkit (report-core.ts / report-export.client.ts),
// plus Expenses report Search and enforcement of the already-declared
// reportsExport/reportsPrint permissions. Structural (source-text) convention,
// matching this repo's established pattern for route/component contract tests.

const root = resolve(__dirname, "..");
function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const reportsPage = read(resolve(root, "src/routes/_authenticated/accounting.reports.tsx"));
const expenseTab = read(resolve(root, "src/components/accounting/expense-reports-tab.tsx"));
const expenseReportsFns = read(resolve(root, "src/lib/accounting/expense-reports.functions.ts"));
const reportAccessServer = read(resolve(root, "src/lib/reports/report-access.server.ts"));
const permissions = read(resolve(root, "src/lib/accounting/permissions.ts"));

describe("Financial Reports (P&L/BS/TB) — migrated onto the shared report toolkit", () => {
  it("removed the old ad-hoc local toCSV/download implementation", () => {
    expect(reportsPage).not.toMatch(/function toCSV/);
    expect(reportsPage).not.toMatch(/function download\(/);
  });

  it("uses the shared report-core/report-export.client toolkit instead of a second export framework", () => {
    expect(reportsPage).toContain('from "@/lib/reports/report-core"');
    expect(reportsPage).toContain('import("@/lib/reports/report-export.client")');
    expect(reportsPage).toContain("createClientOnlyFn(");
  });

  for (const { name, defVar } of [
    { name: "P&L", defVar: "plDefinition" },
    { name: "Balance Sheet", defVar: "bsDefinition" },
    { name: "Trial Balance", defVar: "tbDefinition" },
  ]) {
    it(`${name}: provides CSV, XLSX, PDF, and Print via the shared exportFinancialReport helper`, () => {
      for (const fmt of ["csv", "xlsx", "pdf", "print"]) {
        expect(reportsPage).toContain(`exportFinancialReport(${defVar}, "${fmt}")`);
      }
    });
  }

  it("P&L export dataset is the exact same query-driven array (pl.data) the visible Revenue/Expense sections are derived from — no parallel export-only dataset", () => {
    const plRevIdx = reportsPage.indexOf('const plRev = (pl.data ?? []).filter((r: any) => r.type === "revenue");');
    const plExpIdx = reportsPage.indexOf('const plExp = (pl.data ?? []).filter((r: any) => r.type === "expense");');
    const plDefIdx = reportsPage.indexOf("const plDefinition: ReportDefinition<any> = {");
    const plDefRowsIdx = reportsPage.indexOf("rows: pl.data ?? [],");
    expect(plRevIdx).toBeGreaterThan(-1);
    expect(plExpIdx).toBeGreaterThan(-1);
    expect(plDefIdx).toBeGreaterThan(plExpIdx);
    expect(plDefRowsIdx).toBeGreaterThan(plDefIdx);
  });

  it("Balance Sheet export dataset is the exact same query-driven array (bs.data) the visible Assets/Liabilities/Equity sections are derived from", () => {
    const bsAssetsIdx = reportsPage.indexOf('const bsAssets = (bs.data ?? []).filter((r: any) => r.type === "asset");');
    const bsDefIdx = reportsPage.indexOf("const bsDefinition: ReportDefinition<any> = {");
    const bsDefRowsIdx = reportsPage.indexOf("rows: bs.data ?? [],");
    expect(bsAssetsIdx).toBeGreaterThan(-1);
    expect(bsDefIdx).toBeGreaterThan(bsAssetsIdx);
    expect(bsDefRowsIdx).toBeGreaterThan(bsDefIdx);
  });

  it("Trial Balance export dataset is the exact same query-driven array (tb.data) the visible table rows are mapped from", () => {
    const tbRenderIdx = reportsPage.indexOf("{(tb.data ?? []).map((r: any) => (");
    const tbDefIdx = reportsPage.indexOf("const tbDefinition: ReportDefinition<any> = {");
    const tbDefRowsIdx = reportsPage.indexOf("rows: tb.data ?? [],");
    expect(tbRenderIdx).toBeGreaterThan(-1);
    expect(tbDefIdx).toBeGreaterThan(-1);
    expect(tbDefRowsIdx).toBeGreaterThan(tbDefIdx);
  });

  it("Balance Sheet is a point-in-time report — no misleading one-day dateRange is fabricated for it", () => {
    const bsDefBlock = reportsPage.slice(
      reportsPage.indexOf("const bsDefinition: ReportDefinition<any> = {"),
      reportsPage.indexOf("const tbDefinition: ReportDefinition<any> = {"),
    );
    expect(bsDefBlock).not.toMatch(/dateRange:\s*\{/);
    expect(bsDefBlock).toContain("title: `Balance Sheet · as of ${to}`,");
  });
});

describe("Expenses report — Search", () => {
  it("adds a Search input backed by the shared filterReportRows utility, not a new filtering framework", () => {
    expect(expenseTab).toContain('import { filterReportRows, type ReportDefinition, type ReportFormat } from "@/lib/reports/report-core";');
    expect(expenseTab).toContain('const [search, setSearch] = useState("");');
    expect(expenseTab).toContain("filterReportRows({");
  });

  it("Search combines with the existing report-type filter via per-shape searchValues (group label / approval-history fields / corrections fields / register fields)", () => {
    expect(expenseTab).toContain("function searchValuesFor(row: any): unknown[] {");
    expect(expenseTab).toContain("if (GROUPED_TYPES.has(reportType)) return [row.label];");
    expect(expenseTab).toContain('if (reportType === "approval-history") {');
    expect(expenseTab).toContain('if (reportType === "corrections-reversals") {');
  });

  it("Search combines with the existing date range as AND: the date range narrows the server query (queryKey includes from/to), then search narrows further client-side over that already-scoped result", () => {
    expect(expenseTab).toContain('queryKey: ["expense-report", propertyId, baseType, from, to],');
    const searchIdx = expenseTab.indexOf("const filteredRows = filterReportRows({");
    const queryIdx = expenseTab.indexOf('queryKey: ["expense-report"');
    expect(queryIdx).toBeGreaterThan(-1);
    expect(searchIdx).toBeGreaterThan(queryIdx);
  });

  it("every render branch (grouped / approval-history / corrections-reversals / register) maps over filteredRows, never the unfiltered rows/grouped arrays", () => {
    const renderSection = expenseTab.slice(expenseTab.indexOf("<CardContent"));
    expect(renderSection).not.toMatch(/\{grouped\.map/);
    expect(renderSection.match(/\{filteredRows\.map/g)?.length).toBe(4);
    expect(renderSection).not.toMatch(/\{rows\.map/);
  });

  it("every buildDefinition() branch exports filteredRows, never the unfiltered rows/grouped arrays — exported rows can never drift from what Search shows on screen", () => {
    const defSection = expenseTab.slice(
      expenseTab.indexOf("function buildDefinition()"),
      expenseTab.indexOf("async function handleExport"),
    );
    expect(defSection).not.toMatch(/rows:\s*grouped,/);
    expect(defSection).not.toMatch(/\n\s*rows,\n/);
    expect(defSection.match(/rows:\s*filteredRows,/g)?.length).toBe(4);
  });
});

describe("Expenses report — permission enforcement (reportsExport / reportsPrint)", () => {
  it("EXPENSE_PERMISSIONS.reportsExport/.reportsPrint are the exact module+capability pair the server already asserts on every export/print call", () => {
    expect(permissions).toContain('reportsExport: { module: "expense_reports", capability: "export" },');
    expect(permissions).toContain('reportsPrint: { module: "expense_reports", capability: "print" },');
    expect(reportAccessServer).toContain("module: request.reportKey,");
    expect(reportAccessServer).toContain("capability: request.action,");
    expect(expenseReportsFns).toContain('reportKey: "expense_reports",');
    expect(expenseReportsFns).toContain("action: data.action,");
  });

  it("the client now mirrors that exact module/capability pair via usePermission, gated by the same ACCOUNTING_ADMIN_ROLES default the server uses", () => {
    expect(expenseTab).toContain('import { usePermission } from "@/hooks/use-permission";');
    expect(expenseTab).toContain('import { ACCOUNTING_ADMIN_ROLES } from "@/lib/accounting/permissions";');
    expect(expenseTab).toMatch(
      /const canExport = usePermission\(\{\s*propertyId,\s*module: "expense_reports",\s*capability: "export",\s*defaultRoles: ACCOUNTING_ADMIN_ROLES,\s*\}\);/,
    );
    expect(expenseTab).toMatch(
      /const canPrint = usePermission\(\{\s*propertyId,\s*module: "expense_reports",\s*capability: "print",\s*defaultRoles: ACCOUNTING_ADMIN_ROLES,\s*\}\);/,
    );
  });

  it("CSV/XLSX/PDF buttons are hidden entirely (not merely disabled) unless canExport.allowed — unauthorized users never see an export action", () => {
    expect(expenseTab).toContain("{canExport.allowed && (");
    const gatedBlock = expenseTab.slice(
      expenseTab.indexOf("{canExport.allowed && ("),
      expenseTab.indexOf("{canPrint.allowed && ("),
    );
    expect(gatedBlock).toContain('handleExport("csv")');
    expect(gatedBlock).toContain('handleExport("xlsx")');
    expect(gatedBlock).toContain('handleExport("pdf")');
  });

  it("Print button is hidden entirely unless canPrint.allowed — unauthorized users never see the print action", () => {
    expect(expenseTab).toContain("{canPrint.allowed && (");
    const printBlockIdx = expenseTab.indexOf("{canPrint.allowed && (");
    const printBlock = expenseTab.slice(printBlockIdx, printBlockIdx + 200);
    expect(printBlock).toContain('handleExport("print")');
  });

  it("does not invent a new permission model — no new module/capability constants added beyond the pre-existing EXPENSE_PERMISSIONS.reportsExport/.reportsPrint pair", () => {
    expect(expenseTab).not.toMatch(/module:\s*"(?!expense_reports)/);
  });

  it("the server-side authorization call (authorizeFn) is unchanged — the client-side gate is additive UI polish, not a replacement for the existing server enforcement", () => {
    expect(expenseTab).toContain("await authorizeFn({");
    expect(expenseTab).toContain('action: exportFormat === "print" ? "print" : "export",');
  });
});

describe("Expenses report — no report action mutates data", () => {
  it("getExpenseReportData only ever performs .select() reads against expenses/expense_status_history/expense_corrections — never insert/update/delete", () => {
    const handlerBody = expenseReportsFns.slice(
      expenseReportsFns.indexOf("export const getExpenseReportData"),
    );
    expect(handlerBody).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
  });

  it("authorizeExpenseReportAction only authorizes and (for sensitive actions) writes an audit log entry — it never touches expense/report data tables", () => {
    expect(reportAccessServer).toContain("captureAuditEvent(context, {");
    expect(reportAccessServer).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
  });

  it("exportReport (the shared client-side export pipeline) only ever reads the definition's rows to build a download/print artifact — no Supabase call of any kind", () => {
    const exportClient = read(resolve(root, "src/lib/reports/report-export.client.ts"));
    expect(exportClient).not.toMatch(/supabase|\.rpc\(|\.from\(/);
  });
});

describe("Property isolation is preserved", () => {
  it("propertyId still flows unchanged into the export authorization call, the report data query, and both new permission checks", () => {
    expect(expenseTab).toContain("propertyId,\n    module: \"expense_reports\",\n    capability: \"export\",");
    expect(expenseTab).toContain("propertyId,\n          action: exportFormat === \"print\" ? \"print\" : \"export\",");
    expect(expenseTab).toContain('queryKey: ["expense-report", propertyId, baseType, from, to],');
  });

  it("getExpenseReportData still scopes every query by .eq(\"property_id\", data.propertyId) — unchanged by this PR", () => {
    const matches = expenseReportsFns.match(/\.eq\("property_id", data\.propertyId\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});
