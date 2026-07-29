/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 4B tables await generated database types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { captureAuditEvent } from "@/lib/audit.server";
import { assertServerPermission } from "@/lib/permissions.server";
import { authorizeReportAction } from "@/lib/reports/report-access.server";
import { pageRange } from "@/lib/query-state";
import { HRM_PERMISSIONS, PAYROLL_SENSITIVE_ROLES } from "@/lib/hrm/permissions";
import {
  calculatePayroll,
  validateStatutoryRule,
  type CalculationComponent,
  type PayrollFinding,
  type StatutoryRule,
} from "@/lib/hrm/payroll-calculation";
import { preparePayrollInputs } from "@/lib/hrm/payroll-inputs";

type Context = { userId: string; supabase: any };
const uuid = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) throw new Error("Valid identifier required");
  return value;
};
const iso = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Valid date required");
  return value;
};
async function allow(context: Context, propertyId: string, permission: any) {
  await assertServerPermission(context, { propertyId, ...permission });
}
async function audit(
  context: Context,
  propertyId: string,
  action: string,
  resourceType: string,
  resourceId: string,
  newValues: unknown,
) {
  await captureAuditEvent(context, {
    propertyId,
    action,
    resourceType,
    resourceId,
    newValues,
    sourceModule: "payroll_draft_calculation",
  });
}

export const listDraftPayrollRuns = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    page: Math.max(1, Number(data.page ?? 1)),
    pageSize: Math.min(100, Math.max(10, Number(data.pageSize ?? 25))),
    status: String(data.status ?? "active"),
    search: String(data.search ?? "")
      .replace(/[%_(),.*]/g, " ")
      .trim()
      .slice(0, 80),
  }))
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.payrollRunsView);
    const range = pageRange(data.page, data.pageSize);
    let query = (context.supabase as any)
      .from("payroll_runs")
      .select(
        "*,period:calendar_period_id(period_label,start_date,end_date,status),version:current_calculation_version(id,status,completed_at)",
        { count: "exact" },
      )
      .eq("property_id", data.propertyId)
      .order("created_at", { ascending: false })
      .range(range.from, range.to);
    query =
      data.status === "archived"
        ? query.not("archived_at", "is", null)
        : query.is("archived_at", null);
    if (data.status !== "active" && data.status !== "archived")
      query = query.eq("status", data.status);
    if (data.search) query = query.ilike("run_code", `%${data.search}%`);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const getDraftPayrollRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    runId: uuid(data.runId),
    version: data.version == null ? null : Number(data.version),
    page: Math.max(1, Number(data.page ?? 1)),
    pageSize: Math.min(100, Math.max(10, Number(data.pageSize ?? 25))),
    search: String(data.search ?? "")
      .replace(/[%_(),.*]/g, " ")
      .trim()
      .slice(0, 80),
  }))
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.payrollRunsView);
    const db = context.supabase as any;
    const run = await db
      .from("payroll_runs")
      .select("*,period:calendar_period_id(*)")
      .eq("property_id", data.propertyId)
      .eq("id", data.runId)
      .single();
    if (run.error) throw new Error(run.error.message);
    const version = data.version ?? run.data.current_calculation_version;
    const range = pageRange(data.page, data.pageSize);
    let matchingEmployeeIds: string[] | null = null;
    if (data.search) {
      const matching = await db
        .from("hr_employees")
        .select("id")
        .eq("property_id", data.propertyId)
        .or(
          `employee_number.ilike.%${data.search}%,first_name.ilike.%${data.search}%,last_name.ilike.%${data.search}%`,
        )
        .limit(1000);
      if (matching.error) throw new Error(matching.error.message);
      matchingEmployeeIds = (matching.data ?? []).map((row: any) => row.id);
    }
    let employeeQuery = db
      .from("payroll_run_employees")
      .select("*,employee:employee_id(employee_number,first_name,last_name)", { count: "exact" })
      .eq("property_id", data.propertyId)
      .eq("payroll_run_id", data.runId)
      .eq("calculation_version", version)
      .order("created_at")
      .range(range.from, range.to);
    if (matchingEmployeeIds)
      employeeQuery = employeeQuery.in(
        "employee_id",
        matchingEmployeeIds.length ? matchingEmployeeIds : ["00000000-0000-0000-0000-000000000000"],
      );
    const [versions, employees, findings] = await Promise.all([
      db
        .from("payroll_run_versions")
        .select("*")
        .eq("property_id", data.propertyId)
        .eq("payroll_run_id", data.runId)
        .order("calculation_version", { ascending: false }),
      employeeQuery,
      db
        .from("payroll_calculation_findings")
        .select("*")
        .eq("property_id", data.propertyId)
        .eq("payroll_run_id", data.runId)
        .eq("calculation_version", version)
        .order("severity"),
    ]);
    for (const result of [versions, employees, findings])
      if (result.error) throw new Error(result.error.message);
    await audit(context, data.propertyId, "view", "draft_payroll_run", data.runId, {
      calculationVersion: version,
      employeeRows: employees.data?.length ?? 0,
    });
    const selectedVersion = (versions.data ?? []).find(
      (row: any) => row.calculation_version === version,
    );
    return {
      run: selectedVersion
        ? {
            ...run.data,
            employee_count: selectedVersion.employee_count,
            gross_total: selectedVersion.gross_total,
            deduction_total: selectedVersion.deduction_total,
            net_total: selectedVersion.net_total,
            employer_cost_total: selectedVersion.employer_cost_total,
            warning_count: selectedVersion.warning_count,
            error_count: selectedVersion.error_count,
          }
        : run.data,
      versions: versions.data ?? [],
      employees: employees.data ?? [],
      employeeTotal: employees.count ?? 0,
      findings: findings.data ?? [],
      selectedVersion: version,
    };
  });

