/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 4A tables await generated database types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { captureAuditEvent } from "@/lib/audit.server";
import { assertServerPermission } from "@/lib/permissions.server";
import { pageRange } from "@/lib/query-state";
import { HRM_PERMISSIONS } from "@/lib/hrm/permissions";
import {
  generatePayPeriods,
  maskPaymentValue,
  validateBaseSalary,
  validateGradeBand,
  validateOpeningBalance,
  validatePayComponent,
  validatePayrollSettings,
  validateStructuredRuleParameters,
} from "@/lib/hrm/payroll-domain";
import { decryptPayrollValue, encryptPayrollValue } from "@/lib/hrm/payroll-crypto.server";

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
  await assertServerPermission(context, {
    propertyId,
    ...permission,
  });
}
async function audit(
  context: Context,
  propertyId: string,
  action: string,
  resourceType: string,
  resourceId: string,
  oldValues: unknown,
  newValues: unknown,
) {
  await captureAuditEvent(context, {
    propertyId,
    action,
    resourceType,
    resourceId,
    oldValues,
    newValues,
    sourceModule: "payroll_configuration",
  });
}
function listInput(data: any) {
  uuid(data.propertyId);
  return {
    ...data,
    search: String(data.search ?? "")
      .replace(/[%_(),.*]/g, " ")
      .trim()
      .slice(0, 100),
    page: Math.max(1, Number(data.page) || 1),
    pageSize: [10, 25, 50, 100].includes(Number(data.pageSize)) ? Number(data.pageSize) : 25,
  };
}
const resourceConfig = {
  frequencies: {
    table: "payroll_pay_frequencies",
    permission: HRM_PERMISSIONS.payCalendarsView,
    order: "name",
    search: "name,code",
  },
  periods: {
    table: "payroll_calendar_periods",
    permission: HRM_PERMISSIONS.payCalendarsView,
    order: "start_date",
    search: "period_label",
  },
  structures: {
    table: "payroll_salary_structures",
    permission: HRM_PERMISSIONS.salaryStructuresView,
    order: "effective_from",
    search: "name,code",
  },
  grades: {
    table: "payroll_salary_grades",
    permission: HRM_PERMISSIONS.salaryStructuresView,
    order: "rank_order",
    search: "name,code",
  },
  components: {
    table: "payroll_pay_components",
    permission: HRM_PERMISSIONS.payComponentsView,
    order: "display_order",
    search: "name,code",
  },
  structureComponents: {
    table: "payroll_structure_components",
    permission: HRM_PERMISSIONS.salaryStructuresView,
    order: "display_order",
    search: "",
  },
  compensations: {
    table: "payroll_employee_compensations",
    permission: HRM_PERMISSIONS.sensitiveCompensationView,
    order: "effective_from",
    search: "",
  },
  employeeComponents: {
    table: "payroll_employee_components",
    permission: HRM_PERMISSIONS.sensitiveCompensationView,
    order: "start_date",
    search: "",
  },
  statutoryRules: {
    table: "payroll_statutory_rule_sets",
    permission: HRM_PERMISSIONS.statutoryRulesView,
    order: "effective_from",
    search: "name,jurisdiction_code,rule_category",
  },
  openingBalances: {
    table: "payroll_opening_balances",
    permission: HRM_PERMISSIONS.openingBalancesView,
    order: "as_of_date",
    search: "category,source_reference",
  },
} as const;

