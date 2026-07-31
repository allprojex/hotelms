/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 4C joined rows await generated types. */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClientOnlyFn, useServerFn } from "@tanstack/react-start";
import {
  CheckCircle2,
  Download,
  FileText,
  LockKeyhole,
  RotateCcw,
  Send,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DataQueryState,
  ServerPagination,
  SharedListFilters,
} from "@/components/shared/data-query-controls";
import { HrmPageHeader, useHrmListState } from "@/components/hrm/shared";
import { useActiveProperty } from "@/hooks/use-active-property";
import { useCurrentUserId } from "@/hooks/use-user-roles";
import { usePermission } from "@/hooks/use-permission";
import { PAYROLL_SENSITIVE_ROLES } from "@/lib/hrm/permissions";
import {
  authorizeFinalizedPayrollReport,
  closePayrollPeriod,
  createPayrollCorrection,
  executeReversalFoundation,
  exportPaymentBatch,
  finalizePayrollRun,
  generatePayslips,
  getFinalizedPayroll,
  getPayrollApproval,
  listFinalizedPayrolls,
  listJournalDrafts,
  listPaymentBatches,
  listPaymentTemplates,
  listPayrollApprovals,
  listPayrollCorrections,
  listPayslips,
  listStatutoryLiabilities,
  prepareJournalDraft,
  preparePaymentBatch,
  publishPayslips,
  reviewPayrollCorrection,
  savePaymentTemplate,
  transitionPayrollApproval,
  validatePaymentBatch,
} from "@/lib/hrm/payroll-finalization.functions";
import type { ReportDefinition, ReportFormat } from "@/lib/reports/report-core";

const exportFinalizedPayrollReport = createClientOnlyFn(
  async (definition: ReportDefinition<any>, format: ReportFormat) => {
    const { exportReport } = await import("@/lib/reports/report-export.client");
    return exportReport(definition, format);
  },
);

function money(value: unknown, currency = "GHS") {
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(Number(value ?? 0));
}

function SafetyNotice() {
  return (
    <Alert>
      <ShieldCheck className="h-4 w-4" />
      <AlertTitle>Finalization foundation</AlertTitle>
      <AlertDescription>
        This area prepares approved payroll, payslips, payment files, liability summaries and
        journal drafts. It does not transmit payments, submit returns or post journals.
      </AlertDescription>
    </Alert>
  );
}