export const getDraftPayrollEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    runId: uuid(data.runId),
    employeeId: uuid(data.employeeId),
    version: Number(data.version),
  }))
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.payrollEmployeeResultsView);
    await allow(context, data.propertyId, HRM_PERMISSIONS.payrollCalculationDetailsView);
    const db = context.supabase as any;
    const employee = await db
      .from("payroll_run_employees")
      .select("*,employee:employee_id(employee_number,first_name,last_name)")
      .eq("property_id", data.propertyId)
      .eq("payroll_run_id", data.runId)
      .eq("employee_id", data.employeeId)
      .eq("calculation_version", data.version)
      .single();
    if (employee.error) throw new Error(employee.error.message);
    const [lines, findings] = await Promise.all([
      db
        .from("payroll_run_line_items")
        .select("*")
        .eq("property_id", data.propertyId)
        .eq("run_employee_id", employee.data.id)
        .order("display_order"),
      db
        .from("payroll_calculation_findings")
        .select("*")
        .eq("property_id", data.propertyId)
        .eq("run_employee_id", employee.data.id)
        .order("severity"),
    ]);
    if (lines.error || findings.error)
      throw new Error(lines.error?.message ?? findings.error.message);
    await audit(
      context,
      data.propertyId,
      "view",
      "draft_payroll_employee_result",
      employee.data.id,
      {
        calculationVersion: data.version,
      },
    );
    return { employee: employee.data, lines: lines.data ?? [], findings: findings.data ?? [] };
  });

export const createDraftPayrollRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    calendarPeriodId: uuid(data.calendarPeriodId),
    runType: ["regular", "off_cycle", "correction_draft"].includes(data.runType)
      ? data.runType
      : "regular",
    idempotencyKey: uuid(data.idempotencyKey),
  }))
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.payrollRunsCreate);
    const result = await (context.supabase as any).rpc("payroll_create_draft_run", {
      _property_id: data.propertyId,
      _calendar_period_id: data.calendarPeriodId,
      _run_type: data.runType,
      _idempotency_key: data.idempotencyKey,
    });
    if (result.error) throw new Error(result.error.message);
    return { id: result.data };
  });

function componentLineType(component: any): CalculationComponent["lineType"] {
  if (component.component_type === "earning") return "earning";
  if (component.component_type === "deduction")
    return component.taxable_classification === "pre_tax"
      ? "pre_tax_deduction"
      : "post_tax_deduction";
  if (component.component_type === "employee_contribution") return "employee_statutory";
  if (component.component_type === "employer_contribution") return "employer_statutory";
  if (component.component_type === "reimbursement") return "reimbursement";
  return "informational";
}