export const getPayrollBootstrap = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string }) => ({ propertyId: uuid(data.propertyId) }))
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.payrollOverviewView);
    const db = context.supabase as any;
    const [
      property,
      settings,
      frequencies,
      structures,
      grades,
      components,
      employees,
      departments,
    ] = await Promise.all([
      db
        .from("properties")
        .select("id,name,base_currency,timezone")
        .eq("id", data.propertyId)
        .single(),
      db
        .from("payroll_settings")
        .select("*")
        .eq("property_id", data.propertyId)
        .order("effective_from", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .from("payroll_pay_frequencies")
        .select("id,name,code,periods_per_year")
        .eq("property_id", data.propertyId)
        .is("archived_at", null)
        .order("name"),
      db
        .from("payroll_salary_structures")
        .select("id,name,code,currency,pay_frequency_id")
        .eq("property_id", data.propertyId)
        .is("archived_at", null)
        .order("name"),
      db
        .from("payroll_salary_grades")
        .select(
          "id,name,code,salary_structure_id,minimum_base_salary,midpoint_salary,maximum_base_salary",
        )
        .eq("property_id", data.propertyId)
        .is("archived_at", null)
        .order("rank_order"),
      db
        .from("payroll_pay_components")
        .select("id,name,code,calculation_method")
        .eq("property_id", data.propertyId)
        .is("archived_at", null)
        .order("display_order"),
      db
        .from("hr_employees")
        .select("id,employee_number,first_name,last_name,department_id")
        .eq("property_id", data.propertyId)
        .is("archived_at", null)
        .order("first_name"),
      db
        .from("hr_departments")
        .select("id,name")
        .eq("property_id", data.propertyId)
        .is("archived_at", null)
        .order("name"),
    ]);
    for (const result of [
      property,
      settings,
      frequencies,
      structures,
      grades,
      components,
      employees,
      departments,
    ])
      if (result.error) throw new Error(result.error.message);
    return {
      property: property.data,
      settings: settings.data,
      frequencies: frequencies.data ?? [],
      structures: structures.data ?? [],
      grades: grades.data ?? [],
      components: components.data ?? [],
      employees: employees.data ?? [],
      departments: departments.data ?? [],
      capabilities: {
        payrollProcessingAvailable: false,
        payrollRunsAvailable: false,
        statutoryCalculationsAvailable: false,
      },
    };
  });

export const listPayrollResource = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => {
    const normalized = listInput(data);
    if (!(normalized.resource in resourceConfig)) throw new Error("Unsupported payroll resource");
    return normalized;
  })
  .handler(async ({ data, context }) => {
    const config = resourceConfig[data.resource as keyof typeof resourceConfig];
    await allow(context, data.propertyId, config.permission);
    const range = pageRange(data.page, data.pageSize);
    let query = (context.supabase as any)
      .from(config.table)
      .select("*", { count: "exact" })
      .eq("property_id", data.propertyId)
      .order(config.order, { ascending: data.resource !== "compensations" })
      .range(range.from, range.to);
    if (data.search && config.search) {
      query = query.or(
        config.search
          .split(",")
          .map((column) => `${column}.ilike.%${data.search}%`)
          .join(","),
      );
    }
    const archiveResources = ["frequencies", "structures", "grades", "components"];
    if (data.status === "archived" && archiveResources.includes(data.resource))
      query = query.not("archived_at", "is", null);
    else if (archiveResources.includes(data.resource)) query = query.is("archived_at", null);
    if (data.parentId) {
      const parentColumn =
        data.resource === "grades"
          ? "salary_structure_id"
          : data.resource === "periods"
            ? "pay_frequency_id"
            : data.resource === "employeeComponents"
              ? "compensation_id"
              : data.resource === "structureComponents"
                ? "salary_structure_id"
                : "employee_id";
      query = query.eq(parentColumn, data.parentId);
    }
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    if (data.resource === "compensations") {
      await audit(
        context,
        data.propertyId,
        "view",
        "employee_compensation_sensitive",
        "list",
        null,
        {
          page: data.page,
          rowCount: result.data?.length ?? 0,
          searchUsed: Boolean(data.search),
        },
      );
    }
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const savePayrollSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => data)
  .handler(async ({ data, context }) => {
    uuid(data.propertyId);
    await allow(context, data.propertyId, HRM_PERMISSIONS.payrollSettingsManage);
    const db = context.supabase as any;
    const property = await db
      .from("properties")
      .select("base_currency,timezone")
      .eq("id", data.propertyId)
      .single();
    if (property.error) throw new Error(property.error.message);
    validatePayrollSettings({
      currency: data.currency,
      propertyCurrency: property.data.base_currency,
      timezone: data.timezone,
      monetaryPrecision: Number(data.monetaryPrecision),
      payrollEnabled: Boolean(data.payrollEnabled),
      approvalRequired: Boolean(data.approvalRequired),
      finalizationRequiresApproval: Boolean(data.finalizationRequiresApproval),
      payrollYearStartMonth: Number(data.payrollYearStartMonth),
    });
    const payload = {
      property_id: data.propertyId,
      effective_from: iso(data.effectiveFrom),
      effective_to: data.effectiveTo ? iso(data.effectiveTo) : null,
      payroll_enabled: Boolean(data.payrollEnabled),
      display_name: data.displayName.trim(),
      currency: data.currency,
      jurisdiction_code: data.jurisdictionCode.trim().toUpperCase(),
      default_pay_frequency_id: data.defaultPayFrequencyId || null,
      timezone: data.timezone,
      rounding_method: data.roundingMethod,
      monetary_precision: Number(data.monetaryPrecision),
      default_payment_method: data.defaultPaymentMethod,
      salary_proration_method: data.salaryProrationMethod,
      unpaid_day_method: data.unpaidDayMethod,
      working_days_basis: Number(data.workingDaysBasis),
      calendar_days_basis: Number(data.calendarDaysBasis),
      approval_required: Boolean(data.approvalRequired),
      finalization_requires_approval: Boolean(data.finalizationRequiresApproval),
      allow_negative_net_pay: Boolean(data.allowNegativeNetPay),
      allow_retroactive_adjustments: Boolean(data.allowRetroactiveAdjustments),
      require_employee_bank_details: Boolean(data.requireEmployeeBankDetails),
      payslip_visibility_placeholder: data.payslipVisibilityPlaceholder,
      payroll_year_start_month: Number(data.payrollYearStartMonth),
      created_by: context.userId,
      updated_by: context.userId,
    };
    const result = await db.from("payroll_settings").insert(payload).select("*").single();
    if (result.error) throw new Error(result.error.message);
    await audit(context, data.propertyId, "create", "payroll_settings", result.data.id, null, {
      ...payload,
      created_by: undefined,
      updated_by: undefined,
    });
    return result.data;
  });

export const savePayFrequency = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => data)
  .handler(async ({ data, context }) => {
    uuid(data.propertyId);
    await allow(context, data.propertyId, HRM_PERMISSIONS.payCalendarsManage);
    const db = context.supabase as any;
    const before = data.id
      ? await db
          .from("payroll_pay_frequencies")
          .select("*")
          .eq("property_id", data.propertyId)
          .eq("id", data.id)
          .single()
      : { data: null, error: null };
    if (before.error) throw new Error(before.error.message);
    const payload = {
      property_id: data.propertyId,
      name: data.name.trim(),
      code: data.code.trim().toUpperCase(),
      frequency_type: data.frequencyType.trim(),
      periods_per_year: Number(data.periodsPerYear),
      interval_definition: { intervalDays: Number(data.intervalDays) },
      first_period_start: iso(data.firstPeriodStart),
      cutoff_rule: { offsetDays: Number(data.cutoffOffsetDays ?? 0) },
      payment_day_rule: { offsetDays: Number(data.paymentOffsetDays ?? 0) },
      weekend_adjustment: data.weekendAdjustment,
      holiday_adjustment: data.holidayAdjustment,
      continuous_periods: data.continuousPeriods ?? true,
      active: true,
      created_by: before.data?.created_by ?? context.userId,
      updated_by: context.userId,
    };
    if (payload.periods_per_year < 1 || payload.interval_definition.intervalDays < 1)
      throw new Error("Frequency periods and interval must be positive");
    const result = data.id
      ? await db
          .from("payroll_pay_frequencies")
          .update(payload)
          .eq("property_id", data.propertyId)
          .eq("id", data.id)
          .select("*")
          .single()
      : await db.from("payroll_pay_frequencies").insert(payload).select("*").single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      data.id ? "update" : "create",
      "pay_frequency",
      result.data.id,
      before.data,
      payload,
    );
    return result.data;
  });

