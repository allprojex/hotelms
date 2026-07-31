/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 4C tables await generated database types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { captureAuditEvent } from "@/lib/audit.server";
import { assertServerPermission } from "@/lib/permissions.server";
import { authorizeReportAction } from "@/lib/reports/report-access.server";
import { pageRange } from "@/lib/query-state";
import { HRM_PERMISSIONS, PAYROLL_SENSITIVE_ROLES } from "@/lib/hrm/permissions";

type Context = { userId: string; supabase: any };
const uuid = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) throw new Error("Valid identifier required");
  return value;
};
const text = (value: unknown, max = 500) =>
  String(value ?? "")
    .trim()
    .slice(0, max);
const idempotency = () => crypto.randomUUID();

async function allow(context: Context, propertyId: string, permission: any) {
  await assertServerPermission(context, { propertyId, ...permission });
}

async function audit(
  context: Context,
  propertyId: string,
  action: string,
  type: string,
  id: string,
) {
  await captureAuditEvent(context, {
    propertyId,
    action,
    resourceType: type,
    resourceId: id,
    newValues: {},
    sourceModule: "payroll_finalization",
  });
}

function listInput(data: any) {
  return {
    propertyId: uuid(data.propertyId),
    page: Math.max(1, Number(data.page ?? 1)),
    pageSize: Math.min(100, Math.max(10, Number(data.pageSize ?? 25))),
    search: text(data.search, 80).replace(/[%_(),.*]/g, " "),
    status: text(data.status, 40),
  };
}

export const listPayrollApprovals = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.payrollApprovalView);
    const range = pageRange(data.page, data.pageSize);
    let query = (context.supabase as any)
      .from("payroll_runs")
      .select("*,period:calendar_period_id(period_label,start_date,end_date)", { count: "exact" })
      .eq("property_id", data.propertyId)
      .in("status", [
        "locked_for_review",
        "submitted_for_approval",
        "approved",
        "rejected",
        "returned_for_correction",
      ])
      .is("archived_at", null)
      .order("updated_at", { ascending: false })
      .range(range.from, range.to);
    if (data.status) query = query.eq("status", data.status);
    if (data.search) query = query.ilike("run_code", `%${data.search}%`);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const getPayrollApproval = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({ propertyId: uuid(data.propertyId), runId: uuid(data.runId) }))
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.payrollApprovalView);
    const db = context.supabase as any;
    const run = await db
      .from("payroll_runs")
      .select("*,period:calendar_period_id(period_label,start_date,end_date)")
      .eq("property_id", data.propertyId)
      .eq("id", data.runId)
      .single();
    if (run.error) throw new Error(run.error.message);
    const history = await db
      .from("payroll_approval_actions")
      .select("*,actor:actor_id(full_name,email)")
      .eq("property_id", data.propertyId)
      .eq("payroll_run_id", data.runId)
      .order("action_at", { ascending: false });
    if (history.error) throw new Error(history.error.message);
    return { run: run.data, history: history.data ?? [] };
  });

export const transitionPayrollApproval = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    runId: uuid(data.runId),
    action: text(data.action, 40),
    calculationVersion: Number(data.calculationVersion),
    reason: text(data.reason, 500),
    idempotencyKey: data.idempotencyKey ? uuid(data.idempotencyKey) : idempotency(),
  }))
  .handler(async ({ data, context }) => {
    const permission =
      data.action === "submit"
        ? HRM_PERMISSIONS.payrollApprovalSubmit
        : data.action === "approve"
          ? HRM_PERMISSIONS.payrollApprovalApprove
          : HRM_PERMISSIONS.payrollApprovalReject;
    await allow(context, data.propertyId, permission);
    const result = await (context.supabase as any).rpc("payroll_approval_transition", {
      _property_id: data.propertyId,
      _run_id: data.runId,
      _action: data.action,
      _calculation_version: data.calculationVersion,
      _reason: data.reason || null,
      _idempotency_key: data.idempotencyKey,
    });
    if (result.error) throw new Error(result.error.message);
    await audit(context, data.propertyId, data.action, "payroll_approval", data.runId);
    return result.data;
  });

export const finalizePayrollRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    runId: uuid(data.runId),
    calculationVersion: Number(data.calculationVersion),
    idempotencyKey: data.idempotencyKey ? uuid(data.idempotencyKey) : idempotency(),
  }))
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.payrollFinalizationExecute);
    const result = await (context.supabase as any).rpc("payroll_finalize_run", {
      _property_id: data.propertyId,
      _run_id: data.runId,
      _calculation_version: data.calculationVersion,
      _idempotency_key: data.idempotencyKey,
    });
    if (result.error) throw new Error(result.error.message);
    await audit(context, data.propertyId, "finalized", "finalized_payroll", result.data);
    return { finalizedPayrollId: result.data };
  });

