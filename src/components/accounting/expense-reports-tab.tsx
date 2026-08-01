/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 6A tables await generated database types. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createClientOnlyFn, useServerFn } from "@tanstack/react-start";
import {
  authorizeExpenseReportAction,
  getExpenseReportData,
} from "@/lib/accounting/expense-reports.functions";
import type { ReportDefinition, ReportFormat } from "@/lib/reports/report-core";
import { formatMoney } from "@/lib/accounting/domain";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Download, Printer } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

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
const GROUP_KEY: Record<string, (row: any) => string> = {
  "by-category": (r) => r.category?.name ?? "Uncategorized",
  "by-vendor": (r) => r.vendor?.name ?? "No vendor",
  "by-cost-centre": (r) => r.cost_centre?.name ?? "No cost centre",
  "by-department": (r) => r.department?.name ?? "No department",
  "by-payment-method": (r) => r.payment_method ?? "Unspecified",
};

const exportExpenseReport = createClientOnlyFn(
  async (definition: ReportDefinition<any>, format: ReportFormat) => {
    const { exportReport } = await import("@/lib/reports/report-export.client");
    return exportReport(definition, format);
  },
);

export function ExpenseReportsTab({
  propertyId,
  from,
  to,
}: {
  propertyId: string;
  from: string;
  to: string;
}) {
  const [reportType, setReportType] = useState<string>("register");
  const authorizeFn = useServerFn(authorizeExpenseReportAction);
  const dataFn = useServerFn(getExpenseReportData);

  const baseType = GROUPED_TYPES.has(reportType) ? "register" : reportType;
  const report = useQuery({
    queryKey: ["expense-report", propertyId, baseType, from, to],
    queryFn: () => dataFn({ data: { propertyId, reportType: baseType, from, to } }),
    enabled: !!propertyId,
  });

  const rows = report.data?.rows ?? [];
  const grouped = GROUPED_TYPES.has(reportType)
    ? Object.values(
        rows.reduce(
          (
            acc: Record<string, { label: string; total: number; currency: string; count: number }>,
            r: any,
          ) => {
            const key = GROUP_KEY[reportType](r);
            const existing = acc[key] ?? { label: key, total: 0, currency: r.currency, count: 0 };
            existing.total += Number(r.total_amount);
            existing.count += 1;
            acc[key] = existing;
            return acc;
          },
          {},
        ),
      )
    : [];

  function buildDefinition(): ReportDefinition<any> {
    const reportLabel =
      EXPENSE_REPORT_TYPES.find((r) => r.value === reportType)?.label ?? reportType;
    if (GROUPED_TYPES.has(reportType)) {
      return {
        title: `Expenses ${reportLabel}`,
        slug: `expenses-${reportType}`,
        dateRange: { from, to },
        columns: [
          { key: "label", label: "Group", value: (r: any) => r.label },
          { key: "count", label: "Count", value: (r: any) => r.count },
          { key: "total", label: "Total", value: (r: any) => formatMoney(r.total, r.currency) },
        ],
        rows: grouped,
      };
    }
    if (reportType === "approval-history") {
      return {
        title: "Expense approval history",
        slug: "expense-approval-history",
        dateRange: { from, to },
        columns: [
          {
            key: "date",
            label: "Date",
            value: (r: any) => format(new Date(r.created_at), "yyyy-MM-dd HH:mm"),
          },
          { key: "expense", label: "Expense", value: (r: any) => r.expense?.expense_number ?? "" },
          { key: "action", label: "Action", value: (r: any) => r.action },
          { key: "actor", label: "Actor", value: (r: any) => r.actor?.full_name ?? "" },
          { key: "reason", label: "Reason", value: (r: any) => r.reason ?? "" },
        ],
        rows,
      };
    }
    if (reportType === "corrections-reversals") {
      return {
        title: "Corrections & reversals register",
        slug: "expense-corrections-reversals",
        dateRange: { from, to },
        columns: [
          { key: "expense", label: "Expense", value: (r: any) => r.expense?.expense_number ?? "" },
          { key: "reason", label: "Reason", value: (r: any) => r.reason },
          { key: "status", label: "Status", value: (r: any) => r.status },
          {
            key: "requester",
            label: "Requested by",
            value: (r: any) => r.requester?.full_name ?? "",
          },
          { key: "reviewer", label: "Reviewed by", value: (r: any) => r.reviewer?.full_name ?? "" },
          {
            key: "reversal",
            label: "Reversal expense",
            value: (r: any) => r.reversal?.expense_number ?? "",
          },
        ],
        rows,
      };
    }
    return {
      title: `Expense ${reportLabel}`,
      slug: `expenses-${reportType}`,
      dateRange: { from, to },
      columns: [
        { key: "number", label: "Number", value: (r: any) => r.expense_number },
        { key: "date", label: "Date", value: (r: any) => r.expense_date },
        { key: "category", label: "Category", value: (r: any) => r.category?.name ?? "" },
        { key: "vendor", label: "Vendor", value: (r: any) => r.vendor?.name ?? "" },
        { key: "costCentre", label: "Cost centre", value: (r: any) => r.cost_centre?.name ?? "" },
        { key: "status", label: "Status", value: (r: any) => r.status },
        {
          key: "paymentReference",
          label: "Payment ref.",
          value: (r: any) => r.payment_reference ?? "",
        },
        {
          key: "total",
          label: "Total",
          value: (r: any) => formatMoney(r.total_amount, r.currency),
        },
      ],
      rows,
    };
  }

  async function handleExport(exportFormat: ReportFormat) {
    try {
      await authorizeFn({
        data: {
          propertyId,
          action: exportFormat === "print" ? "print" : "export",
          format: exportFormat,
          reportType,
        },
      });
      await exportExpenseReport(buildDefinition(), exportFormat);
    } catch (e: any) {
      toast.error(e.message ?? "Export not permitted");
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2 flex-row items-center justify-between space-y-0 flex-wrap gap-2">
        <CardTitle className="text-sm">
          Expense reports · {from} → {to}
        </CardTitle>
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={reportType} onValueChange={setReportType}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPENSE_REPORT_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => handleExport("csv")}>
            <Download className="h-3 w-3 mr-1" /> CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleExport("xlsx")}>
            <Download className="h-3 w-3 mr-1" /> XLSX
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleExport("pdf")}>
            <Download className="h-3 w-3 mr-1" /> PDF
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleExport("print")}>
            <Printer className="h-3 w-3 mr-1" /> Print
          </Button>
        </div>
      </CardHeader>
      <CardContent className="text-sm">
        {report.isLoading && <p className="text-muted-foreground">Loading…</p>}
        {GROUPED_TYPES.has(reportType) ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Group</TableHead>
                <TableHead>Count</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {grouped.map((g: any) => (
                <TableRow key={g.label}>
                  <TableCell>{g.label}</TableCell>
                  <TableCell>{g.count}</TableCell>
                  <TableCell className="text-right font-mono">
                    {formatMoney(g.total, g.currency)}
                  </TableCell>
                </TableRow>
              ))}
              {grouped.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground py-6">
                    No data for this range.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        ) : reportType === "approval-history" ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Expense</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="text-xs">
                    {format(new Date(r.created_at), "MMM d, HH:mm")}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.expense?.expense_number}</TableCell>
                  <TableCell className="text-xs">{r.action}</TableCell>
                  <TableCell className="text-xs">{r.actor?.full_name ?? "—"}</TableCell>
                  <TableCell className="text-xs">{r.reason ?? "—"}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                    No history for this range.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        ) : reportType === "corrections-reversals" ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Expense</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Requester</TableHead>
                <TableHead>Reversal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.expense?.expense_number}</TableCell>
                  <TableCell className="text-xs max-w-xs truncate">{r.reason}</TableCell>
                  <TableCell className="text-xs">{r.status}</TableCell>
                  <TableCell className="text-xs">{r.requester?.full_name ?? "—"}</TableCell>
                  <TableCell className="text-xs">{r.reversal?.expense_number ?? "—"}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                    No corrections for this range.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.expense_number}</TableCell>
                  <TableCell className="text-xs">{r.expense_date}</TableCell>
                  <TableCell className="text-xs">{r.category?.name ?? "—"}</TableCell>
                  <TableCell className="text-xs">{r.status}</TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatMoney(r.total_amount, r.currency)}
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                    No expenses for this range.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