export const setPayFrequencyArchived = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; id: string; archived: boolean }) => data)
  .handler(async ({ data, context }) => {
    uuid(data.propertyId);
    uuid(data.id);
    await allow(context, data.propertyId, HRM_PERMISSIONS.payCalendarsManage);
    const db = context.supabase as any;
    if (data.archived) {
      const referenced = await db
        .from("payroll_calendar_periods")
        .select("id", { count: "exact", head: true })
        .eq("property_id", data.propertyId)
        .eq("pay_frequency_id", data.id)
        .neq("status", "archived");
      if (referenced.error) throw new Error(referenced.error.message);
      if (referenced.count)
        throw new Error("Archive calendar periods before archiving this frequency");
    }
    const result = await db
      .from("payroll_pay_frequencies")
      .update(
        data.archived
          ? { archived_at: new Date().toISOString(), archived_by: context.userId, active: false }
          : { archived_at: null, archived_by: null, active: true },
      )
      .eq("property_id", data.propertyId)
      .eq("id", data.id)
      .select("*")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      data.archived ? "delete" : "update",
      "pay_frequency",
      data.id,
      null,
      {
        archived: data.archived,
      },
    );
    return result.data;
  });

export const previewPayCalendar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => data)
  .handler(async ({ data, context }) => {
    uuid(data.propertyId);
    await allow(context, data.propertyId, HRM_PERMISSIONS.payCalendarsView);
    const db = context.supabase as any;
    const frequency = await db
      .from("payroll_pay_frequencies")
      .select("*")
      .eq("property_id", data.propertyId)
      .eq("id", data.frequencyId)
      .single();
    if (frequency.error) throw new Error(frequency.error.message);
    const holidays = await db
      .from("hr_holidays")
      .select("holiday_date")
      .eq("property_id", data.propertyId)
      .eq("active", true)
      .is("archived_at", null);
    if (holidays.error) throw new Error(holidays.error.message);
    return generatePayPeriods({
      firstPeriodStart: frequency.data.first_period_start,
      payrollYear: Number(data.payrollYear),
      periodsPerYear: frequency.data.periods_per_year,
      intervalDays: Number(frequency.data.interval_definition?.intervalDays),
      cutoffOffsetDays: Number(frequency.data.cutoff_rule?.offsetDays ?? 0),
      paymentOffsetDays: Number(frequency.data.payment_day_rule?.offsetDays ?? 0),
      weekendRule: frequency.data.weekend_adjustment,
      holidayRule: frequency.data.holiday_adjustment,
      holidays: (holidays.data ?? []).map((row: any) => row.holiday_date),
    });
  });