function componentFromRows(
  component: any,
  rule: any,
  sourceType: CalculationComponent["sourceType"],
  sourceId: string,
  overrides: { amount?: any; percentage?: any; manualQuantity?: any } = {},
): CalculationComponent {
  return {
    id: component.id,
    propertyId: component.property_id,
    code: component.code,
    name: component.name,
    method: rule.calculation_method,
    lineType: componentLineType(component),
    amount: overrides.amount ?? rule.amount,
    manualQuantity: overrides.manualQuantity,
    percentage: overrides.percentage ?? rule.percentage,
    basisComponentCode: rule.basis_component?.code ?? null,
    minimum: rule.minimum_amount,
    maximum: rule.maximum_amount,
    displayOrder: component.display_order,
    taxable: Boolean(component.taxable_classification),
    pensionable: Boolean(component.pensionable_classification),
    prorate: component.proration_enabled,
    sourceType,
    sourceId,
    effectiveFrom: rule.effective_from,
    effectiveTo: rule.effective_to,
  };
}

function statutoryFromRow(row: any): StatutoryRule {
  const structure = row.parameters?.structure ?? row.parameters;
  const resultType =
    row.parameters?.resultType ??
    (row.rule_category.includes("employer")
      ? "employer_statutory"
      : row.rule_category.includes("tax") || row.rule_category.includes("levy")
        ? "tax"
        : "employee_statutory");
  const rule: StatutoryRule = {
    id: row.id,
    propertyId: row.property_id,
    code: `${row.rule_category}:${row.version}`,
    name: row.name,
    version: row.version,
    status: row.verification_status,
    resultType,
    order: row.calculation_order,
    structure,
  };
  validateStatutoryRule(rule);
  return rule;
}

