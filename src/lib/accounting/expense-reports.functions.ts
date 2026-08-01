/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 6A tables await generated database types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertServerPermission, hasServerPermission } from "@/lib/permissions.server";
import { authorizeReportAction } from "@/lib/reports/report-access.server";
import { ACCOUNTING_ADMIN_ROLES, EXPENSE_PERMISSIONS } from "@/lib/accounting/permissions";
import { uuid } from "@/lib/accounting/domain";

const REPORT_TYPES = [
  "register",
  "by-category",
  "by-vendor",
  "by-cost-centre",
  "by-department",
  "by-payment-method",
  "approved",
  "rejected",
  "cancelled",
  "missing-receipts",
  "approval-history",
  "corrections-reversals",
  "period-totals",
] as const;
type ReportType = (typeof REPORT_TYPES)[number];

function maskReference(value: string | null, canViewSensitive: boolean): string | null {
  if (!value) return value;
  if (canViewSensitive) return value;
  return value.length <= 4 ? "****" : `****${value.slice(-4)}`;
}

export const authorizeExpenseReportAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: any) => ({
    propertyId: uuid(d.propertyId),
    action: (d.action === "print" ? "print" : "export") as "print" | "export",
    format: String(d.format ?? "csv"),
    reportType: String(d.reportType ?? "register").slice(0, 40),
  }))
  .handler(async ({ data, context }) => {
    await authorizeReportAction(context as any, {
      propertyId: data.propertyId,
      reportKey: "expense_reports",
      title: `Expense report: ${data.reportType}`,
      action: data.action,
      format: data.format,
      filters: { reportType: data.reportType },
      sensitive: true,
      defaultRoles: ACCOUNTING_ADMIN_ROLES,
    });
    return { authorized: true };
  });

export const getExpenseReportData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; reportType: string; from?: string; to?: string }) => {
    if (!REPORT_TYPES.includes(d.reportType as ReportType))
      throw new Error("Unsupported expense report");
    return {
      propertyId: uuid(d.propertyId),
      reportType: d.reportType as ReportType,
      from: d.from && /^\d{4}-\d{2}-\d{2}$/.test(d.from) ? d.from : null,
      to: d.to && /^\d{4}-\d{2}-\d{2}$/.test(d.to) ? d.to : null,
    };
  })
  .handler(async ({ data, context }) => {
    await assertServerPermission(context as any, {
      propertyId: data.propertyId,
      ...EXPENSE_PERMISSIONS.reportsView,
      defaultRoles: ACCOUNTING_ADMIN_ROLES,
    });
    const canViewSensitive = await hasServerPermission(context as any, {
      propertyId: data.propertyId,
      ...EXPENSE_PERMISSIONS.expensesSensitiveView,
      defaultRoles: ACCOUNTING_ADMIN_ROLES,
    });
    const db = context.supabase as any;

    if (data.reportType === "approval-history") {
      let query = db
        .from("expense_status_history")
        .select(
          "*,expense:expense_id(id,expense_number,currency,total_amount),actor:actor_id(id,full_name)",
        )
        .eq("property_id", data.propertyId)
        .order("created_at", { ascending: false });
      if (data.from) query = query.gte("created_at", `${data.from}T00:00:00.000Z`);
      if (data.to) query = query.lte("created_at", `${data.to}T23:59:59.999Z`);
      const result = await query;
      if (result.error) throw new Error(result.error.message);
      return { rows: result.data ?? [], canViewSensitive };
    }

    if (data.reportType === "corrections-reversals") {
      let query = db
        .from("expense_corrections")
        .select(
          "*,expense:expense_id(id,expense_number,currency,total_amount),reversal:reversal_expense_id(id,expense_number,total_amount),requester:requested_by(id,full_name),reviewer:reviewed_by(id,full_name)",
        )
        .eq("property_id", data.propertyId)
        .order("requested_at", { ascending: false });
      if (data.from) query = query.gte("requested_at", `${data.from}T00:00:00.000Z`);
      if (data.to) query = query.lte("requested_at", `${data.to}T23:59:59.999Z`);
      const result = await query;
      if (result.error) throw new Error(result.error.message);
      return { rows: result.data ?? [], canViewSensitive };
    }

    let query = db
      .from("expenses")
      .select(
        "*,vendor:vendor_id(id,name,vendor_code),category:category_id(id,name,code),cost_centre:cost_centre_id(id,name,code),department:department_id(id,name),creator:created_by(id,full_name),financial_period:financial_period_id(id,name,code)",
      )
      .eq("property_id", data.propertyId)
      .order("expense_date", { ascending: false });
    if (data.from) query = query.gte("expense_date", data.from);
    if (data.to) query = query.lte("expense_date", data.to);
    if (data.reportType === "approved") query = query.eq("status", "approved");
    if (data.reportType === "rejected") query = query.eq("status", "rejected");
    if (data.reportType === "cancelled") query = query.eq("status", "cancelled");
    if (data.reportType === "missing-receipts") query = query.eq("receipt_status", "missing");

    const result = await query;
    if (result.error) throw new Error(result.error.message);
    const rows = (result.data ?? []).map((row: any) => ({
      ...row,
      payment_reference: maskReference(row.payment_reference, canViewSensitive),
    }));
    return { rows, canViewSensitive };
  });