export const generatePlannedPayCalendar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => data)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.payCalendarsManage);
    const db = context.supabase as any;
    const periods = await previewCalendarInternal(context, data);
    const insert = await db
      .from("payroll_calendar_periods")
      .insert(
        periods.map((period) => ({
          property_id: data.propertyId,
          pay_frequency_id: data.frequencyId,
          payroll_year: period.payrollYear,
          period_number: period.periodNumber,
          period_label: period.periodLabel,
          start_date: period.startDate,
          end_date: period.endDate,
          cutoff_date: period.cutoffDate,
          expected_payment_date: period.expectedPaymentDate,
          status: "planned",
          created_by: context.userId,
        })),
      )
      .select("id");
    if (insert.error) throw new Error(insert.error.message);
    await audit(context, data.propertyId, "create", "payroll_calendar", data.frequencyId, null, {
      payrollYear: data.payrollYear,
      generatedPeriods: insert.data?.length ?? 0,
    });
    return { created: insert.data?.length ?? 0 };
  });

async function previewCalendarInternal(context: Context, data: any) {
  const db = context.supabase as any;
  const frequency = await db
    .from("payroll_pay_frequencies")
    .select("*")
    .eq("property_id", data.propertyId)
    .eq("id", data.frequencyId)
    .single();
  if (frequency.error) throw new Error(frequency.error.message);
  const holidays = await db
    .from("hr_holidays")
    .select("holiday_date")
    .eq("property_id", data.propertyId)
    .eq("active", true)
    .is("archived_at", null);
  if (holidays.error) throw new Error(holidays.error.message);
  return generatePayPeriods({
    firstPeriodStart: frequency.data.first_period_start,
    payrollYear: Number(data.payrollYear),
    periodsPerYear: frequency.data.periods_per_year,
    intervalDays: Number(frequency.data.interval_definition?.intervalDays),
    cutoffOffsetDays: Number(frequency.data.cutoff_rule?.offsetDays ?? 0),
    paymentOffsetDays: Number(frequency.data.payment_day_rule?.offsetDays ?? 0),
    weekendRule: frequency.data.weekend_adjustment,
    holidayRule: frequency.data.holiday_adjustment,
    holidays: (holidays.data ?? []).map((row: any) => row.holiday_date),
  });
}

export const saveSalaryStructure = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => data)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.salaryStructuresManage);
    const db = context.supabase as any;
    const payload = {
      property_id: data.propertyId,
      name: data.name.trim(),
      code: data.code.trim().toUpperCase(),
      description: data.description?.trim() || null,
      currency: data.currency,
      pay_frequency_id: data.payFrequencyId,
      effective_from: iso(data.effectiveFrom),
      effective_to: data.effectiveTo ? iso(data.effectiveTo) : null,
      active: true,
      created_by: context.userId,
      updated_by: context.userId,
    };
    const result = await db.from("payroll_salary_structures").insert(payload).select("*").single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      "create",
      "salary_structure",
      result.data.id,
      null,
      payload,
    );
    return result.data;
  });