function RowActions({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>;
}

function useListQuery(key: string, fn: any) {
  const propertyId = useActiveProperty();
  const state = useHrmListState();
  const call = useServerFn(fn);
  const query = useQuery({
    queryKey: [key, propertyId, state.page, state.pageSize, state.search],
    enabled: !!propertyId,
    queryFn: () =>
      call({
        data: {
          propertyId: propertyId!,
          page: state.page,
          pageSize: state.pageSize,
          search: state.search,
        },
      }) as Promise<any>,
  });
  return { propertyId, state, query };
}

function ListShell({
  title,
  description,
  queryKey,
  serverFn,
  headers,
  renderRow,
  children,
}: {
  title: string;
  description: string;
  queryKey: string;
  serverFn: any;
  headers: string[];
  renderRow: (row: any) => React.ReactNode;
  children?: React.ReactNode;
}) {
  const { state, query } = useListQuery(queryKey, serverFn);
  return (
    <div className="space-y-4">
      <HrmPageHeader title={title} description={description} />
      <SafetyNotice />
      {children}
      <Card className="space-y-4 p-4">
        <SharedListFilters
          search={state.search}
          from={null}
          to={null}
          onSearchChange={state.setSearch}
          onFromChange={() => undefined}
          onToChange={() => undefined}
          onClear={() => state.setSearch("")}
        />
        <DataQueryState
          loading={query.isLoading}
          error={query.error}
          empty={!query.data?.rows.length}
          emptyTitle={`No ${title.toLowerCase()}`}
        >
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  {headers.map((header) => (
                    <th key={header} className="px-3 py-2 font-medium">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>{query.data?.rows.map((row: any) => renderRow(row))}</tbody>
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

export function PayrollApprovalsPage() {
  const propertyId = useActiveProperty();
  const submit = useServerFn(transitionPayrollApproval);
  const client = useQueryClient();
  async function act(row: any, action: string) {
    const reason = ["reject", "return"].includes(action) ? window.prompt("Reason required") : "";
    if (["reject", "return"].includes(action) && !reason) return;
    await submit({
      data: {
        propertyId,
        runId: row.id,
        action,
        calculationVersion: row.current_calculation_version,
        reason,
      },
    });
    toast.success("Payroll approval updated");
    await client.invalidateQueries({ queryKey: ["payroll-approvals"] });
  }
  return (
    <ListShell
      title="Payroll Approvals"
      description="Submit, approve, reject and return version-locked payroll runs."
      queryKey="payroll-approvals"
      serverFn={listPayrollApprovals}
      headers={["Run", "Period", "Version", "Status", "Totals", "Actions"]}
      renderRow={(row) => (
        <tr key={row.id} className="border-t">
          <td className="px-3 py-3">
            <Link
              to="/hrm/payroll/runs/$runId/approval"
              params={{ runId: row.id }}
              className="font-medium text-primary hover:underline"
            >
              {row.run_code}
            </Link>
          </td>
          <td className="px-3 py-3">{row.period?.period_label}</td>
          <td className="px-3 py-3">v{row.current_calculation_version}</td>
          <td className="px-3 py-3">
            <Badge variant="secondary">{row.status}</Badge>
          </td>
          <td className="px-3 py-3">{money(row.net_total, row.currency)}</td>
          <td className="px-3 py-3">
            <RowActions>
              <Button size="sm" variant="outline" onClick={() => act(row, "submit")}>
                <Send className="mr-1 h-4 w-4" />
                Submit
              </Button>
              <Button size="sm" variant="outline" onClick={() => act(row, "approve")}>
                <CheckCircle2 className="mr-1 h-4 w-4" />
                Approve
              </Button>
              <Button size="sm" variant="outline" onClick={() => act(row, "return")}>
                Return
              </Button>
              <Button size="sm" variant="destructive" onClick={() => act(row, "reject")}>
                Reject
              </Button>
            </RowActions>
          </td>
        </tr>
      )}
    />
  );
}

export function PayrollRunApprovalPage({ runId }: { runId: string }) {
  const propertyId = useActiveProperty();
  const get = useServerFn(getPayrollApproval);
  const finalize = useServerFn(finalizePayrollRun);
  const query = useQuery({
    queryKey: ["payroll-approval", propertyId, runId],
    enabled: !!propertyId,
    queryFn: () => get({ data: { propertyId, runId } }) as Promise<any>,
  });
  async function doFinalize() {
    if (
      !window.confirm(
        "Finalize this approved payroll? This creates immutable snapshots and cannot be normally edited.",
      )
    )
      return;
    const result = (await finalize({
      data: { propertyId, runId, calculationVersion: query.data.run.current_calculation_version },
    })) as any;
    toast.success("Payroll finalized");
    window.location.href = `/hrm/payroll/finalized/${result.finalizedPayrollId}`;
  }
  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Payroll Approval Detail"
        description="Approval evidence and controlled finalization."
      />
      <SafetyNotice />
      <DataQueryState
        loading={query.isLoading}
        error={query.error}
        empty={!query.data?.run}
        emptyTitle="Approval record not found"
      >
        <Card className="space-y-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-lg font-semibold">{query.data?.run.run_code}</div>
              <div className="text-sm text-muted-foreground">
                Version {query.data?.run.current_calculation_version} -{" "}
                {money(query.data?.run.net_total, query.data?.run.currency)}
              </div>
            </div>
            <Button onClick={doFinalize}>
              <LockKeyhole className="mr-1 h-4 w-4" />
              Finalize approved payroll
            </Button>
          </div>
          <div className="rounded-md border">
            {query.data?.history.map((row: any) => (
              <div key={row.id} className="border-t p-3 first:border-t-0">
                <Badge>{row.action}</Badge> {row.prior_status} to {row.new_status}
                <div className="text-sm text-muted-foreground">
                  {row.reason || "No reason recorded"} - {new Date(row.action_at).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </DataQueryState>
    </div>
  );
}

export function FinalizedPayrollsPage() {
  return (
    <ListShell
      title="Finalized Payroll"
      description="Immutable finalized payroll snapshots."
      queryKey="finalized-payrolls"
      serverFn={listFinalizedPayrolls}
      headers={["Payroll", "Period", "Status", "Employees", "Gross", "Net"]}
      renderRow={(row) => (
        <tr key={row.id} className="border-t">
          <td className="px-3 py-3">
            <Link
              to="/hrm/payroll/finalized/$payrollId"
              params={{ payrollId: row.id }}
              className="font-medium text-primary hover:underline"
            >
              {row.final_payroll_code}
            </Link>
          </td>
          <td className="px-3 py-3">{row.period?.period_label}</td>
          <td className="px-3 py-3">
            <Badge>{row.status}</Badge>
          </td>
          <td className="px-3 py-3">{row.employee_count}</td>
          <td className="px-3 py-3">{money(row.gross_total, row.currency)}</td>
          <td className="px-3 py-3">{money(row.net_total, row.currency)}</td>
        </tr>
      )}
    />
  );
}

export function FinalizedPayrollDetailPage({ payrollId }: { payrollId: string }) {
  const propertyId = useActiveProperty();
  const get = useServerFn(getFinalizedPayroll);
  const slips = useServerFn(generatePayslips);
  const publish = useServerFn(publishPayslips);
  const payBatch = useServerFn(preparePaymentBatch);
  const journal = useServerFn(prepareJournalDraft);
  const close = useServerFn(closePayrollPeriod);
  const reverse = useServerFn(executeReversalFoundation);
  const reportAuth = useServerFn(authorizeFinalizedPayrollReport);
  const query = useQuery({
    queryKey: ["finalized-payroll", propertyId, payrollId],
    enabled: !!propertyId,
    queryFn: () => get({ data: { propertyId, payrollId } }) as Promise<any>,
  });
  async function report() {
    await reportAuth({
      data: { propertyId, reportType: "finalized-payroll-summary", action: "export" },
    });
    await exportFinalizedPayrollReport(
      {
        title: "Finalized payroll summary",
        columns: [],
        rows: [query.data?.payroll],
        generatedAt: new Date().toISOString(),
      } as any,
      "csv",
    );
  }
  async function run(label: string, fn: () => Promise<unknown>) {
    if (!window.confirm(label)) return;
    await fn();
    toast.success(label);
  }
  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Finalized Payroll Detail"
        description="Payslip, payment, journal, close and correction controls."
      />
      <SafetyNotice />
      <DataQueryState
        loading={query.isLoading}
        error={query.error}
        empty={!query.data?.payroll}
        emptyTitle="Finalized payroll not found"
      >
        <Card className="space-y-4 p-4">
          <div className="flex flex-wrap justify-between gap-3">
            <div>
              <div className="text-lg font-semibold">{query.data?.payroll.final_payroll_code}</div>
              <div className="text-sm text-muted-foreground">
                Finalized {query.data?.payroll.finalized_at}
              </div>
            </div>
            <RowActions>
              <Button
                size="sm"
                onClick={() =>
                  run("Generate draft payslips", () => slips({ data: { propertyId, payrollId } }))
                }
              >
                Generate payslips
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  run("Publish eligible payslips", () =>
                    publish({ data: { propertyId, payrollId, publish: true } }),
                  )
                }
              >
                Publish payslips
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  run("Prepare payment batch", () =>
                    payBatch({ data: { propertyId, payrollId, paymentMethod: "bank_transfer" } }),
                  )
                }
              >
                Prepare payment
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  run("Prepare journal draft", () => journal({ data: { propertyId, payrollId } }))
                }
              >
                Prepare journal
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  run("Close payroll period", () =>
                    close({
                      data: {
                        propertyId,
                        calendarPeriodId: query.data.payroll.calendar_period_id,
                        close: true,
                        reason: "Payroll finalized and reviewed",
                      },
                    }),
                  )
                }
              >
                Close period
              </Button>
              <Button size="sm" variant="outline" onClick={report}>
                <Download className="mr-1 h-4 w-4" />
                Export summary
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() =>
                  run("Create blocked reversal foundation", () =>
                    reverse({
                      data: {
                        propertyId,
                        payrollId,
                        reason: "Operational reversal review requested",
                      },
                    }),
                  )
                }
              >
                <RotateCcw className="mr-1 h-4 w-4" />
                Reversal foundation
              </Button>
            </RowActions>
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            {["gross_total", "deduction_total", "net_total", "employer_cost_total"].map((key) => (
              <Card key={key} className="p-3">
                <div className="text-xs uppercase text-muted-foreground">
                  {key.replaceAll("_", " ")}
                </div>
                <div className="font-semibold">
                  {money(query.data?.payroll[key], query.data?.payroll.currency)}
                </div>
              </Card>
            ))}
          </div>
        </Card>
      </DataQueryState>
    </div>
  );
}

export function PayslipsPage() {
  return (
    <ListShell
      title="Payslips"
      description="Secure generated payslip versions and publication status."
      queryKey="payslips"
      serverFn={listPayslips}
      headers={["Employee", "Payroll", "Version", "Status", "Generated"]}
      renderRow={(row) => (
        <tr key={row.id} className="border-t">
          <td className="px-3 py-3">
            {row.employee?.employee_number} {row.employee?.first_name} {row.employee?.last_name}
          </td>
          <td className="px-3 py-3">{row.payroll?.final_payroll_code}</td>
          <td className="px-3 py-3">v{row.document_version}</td>
          <td className="px-3 py-3">
            <Badge>{row.status}</Badge>
          </td>
          <td className="px-3 py-3">{new Date(row.generated_at).toLocaleString()}</td>
        </tr>
      )}
    />
  );
}

export function PaymentBatchesPage() {
  const propertyId = useActiveProperty();
  const validate = useServerFn(validatePaymentBatch);
  const exportBatch = useServerFn(exportPaymentBatch);
  return (
    <ListShell
      title="Payment Preparation"
      description="Prepared and exported payment files only; no payment execution."
      queryKey="payment-batches"
      serverFn={listPaymentBatches}
      headers={["Batch", "Payroll", "Method", "Status", "Employees", "Total", "Actions"]}
      renderRow={(row) => (
        <tr key={row.id} className="border-t">
          <td className="px-3 py-3">{row.batch_code}</td>
          <td className="px-3 py-3">{row.payroll?.final_payroll_code}</td>
          <td className="px-3 py-3">{row.payment_method}</td>
          <td className="px-3 py-3">
            <Badge>{row.status}</Badge>
          </td>
          <td className="px-3 py-3">{row.employee_count}</td>
          <td className="px-3 py-3">{money(row.total_amount, row.currency)}</td>
          <td className="px-3 py-3">
            <RowActions>
              <Button
                size="sm"
                variant="outline"
                onClick={() => validate({ data: { propertyId, batchId: row.id } })}
              >
                Validate
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const templateId = window.prompt("Template ID");
                  if (templateId)
                    exportBatch({ data: { propertyId, batchId: row.id, templateId } });
                }}
              >
                Export file
              </Button>
            </RowActions>
          </td>
        </tr>
      )}
    />
  );
}

export function PaymentTemplatesPage() {
  const propertyId = useActiveProperty();
  const save = useServerFn(savePaymentTemplate);
  const client = useQueryClient();
  async function createTemplate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await save({
      data: {
        propertyId,
        name: form.get("name"),
        format: form.get("format"),
        template: {
          fields: [
            { name: "employee", source: "employee_number" },
            { name: "amount", source: "net_pay" },
          ],
        },
      },
    });
    toast.success("Template created");
    await client.invalidateQueries({ queryKey: ["payment-templates"] });
  }
  return (
    <ListShell
      title="Payment Export Templates"
      description="Allow-listed CSV, XLSX and fixed-width preparation templates."
      queryKey="payment-templates"
      serverFn={listPaymentTemplates}
      headers={["Name", "Format", "Version", "Active"]}
      renderRow={(row) => (
        <tr key={row.id} className="border-t">
          <td className="px-3 py-3">{row.name}</td>
          <td className="px-3 py-3">{row.format}</td>
          <td className="px-3 py-3">v{row.version}</td>
          <td className="px-3 py-3">{String(row.active)}</td>
        </tr>
      )}
    >
      <Card className="p-4">
        <form className="grid gap-3 md:grid-cols-3" onSubmit={createTemplate}>
          <div>
            <Label>Name</Label>
            <Input name="name" required />
          </div>
          <div>
            <Label>Format</Label>
            <Input name="format" defaultValue="csv" />
          </div>
          <Button className="self-end" type="submit">
            Create safe template
          </Button>
        </form>
      </Card>
    </ListShell>
  );
}