function periodDays(startDate: string, endDate: string) {
  return (
    Math.floor(
      (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000,
    ) + 1
  );
}

async function loadCalculationData(context: Context, propertyId: string, runId: string) {
  const db = context.supabase as any;
  const run = await db
    .from("payroll_runs")
    .select("*,period:calendar_period_id(*),settings:payroll_settings_id(*)")
    .eq("property_id", propertyId)
    .eq("id", runId)
    .single();
  if (run.error) throw new Error(run.error.message);
  const period = run.data.period;
  const [
    employees,
    compensations,
    attendance,
    leave,
    rules,
    attachments,
    employeeComponents,
    manual,
    statutory,
    paymentDetails,
    priorResults,
  ] = await Promise.all([
    db
      .from("hr_employees")
      .select("id,employee_number,first_name,last_name,employment_status,hire_date,exit_date")
      .eq("property_id", propertyId)
      .in("employment_status", ["active", "probation", "exited"]),
    db
      .from("payroll_employee_compensations")
      .select("*")
      .eq("property_id", propertyId)
      .lte("effective_from", period.end_date)
      .or(`effective_to.is.null,effective_to.gte.${period.start_date}`)
      .is("archived_at", null),
    db
      .from("hr_attendance_summaries")
      .select("*")
      .eq("property_id", propertyId)
      .gte("business_date", period.start_date)
      .lte("business_date", period.end_date),
    db
      .from("hr_leave_requests")
      .select("*,leave_type:leave_type_id(paid)")
      .eq("property_id", propertyId)
      .eq("status", "approved")
      .lte("start_date", period.end_date)
      .gte("end_date", period.start_date),
    db
      .from("payroll_component_calculation_rules")
      .select("*,basis_component:basis_component_id(code),component:pay_component_id(*)")
      .eq("property_id", propertyId)
      .eq("active", true)
      .lte("effective_from", period.end_date)
      .or(`effective_to.is.null,effective_to.gte.${period.start_date}`),
    db
      .from("payroll_structure_components")
      .select("*")
      .eq("property_id", propertyId)
      .eq("active", true)
      .lte("effective_from", period.end_date)
      .or(`effective_to.is.null,effective_to.gte.${period.start_date}`),
    db
      .from("payroll_employee_components")
      .select("*")
      .eq("property_id", propertyId)
      .eq("active", true)
      .lte("start_date", period.end_date)
      .or(`end_date.is.null,end_date.gte.${period.start_date}`),
    db
      .from("payroll_manual_inputs")
      .select("*")
      .eq("property_id", propertyId)
      .eq("calendar_period_id", period.id)
      .is("archived_at", null),
    db
      .from("payroll_statutory_rule_sets")
      .select("*")
      .eq("property_id", propertyId)
      .eq("active", true)
      .lte("effective_from", period.end_date)
      .or(`effective_to.is.null,effective_to.gte.${period.start_date}`)
      .is("archived_at", null),
    db
      .from("payroll_payment_details")
      .select("employee_id,verification_status")
      .eq("property_id", propertyId)
      .eq("is_primary", true)
      .is("archived_at", null),
    db
      .from("payroll_run_employees")
      .select("employee_id,net_pay,calculated_at")
      .eq("property_id", propertyId)
      .neq("payroll_run_id", runId)
      .in("status", ["calculated", "warning"])
      .order("calculated_at", { ascending: false })
      .limit(1000),
  ]);
  for (const result of [
    employees,
    compensations,
    attendance,
    leave,
    rules,
    attachments,
    employeeComponents,
    manual,
    statutory,
    paymentDetails,
    priorResults,
  ])
    if (result.error) throw new Error(result.error.message);
  return {
    run: run.data,
    employees: employees.data ?? [],
    compensations: compensations.data ?? [],
    attendance: attendance.data ?? [],
    leave: leave.data ?? [],
    rules: rules.data ?? [],
    attachments: attachments.data ?? [],
    employeeComponents: employeeComponents.data ?? [],
    manual: manual.data ?? [],
    statutory: statutory.data ?? [],
    paymentDetails: paymentDetails.data ?? [],
    priorResults: priorResults.data ?? [],
  };
}

export const calculateDraftPayrollRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    runId: uuid(data.runId),
    idempotencyKey: uuid(data.idempotencyKey),
    employeeIds: Array.isArray(data.employeeIds)
      ? [...new Set(data.employeeIds.map((value: string) => uuid(value)))].slice(0, 1000)
      : [],
  }))
  .handler(async ({ data, context }) => {
    await allow(
      context,
      data.propertyId,
      data.employeeIds.length
        ? HRM_PERMISSIONS.payrollRunsRecalculate
        : HRM_PERMISSIONS.payrollRunsCalculate,
    );
    const db = context.supabase as any;
    const begin = await db.rpc("payroll_begin_calculation", {
      _property_id: data.propertyId,
      _run_id: data.runId,
      _idempotency_key: data.idempotencyKey,
      _selected_employee_ids: data.employeeIds.length ? data.employeeIds : null,
    });
    if (begin.error) throw new Error(begin.error.message);
    const lease = Array.isArray(begin.data) ? begin.data[0] : begin.data;
    try {
      const loaded = await loadCalculationData(context, data.propertyId, data.runId);
      const period = loaded.run.period;
      const settings = loaded.run.settings;
      const employees = loaded.employees.filter(
        (employee: any) =>
          employee.hire_date <= period.end_date &&
          (!employee.exit_date || employee.exit_date >= period.start_date),
      );
      // Every immutable calculation version is a complete snapshot. Selected retry
      // requests still refresh the full run so totals and unaffected employees cannot disappear.
      const priorByEmployee = new Map<string, any>();
      for (const row of loaded.priorResults)
        if (!priorByEmployee.has(row.employee_id)) priorByEmployee.set(row.employee_id, row);
      const verifiedPaymentEmployees = new Set(
        loaded.paymentDetails
          .filter((row: any) => row.verification_status === "verified")
          .map((row: any) => row.employee_id),
      );
      const statutoryRules: StatutoryRule[] = [];
      const statutoryConfigurationFindings: PayrollFinding[] = [];
      const selectedStatutory = new Map<string, any>();
      for (const row of [...loaded.statutory].sort((a: any, b: any) =>
        String(b.effective_from).localeCompare(String(a.effective_from)),
      )) {
        const key = `${row.jurisdiction ?? ""}:${row.rule_category}`;
        if (!selectedStatutory.has(key)) selectedStatutory.set(key, row);
      }
      for (const row of selectedStatutory.values()) {
        try {
          statutoryRules.push(statutoryFromRow(row));
        } catch (error) {
          statutoryConfigurationFindings.push({
            severity: "blocking",
            code: "INVALID_STATUTORY_RULE",
            message:
              error instanceof Error ? error.message : "Invalid statutory rule configuration",
            sourceType: "statutory_rule",
            sourceId: row.id,
          });
        }
      }
      const results = employees.map((employee: any) => {
        const compensation = loaded.compensations.find(
          (row: any) =>
            row.employee_id === employee.id &&
            row.effective_from <= period.end_date &&
            (!row.effective_to || row.effective_to >= period.start_date),
        );
        if (!compensation) {
          return {
            propertyId: data.propertyId,
            employeeId: employee.id,
            compensationId: null,
            status: "blocked",
            currency: loaded.run.currency,
            baseSalary: "0",
            totals: {
              base: "0",
              gross: "0",
              deductions: "0",
              employerContributions: "0",
              net: "0",
              employerCost: "0",
            },
            attendance: {},
            leave: {},
            trace: { calculationVersion: "phase-4b-v1" },
            sourceReferences: [],
            lines: [],
            findings: [
              {
                severity: "blocking",
                code: "MISSING_COMPENSATION",
                message: "No active compensation assignment covers this payroll period",
              },
            ],
          };
        }
        const inputSummary = preparePayrollInputs({
          propertyId: data.propertyId,
          periodStart: period.start_date,
          periodEnd: period.end_date,
          attendance: loaded.attendance
            .filter((row: any) => row.employee_id === employee.id)
            .map((row: any) => ({
              id: row.id,
              propertyId: row.property_id,
              businessDate: row.business_date,
              scheduled: Boolean(row.scheduled_start),
              attendanceStatus: row.attendance_status,
              calculationStatus: row.calculation_status,
              approvalStatus: row.approval_status,
              workedMinutes: row.worked_minutes,
              lateMinutes: row.late_minutes,
              earlyDepartureMinutes: row.early_departure_minutes,
              overtimeMinutes: row.overtime_minutes,
            })),
          leave: loaded.leave
            .filter((row: any) => row.employee_id === employee.id)
            .map((row: any) => ({
              id: row.id,
              propertyId: row.property_id,
              startDate: row.start_date,
              endDate: row.end_date,
              totalDays: Number(row.total_requested_days),
              partialDayMode: row.partial_day_mode,
              status: row.status,
              paid: Boolean(row.leave_type?.paid),
            })),
        });
        const attachmentRows = loaded.attachments.filter(
          (row: any) =>
            row.salary_structure_id === compensation.salary_structure_id &&
            (!row.salary_grade_id || row.salary_grade_id === compensation.salary_grade_id),
        );
        const employeeRows = loaded.employeeComponents.filter(
          (row: any) => row.compensation_id === compensation.id,
        );
        const manualRows = loaded.manual.filter((row: any) => row.employee_id === employee.id);
        const componentMap = new Map<string, CalculationComponent>();
        const configurationFindings: PayrollFinding[] = [];
        for (const attachment of attachmentRows) {
          const rule = loaded.rules.find(
            (row: any) => row.pay_component_id === attachment.pay_component_id,
          );
          if (rule?.component)
            componentMap.set(
              attachment.pay_component_id,
              componentFromRows(rule.component, rule, "structure", attachment.id, {
                amount: attachment.default_amount_override,
                percentage: attachment.default_percentage_override,
              }),
            );
          else
            configurationFindings.push({
              severity: "blocking",
              code: "MISSING_COMPONENT_CALCULATION_RULE",
              message: "A salary structure component has no active calculation rule",
              sourceType: "structure_component",
              sourceId: attachment.id,
            });
        }
        for (const assigned of employeeRows) {
          const rule = loaded.rules.find(
            (row: any) => row.pay_component_id === assigned.pay_component_id,
          );
          if (rule?.component)
            componentMap.set(
              assigned.pay_component_id,
              componentFromRows(rule.component, rule, "employee", assigned.id, {
                amount: assigned.fixed_amount_override,
                percentage: assigned.percentage_override,
              }),
            );
          else
            configurationFindings.push({
              severity: "blocking",
              code: "MISSING_COMPONENT_CALCULATION_RULE",
              message: "An employee component has no active calculation rule",
              sourceType: "employee_component",
              sourceId: assigned.id,
            });
        }
        for (const manual of manualRows) {
          const rule = loaded.rules.find(
            (row: any) => row.pay_component_id === manual.pay_component_id,
          );
          if (rule?.component)
            componentMap.set(
              manual.pay_component_id,
              componentFromRows(
                rule.component,
                { ...rule, calculation_method: "manual_amount" },
                "manual",
                manual.id,
                {
                  amount: manual.amount ?? rule.amount,
                  manualQuantity: manual.quantity,
                },
              ),
            );
          else
            configurationFindings.push({
              severity: "blocking",
              code: "MISSING_COMPONENT_CALCULATION_RULE",
              message: "A manual payroll input has no active calculation rule",
              sourceType: "manual_input",
              sourceId: manual.id,
            });
        }
        const components = [...componentMap.values()];
        const result = calculatePayroll({
          propertyId: data.propertyId,
          currency: loaded.run.currency,
          precision: settings.monetary_precision,
          roundingMethod: settings.rounding_method,
          allowNegativeNetPay: settings.allow_negative_net_pay,
          blockUnverifiedStatutoryRules: settings.block_unverified_statutory_rules,
          period: {
            startDate: period.start_date,
            endDate: period.end_date,
            totalDays: periodDays(period.start_date, period.end_date),
          },
          compensation: {
            id: compensation.id,
            propertyId: compensation.property_id,
            baseSalary: compensation.base_salary,
            employmentPercentage: compensation.employment_percentage,
            effectiveFrom: compensation.effective_from,
            effectiveTo: compensation.effective_to,
          },
          components,
          statutoryRules,
          inputs: inputSummary,
        });
        const findings: PayrollFinding[] = [
          ...result.findings,
          ...statutoryConfigurationFindings,
          ...configurationFindings,
        ];
        if (compensation.currency !== loaded.run.currency)
          findings.push({
            severity: "blocking",
            code: "CURRENCY_MISMATCH",
            message: "Employee compensation currency differs from the payroll run",
          });
        if (settings.require_employee_bank_details && !verifiedPaymentEmployees.has(employee.id))
          findings.push({
            severity: "blocking",
            code: "MISSING_VERIFIED_PAYMENT_DETAILS",
            message: "Verified primary payment details are required by property policy",
          });
        if (settings.incomplete_attendance_policy === "block")
          findings.forEach((finding) => {
            if (finding.code === "INCOMPLETE_ATTENDANCE") finding.severity = "blocking";
          });
        const prior = priorByEmployee.get(employee.id);
        if (prior && Number(prior.net_pay) !== 0) {
          const change =
            (Math.abs(Number(result.totals.net) - Number(prior.net_pay)) /
              Math.abs(Number(prior.net_pay))) *
            100;
          if (change >= Number(settings.variance_warning_percentage))
            findings.push({
              severity: "warning",
              code: "NET_PAY_VARIANCE",
              message: `Net pay differs from the latest comparable draft result by ${change.toFixed(2)}%`,
              sourceType: "prior_draft_result",
              sourceId: prior.employee_id,
            });
        }
        const blocking = findings.some((finding) => finding.severity === "blocking");
        const warning = findings.some((finding) => finding.severity === "warning");
        return {
          propertyId: data.propertyId,
          employeeId: employee.id,
          compensationId: compensation.id,
          status: blocking ? "blocked" : warning ? "warning" : "calculated",
          currency: loaded.run.currency,
          baseSalary: String(compensation.base_salary),
          totals: result.totals,
          attendance: {
            scheduledWorkingDays: inputSummary.scheduledWorkingDays,
            attendedDays: inputSummary.attendedDays,
            workedHours: inputSummary.workedHours,
            lateHours: inputSummary.lateHours,
            earlyDepartureHours: inputSummary.earlyDepartureHours,
            unpaidAbsenceDays: inputSummary.unpaidAbsenceDays,
            incomplete: inputSummary.incompleteAttendance,
          },
          leave: {
            paidLeaveDays: inputSummary.paidLeaveDays,
            unpaidLeaveDays: inputSummary.unpaidLeaveDays,
          },
          trace: result.trace,
          sourceReferences: inputSummary.sourceReferences,
          lines: result.lines,
          findings,
        };
      });
      const stored = await db.rpc("payroll_store_calculation_results", {
        _property_id: data.propertyId,
        _run_id: data.runId,
        _run_version_id: lease.run_version_id,
        _results: results,
      });
      if (stored.error) throw new Error(stored.error.message);
      return stored.data;
    } catch (error) {
      await db.rpc("payroll_fail_calculation", {
        _property_id: data.propertyId,
        _run_id: data.runId,
        _run_version_id: lease.run_version_id,
        _message: error instanceof Error ? error.message.slice(0, 500) : "Calculation failed",
      });
      throw error;
    }
  });