export const saveSalaryGrade = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => data)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.salaryStructuresManage);
    validateGradeBand(
      Number(data.minimum),
      data.midpoint == null ? null : Number(data.midpoint),
      Number(data.maximum),
    );
    const payload = {
      property_id: data.propertyId,
      salary_structure_id: data.salaryStructureId,
      name: data.name.trim(),
      code: data.code.trim().toUpperCase(),
      rank_order: Number(data.rankOrder ?? 0),
      minimum_base_salary: Number(data.minimum),
      midpoint_salary: data.midpoint == null ? null : Number(data.midpoint),
      maximum_base_salary: Number(data.maximum),
      step_progression: data.stepProgression ?? {},
      effective_from: iso(data.effectiveFrom),
      effective_to: data.effectiveTo ? iso(data.effectiveTo) : null,
      active: true,
      created_by: context.userId,
      updated_by: context.userId,
    };
    const result = await (context.supabase as any)
      .from("payroll_salary_grades")
      .insert(payload)
      .select("*")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(context, data.propertyId, "create", "salary_grade", result.data.id, null, payload);
    return result.data;
  });

export const saveStructureComponent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => {
    if (data.defaultAmount != null && data.defaultPercentage != null)
      throw new Error("Choose an amount or percentage override, not both");
    return data;
  })
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.salaryStructuresManage);
    const payload = {
      property_id: data.propertyId,
      salary_structure_id: data.salaryStructureId,
      salary_grade_id: data.gradeId || null,
      pay_component_id: data.payComponentId,
      default_amount_override: data.defaultAmount == null ? null : Number(data.defaultAmount),
      default_percentage_override:
        data.defaultPercentage == null ? null : Number(data.defaultPercentage),
      required: Boolean(data.required),
      effective_from: iso(data.effectiveFrom),
      effective_to: data.effectiveTo ? iso(data.effectiveTo) : null,
      display_order: Number(data.displayOrder ?? 0),
      active: true,
      created_by: context.userId,
      updated_by: context.userId,
    };
    const result = await (context.supabase as any)
      .from("payroll_structure_components")
      .insert(payload)
      .select("*")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      "create",
      "salary_structure_component",
      result.data.id,
      null,
      payload,
    );
    return result.data;
  });

export const savePayComponent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => data)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.payComponentsManage);
    validatePayComponent(data);
    const payload = {
      property_id: data.propertyId,
      name: data.name.trim(),
      code: data.code.trim().toUpperCase(),
      component_type: data.componentType,
      description: data.description?.trim() || null,
      taxable_classification: data.taxableClassification?.trim() || null,
      statutory_classification: data.statutoryClassification?.trim() || null,
      pensionable_classification: data.pensionableClassification?.trim() || null,
      value_type: data.valueType,
      calculation_method: data.calculationMethod,
      default_amount: data.defaultAmount == null ? null : Number(data.defaultAmount),
      default_percentage: data.defaultPercentage == null ? null : Number(data.defaultPercentage),
      percentage_basis_code: data.percentageBasisCode?.trim() || null,
      minimum_amount: data.minimumAmount == null ? null : Number(data.minimumAmount),
      maximum_amount: data.maximumAmount == null ? null : Number(data.maximumAmount),
      currency: data.currency || null,
      recurrence: data.recurrence,
      proration_enabled: Boolean(data.prorationEnabled),
      attendance_sensitive: Boolean(data.attendanceSensitive),
      leave_sensitive: Boolean(data.leaveSensitive),
      overtime_sensitive: Boolean(data.overtimeSensitive),
      display_order: Number(data.displayOrder ?? 0),
      payslip_visible: data.payslipVisible ?? true,
      effective_from: iso(data.effectiveFrom),
      effective_to: data.effectiveTo ? iso(data.effectiveTo) : null,
      active: true,
      created_by: context.userId,
      updated_by: context.userId,
    };
    const result = await (context.supabase as any)
      .from("payroll_pay_components")
      .insert(payload)
      .select("*")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(context, data.propertyId, "create", "pay_component", result.data.id, null, payload);
    return result.data;
  });

export const setPayrollConfigurationArchived = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => {
    const supported = ["structure", "grade", "component"];
    if (!supported.includes(data.resource)) throw new Error("Unsupported archive resource");
    return data;
  })
  .handler(async ({ data, context }) => {
    const mapping = {
      structure: {
        table: "payroll_salary_structures",
        permission: HRM_PERMISSIONS.salaryStructuresManage,
      },
      grade: {
        table: "payroll_salary_grades",
        permission: HRM_PERMISSIONS.salaryStructuresManage,
      },
      component: {
        table: "payroll_pay_components",
        permission: HRM_PERMISSIONS.payComponentsManage,
      },
    } as const;
    const config = mapping[data.resource as keyof typeof mapping];
    await allow(context, data.propertyId, config.permission);
    const result = await (context.supabase as any)
      .from(config.table)
      .update(
        data.archived
          ? { archived_at: new Date().toISOString(), archived_by: context.userId, active: false }
          : { archived_at: null, archived_by: null, active: true },
      )
      .eq("property_id", data.propertyId)
      .eq("id", data.id)
      .select("id")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      data.archived ? "delete" : "update",
      `payroll_${data.resource}`,
      data.id,
      null,
      { archived: Boolean(data.archived) },
    );
    return { ok: true };
  });