export function StatutoryLiabilitiesPage() {
  return (
    <ListShell
      title="Statutory Liabilities"
      description="Summaries from finalized line items, not submitted returns."
      queryKey="statutory-liabilities"
      serverFn={listStatutoryLiabilities}
      headers={["Payroll", "Rule", "Category", "Employee", "Employer", "Verification"]}
      renderRow={(row) => (
        <tr key={row.id} className="border-t">
          <td className="px-3 py-3">{row.payroll?.final_payroll_code}</td>
          <td className="px-3 py-3">{row.statutory_rule_version}</td>
          <td className="px-3 py-3">{row.rule_category}</td>
          <td className="px-3 py-3">{money(row.employee_contribution_total, row.currency)}</td>
          <td className="px-3 py-3">{money(row.employer_contribution_total, row.currency)}</td>
          <td className="px-3 py-3">
            <Badge>{row.verification_status}</Badge>
          </td>
        </tr>
      )}
    />
  );
}

export function JournalDraftsPage() {
  return (
    <ListShell
      title="Journal Drafts"
      description="Balanced accounting preparation only; no posting."
      queryKey="journal-drafts"
      serverFn={listJournalDrafts}
      headers={["Reference", "Payroll", "Status", "Debit", "Credit"]}
      renderRow={(row) => (
        <tr key={row.id} className="border-t">
          <td className="px-3 py-3">{row.reference}</td>
          <td className="px-3 py-3">{row.payroll?.final_payroll_code}</td>
          <td className="px-3 py-3">
            <Badge>{row.status}</Badge>
          </td>
          <td className="px-3 py-3">{money(row.debit_total, row.currency)}</td>
          <td className="px-3 py-3">{money(row.credit_total, row.currency)}</td>
        </tr>
      )}
    />
  );
}