export const transitionDraftPayrollReview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    runId: uuid(data.runId),
    action: String(data.action),
    reason: String(data.reason ?? ""),
  }))
  .handler(async ({ data, context }) => {
    const permission =
      data.action === "lock"
        ? HRM_PERMISSIONS.payrollRunsLock
        : data.action === "reopen"
          ? HRM_PERMISSIONS.payrollRunsReopen
          : HRM_PERMISSIONS.payrollRunsArchive;
    await allow(context, data.propertyId, permission);
    const result = await (context.supabase as any).rpc("payroll_transition_review", {
      _property_id: data.propertyId,
      _run_id: data.runId,
      _action: data.action,
      _reason: data.reason || null,
    });
    if (result.error) throw new Error(result.error.message);
    return { ok: true };
  });

export const acknowledgePayrollWarning = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    findingId: uuid(data.findingId),
    reason: String(data.reason ?? ""),
  }))
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.payrollWarningsAcknowledge);
    const result = await (context.supabase as any).rpc("payroll_acknowledge_warning", {
      _property_id: data.propertyId,
      _finding_id: data.findingId,
      _reason: data.reason,
    });
    if (result.error) throw new Error(result.error.message);
    return { ok: true };
  });

export const listPayrollManualInputs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    calendarPeriodId: data.calendarPeriodId ? uuid(data.calendarPeriodId) : null,
    page: Math.max(1, Number(data.page ?? 1)),
    pageSize: Math.min(100, Math.max(10, Number(data.pageSize ?? 25))),
  }))
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.payrollManualInputsView);
    const range = pageRange(data.page, data.pageSize);
    let query = (context.supabase as any)
      .from("payroll_manual_inputs")
      .select(
        "*,employee:employee_id(employee_number,first_name,last_name),component:pay_component_id(code,name),period:calendar_period_id(period_label)",
        { count: "exact" },
      )
      .eq("property_id", data.propertyId)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .range(range.from, range.to);
    if (data.calendarPeriodId) query = query.eq("calendar_period_id", data.calendarPeriodId);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const savePayrollManualInput = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => data)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.payrollManualInputsManage);
    const result = await (context.supabase as any).rpc("payroll_save_manual_input", {
      _property_id: uuid(data.propertyId),
      _calendar_period_id: uuid(data.calendarPeriodId),
      _employee_id: uuid(data.employeeId),
      _component_id: uuid(data.componentId),
      _amount: data.amount === "" || data.amount == null ? null : String(data.amount),
      _quantity: data.quantity === "" || data.quantity == null ? null : String(data.quantity),
      _reason: String(data.reason),
      _source_reference: String(data.sourceReference),
      _effective_date: iso(data.effectiveDate),
      _supersedes_id: data.supersedesId ? uuid(data.supersedesId) : null,
    });
    if (result.error) throw new Error(result.error.message);
    return { id: result.data, requiresRecalculation: true };
  });