export const saveCompensation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => data)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.employeeCompensationManage);
    await allow(context, data.propertyId, HRM_PERMISSIONS.sensitiveCompensationView);
    const db = context.supabase as any;
    const grade = data.gradeId
      ? await db
          .from("payroll_salary_grades")
          .select("minimum_base_salary,maximum_base_salary")
          .eq("property_id", data.propertyId)
          .eq("id", data.gradeId)
          .single()
      : { data: null, error: null };
    if (grade.error) throw new Error(grade.error.message);
    validateBaseSalary(
      Number(data.baseSalary),
      grade.data
        ? {
            minimum: Number(grade.data.minimum_base_salary),
            maximum: Number(grade.data.maximum_base_salary),
          }
        : null,
      Boolean(data.gradeBandOverride),
      data.gradeBandOverrideReason,
    );
    const payload = {
      property_id: data.propertyId,
      employee_id: data.employeeId,
      salary_structure_id: data.salaryStructureId,
      salary_grade_id: data.gradeId || null,
      base_salary: Number(data.baseSalary),
      currency: data.currency,
      pay_frequency_id: data.payFrequencyId,
      effective_from: iso(data.effectiveFrom),
      effective_to: data.effectiveTo ? iso(data.effectiveTo) : null,
      employment_percentage: Number(data.employmentPercentage ?? 100),
      payment_method: data.paymentMethod,
      reason_for_change: data.reason.trim(),
      grade_band_override: Boolean(data.gradeBandOverride),
      grade_band_override_reason: data.gradeBandOverrideReason?.trim() || null,
      approval_status: "draft",
      notes: data.notes?.trim() || null,
      active: true,
      created_by: context.userId,
      updated_by: context.userId,
    };
    const result = await db
      .from("payroll_employee_compensations")
      .insert(payload)
      .select("*")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(context, data.propertyId, "create", "employee_compensation", result.data.id, null, {
      employeeId: data.employeeId,
      salaryStructureId: data.salaryStructureId,
      gradeId: data.gradeId || null,
      effectiveFrom: data.effectiveFrom,
      reason: data.reason.trim(),
      gradeBandOverride: Boolean(data.gradeBandOverride),
    });
    return result.data;
  });

export const saveEmployeeComponent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => data)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.employeeCompensationManage);
    const payload = {
      property_id: data.propertyId,
      compensation_id: data.compensationId,
      pay_component_id: data.payComponentId,
      fixed_amount_override: data.fixedAmount == null ? null : Number(data.fixedAmount),
      percentage_override: data.percentage == null ? null : Number(data.percentage),
      recurrence: data.recurrence,
      start_date: iso(data.startDate),
      end_date: data.endDate ? iso(data.endDate) : null,
      reason: data.reason.trim(),
      active: true,
      created_by: context.userId,
    };
    const result = await (context.supabase as any)
      .from("payroll_employee_components")
      .insert(payload)
      .select("*")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      "create",
      "employee_pay_component",
      result.data.id,
      null,
      {
        compensationId: data.compensationId,
        payComponentId: data.payComponentId,
        startDate: data.startDate,
        reason: data.reason.trim(),
      },
    );
    return result.data;
  });

export const listPaymentDetails = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.paymentDetailsView);
    const range = pageRange(data.page, data.pageSize);
    const result = await (context.supabase as any)
      .from("payroll_payment_details")
      .select(
        "id,property_id,employee_id,payment_method,account_name,bank_name,branch_name,account_number_last4,routing_code_last4,mobile_provider,mobile_number_last4,payment_reference,is_primary,verification_status,effective_from,effective_to,archived_at,employee:employee_id(employee_number,first_name,last_name)",
        { count: "exact" },
      )
      .eq("property_id", data.propertyId)
      .is("archived_at", null)
      .order("effective_from", { ascending: false })
      .range(range.from, range.to);
    if (result.error) throw new Error(result.error.message);
    await audit(context, data.propertyId, "view", "payroll_payment_details_masked", "list", null, {
      page: data.page,
      rowCount: result.data?.length ?? 0,
    });
    return {
      rows: (result.data ?? []).map((row: any) => ({
        ...row,
        maskedAccount: row.account_number_last4
          ? `•••• ${row.account_number_last4}`
          : "Not provided",
        maskedRouting: row.routing_code_last4 ? `•••• ${row.routing_code_last4}` : "Not provided",
        maskedMobile: row.mobile_number_last4 ? `•••• ${row.mobile_number_last4}` : "Not provided",
      })),
      total: result.count ?? 0,
    };
  });

