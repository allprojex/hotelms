/* eslint-disable @typescript-eslint/no-explicit-any -- Generate Supabase types after the Phase 3B migration is applied locally. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { captureAuditEvent } from "@/lib/audit.server";
import { assertServerPermission } from "@/lib/permissions.server";
import { pageRange } from "@/lib/query-state";
import { HRM_ADMIN_ROLES, HRM_PERMISSIONS } from "@/lib/hrm/permissions";

type Context = { userId: string; supabase: any };
type ListInput = {
  propertyId: string;
  search?: string;
  employeeId?: string;
  departmentId?: string;
  designationId?: string;
  status?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};

function uuid(value: string, label = "identifier"): string {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) throw new Error(`Valid ${label} required`);
  return value;
}
function input(data: ListInput) {
  uuid(data.propertyId, "property");
  return {
    ...data,
    search:
      data.search
        ?.trim()
        .replace(/[%_(),.*]/g, " ")
        .slice(0, 120) ?? "",
    page: Math.max(1, Math.trunc(data.page ?? 1)),
    pageSize: [10, 25, 50, 100].includes(data.pageSize ?? 25) ? data.pageSize! : 25,
  };
}
async function authorize(context: Context, propertyId: string, permission: any) {
  await assertServerPermission(context, {
    propertyId,
    ...permission,
    defaultRoles: HRM_ADMIN_ROLES,
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
    sourceModule: "attendance",
  });
}

export const getTimeClockState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string }) => ({
    propertyId: uuid(data.propertyId, "property"),
  }))
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.ownTimeClockUse);
    const db = context.supabase as any;
    const employeeResult = await db
      .from("hr_employees")
      .select("id,employee_number,first_name,last_name,department_id")
      .eq("property_id", data.propertyId)
      .eq("staff_user_id", context.userId)
      .in("employment_status", ["active", "probation"])
      .is("archived_at", null);
    if (employeeResult.error) throw new Error(employeeResult.error.message);
    if (employeeResult.data?.length !== 1) {
      throw new Error("Your account must be linked to exactly one active employee");
    }
    const employee = employeeResult.data[0];
    const settings = await db
      .from("hr_workforce_settings")
      .select("timezone")
      .eq("property_id", data.propertyId)
      .single();
    if (settings.error) throw new Error(settings.error.message);
    const events = await db
      .from("hr_attendance_events")
      .select("id,event_type,event_at,business_date,source,roster_id")
      .eq("property_id", data.propertyId)
      .eq("employee_id", employee.id)
      .is("invalidated_at", null)
      .order("event_at", { ascending: false })
      .limit(12);
    if (events.error) throw new Error(events.error.message);
    const latest = events.data?.[0] ?? null;
    const roster = await db
      .from("hr_duty_roster")
      .select("id,duty_date,starts_at,ends_at,shift:shift_id(name,start_time,end_time)")
      .eq("property_id", data.propertyId)
      .eq("employee_id", employee.id)
      .is("archived_at", null)
      .gte("ends_at", new Date(Date.now() - 6 * 3600_000).toISOString())
      .lte("starts_at", new Date(Date.now() + 30 * 3600_000).toISOString())
      .order("starts_at")
      .limit(1)
      .maybeSingle();
    if (roster.error) throw new Error(roster.error.message);
    return {
      employee,
      timezone: settings.data.timezone,
      recentEvents: events.data ?? [],
      currentRoster: roster.data,
      currentStatus: latest?.event_type?.replace(/^manual_/, "") ?? "not_clocked_in",
      openSince: latest?.event_at ?? null,
    };
  });

export const recordTimeClockEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; eventType: string; requestId: string }) => {
    uuid(data.propertyId, "property");
    uuid(data.requestId, "request");
    if (!["clock_in", "clock_out", "break_start", "break_end"].includes(data.eventType)) {
      throw new Error("Unsupported time-clock event");
    }
    return data;
  })
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.ownTimeClockUse);
    const result = await (context.supabase as any).rpc("record_hr_time_clock_event", {
      _property_id: data.propertyId,
      _event_type: data.eventType,
      _request_id: data.requestId,
      _session_metadata: { channel: "web" },
    });
    if (result.error) throw new Error(result.error.message);
    return result.data;
  });

export const listAttendance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(input)
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.attendanceView);
    const db = context.supabase as any;
    let employeeIds: string[] | null = null;
    if (data.search || data.departmentId || data.designationId) {
      let employees = db.from("hr_employees").select("id").eq("property_id", data.propertyId);
      if (data.departmentId) employees = employees.eq("department_id", data.departmentId);
      if (data.designationId) employees = employees.eq("designation_id", data.designationId);
      if (data.search) {
        employees = employees.or(
          `employee_number.ilike.%${data.search}%,first_name.ilike.%${data.search}%,last_name.ilike.%${data.search}%`,
        );
      }
      const found = await employees;
      if (found.error) throw new Error(found.error.message);
      const ids = (found.data ?? []).map((row: { id: string }) => row.id);
      if (!ids.length) return { rows: [], total: 0 };
      employeeIds = ids;
    }
    const range = pageRange(data.page, data.pageSize);
    let query = db
      .from("hr_attendance_summaries")
      .select(
        "*,employee:employee_id(id,employee_number,first_name,last_name,department:department_id(name),designation:designation_id(name:title)),roster:roster_id(id,shift:shift_id(name))",
        { count: "exact" },
      )
      .eq("property_id", data.propertyId)
      .order("business_date", { ascending: false })
      .range(range.from, range.to);
    if (employeeIds) query = query.in("employee_id", employeeIds);
    if (data.employeeId) query = query.eq("employee_id", data.employeeId);
    if (data.status) query = query.eq("attendance_status", data.status);
    if (data.from) query = query.gte("business_date", data.from);
    if (data.to) query = query.lte("business_date", data.to);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const getAttendanceOptions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string }) => ({
    propertyId: uuid(data.propertyId, "property"),
  }))
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.attendanceView);
    const db = context.supabase as any;
    const [departments, designations, employees] = await Promise.all([
      db
        .from("hr_departments")
        .select("id,name")
        .eq("property_id", data.propertyId)
        .is("archived_at", null)
        .order("name"),
      db
        .from("hr_designations")
        .select("id,name")
        .eq("property_id", data.propertyId)
        .is("archived_at", null)
        .order("name"),
      db
        .from("hr_employees")
        .select("id,employee_number,first_name,last_name")
        .eq("property_id", data.propertyId)
        .is("archived_at", null)
        .order("first_name"),
    ]);
    for (const result of [departments, designations, employees]) {
      if (result.error) throw new Error(result.error.message);
    }
    return {
      departments: departments.data ?? [],
      designations: designations.data ?? [],
      employees: employees.data ?? [],
    };
  });

export const getAttendanceDetails = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; summaryId: string }) => {
    uuid(data.propertyId, "property");
    uuid(data.summaryId, "summary");
    return data;
  })
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.attendanceEventsView);
    const db = context.supabase as any;
    const summary = await db
      .from("hr_attendance_summaries")
      .select("*")
      .eq("property_id", data.propertyId)
      .eq("id", data.summaryId)
      .single();
    if (summary.error) throw new Error(summary.error.message);
    const [events, calculations, adjustments] = await Promise.all([
      db
        .from("hr_attendance_events")
        .select("*")
        .eq("property_id", data.propertyId)
        .eq("employee_id", summary.data.employee_id)
        .eq("business_date", summary.data.business_date)
        .order("event_at"),
      db
        .from("hr_attendance_calculation_runs")
        .select("*")
        .eq("property_id", data.propertyId)
        .eq("summary_id", data.summaryId)
        .order("created_at", { ascending: false }),
      db
        .from("hr_attendance_adjustments")
        .select("*")
        .eq("property_id", data.propertyId)
        .eq("summary_id", data.summaryId)
        .order("created_at", { ascending: false }),
    ]);
    for (const result of [events, calculations, adjustments]) {
      if (result.error) throw new Error(result.error.message);
    }
    return {
      summary: summary.data,
      events: events.data ?? [],
      calculations: calculations.data ?? [],
      adjustments: adjustments.data ?? [],
    };
  });

export const createAttendanceAdjustment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      propertyId: string;
      employeeId: string;
      businessDate: string;
      summaryId?: string;
      adjustmentType: string;
      reason: string;
      proposedValues: Record<string, unknown>;
      previousValues?: Record<string, unknown>;
    }) => {
      uuid(data.propertyId, "property");
      uuid(data.employeeId, "employee");
      if (data.reason.trim().length < 5) throw new Error("Adjustment reason is required");
      return { ...data, reason: data.reason.trim().slice(0, 1000) };
    },
  )
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.attendanceAdjustmentCreate);
    const db = context.supabase as any;
    const result = await db
      .from("hr_attendance_adjustments")
      .insert({
        property_id: data.propertyId,
        employee_id: data.employeeId,
        business_date: data.businessDate,
        summary_id: data.summaryId ?? null,
        adjustment_type: data.adjustmentType,
        reason: data.reason,
        previous_values: data.previousValues ?? {},
        proposed_values: data.proposedValues,
        submitted_by: context.userId,
      })
      .select("*")
      .single();
    if (result.error) throw new Error(result.error.message);
    const settings = await db
      .from("hr_workforce_settings")
      .select("attendance_approval_required")
      .eq("property_id", data.propertyId)
      .single();
    if (settings.error) throw new Error(settings.error.message);
    let saved = result.data;
    if (!settings.data.attendance_approval_required) {
      const applied = await db.rpc("review_hr_attendance_adjustment", {
        _property_id: data.propertyId,
        _adjustment_id: result.data.id,
        _decision: "approved",
        _review_notes: "Approval not required by workforce settings",
      });
      if (applied.error) throw new Error(applied.error.message);
      saved = applied.data;
    }
    await audit(
      context,
      data.propertyId,
      "create",
      "hr_attendance_adjustment",
      result.data.id,
      null,
      {
        adjustmentType: data.adjustmentType,
        employeeId: data.employeeId,
        businessDate: data.businessDate,
        reason: data.reason,
      },
    );
    return saved;
  });

export const reviewAttendanceAdjustment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { propertyId: string; adjustmentId: string; decision: string; notes?: string }) => {
      uuid(data.propertyId, "property");
      uuid(data.adjustmentId, "adjustment");
      if (!["approved", "rejected", "returned"].includes(data.decision)) {
        throw new Error("Invalid adjustment decision");
      }
      return data;
    },
  )
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.attendanceAdjustmentApprove);
    const db = context.supabase as any;
    const before = await db
      .from("hr_attendance_adjustments")
      .select("*")
      .eq("property_id", data.propertyId)
      .eq("id", data.adjustmentId)
      .single();
    if (before.error) throw new Error(before.error.message);
    const result = await db.rpc("review_hr_attendance_adjustment", {
      _property_id: data.propertyId,
      _adjustment_id: data.adjustmentId,
      _decision: data.decision,
      _review_notes: data.notes?.trim() || null,
    });
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      data.decision === "approved" ? "approve" : "update",
      "hr_attendance_adjustment",
      data.adjustmentId,
      before.data,
      { decision: data.decision, notes: data.notes?.trim() || null },
    );
    return result.data;
  });

export const setAttendanceApproval = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      propertyId: string;
      summaryId: string;
      decision: "approved" | "rejected" | "returned";
      notes?: string;
    }) => data,
  )
  .handler(async ({ data, context }) => {
    uuid(data.propertyId, "property");
    uuid(data.summaryId, "summary");
    await authorize(context, data.propertyId, HRM_PERMISSIONS.attendanceApprove);
    const db = context.supabase as any;
    const before = await db
      .from("hr_attendance_summaries")
      .select("*")
      .eq("property_id", data.propertyId)
      .eq("id", data.summaryId)
      .single();
    if (before.error) throw new Error(before.error.message);
    const result = await db
      .from("hr_attendance_summaries")
      .update({
        approval_status: data.decision,
        approved_by: data.decision === "approved" ? context.userId : null,
        approved_at: data.decision === "approved" ? new Date().toISOString() : null,
        notes: data.notes?.trim() || before.data.notes,
      })
      .eq("property_id", data.propertyId)
      .eq("id", data.summaryId)
      .select("*")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      "approve",
      "hr_attendance_summary",
      data.summaryId,
      before.data,
      {
        approvalStatus: data.decision,
        notes: data.notes?.trim() || null,
      },
    );
    return result.data;
  });

export const getAttendanceExportData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: ListInput & { format: "csv" | "xlsx" | "pdf" | "print" }) => ({
    ...input(data),
    format: data.format,
  }))
  .handler(async ({ data, context }) => {
    await authorize(
      context,
      data.propertyId,
      data.format === "print" ? HRM_PERMISSIONS.attendancePrint : HRM_PERMISSIONS.attendanceExport,
    );
    const db = context.supabase as any;
    let employeeIds: string[] | null = null;
    if (data.search || data.departmentId || data.designationId || data.employeeId) {
      let employees = db.from("hr_employees").select("id").eq("property_id", data.propertyId);
      if (data.employeeId) employees = employees.eq("id", data.employeeId);
      if (data.departmentId) employees = employees.eq("department_id", data.departmentId);
      if (data.designationId) employees = employees.eq("designation_id", data.designationId);
      if (data.search) {
        employees = employees.or(
          `employee_number.ilike.%${data.search}%,first_name.ilike.%${data.search}%,last_name.ilike.%${data.search}%`,
        );
      }
      const found = await employees;
      if (found.error) throw new Error(found.error.message);
      employeeIds = (found.data ?? []).map((row: { id: string }) => row.id);
    }
    let query = db
      .from("hr_attendance_summaries")
      .select(
        "business_date,attendance_status,worked_minutes,break_minutes,late_minutes,early_departure_minutes,overtime_minutes,approval_status,employee:employee_id(employee_number,first_name,last_name)",
      )
      .eq("property_id", data.propertyId)
      .order("business_date", { ascending: false })
      .limit(10_000);
    if (employeeIds) {
      if (!employeeIds.length) {
        await audit(
          context,
          data.propertyId,
          "export",
          "attendance_report",
          data.propertyId,
          null,
          {
            format: data.format,
            from: data.from || null,
            to: data.to || null,
            rowCount: 0,
          },
        );
        return { rows: [], timezone: "Africa/Accra" };
      }
      query = query.in("employee_id", employeeIds);
    }
    if (data.from) query = query.gte("business_date", data.from);
    if (data.to) query = query.lte("business_date", data.to);
    if (data.status) query = query.eq("attendance_status", data.status);
    const [result, settings] = await Promise.all([
      query,
      db
        .from("hr_workforce_settings")
        .select("timezone")
        .eq("property_id", data.propertyId)
        .single(),
    ]);
    if (result.error) throw new Error(result.error.message);
    if (settings.error) throw new Error(settings.error.message);
    await audit(context, data.propertyId, "export", "attendance_report", data.propertyId, null, {
      format: data.format,
      from: data.from || null,
      to: data.to || null,
      rowCount: result.data?.length ?? 0,
    });
    return { rows: result.data ?? [], timezone: settings.data.timezone };
  });
