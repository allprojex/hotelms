/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 4B joined rows await generated types. */
import { useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClientOnlyFn, useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  Archive,
  Calculator,
  Download,
  FileWarning,
  Lock,
  Plus,
  Printer,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  DataQueryState,
  ServerPagination,
  SharedListFilters,
} from "@/components/shared/data-query-controls";
import { HrmPageHeader, OptionalSelect, useHrmListState } from "@/components/hrm/shared";
import { useActiveProperty } from "@/hooks/use-active-property";
import { getPayrollBootstrap, listPayrollResource } from "@/lib/hrm/payroll.functions";
import {
  acknowledgePayrollWarning,
  authorizePayrollDraftReport,
  calculateDraftPayrollRun,
  createDraftPayrollRun,
  getDraftPayrollEmployee,
  getDraftPayrollRun,
  getPayrollDraftReportData,
  listDraftPayrollRuns,
  listPayrollManualInputs,
  savePayrollCalculationRule,
  savePayrollManualInput,
  transitionDraftPayrollReview,
} from "@/lib/hrm/payroll-runs.functions";
import type { ReportDefinition, ReportFormat } from "@/lib/reports/report-core";

const exportPayrollDraftReport = createClientOnlyFn(
  async (definition: ReportDefinition<any>, format: ReportFormat) => {
    const { exportReport } = await import("@/lib/reports/report-export.client");
    return exportReport(definition, format);
  },
);

function DraftNotice() {
  return (
    <Alert>
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Draft calculation only</AlertTitle>
      <AlertDescription>
        No payment has been made, no payslip published, no statutory submission filed, and no
        accounting journal posted.
      </AlertDescription>
    </Alert>
  );
}

function money(value: unknown, currency = "GHS") {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(Number(value ?? 0));
}

function statusVariant(status: string) {
  return status === "calculated"
    ? "default"
    : status === "locked_for_review"
      ? "secondary"
      : status === "calculation_failed" || status === "blocked"
        ? "destructive"
        : "outline";
}