export const savePaymentDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => data)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.paymentDetailsManage);
    const [account, routing, mobile] = await Promise.all([
      data.accountNumber ? encryptPayrollValue(data.accountNumber) : null,
      data.routingCode ? encryptPayrollValue(data.routingCode) : null,
      data.mobileNumber ? encryptPayrollValue(data.mobileNumber) : null,
    ]);
    const payload = {
      property_id: data.propertyId,
      employee_id: data.employeeId,
      payment_method: data.paymentMethod,
      account_name: data.accountName?.trim() || null,
      bank_name: data.bankName?.trim() || null,
      branch_name: data.branchName?.trim() || null,
      account_number_ciphertext: account?.ciphertext ?? null,
      account_number_iv: account?.iv ?? null,
      account_number_last4: account?.last4 ?? null,
      routing_code_ciphertext: routing?.ciphertext ?? null,
      routing_code_iv: routing?.iv ?? null,
      routing_code_last4: routing?.last4 ?? null,
      mobile_provider: data.mobileProvider?.trim() || null,
      mobile_number_ciphertext: mobile?.ciphertext ?? null,
      mobile_number_iv: mobile?.iv ?? null,
      mobile_number_last4: mobile?.last4 ?? null,
      payment_reference: data.paymentReference?.trim() || null,
      is_primary: Boolean(data.isPrimary),
      verification_status: "unverified",
      effective_from: iso(data.effectiveFrom),
      effective_to: data.effectiveTo ? iso(data.effectiveTo) : null,
      created_by: context.userId,
      updated_by: context.userId,
    };
    const result = await (context.supabase as any)
      .from("payroll_payment_details")
      .insert(payload)
      .select("id")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      "create",
      "payroll_payment_detail",
      result.data.id,
      null,
      {
        employeeId: data.employeeId,
        paymentMethod: data.paymentMethod,
        bankName: data.bankName?.trim() || null,
        accountNumber: maskPaymentValue(data.accountNumber),
        routingCode: maskPaymentValue(data.routingCode),
        mobileNumber: maskPaymentValue(data.mobileNumber),
        isPrimary: Boolean(data.isPrimary),
      },
    );
    return { id: result.data.id };
  });

export const revealPaymentDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; id: string; reason: string }) => data)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.fullPaymentDetailsReveal);
    if (data.reason.trim().length < 5) throw new Error("Reveal reason is required");
    const result = await (context.supabase as any)
      .from("payroll_payment_details")
      .select(
        "account_number_ciphertext,account_number_iv,routing_code_ciphertext,routing_code_iv,mobile_number_ciphertext,mobile_number_iv",
      )
      .eq("property_id", data.propertyId)
      .eq("id", data.id)
      .single();
    if (result.error) throw new Error(result.error.message);
    const revealed = {
      accountNumber:
        result.data.account_number_ciphertext && result.data.account_number_iv
          ? await decryptPayrollValue(
              result.data.account_number_ciphertext,
              result.data.account_number_iv,
            )
          : null,
      routingCode:
        result.data.routing_code_ciphertext && result.data.routing_code_iv
          ? await decryptPayrollValue(
              result.data.routing_code_ciphertext,
              result.data.routing_code_iv,
            )
          : null,
      mobileNumber:
        result.data.mobile_number_ciphertext && result.data.mobile_number_iv
          ? await decryptPayrollValue(
              result.data.mobile_number_ciphertext,
              result.data.mobile_number_iv,
            )
          : null,
    };
    await audit(context, data.propertyId, "view", "payroll_payment_detail_reveal", data.id, null, {
      reason: data.reason.trim(),
      fieldsRevealed: Object.entries(revealed)
        .filter(([, value]) => value)
        .map(([key]) => key),
    });
    return revealed;
  });