export function PayrollCorrectionsPage() {
  const propertyId = useActiveProperty();
  const currentUserId = useCurrentUserId();
  const create = useServerFn(createPayrollCorrection);
  const review = useServerFn(reviewPayrollCorrection);
  const client = useQueryClient();
  const canReview = usePermission({
    propertyId,
    module: "payroll_corrections",
    capability: "approve",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await create({
      data: {
        propertyId,
        payrollId: form.get("payrollId"),
        requestType: form.get("requestType"),
        reason: form.get("reason"),
      },
    });
    toast.success("Correction request recorded");
    await client.invalidateQueries({ queryKey: ["payroll-corrections"] });
  }
  async function decide(row: any, decision: "approved" | "rejected") {
    let reviewReason = "";
    if (decision === "rejected") {
      reviewReason = window.prompt("Reason for rejecting this correction request (required)") ?? "";
      if (reviewReason.trim().length < 5) return;
    } else {
      reviewReason = window.prompt("Optional review note for approval") ?? "";
    }
    if (
      !window.confirm(
        `${decision === "approved" ? "Approve" : "Reject"} this correction request? Approval only authorizes the next controlled correction, supplemental or reversal step - it does not by itself alter finalized payroll.`,
      )
    )
      return;
    setReviewingId(row.id);
    try {
      await review({ data: { propertyId, correctionId: row.id, decision, reviewReason } });
      toast.success(
        decision === "approved" ? "Correction request approved" : "Correction request rejected",
      );
      await client.invalidateQueries({ queryKey: ["payroll-corrections"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Review failed");
    } finally {
      setReviewingId(null);
    }
  }
  return (
    <ListShell
      title="Payroll Corrections"
      description="Correction, supplemental and reversal request foundation."
      queryKey="payroll-corrections"
      serverFn={listPayrollCorrections}
      headers={[
        "Payroll",
        "Type",
        "Status",
        "Employee",
        "Reason",
        "Requested by",
        "Reviewed by",
        "Actions",
      ]}
      renderRow={(row) => {
        const isOwnRequest = !!currentUserId && row.created_by === currentUserId;
        const canAct = canReview.allowed && row.status === "requested" && !isOwnRequest;
        const busy = reviewingId === row.id;
        return (
          <tr key={row.id} className="border-t align-top">
            <td className="px-3 py-3">{row.payroll?.final_payroll_code}</td>
            <td className="px-3 py-3">{row.request_type}</td>
            <td className="px-3 py-3">
              <Badge>{row.status}</Badge>
            </td>
            <td className="px-3 py-3">
              {row.employee
                ? `${row.employee.employee_number ?? ""} ${row.employee.first_name ?? ""} ${row.employee.last_name ?? ""}`.trim()
                : "-"}
            </td>
            <td className="px-3 py-3">
              <div>{row.reason}</div>
              {row.financial_impact != null && (
                <div className="text-xs text-muted-foreground">
                  Impact: {money(row.financial_impact)}
                </div>
              )}
              {row.review_reason && (
                <div className="mt-1 text-xs text-muted-foreground">
                  Review note: {row.review_reason}
                </div>
              )}
            </td>
            <td className="px-3 py-3">
              <div>{row.requester?.full_name || row.requester?.email || "-"}</div>
              <div className="text-xs text-muted-foreground">
                {new Date(row.created_at).toLocaleString()}
              </div>
            </td>
            <td className="px-3 py-3">
              {row.reviewed_by ? (
                <>
                  <div>{row.reviewer?.full_name || row.reviewer?.email || "-"}</div>
                  <div className="text-xs text-muted-foreground">
                    {row.reviewed_at ? new Date(row.reviewed_at).toLocaleString() : ""}
                  </div>
                </>
              ) : (
                <span className="text-xs text-muted-foreground">Not yet reviewed</span>
              )}
            </td>
            <td className="px-3 py-3">
              {row.status !== "requested" ? (
                <span className="text-xs text-muted-foreground">
                  Decision recorded - not editable
                </span>
              ) : !canReview.allowed ? (
                <span className="text-xs text-muted-foreground">Review permission required</span>
              ) : isOwnRequest ? (
                <span className="text-xs text-muted-foreground">
                  Requester cannot review own request
                </span>
              ) : (
                <RowActions>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canAct || busy}
                    onClick={() => decide(row, "approved")}
                  >
                    <CheckCircle2 className="mr-1 h-4 w-4" />
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={!canAct || busy}
                    onClick={() => decide(row, "rejected")}
                  >
                    Reject
                  </Button>
                </RowActions>
              )}
            </td>
          </tr>
        );
      }}
    >
      <Alert>
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>Review authorizes, it does not execute</AlertTitle>
        <AlertDescription>
          Approving a correction request only authorizes the next controlled correction,
          supplemental payroll or reversal step. It never edits finalized payroll, marks a payment
          as reversed, or claims a correction has already been executed.
        </AlertDescription>
      </Alert>
      <Card className="p-4">
        <form className="grid gap-3 md:grid-cols-4" onSubmit={submit}>
          <div>
            <Label>Finalized payroll ID</Label>
            <Input name="payrollId" required />
          </div>
          <div>
            <Label>Type</Label>
            <Input name="requestType" defaultValue="correction" />
          </div>
          <div>
            <Label>Reason</Label>
            <Input name="reason" required />
          </div>
          <Button className="self-end" type="submit">
            <FileText className="mr-1 h-4 w-4" />
            Record request
          </Button>
        </form>
      </Card>
    </ListShell>
  );
}