export const savePayrollCalculationRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => data)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.payComponentsManage);
    const payload = {
      property_id: uuid(data.propertyId),
      pay_component_id: uuid(data.componentId),
      calculation_method: data.method,
      amount: data.amount === "" || data.amount == null ? null : String(data.amount),
      percentage:
        data.percentage === "" || data.percentage == null ? null : String(data.percentage),
      basis_component_id: data.basisComponentId ? uuid(data.basisComponentId) : null,
      minimum_amount: data.minimum === "" || data.minimum == null ? null : String(data.minimum),
      maximum_amount: data.maximum === "" || data.maximum == null ? null : String(data.maximum),
      parameters: {},
      effective_from: iso(data.effectiveFrom),
      active: true,
      created_by: context.userId,
      updated_by: context.userId,
    };
    const result = await (context.supabase as any)
      .from("payroll_component_calculation_rules")
      .insert(payload)
      .select("id")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      "create",
      "payroll_component_calculation_rule",
      result.data.id,
      {
        componentId: data.componentId,
        method: data.method,
        effectiveFrom: data.effectiveFrom,
      },
    );
    return result.data;
  });

export const authorizePayrollDraftReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => ({
    propertyId: uuid(data.propertyId),
    runId: uuid(data.runId),
    action: (data.action === "print" ? "print" : "export") as "print" | "export",
    format: String(data.format ?? "csv"),
    reportType: String(data.reportType ?? "summary").slice(0, 40),
    calculationVersion: Number(data.calculationVersion),
  }))
  .handler(async ({ data, context }) => {
    await authorizeReportAction(context, {
      propertyId: data.propertyId,
      reportKey: "payroll_draft_reports",
      title: `DRAFT payroll ${data.reportType}`,
      action: data.action,
      format: data.format,
      filters: {
        runId: data.runId,
        calculationVersion: data.calculationVersion,
        reportType: data.reportType,
      },
      sensitive: true,
      defaultRoles: PAYROLL_SENSITIVE_ROLES,
    });
    return { authorized: true, draft: true };
  });