export const verifyPaymentDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { propertyId: string; id: string; verified: boolean; reason: string }) => data,
  )
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.paymentDetailsVerify);
    if (data.reason.trim().length < 5) throw new Error("Verification reason is required");
    const result = await (context.supabase as any)
      .from("payroll_payment_details")
      .update({
        verification_status: data.verified ? "verified" : "rejected",
        verified_by: context.userId,
        verified_at: new Date().toISOString(),
        updated_by: context.userId,
      })
      .eq("property_id", data.propertyId)
      .eq("id", data.id)
      .select("id")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      "approve",
      "payroll_payment_detail_verification",
      data.id,
      null,
      {
        verified: data.verified,
        reason: data.reason.trim(),
      },
    );
    return { ok: true };
  });

export const saveStatutoryRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => {
    validateStructuredRuleParameters(data.parameters);
    return data;
  })
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.statutoryRulesManage);
    const verified = data.verificationStatus === "verified";
    const payload = {
      property_id: data.propertyId,
      jurisdiction_code: data.jurisdictionCode.trim().toUpperCase(),
      name: data.name.trim(),
      rule_category: data.ruleCategory.trim(),
      effective_from: iso(data.effectiveFrom),
      effective_to: data.effectiveTo ? iso(data.effectiveTo) : null,
      version: data.version.trim(),
      source_reference: data.sourceReference ?? {},
      verification_status: data.verificationStatus,
      reviewed_by: verified ? context.userId : null,
      reviewed_at: verified ? new Date().toISOString() : null,
      parameters: data.parameters,
      calculation_order: Number(data.calculationOrder ?? 0),
      active: true,
      created_by: context.userId,
      updated_by: context.userId,
    };
    const result = await (context.supabase as any)
      .from("payroll_statutory_rule_sets")
      .insert(payload)
      .select("*")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      "create",
      "statutory_rule_configuration",
      result.data.id,
      null,
      {
        jurisdictionCode: payload.jurisdiction_code,
        ruleCategory: payload.rule_category,
        version: payload.version,
        verificationStatus: payload.verification_status,
        effectiveFrom: payload.effective_from,
        sourceReference: payload.source_reference,
      },
    );
    return result.data;
  });

export const stageOpeningBalance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => data)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.openingBalancesImport);
    const db = context.supabase as any;
    const property = await db
      .from("properties")
      .select("base_currency")
      .eq("id", data.propertyId)
      .single();
    if (property.error) throw new Error(property.error.message);
    validateOpeningBalance({
      amount: Number(data.amount),
      currency: data.currency,
      propertyCurrency: property.data.base_currency,
      asOfDate: data.asOfDate,
      sourceSystem: data.sourceSystem,
    });
    let batchId = data.batchId;
    if (!batchId) {
      const batch = await db
        .from("payroll_opening_import_batches")
        .insert({
          property_id: data.propertyId,
          source_system: data.sourceSystem.trim(),
          source_reference: data.sourceReference?.trim() || null,
          as_of_date: iso(data.asOfDate),
          status: "staged",
          evidence_metadata: data.evidenceMetadata ?? {},
          imported_by: context.userId,
        })
        .select("id")
        .single();
      if (batch.error) throw new Error(batch.error.message);
      batchId = batch.data.id;
    }
    const result = await db
      .from("payroll_opening_balances")
      .insert({
        property_id: data.propertyId,
        import_batch_id: batchId,
        employee_id: data.employeeId,
        category: data.category,
        amount: Number(data.amount),
        currency: data.currency,
        as_of_date: iso(data.asOfDate),
        source_reference: data.sourceReference?.trim() || null,
        validation_status: "valid",
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      "create",
      "payroll_opening_balance",
      result.data.id,
      null,
      {
        employeeId: data.employeeId,
        category: data.category,
        amount: Number(data.amount),
        currency: data.currency,
        asOfDate: data.asOfDate,
        sourceSystem: data.sourceSystem.trim(),
        sourceReference: data.sourceReference?.trim() || null,
        importBatchId: batchId,
      },
    );
    return { id: result.data.id, batchId };
  });

export const correctOpeningBalance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => {
    if (!Number.isFinite(Number(data.amount))) throw new Error("Valid correction amount required");
    if (String(data.sourceReference ?? "").trim().length < 2)
      throw new Error("Correction source reference required");
    return data;
  })
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.openingBalancesManage);
    const result = await (context.supabase as any).rpc("payroll_supersede_opening_balance", {
      _property_id: data.propertyId,
      _balance_id: data.id,
      _amount: Number(data.amount),
      _source_reference: data.sourceReference.trim(),
    });
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      "update",
      "payroll_opening_balance_correction",
      result.data,
      { supersededId: data.id },
      {
        amount: Number(data.amount),
        sourceReference: data.sourceReference.trim(),
      },
    );
    return { id: result.data };
  });