export function PayrollRunsPage() {
  const propertyId = useActiveProperty();
  const list = useServerFn(listDraftPayrollRuns);
  const state = useHrmListState();
  const [status, setStatus] = useState("active");
  const query = useQuery({
    queryKey: ["payroll-runs", propertyId, state.page, state.pageSize, state.search, status],
    enabled: !!propertyId,
    queryFn: () =>
      list({
        data: {
          propertyId: propertyId!,
          page: state.page,
          pageSize: state.pageSize,
          search: state.search,
          status,
        },
      }) as Promise<any>,
  });
  return (
    <div className="space-y-4">
      <HrmPageHeader title="Draft Payroll Runs" description="Versioned calculation and review." />
      <DraftNotice />
      <div className="flex justify-end">
        <Button asChild>
          <Link to="/hrm/payroll/runs/new">
            <Plus className="mr-1 h-4 w-4" />
            New draft run
          </Link>
        </Button>
      </div>
      <Card className="space-y-4 p-4">
        <SharedListFilters
          search={state.search}
          from={null}
          to={null}
          onSearchChange={state.setSearch}
          onFromChange={() => undefined}
          onToChange={() => undefined}
          onClear={() => {
            state.setSearch("");
            setStatus("active");
          }}
        >
          <div className="min-w-44 space-y-1">
            <Label>Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  "active",
                  "draft",
                  "calculating",
                  "calculated",
                  "calculation_failed",
                  "locked_for_review",
                  "reopened",
                  "archived",
                ].map((value) => (
                  <SelectItem key={value} value={value}>
                    {value.replaceAll("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SharedListFilters>
        <DataQueryState
          loading={query.isLoading}
          error={query.error}
          empty={!query.data?.rows.length}
          emptyTitle="No draft payroll runs"
        >
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  {[
                    "Run",
                    "Period",
                    "Version",
                    "Status",
                    "Employees",
                    "Gross",
                    "Net",
                    "Findings",
                  ].map((label) => (
                    <th key={label} className="px-3 py-2 font-medium">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {query.data?.rows.map((row: any) => (
                  <tr key={row.id} className="border-t">
                    <td className="px-3 py-3">
                      <Link
                        to="/hrm/payroll/runs/$runId"
                        params={{ runId: row.id }}
                        className="font-medium text-primary hover:underline"
                      >
                        {row.run_code}
                      </Link>
                    </td>
                    <td className="px-3 py-3">{row.period?.period_label}</td>
                    <td className="px-3 py-3">v{row.current_calculation_version}</td>
                    <td className="px-3 py-3">
                      <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
                    </td>
                    <td className="px-3 py-3">{row.employee_count}</td>
                    <td className="px-3 py-3">{money(row.gross_total, row.currency)}</td>
                    <td className="px-3 py-3">{money(row.net_total, row.currency)}</td>
                    <td className="px-3 py-3">
                      {row.warning_count} warnings · {row.error_count} errors
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DataQueryState>
        <ServerPagination
          page={state.page}
          pageSize={state.pageSize}
          totalRows={query.data?.total ?? 0}
          onPageChange={state.setPage}
          onPageSizeChange={state.setPageSize}
        />
      </Card>
    </div>
  );
}

export function NewPayrollRunPage() {
  const propertyId = useActiveProperty();
  const navigate = useNavigate();
  const bootstrapFn = useServerFn(getPayrollBootstrap);
  const list = useServerFn(listPayrollResource);
  const create = useServerFn(createDraftPayrollRun);
  const [periodId, setPeriodId] = useState("");
  const [runType, setRunType] = useState("regular");
  const bootstrap = useQuery({
    queryKey: ["payroll-bootstrap", propertyId],
    enabled: !!propertyId,
    queryFn: () => bootstrapFn({ data: { propertyId: propertyId! } }) as Promise<any>,
  });
  const periods = useQuery({
    queryKey: ["payroll-periods-eligible", propertyId],
    enabled: !!propertyId,
    queryFn: () =>
      list({
        data: { propertyId: propertyId!, resource: "periods", page: 1, pageSize: 100 },
      }) as Promise<any>,
  });
  async function submit() {
    try {
      const result = await create({
        data: {
          propertyId: propertyId!,
          calendarPeriodId: periodId,
          runType,
          idempotencyKey: crypto.randomUUID(),
        },
      });
      toast.success("Draft payroll run created");
      navigate({ to: "/hrm/payroll/runs/$runId", params: { runId: result.id } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to create draft run");
    }
  }
  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="New Draft Payroll Run"
        description="Select an eligible calendar period."
      />
      <DraftNotice />
      <Card className="max-w-2xl space-y-4 p-4">
        <OptionalSelect
          id="run-period"
          label="Payroll calendar period"
          value={periodId}
          onChange={setPeriodId}
          options={(periods.data?.rows ?? [])
            .filter((row: any) => ["planned", "open"].includes(row.status))
            .map((row: any) => ({
              value: row.id,
              label: `${row.period_label} · ${row.start_date} to ${row.end_date}`,
            }))}
        />
        <div className="space-y-1">
          <Label>Run type</Label>
          <Select value={runType} onValueChange={setRunType}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="regular">Regular</SelectItem>
              <SelectItem value="off_cycle">Off-cycle draft</SelectItem>
              <SelectItem value="correction_draft">Correction draft</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="text-sm text-muted-foreground">
          Currency: {bootstrap.data?.property?.base_currency ?? "—"}. Creating this record does not
          calculate, approve, or pay payroll.
        </p>
        <Button disabled={!periodId} onClick={submit}>
          Create draft run
        </Button>
      </Card>
    </div>
  );
}

function SummaryCards({ run }: { run: any }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {[
        ["Employees", run.employee_count],
        ["Gross", money(run.gross_total, run.currency)],
        ["Deductions", money(run.deduction_total, run.currency)],
        ["Net", money(run.net_total, run.currency)],
        ["Employer cost", money(run.employer_cost_total, run.currency)],
      ].map(([label, value]) => (
        <Card key={String(label)} className="p-4">
          <p className="text-xs uppercase text-muted-foreground">{label}</p>
          <p className="mt-1 text-lg font-semibold">{value}</p>
        </Card>
      ))}
    </div>
  );
}

export function PayrollRunDetailPage({ runId }: { runId: string }) {
  const propertyId = useActiveProperty();
  const get = useServerFn(getDraftPayrollRun);
  const calculate = useServerFn(calculateDraftPayrollRun);
  const transition = useServerFn(transitionDraftPayrollReview);
  const acknowledge = useServerFn(acknowledgePayrollWarning);
  const authorizeReport = useServerFn(authorizePayrollDraftReport);
  const getReportData = useServerFn(getPayrollDraftReportData);
  const qc = useQueryClient();
  const state = useHrmListState();
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [reportType, setReportType] = useState("payroll-run-summary");
  const query = useQuery({
    queryKey: [
      "payroll-run",
      propertyId,
      runId,
      selectedVersion,
      state.page,
      state.pageSize,
      state.search,
    ],
    enabled: !!propertyId,
    queryFn: () =>
      get({
        data: {
          propertyId: propertyId!,
          runId,
          version: selectedVersion,
          page: state.page,
          pageSize: state.pageSize,
          search: state.search,
        },
      }) as Promise<any>,
  });
  async function runCalculation(employeeIds: string[] = []) {
    try {
      await calculate({
        data: {
          propertyId: propertyId!,
          runId,
          employeeIds,
          idempotencyKey: crypto.randomUUID(),
        },
      });
      toast.success(
        employeeIds.length ? "Employee recalculated as a new version" : "Draft run calculated",
      );
      setSelectedVersion(null);
      qc.invalidateQueries({ queryKey: ["payroll-run"] });
      qc.invalidateQueries({ queryKey: ["payroll-runs"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Draft calculation failed");
    }
  }
  async function review(action: "lock" | "reopen" | "archive") {
    const reason =
      action === "reopen" ? (prompt("Reason for reopening this review-locked draft:") ?? "") : "";
    if (action === "reopen" && reason.trim().length < 5) return;
    try {
      await transition({ data: { propertyId: propertyId!, runId, action, reason } });
      toast.success(`Draft run ${action === "lock" ? "locked for review" : `${action}d`}`);
      qc.invalidateQueries({ queryKey: ["payroll-run"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Review transition failed");
    }
  }
  async function acknowledgeFinding(findingId: string) {
    const reason = prompt("Reason for acknowledging this warning:") ?? "";
    if (reason.trim().length < 5) return;
    try {
      await acknowledge({ data: { propertyId: propertyId!, findingId, reason } });
      toast.success("Warning acknowledged");
      qc.invalidateQueries({ queryKey: ["payroll-run"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to acknowledge warning");
    }
  }
  async function output(format: ReportFormat) {
    if (!query.data) return;
    try {
      await authorizeReport({
        data: {
          propertyId: propertyId!,
          runId,
          action: format === "print" ? "print" : "export",
          format,
          reportType,
          calculationVersion: query.data.selectedVersion,
        },
      });
      const report = (await getReportData({
        data: {
          propertyId: propertyId!,
          runId,
          reportType,
          calculationVersion: query.data.selectedVersion,
        },
      })) as any;
      const rows = report.rows as any[];
      const value = (row: any, key: string) => {
        const employee = row.employee?.employee ?? row.employee;
        if (key === "employee")
          return employee
            ? `${employee.employee_number ?? ""} · ${employee.first_name ?? ""} ${employee.last_name ?? ""}`
            : "";
        if (key === "attendance") return JSON.stringify(row.attendance_input_summary ?? {});
        if (key === "leave") return JSON.stringify(row.leave_input_summary ?? {});
        if (key === "component")
          return row.component ? `${row.component.code} · ${row.component.name}` : "";
        return row[key] ?? "";
      };
      const keys =
        reportType === "calculation-version-comparison"
          ? [
              "calculation_version",
              "status",
              "completed_at",
              "employee_count",
              "gross_total",
              "deduction_total",
              "net_total",
              "employer_cost_total",
              "warning_count",
              "error_count",
            ]
          : reportType === "manual-input-report"
            ? [
                "employee",
                "component",
                "effective_date",
                "amount",
                "quantity",
                "reason",
                "source_reference",
              ]
            : reportType === "validation-findings"
              ? [
                  "employee",
                  "severity",
                  "finding_code",
                  "message",
                  "source_type",
                  "acknowledged_at",
                ]
              : ["employee", ...Object.keys(rows[0] ?? {}).filter((key) => key !== "employee")];
      await exportPayrollDraftReport(
        {
          title: `DRAFT ${reportType.replaceAll("-", " ")} · ${query.data.run.run_code} · v${query.data.selectedVersion}`,
          slug: `draft-${reportType}-${query.data.run.run_code}-v${query.data.selectedVersion}`,
          propertyName: "ThesKwoff Hotel",
          dateRange: {
            from: query.data.run.period.start_date,
            to: query.data.run.period.end_date,
          },
          generatedAt: new Date(
            query.data.versions.find(
              (version: any) => version.calculation_version === query.data.selectedVersion,
            )?.completed_at ?? Date.now(),
          ),
          columns: [
            ...keys.map((key) => ({
              key,
              label: key.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
              value: (row: any) => value(row, key),
            })),
            { key: "draft", label: "Output Status", value: () => "DRAFT · NOT PAID" },
          ],
          rows,
        },
        format,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Draft report unavailable");
    }
  }
  return (
    <div className="space-y-4">
      <DataQueryState loading={query.isLoading} error={query.error} empty={!query.data}>
        {query.data && (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <HrmPageHeader
                title={query.data.run.run_code}
                description={`${query.data.run.period.period_label} · calculation v${query.data.selectedVersion}`}
              />
              <Badge variant={statusVariant(query.data.run.status)}>{query.data.run.status}</Badge>
            </div>
            <DraftNotice />
            <SummaryCards run={query.data.run} />
            <Card className="flex flex-wrap gap-2 p-4">
              <Button
                onClick={() => runCalculation()}
                disabled={["calculating", "locked_for_review", "archived"].includes(
                  query.data.run.status,
                )}
              >
                <Calculator className="mr-1 h-4 w-4" />
                {query.data.run.current_calculation_version
                  ? "Recalculate as new version"
                  : "Calculate run"}
              </Button>
              {query.data.run.status === "calculated" && (
                <Button variant="outline" onClick={() => review("lock")}>
                  <Lock className="mr-1 h-4 w-4" />
                  Lock for review
                </Button>
              )}
              {query.data.run.status === "locked_for_review" && (
                <Button variant="outline" onClick={() => review("reopen")}>
                  <RotateCcw className="mr-1 h-4 w-4" />
                  Reopen draft
                </Button>
              )}
              {["draft", "calculation_failed", "reopened"].includes(query.data.run.status) && (
                <Button variant="destructive" onClick={() => review("archive")}>
                  <Archive className="mr-1 h-4 w-4" />
                  Archive draft
                </Button>
              )}
              {(["csv", "xlsx", "pdf", "print"] as ReportFormat[]).map((format) => (
                <Button key={format} variant="outline" onClick={() => output(format)}>
                  {format === "print" ? (
                    <Printer className="mr-1 h-4 w-4" />
                  ) : (
                    <Download className="mr-1 h-4 w-4" />
                  )}
                  {format.toUpperCase()}
                </Button>
              ))}
              <div className="min-w-56">
                <Select value={reportType} onValueChange={setReportType}>
                  <SelectTrigger aria-label="Draft report type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[
                      "payroll-run-summary",
                      "employee-payroll-detail",
                      "earning-breakdown",
                      "deduction-breakdown",
                      "employer-contribution-breakdown",
                      "validation-findings",
                      "attendance-leave-summary",
                      "manual-input-report",
                      "calculation-version-comparison",
                    ].map((value) => (
                      <SelectItem key={value} value={value}>
                        {value.replaceAll("-", " ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-36">
                <Select
                  value={String(query.data.selectedVersion)}
                  onValueChange={(value) => setSelectedVersion(Number(value))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {query.data.versions.map((version: any) => (
                      <SelectItem key={version.id} value={String(version.calculation_version)}>
                        Version {version.calculation_version} · {version.status}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </Card>
            {!!query.data.findings.length && (
              <Card className="space-y-2 p-4">
                <h2 className="flex items-center gap-2 font-semibold">
                  <FileWarning className="h-4 w-4" />
                  Validation findings
                </h2>
                {query.data.findings.map((finding: any) => (
                  <div
                    key={finding.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
                  >
                    <div>
                      <Badge variant={finding.severity === "blocking" ? "destructive" : "outline"}>
                        {finding.severity}
                      </Badge>{" "}
                      <span className="font-medium">{finding.finding_code}</span> ·{" "}
                      {finding.message}
                    </div>
                    {finding.severity === "warning" && !finding.acknowledged_at && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => acknowledgeFinding(finding.id)}
                      >
                        Acknowledge
                      </Button>
                    )}
                  </div>
                ))}
              </Card>
            )}
            <Card className="space-y-4 p-4">
              <Input
                type="search"
                placeholder="Search employee results"
                value={state.search}
                onChange={(event) => state.setSearch(event.target.value)}
              />
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full min-w-[950px] text-sm">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      {[
                        "Employee",
                        "Status",
                        "Base",
                        "Gross",
                        "Deductions",
                        "Net",
                        "Employer cost",
                        "Actions",
                      ].map((label) => (
                        <th key={label} className="px-3 py-2 font-medium">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.employees.map((row: any) => (
                      <tr key={row.id} className="border-t">
                        <td className="px-3 py-3">
                          <Link
                            to="/hrm/payroll/runs/$runId/employees/$employeeId"
                            params={{ runId, employeeId: row.employee_id }}
                            className="font-medium text-primary hover:underline"
                          >
                            {row.employee?.employee_number} · {row.employee?.first_name}{" "}
                            {row.employee?.last_name}
                          </Link>
                        </td>
                        <td className="px-3 py-3">
                          <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
                        </td>
                        <td className="px-3 py-3">
                          {money(row.prorated_base_salary, row.currency)}
                        </td>
                        <td className="px-3 py-3">{money(row.gross_pay, row.currency)}</td>
                        <td className="px-3 py-3">
                          {money(row.employee_deductions, row.currency)}
                        </td>
                        <td className="px-3 py-3">{money(row.net_pay, row.currency)}</td>
                        <td className="px-3 py-3">{money(row.employer_cost, row.currency)}</td>
                        <td className="px-3 py-3">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => runCalculation([row.employee_id])}
                          >
                            <RefreshCw className="mr-1 h-3 w-3" />
                            Retry
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ServerPagination
                page={state.page}
                pageSize={state.pageSize}
                totalRows={query.data.employeeTotal}
                onPageChange={state.setPage}
                onPageSizeChange={state.setPageSize}
              />
            </Card>
          </>
        )}
      </DataQueryState>
    </div>
  );
}

export function PayrollEmployeeDetailPage({
  runId,
  employeeId,
}: {
  runId: string;
  employeeId: string;
}) {
  const propertyId = useActiveProperty();
  const getRun = useServerFn(getDraftPayrollRun);
  const getEmployee = useServerFn(getDraftPayrollEmployee);
  const run = useQuery({
    queryKey: ["payroll-run-version-context", propertyId, runId],
    enabled: !!propertyId,
    queryFn: () =>
      getRun({
        data: { propertyId: propertyId!, runId, page: 1, pageSize: 10 },
      }) as Promise<any>,
  });
  const query = useQuery({
    queryKey: ["payroll-employee-detail", propertyId, runId, employeeId, run.data?.selectedVersion],
    enabled: !!propertyId && !!run.data?.selectedVersion,
    queryFn: () =>
      getEmployee({
        data: {
          propertyId: propertyId!,
          runId,
          employeeId,
          version: run.data.selectedVersion,
        },
      }) as Promise<any>,
  });
  return (
    <div className="space-y-4">
      <DataQueryState loading={query.isLoading} error={query.error} empty={!query.data}>
        {query.data && (
          <>
            <HrmPageHeader
              title={`${query.data.employee.employee?.first_name} ${query.data.employee.employee?.last_name}`}
              description={`Draft employee calculation · version ${query.data.employee.calculation_version}`}
            />
            <DraftNotice />
            <SummaryCards
              run={{
                employee_count: 1,
                gross_total: query.data.employee.gross_pay,
                deduction_total: query.data.employee.employee_deductions,
                net_total: query.data.employee.net_pay,
                employer_cost_total: query.data.employee.employer_cost,
                currency: query.data.employee.currency,
              }}
            />
            <Card className="space-y-3 p-4">
              <h2 className="font-semibold">Traceable line items</h2>
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full min-w-[1000px] text-sm">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      {[
                        "Code",
                        "Name",
                        "Type",
                        "Quantity",
                        "Rate",
                        "Unrounded",
                        "Rounded",
                        "Source",
                        "Explanation",
                      ].map((label) => (
                        <th key={label} className="px-3 py-2 font-medium">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.lines.map((line: any) => (
                      <tr key={line.id} className="border-t align-top">
                        <td className="px-3 py-3 font-mono">{line.line_code}</td>
                        <td className="px-3 py-3">{line.line_name}</td>
                        <td className="px-3 py-3">{line.line_type}</td>
                        <td className="px-3 py-3">{line.quantity}</td>
                        <td className="px-3 py-3">{line.rate}</td>
                        <td className="px-3 py-3">{line.unrounded_amount}</td>
                        <td className="px-3 py-3">
                          {money(line.rounded_amount, query.data.employee.currency)}
                        </td>
                        <td className="px-3 py-3">{line.source_type}</td>
                        <td className="max-w-xs px-3 py-3 text-xs">
                          {JSON.stringify(line.calculation_explanation)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </DataQueryState>
    </div>
  );
}

export function PayrollManualInputsPage() {
  const propertyId = useActiveProperty();
  const bootstrapFn = useServerFn(getPayrollBootstrap);
  const listResource = useServerFn(listPayrollResource);
  const list = useServerFn(listPayrollManualInputs);
  const save = useServerFn(savePayrollManualInput);
  const saveRule = useServerFn(savePayrollCalculationRule);
  const qc = useQueryClient();
  const state = useHrmListState();
  const [form, setForm] = useState({
    calendarPeriodId: "",
    employeeId: "",
    componentId: "",
    amount: "",
    quantity: "",
    reason: "",
    sourceReference: "",
    effectiveDate: new Date().toISOString().slice(0, 10),
  });
  const [rule, setRule] = useState({
    componentId: "",
    method: "fixed_amount",
    amount: "",
    percentage: "",
    basisComponentId: "",
    minimum: "",
    maximum: "",
    effectiveFrom: new Date().toISOString().slice(0, 10),
  });
  const bootstrap = useQuery({
    queryKey: ["payroll-bootstrap", propertyId],
    enabled: !!propertyId,
    queryFn: () => bootstrapFn({ data: { propertyId: propertyId! } }) as Promise<any>,
  });
  const periods = useQuery({
    queryKey: ["payroll-manual-periods", propertyId],
    enabled: !!propertyId,
    queryFn: () =>
      listResource({
        data: { propertyId: propertyId!, resource: "periods", page: 1, pageSize: 100 },
      }) as Promise<any>,
  });
  const query = useQuery({
    queryKey: [
      "payroll-manual-inputs",
      propertyId,
      form.calendarPeriodId,
      state.page,
      state.pageSize,
    ],
    enabled: !!propertyId,
    queryFn: () =>
      list({
        data: {
          propertyId: propertyId!,
          calendarPeriodId: form.calendarPeriodId || null,
          page: state.page,
          pageSize: state.pageSize,
        },
      }) as Promise<any>,
  });
  const periodOptions = useMemo(
    () =>
      (periods.data?.rows ?? []).map((row: any) => ({
        value: row.id,
        label: row.period_label,
      })),
    [periods.data],
  );
  async function submit() {
    try {
      await save({ data: { propertyId: propertyId!, ...form } });
      toast.success("Manual draft input saved; recalculate the affected run");
      qc.invalidateQueries({ queryKey: ["payroll-manual-inputs"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save manual input");
    }
  }
  async function submitRule() {
    try {
      await saveRule({ data: { propertyId: propertyId!, ...rule } });
      toast.success("Effective-dated calculation rule saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save calculation rule");
    }
  }
  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Manual Payroll Inputs"
        description="Controlled source-backed inputs and allow-listed component methods."
      />
      <DraftNotice />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="space-y-3 p-4">
          <h2 className="font-semibold">New manual input</h2>
          <OptionalSelect
            id="manual-period"
            label="Period"
            value={form.calendarPeriodId}
            onChange={(value) => setForm({ ...form, calendarPeriodId: value })}
            options={periodOptions}
          />
          <OptionalSelect
            id="manual-employee"
            label="Employee"
            value={form.employeeId}
            onChange={(value) => setForm({ ...form, employeeId: value })}
            options={(bootstrap.data?.employees ?? []).map((row: any) => ({
              value: row.id,
              label: `${row.employee_number} · ${row.first_name} ${row.last_name}`,
            }))}
          />
          <OptionalSelect
            id="manual-component"
            label="Pay component"
            value={form.componentId}
            onChange={(value) => setForm({ ...form, componentId: value })}
            options={(bootstrap.data?.components ?? []).map((row: any) => ({
              value: row.id,
              label: `${row.code} · ${row.name}`,
            }))}
          />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="manual-amount">Amount</Label>
              <Input
                id="manual-amount"
                inputMode="decimal"
                value={form.amount}
                onChange={(event) => setForm({ ...form, amount: event.target.value, quantity: "" })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="manual-quantity">Or quantity</Label>
              <Input
                id="manual-quantity"
                inputMode="decimal"
                value={form.quantity}
                onChange={(event) => setForm({ ...form, quantity: event.target.value, amount: "" })}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="manual-reason">Reason</Label>
            <Textarea
              id="manual-reason"
              value={form.reason}
              onChange={(event) => setForm({ ...form, reason: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="manual-source">Source reference</Label>
            <Input
              id="manual-source"
              value={form.sourceReference}
              onChange={(event) => setForm({ ...form, sourceReference: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="manual-date">Effective date</Label>
            <Input
              id="manual-date"
              type="date"
              value={form.effectiveDate}
              onChange={(event) => setForm({ ...form, effectiveDate: event.target.value })}
            />
          </div>
          <Button onClick={submit}>Save input</Button>
        </Card>
        <Card className="space-y-3 p-4">
          <h2 className="font-semibold">Component calculation rule</h2>
          <p className="text-sm text-muted-foreground">
            Allow-listed methods only. No formula or executable expression is accepted.
          </p>
          <OptionalSelect
            id="rule-component"
            label="Pay component"
            value={rule.componentId}
            onChange={(value) => setRule({ ...rule, componentId: value })}
            options={(bootstrap.data?.components ?? []).map((row: any) => ({
              value: row.id,
              label: `${row.code} · ${row.name}`,
            }))}
          />
          <div className="space-y-1">
            <Label>Calculation method</Label>
            <Select
              value={rule.method}
              onValueChange={(value) => setRule({ ...rule, method: value })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  "fixed_amount",
                  "percentage_base",
                  "percentage_gross",
                  "percentage_component",
                  "attendance_day",
                  "worked_hour",
                  "unpaid_day_deduction",
                  "fixed_one_time",
                  "manual_amount",
                  "informational_overtime",
                ].map((value) => (
                  <SelectItem key={value} value={value}>
                    {value.replaceAll("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="rule-amount">Amount/rate</Label>
              <Input
                id="rule-amount"
                inputMode="decimal"
                value={rule.amount}
                onChange={(event) => setRule({ ...rule, amount: event.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rule-percentage">Percentage</Label>
              <Input
                id="rule-percentage"
                inputMode="decimal"
                value={rule.percentage}
                onChange={(event) => setRule({ ...rule, percentage: event.target.value })}
              />
            </div>
          </div>
          {rule.method === "percentage_component" && (
            <OptionalSelect
              id="rule-basis"
              label="Basis component"
              value={rule.basisComponentId}
              onChange={(value) => setRule({ ...rule, basisComponentId: value })}
              options={(bootstrap.data?.components ?? []).map((row: any) => ({
                value: row.id,
                label: `${row.code} · ${row.name}`,
              }))}
            />
          )}
          <div className="space-y-1">
            <Label htmlFor="rule-effective">Effective from</Label>
            <Input
              id="rule-effective"
              type="date"
              value={rule.effectiveFrom}
              onChange={(event) => setRule({ ...rule, effectiveFrom: event.target.value })}
            />
          </div>
          <Button onClick={submitRule}>Save calculation rule</Button>
        </Card>
      </div>
      <Card className="space-y-3 p-4">
        <h2 className="font-semibold">Active manual inputs</h2>
        <DataQueryState
          loading={query.isLoading}
          error={query.error}
          empty={!query.data?.rows.length}
        >
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[800px] text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  {["Period", "Employee", "Component", "Amount/quantity", "Reason", "Source"].map(
                    (label) => (
                      <th key={label} className="px-3 py-2">
                        {label}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {query.data?.rows.map((row: any) => (
                  <tr key={row.id} className="border-t">
                    <td className="px-3 py-3">{row.period?.period_label}</td>
                    <td className="px-3 py-3">
                      {row.employee?.employee_number} · {row.employee?.first_name}{" "}
                      {row.employee?.last_name}
                    </td>
                    <td className="px-3 py-3">{row.component?.code}</td>
                    <td className="px-3 py-3">{row.amount ?? row.quantity}</td>
                    <td className="px-3 py-3">{row.reason}</td>
                    <td className="px-3 py-3">{row.source_reference}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DataQueryState>
        <ServerPagination
          page={state.page}
          pageSize={state.pageSize}
          totalRows={query.data?.total ?? 0}
          onPageChange={state.setPage}
          onPageSizeChange={state.setPageSize}
        />
      </Card>
    </div>
  );
}