export const listFinalizedPayrolls = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.finalizedPayrollView);
    const range = pageRange(data.page, data.pageSize);
    let query = (context.supabase as any)
      .from("finalized_payrolls")
      .select("*,period:calendar_period_id(period_label,start_date,end_date)", { count: "exact" })
      .eq("property_id", data.propertyId)
      .order("finalized_at", { ascending: false })
      .range(range.from, range.to);
    if (data.status) query = query.eq("status", data.status);
    if (data.search) query = query.ilike("final_payroll_code", `%${data.search}%`);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const getFinalizedPayroll = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    payrollId: uuid(data.payrollId),
    page: Math.max(1, Number(data.page ?? 1)),
    pageSize: Math.min(100, Math.max(10, Number(data.pageSize ?? 25))),
  }))
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.finalizedPayrollView);
    const db = context.supabase as any;
    const payroll = await db
      .from("finalized_payrolls")
      .select("*,period:calendar_period_id(period_label,start_date,end_date)")
      .eq("property_id", data.propertyId)
      .eq("id", data.payrollId)
      .single();
    if (payroll.error) throw new Error(payroll.error.message);
    const range = pageRange(data.page, data.pageSize);
    const employees = await db
      .from("finalized_payroll_employees")
      .select("*,employee:employee_id(employee_number,first_name,last_name)", { count: "exact" })
      .eq("property_id", data.propertyId)
      .eq("finalized_payroll_id", data.payrollId)
      .order("created_at")
      .range(range.from, range.to);
    if (employees.error) throw new Error(employees.error.message);
    return { payroll: payroll.data, employees: employees.data ?? [], total: employees.count ?? 0 };
  });

export const generatePayslips = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    payrollId: uuid(data.payrollId),
    employeeIds: Array.isArray(data.employeeIds) ? data.employeeIds.map(uuid) : null,
  }))
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.payslipGenerate);
    const result = await (context.supabase as any).rpc("payroll_generate_payslips", {
      _property_id: data.propertyId,
      _finalized_payroll_id: data.payrollId,
      _employee_ids: data.employeeIds,
    });
    if (result.error) throw new Error(result.error.message);
    return { count: result.data ?? 0 };
  });

export const publishPayslips = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    payrollId: uuid(data.payrollId),
    publish: data.publish !== false,
    reason: text(data.reason, 500),
    employeeIds: Array.isArray(data.employeeIds) ? data.employeeIds.map(uuid) : null,
  }))
  .handler(async ({ data, context }) => {
    await allow(
      context,
      data.propertyId,
      data.publish ? HRM_PERMISSIONS.payslipPublish : HRM_PERMISSIONS.payslipUnpublish,
    );
    const result = await (context.supabase as any).rpc("payroll_publish_payslips", {
      _property_id: data.propertyId,
      _finalized_payroll_id: data.payrollId,
      _employee_ids: data.employeeIds,
      _publish: data.publish,
      _reason: data.reason || null,
    });
    if (result.error) throw new Error(result.error.message);
    return { count: result.data ?? 0 };
  });

export const listPayslips = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    ...listInput(data),
    payrollId: data.payrollId ? uuid(data.payrollId) : null,
  }))
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.payslipDownload);
    const range = pageRange(data.page, data.pageSize);
    let query = (context.supabase as any)
      .from("payroll_payslips")
      .select(
        "*,employee:employee_id(employee_number,first_name,last_name),payroll:finalized_payroll_id(final_payroll_code)",
        { count: "exact" },
      )
      .eq("property_id", data.propertyId)
      .order("generated_at", { ascending: false })
      .range(range.from, range.to);
    if (data.payrollId) query = query.eq("finalized_payroll_id", data.payrollId);
    if (data.status) query = query.eq("status", data.status);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const preparePaymentBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    payrollId: uuid(data.payrollId),
    paymentMethod: text(data.paymentMethod, 40) || "bank_transfer",
    idempotencyKey: data.idempotencyKey ? uuid(data.idempotencyKey) : idempotency(),
  }))
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.paymentBatchesPrepare);
    const result = await (context.supabase as any).rpc("payroll_prepare_payment_batch", {
      _property_id: data.propertyId,
      _finalized_payroll_id: data.payrollId,
      _payment_method: data.paymentMethod,
      _idempotency_key: data.idempotencyKey,
    });
    if (result.error) throw new Error(result.error.message);
    return { batchId: result.data };
  });