const PAYROLL_DRAFT_REPORT_TYPES = [
  "payroll-run-summary",
  "employee-payroll-detail",
  "earning-breakdown",
  "deduction-breakdown",
  "employer-contribution-breakdown",
  "validation-findings",
  "attendance-leave-summary",
  "manual-input-report",
  "calculation-version-comparison",
] as const;

export const getPayrollDraftReportData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => {
    const reportType = String(data.reportType);
    if (!PAYROLL_DRAFT_REPORT_TYPES.includes(reportType as any))
      throw new Error("Unsupported draft payroll report");
    return {
      propertyId: uuid(data.propertyId),
      runId: uuid(data.runId),
      calculationVersion: Number(data.calculationVersion),
      reportType,
    };
  })
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.payrollRunsView);
    if (
      [
        "employee-payroll-detail",
        "earning-breakdown",
        "deduction-breakdown",
        "employer-contribution-breakdown",
        "attendance-leave-summary",
      ].includes(data.reportType)
    )
      await allow(context, data.propertyId, HRM_PERMISSIONS.payrollCalculationDetailsView);
    if (data.reportType === "validation-findings")
      await allow(context, data.propertyId, HRM_PERMISSIONS.payrollValidationsView);
    if (data.reportType === "manual-input-report")
      await allow(context, data.propertyId, HRM_PERMISSIONS.payrollManualInputsView);
    const db = context.supabase as any;
    const run = await db
      .from("payroll_runs")
      .select("calendar_period_id")
      .eq("property_id", data.propertyId)
      .eq("id", data.runId)
      .single();
    if (run.error) throw new Error(run.error.message);

    let query: any;
    if (data.reportType === "calculation-version-comparison") {
      query = db
        .from("payroll_run_versions")
        .select(
          "calculation_version,status,completed_at,employee_count,gross_total,deduction_total,net_total,employer_cost_total,warning_count,error_count",
        )
        .eq("property_id", data.propertyId)
        .eq("payroll_run_id", data.runId)
        .order("calculation_version");
    } else if (data.reportType === "manual-input-report") {
      query = db
        .from("payroll_manual_inputs")
        .select(
          "effective_date,amount,quantity,reason,source_reference,employee:employee_id(employee_number,first_name,last_name),component:pay_component_id(code,name)",
        )
        .eq("property_id", data.propertyId)
        .eq("calendar_period_id", run.data.calendar_period_id)
        .is("archived_at", null)
        .order("effective_date");
    } else if (data.reportType === "validation-findings") {
      query = db
        .from("payroll_calculation_findings")
        .select(
          "severity,finding_code,message,source_type,acknowledged_at,employee:run_employee_id(employee:employee_id(employee_number,first_name,last_name))",
        )
        .eq("property_id", data.propertyId)
        .eq("payroll_run_id", data.runId)
        .eq("calculation_version", data.calculationVersion)
        .order("severity");
    } else if (
      [
        "employee-payroll-detail",
        "earning-breakdown",
        "deduction-breakdown",
        "employer-contribution-breakdown",
      ].includes(data.reportType)
    ) {
      const version = await db
        .from("payroll_run_versions")
        .select("id")
        .eq("property_id", data.propertyId)
        .eq("payroll_run_id", data.runId)
        .eq("calculation_version", data.calculationVersion)
        .single();
      if (version.error) throw new Error(version.error.message);
      query = db
        .from("payroll_run_line_items")
        .select(
          "line_type,line_code,line_name,quantity,rate,rounded_amount,taxable_amount,contribution_basis,source_type,employee:run_employee_id(employee:employee_id(employee_number,first_name,last_name))",
        )
        .eq("property_id", data.propertyId)
        .eq("payroll_run_id", data.runId)
        .eq("run_version_id", version.data.id);
      if (data.reportType === "earning-breakdown")
        query = query.in("line_type", ["base_earning", "earning", "reimbursement"]);
      if (data.reportType === "deduction-breakdown")
        query = query.in("line_type", [
          "pre_tax_deduction",
          "employee_statutory",
          "tax",
          "post_tax_deduction",
        ]);
      if (data.reportType === "employer-contribution-breakdown")
        query = query.eq("line_type", "employer_statutory");
      query = query.order("display_order");
    } else {
      query = db
        .from("payroll_run_employees")
        .select(
          "status,prorated_base_salary,gross_pay,employee_deductions,employer_contributions,net_pay,employer_cost,attendance_input_summary,leave_input_summary,warning_count,error_count,calculated_at,employee:employee_id(employee_number,first_name,last_name)",
        )
        .eq("property_id", data.propertyId)
        .eq("payroll_run_id", data.runId)
        .eq("calculation_version", data.calculationVersion)
        .order("created_at");
    }
    const result = await query.limit(5000);
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], reportType: data.reportType };
  });