export const listPaymentBatches = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.paymentBatchesView);
    const range = pageRange(data.page, data.pageSize);
    const result = await (context.supabase as any)
      .from("payroll_payment_batches")
      .select("*,payroll:finalized_payroll_id(final_payroll_code)", { count: "exact" })
      .eq("property_id", data.propertyId)
      .order("prepared_at", { ascending: false })
      .range(range.from, range.to);
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const validatePaymentBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    batchId: uuid(data.batchId),
  }))
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.paymentBatchesValidate);
    const result = await (context.supabase as any).rpc("payroll_validate_payment_batch", {
      _property_id: data.propertyId,
      _batch_id: data.batchId,
    });
    if (result.error) throw new Error(result.error.message);
    return { ok: true };
  });

export const exportPaymentBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    batchId: uuid(data.batchId),
    templateId: uuid(data.templateId),
  }))
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.paymentExportGenerate);
    await allow(context, data.propertyId, HRM_PERMISSIONS.paymentExportSensitiveFields);
    const result = await (context.supabase as any).rpc("payroll_export_payment_batch", {
      _property_id: data.propertyId,
      _batch_id: data.batchId,
      _template_id: data.templateId,
    });
    if (result.error) throw new Error(result.error.message);
    return { exportHash: result.data };
  });

export const listPaymentTemplates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.paymentTemplatesView);
    const result = await (context.supabase as any)
      .from("payroll_payment_export_templates")
      .select("*", { count: "exact" })
      .eq("property_id", data.propertyId)
      .order("updated_at", { ascending: false });
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const savePaymentTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    name: text(data.name, 120),
    format: text(data.format, 20) || "csv",
    template: data.template ?? {},
  }))
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.paymentTemplatesManage);
    const result = await (context.supabase as any)
      .from("payroll_payment_export_templates")
      .insert({
        property_id: data.propertyId,
        name: data.name,
        format: data.format,
        template: data.template,
        created_by: context.userId,
        updated_by: context.userId,
      })
      .select("id")
      .single();
    if (result.error) throw new Error(result.error.message);
    return result.data;
  });

export const listStatutoryLiabilities = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.statutoryLiabilitiesView);
    const result = await (context.supabase as any)
      .from("payroll_statutory_liability_summaries")
      .select("*,payroll:finalized_payroll_id(final_payroll_code)", { count: "exact" })
      .eq("property_id", data.propertyId)
      .order("created_at", { ascending: false });
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const listJournalDrafts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.journalDraftsView);
    const result = await (context.supabase as any)
      .from("payroll_journal_drafts")
      .select("*,payroll:finalized_payroll_id(final_payroll_code)", { count: "exact" })
      .eq("property_id", data.propertyId)
      .order("prepared_at", { ascending: false });
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const prepareJournalDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    payrollId: uuid(data.payrollId),
  }))
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.journalDraftsGenerate);
    const result = await (context.supabase as any).rpc("payroll_prepare_journal_draft", {
      _property_id: data.propertyId,
      _finalized_payroll_id: data.payrollId,
    });
    if (result.error) throw new Error(result.error.message);
    return { journalDraftId: result.data };
  });

export const closePayrollPeriod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    calendarPeriodId: uuid(data.calendarPeriodId),
    close: data.close !== false,
    reason: text(data.reason, 500),
  }))
  .handler(async ({ data, context }) => {
    await allow(
      context,
      data.propertyId,
      data.close ? HRM_PERMISSIONS.payrollPeriodClose : HRM_PERMISSIONS.payrollPeriodReopen,
    );
    const result = await (context.supabase as any).rpc("payroll_close_period", {
      _property_id: data.propertyId,
      _calendar_period_id: data.calendarPeriodId,
      _close: data.close,
      _reason: data.reason,
    });
    if (result.error) throw new Error(result.error.message);
    return { ok: true };
  });

export const listPayrollCorrections = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.payrollCorrectionCreate);
    const result = await (context.supabase as any)
      .from("payroll_correction_requests")
      .select(
        "*,payroll:finalized_payroll_id(final_payroll_code),employee:affected_employee_id(employee_number,first_name,last_name),requester:created_by(full_name,email),reviewer:reviewed_by(full_name,email)",
        { count: "exact" },
      )
      .eq("property_id", data.propertyId)
      .order("created_at", { ascending: false });
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const createPayrollCorrection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    payrollId: uuid(data.payrollId),
    affectedEmployeeId: data.affectedEmployeeId ? uuid(data.affectedEmployeeId) : null,
    requestType: text(data.requestType, 40) || "correction",
    reason: text(data.reason, 500),
    financialImpact: data.financialImpact == null ? null : Number(data.financialImpact),
  }))
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.payrollCorrectionCreate);
    const result = await (context.supabase as any).rpc("payroll_create_correction_request", {
      _property_id: data.propertyId,
      _finalized_payroll_id: data.payrollId,
      _affected_employee_id: data.affectedEmployeeId,
      _request_type: data.requestType,
      _reason: data.reason,
      _financial_impact: data.financialImpact,
    });
    if (result.error) throw new Error(result.error.message);
    return { correctionId: result.data };
  });

export const reviewPayrollCorrection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => {
    const decision = text(data.decision, 20);
    if (decision !== "approved" && decision !== "rejected") {
      throw new Error("Decision must be approved or rejected");
    }
    return {
      propertyId: uuid(data.propertyId),
      correctionId: uuid(data.correctionId),
      decision,
      reviewReason: text(data.reviewReason, 500),
    };
  })
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.payrollCorrectionApprove);
    const result = await (context.supabase as any).rpc("payroll_review_correction_request", {
      _property_id: data.propertyId,
      _correction_id: data.correctionId,
      _decision: data.decision,
      _review_reason: data.reviewReason || null,
    });
    if (result.error) throw new Error(result.error.message);
    return result.data;
  });

export const executeReversalFoundation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    payrollId: uuid(data.payrollId),
    reason: text(data.reason, 500),
  }))
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.payrollReversalExecute);
    const result = await (context.supabase as any).rpc("payroll_execute_reversal_foundation", {
      _property_id: data.propertyId,
      _finalized_payroll_id: data.payrollId,
      _reason: data.reason,
    });
    if (result.error) throw new Error(result.error.message);
    return { reversalId: result.data, executionBlocked: true };
  });

const FINALIZED_REPORT_TYPES = [
  "finalized-payroll-summary",
  "employee-payroll-detail",
  "earnings",
  "deductions",
  "employer-contributions",
  "net-pay-register",
  "payment-preparation-register",
  "statutory-liability-summary",
  "accounting-journal-draft",
  "payslip-publication-status",
  "approval-history",
  "finalization-audit",
  "correction-reversal-register",
] as const;

export const authorizeFinalizedPayrollReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    reportType: text(data.reportType, 80),
    action: text(data.action, 20) === "print" ? "print" : "export",
  }))
  .handler(async ({ data, context }) => {
    if (!FINALIZED_REPORT_TYPES.includes(data.reportType as any))
      throw new Error("Unsupported finalized payroll report");
    await allow(
      context,
      data.propertyId,
      data.action === "print"
        ? HRM_PERMISSIONS.finalizedPayrollPrint
        : HRM_PERMISSIONS.finalizedPayrollExport,
    );
    await authorizeReportAction(context, {
      propertyId: data.propertyId,
      reportKey: "finalized_payroll_reports",
      title: data.reportType,
      action: data.action as "export" | "print",
      defaultRoles: PAYROLL_SENSITIVE_ROLES,
      sensitive: true,
    });
    return { authorized: true, finalized: true };
  });

export const getFinalizedPayrollReportData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    reportType: text(data.reportType, 80),
    payrollId: data.payrollId ? uuid(data.payrollId) : null,
  }))
  .handler(async ({ data, context }) => {
    if (!FINALIZED_REPORT_TYPES.includes(data.reportType as any))
      throw new Error("Unsupported finalized payroll report");
    await allow(context, data.propertyId, HRM_PERMISSIONS.finalizedPayrollView);
    const db = context.supabase as any;
    let query: any;
    if (data.reportType === "payment-preparation-register")
      query = db.from("payroll_payment_batches").select("*").eq("property_id", data.propertyId);
    else if (data.reportType === "statutory-liability-summary")
      query = db
        .from("payroll_statutory_liability_summaries")
        .select("*")
        .eq("property_id", data.propertyId);
    else if (data.reportType === "accounting-journal-draft")
      query = db.from("payroll_journal_drafts").select("*").eq("property_id", data.propertyId);
    else if (data.reportType === "payslip-publication-status")
      query = db
        .from("payroll_payslips")
        .select(
          "status,document_version,generated_at,published_at,employee:employee_id(employee_number,first_name,last_name)",
        )
        .eq("property_id", data.propertyId);
    else if (data.reportType === "approval-history")
      query = db.from("payroll_approval_actions").select("*").eq("property_id", data.propertyId);
    else if (data.reportType === "correction-reversal-register")
      query = db.from("payroll_correction_requests").select("*").eq("property_id", data.propertyId);
    else if (
      [
        "employee-payroll-detail",
        "earnings",
        "deductions",
        "employer-contributions",
        "net-pay-register",
      ].includes(data.reportType)
    )
      query = db
        .from("finalized_payroll_line_items")
        .select("*")
        .eq("property_id", data.propertyId);
    else query = db.from("finalized_payrolls").select("*").eq("property_id", data.propertyId);
    if (data.payrollId && "eq" in query) query = query.eq("finalized_payroll_id", data.payrollId);
    const result = await query.limit(5000);
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], reportType: data.reportType };
  });
