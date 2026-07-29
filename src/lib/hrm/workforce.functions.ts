/* eslint-disable @typescript-eslint/no-explicit-any -- Regenerate Supabase types after applying the additive Phase 3A migration locally. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { captureAuditEvent } from "@/lib/audit.server";
import { assertServerPermission } from "@/lib/permissions.server";
import { pageRange } from "@/lib/query-state";
import { assertPropertyRecord, normalizeHrmCode, validateRequiredText } from "@/lib/hrm/domain";
import { HRM_ADMIN_ROLES, HRM_PERMISSIONS } from "@/lib/hrm/permissions";
import { shiftDuration, validateWorkforceSettings } from "@/lib/hrm/workforce-domain";

type Context = { userId: string; supabase: any };
type ListInput = {
  propertyId: string;
  search?: string;
  status?: string;
  departmentId?: string;
  employeeId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};

function propertyId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) throw new Error("Valid property required");
  return value;
}

function listInput(
  data: ListInput,
): Required<Pick<ListInput, "propertyId" | "page" | "pageSize">> & ListInput {
  propertyId(data.propertyId);
  return {
    ...data,
    search: data.search?.trim().slice(0, 200) ?? "",
    page: Math.max(1, Math.trunc(data.page ?? 1)),
    pageSize: [10, 25, 50, 100].includes(data.pageSize ?? 25) ? data.pageSize! : 25,
  };
}

function searchTerm(value: string): string {
  return value
    .replace(/[%_(),.*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function authorize(
  context: Context,
  targetPropertyId: string,
  permission: { module: string; capability: any },
) {
  await assertServerPermission(context, {
    propertyId: targetPropertyId,
    ...permission,
    defaultRoles: HRM_ADMIN_ROLES,
  });
}

async function audit(
  context: Context,
  targetPropertyId: string,
  action: string,
  type: string,
  id: string,
  before: unknown,
  after: unknown,
) {
  await captureAuditEvent(context, {
    propertyId: targetPropertyId,
    action,
    resourceType: type,
    resourceId: id,
    oldValues: before,
    newValues: after,
    sourceModule: "workforce_scheduling",
  });
}

async function persistRosterAssignment(
  context: Context,
  data: {
    propertyId: string;
    id?: string;
    employeeId: string;
    shiftId: string;
    dutyDate: string;
    departmentId?: string | null;
    workLocation?: string | null;
    notes?: string | null;
    leaveOverrideReason?: string | null;
  },
) {
  const db = context.supabase as any;
  const current = data.id
    ? await db.from("hr_duty_roster").select("*").eq("id", data.id).maybeSingle()
    : { data: null, error: null };
  if (current.error) throw new Error(current.error.message);
  if (data.id) assertPropertyRecord(current.data, data.propertyId);
  const payload = {
    property_id: data.propertyId,
    employee_id: data.employeeId,
    shift_id: data.shiftId,
    duty_date: data.dutyDate,
    department_id: data.departmentId || null,
    work_location: data.workLocation?.trim() || null,
    notes: data.notes?.trim() || null,
    leave_override_reason: data.leaveOverrideReason?.trim() || null,
    created_by: current.data?.created_by ?? context.userId,
    updated_by: context.userId,
    starts_at: new Date().toISOString(),
    ends_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const result = data.id
    ? await db.from("hr_duty_roster").update(payload).eq("id", data.id).select("*").single()
    : await db.from("hr_duty_roster").insert(payload).select("*").single();
  if (result.error) {
    if (result.error.code === "23P01") throw new Error("Roster conflict: employee shifts overlap");
    throw new Error(result.error.message);
  }
  await audit(
    context,
    data.propertyId,
    data.id ? "update" : "create",
    "hr_duty_roster",
    result.data.id,
    current.data,
    result.data,
  );
  return result.data;
}

export const getWorkforceSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string }) => ({ propertyId: propertyId(data.propertyId) }))
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.workforceSettingsView);
    const db = context.supabase as any;
    const result = await db
      .from("hr_workforce_settings")
      .select("*")
      .eq("property_id", data.propertyId)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (result.data) return result.data;
    const fallback = await db
      .from("properties")
      .select("timezone")
      .eq("id", data.propertyId)
      .single();
    if (fallback.error) throw new Error(fallback.error.message);
    return {
      property_id: data.propertyId,
      timezone: fallback.data.timezone || "Africa/Accra",
      default_working_days: [1, 2, 3, 4, 5],
      standard_start_time: "08:00",
      standard_end_time: "17:00",
      grace_period_minutes: 10,
      late_threshold_minutes: 15,
      early_departure_threshold_minutes: 15,
      minimum_full_day_minutes: 480,
      minimum_half_day_minutes: 240,
      maximum_open_shift_minutes: 960,
      allow_overnight_shifts: true,
      weekend_treatment: "normal",
      holiday_treatment: "non_working",
      rounding_rule: "none",
      rounding_interval_minutes: 15,
      attendance_approval_required: true,
      manual_adjustment_enabled: false,
      biometric_attendance_enabled: false,
      biometric_integration_mode: "disabled",
      maximum_consecutive_workdays: 6,
    };
  });

export const saveWorkforceSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      propertyId: string;
      timezone: string;
      defaultWorkingDays: number[];
      standardStartTime: string;
      standardEndTime: string;
      gracePeriodMinutes: number;
      lateThresholdMinutes: number;
      earlyDepartureThresholdMinutes: number;
      minimumFullDayMinutes: number;
      minimumHalfDayMinutes: number;
      maximumOpenShiftMinutes: number;
      allowOvernightShifts: boolean;
      weekendTreatment: string;
      holidayTreatment: string;
      roundingRule: string;
      roundingIntervalMinutes: number;
      attendanceApprovalRequired: boolean;
      manualAdjustmentEnabled: boolean;
      biometricAttendanceEnabled: boolean;
      biometricIntegrationMode: string;
      maximumConsecutiveWorkdays: number;
    }) => {
      propertyId(data.propertyId);
      validateWorkforceSettings(data);
      return data;
    },
  )
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.workforceSettingsManage);
    const db = context.supabase as any;
    const current = await db
      .from("hr_workforce_settings")
      .select("*")
      .eq("property_id", data.propertyId)
      .maybeSingle();
    if (current.error) throw new Error(current.error.message);
    const payload = {
      property_id: data.propertyId,
      timezone: data.timezone,
      default_working_days: [...new Set(data.defaultWorkingDays)].sort(),
      standard_start_time: data.standardStartTime,
      standard_end_time: data.standardEndTime,
      grace_period_minutes: data.gracePeriodMinutes,
      late_threshold_minutes: data.lateThresholdMinutes,
      early_departure_threshold_minutes: data.earlyDepartureThresholdMinutes,
      minimum_full_day_minutes: data.minimumFullDayMinutes,
      minimum_half_day_minutes: data.minimumHalfDayMinutes,
      maximum_open_shift_minutes: data.maximumOpenShiftMinutes,
      allow_overnight_shifts: data.allowOvernightShifts,
      weekend_treatment: data.weekendTreatment,
      holiday_treatment: data.holidayTreatment,
      rounding_rule: data.roundingRule,
      rounding_interval_minutes: data.roundingIntervalMinutes,
      attendance_approval_required: data.attendanceApprovalRequired,
      manual_adjustment_enabled: data.manualAdjustmentEnabled,
      biometric_attendance_enabled: data.biometricAttendanceEnabled,
      biometric_integration_mode: data.biometricIntegrationMode,
      maximum_consecutive_workdays: data.maximumConsecutiveWorkdays,
      updated_by: context.userId,
    };
    const result = await db
      .from("hr_workforce_settings")
      .upsert(payload, { onConflict: "property_id" })
      .select("*")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      "update",
      "hr_workforce_settings",
      data.propertyId,
      current.data,
      result.data,
    );
    return result.data;
  });

export const listShiftTemplates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.shiftView);
    const db = context.supabase as any;
    const range = pageRange(data.page, data.pageSize);
    let query = db
      .from("hr_shift_templates")
      .select("*", { count: "exact" })
      .eq("property_id", data.propertyId)
      .order("name")
      .range(range.from, range.to);
    if (data.search) {
      const term = searchTerm(data.search);
      if (term) query = query.or(`name.ilike.%${term}%,code.ilike.%${term}%`);
    }
    if (data.status === "archived") query = query.not("archived_at", "is", null);
    else if (data.status === "inactive") query = query.eq("active", false).is("archived_at", null);
    else query = query.is("archived_at", null);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const saveShiftTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      propertyId: string;
      id?: string;
      name: string;
      code: string;
      description?: string;
      startTime: string;
      endTime: string;
      breakMinutes: number;
      gracePeriodMinutes: number;
      colour?: string;
      active: boolean;
    }) => {
      propertyId(data.propertyId);
      const duration = shiftDuration(data);
      return {
        ...data,
        name: validateRequiredText(data.name, "Shift name", 120),
        code: normalizeHrmCode(validateRequiredText(data.code, "Shift code", 40)),
        duration,
      };
    },
  )
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.shiftManage);
    const db = context.supabase as any;
    const current = data.id
      ? await db.from("hr_shift_templates").select("*").eq("id", data.id).maybeSingle()
      : { data: null, error: null };
    if (current.error) throw new Error(current.error.message);
    if (data.id) assertPropertyRecord(current.data, data.propertyId);
    const payload = {
      property_id: data.propertyId,
      name: data.name,
      code: data.code,
      description: data.description?.trim() || null,
      start_time: data.startTime,
      end_time: data.endTime,
      is_overnight: data.duration.overnight,
      break_minutes: data.breakMinutes,
      grace_period_minutes: data.gracePeriodMinutes,
      expected_work_minutes: data.duration.expectedWorkMinutes,
      colour: data.colour || null,
      active: data.active,
    };
    const result = data.id
      ? await db.from("hr_shift_templates").update(payload).eq("id", data.id).select("*").single()
      : await db.from("hr_shift_templates").insert(payload).select("*").single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      data.id ? "update" : "create",
      "hr_shift_template",
      result.data.id,
      current.data,
      result.data,
    );
    return result.data;
  });

export const setShiftArchived = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; id: string; archived: boolean }) => data)
  .handler(async ({ data, context }) => {
    propertyId(data.propertyId);
    await authorize(context, data.propertyId, HRM_PERMISSIONS.shiftManage);
    const db = context.supabase as any;
    const current = await db.from("hr_shift_templates").select("*").eq("id", data.id).maybeSingle();
    if (current.error) throw new Error(current.error.message);
    assertPropertyRecord(current.data, data.propertyId);
    const result = await db
      .from("hr_shift_templates")
      .update(
        data.archived
          ? { archived_at: new Date().toISOString(), archived_by: context.userId, active: false }
          : { archived_at: null, archived_by: null, active: true },
      )
      .eq("id", data.id)
      .eq("property_id", data.propertyId)
      .select("*")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      data.archived ? "delete" : "update",
      "hr_shift_template",
      data.id,
      current.data,
      result.data,
    );
    return result.data;
  });

export const getWorkforceOptions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string }) => ({ propertyId: propertyId(data.propertyId) }))
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.rosterView);
    const db = context.supabase as any;
    const [employees, shifts, departments] = await Promise.all([
      db
        .from("hr_employees")
        .select("id,employee_number,first_name,last_name,department_id")
        .eq("property_id", data.propertyId)
        .in("employment_status", ["active", "probation"])
        .is("archived_at", null)
        .order("last_name"),
      db
        .from("hr_shift_templates")
        .select("id,name,code,start_time,end_time,is_overnight")
        .eq("property_id", data.propertyId)
        .eq("active", true)
        .is("archived_at", null)
        .order("name"),
      db
        .from("hr_departments")
        .select("id,name")
        .eq("property_id", data.propertyId)
        .is("archived_at", null)
        .order("name"),
    ]);
    for (const result of [employees, shifts, departments]) {
      if (result.error) throw new Error(result.error.message);
    }
    return {
      employees: employees.data ?? [],
      shifts: shifts.data ?? [],
      departments: departments.data ?? [],
    };
  });

export const getHolidayDepartments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string }) => ({
    propertyId: propertyId(data.propertyId),
  }))
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.holidayView);
    const result = await (context.supabase as any)
      .from("hr_departments")
      .select("id,name")
      .eq("property_id", data.propertyId)
      .is("archived_at", null)
      .order("name");
    if (result.error) throw new Error(result.error.message);
    return { departments: result.data ?? [] };
  });

export const listDutyRoster = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.rosterView);
    const db = context.supabase as any;
    const range = pageRange(data.page, data.pageSize);
    let matchingEmployeeIds: string[] | null = null;
    if (data.search) {
      const term = searchTerm(data.search);
      if (term) {
        const employees = await db
          .from("hr_employees")
          .select("id")
          .eq("property_id", data.propertyId)
          .or(
            `employee_number.ilike.%${term}%,first_name.ilike.%${term}%,last_name.ilike.%${term}%`,
          );
        if (employees.error) throw new Error(employees.error.message);
        const ids = (employees.data ?? []).map((employee: { id: string }) => employee.id);
        if (!ids.length) return { rows: [], total: 0 };
        matchingEmployeeIds = ids;
      }
    }
    let query = db
      .from("hr_duty_roster")
      .select(
        "*,employee:employee_id(id,employee_number,first_name,last_name),shift:shift_id(id,name,code,start_time,end_time,is_overnight),department:department_id(id,name)",
        { count: "exact" },
      )
      .eq("property_id", data.propertyId)
      .order("duty_date")
      .order("starts_at")
      .range(range.from, range.to);
    if (data.employeeId) query = query.eq("employee_id", data.employeeId);
    if (matchingEmployeeIds) query = query.in("employee_id", matchingEmployeeIds);
    if (data.departmentId) query = query.eq("department_id", data.departmentId);
    if (data.from) query = query.gte("duty_date", data.from);
    if (data.to) query = query.lte("duty_date", data.to);
    if (data.status === "archived") query = query.not("archived_at", "is", null);
    else if (data.status)
      query = query.eq("publication_status", data.status).is("archived_at", null);
    else query = query.is("archived_at", null);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const saveRosterAssignment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      propertyId: string;
      id?: string;
      employeeId: string;
      shiftId: string;
      dutyDate: string;
      departmentId?: string | null;
      workLocation?: string;
      leaveOverrideReason?: string;
      notes?: string;
    }) => {
      propertyId(data.propertyId);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data.dutyDate)) throw new Error("Valid duty date required");
      return data;
    },
  )
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.rosterManage);
    return persistRosterAssignment(context, data);
  });

export const bulkAssignRoster = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      propertyId: string;
      employeeIds: string[];
      shiftId: string;
      dutyDates: string[];
      departmentId?: string | null;
      workLocation?: string;
      leaveOverrideReason?: string;
    }) => {
      propertyId(data.propertyId);
      if (!data.employeeIds.length || !data.dutyDates.length)
        throw new Error("Employees and dates required");
      if (data.employeeIds.length * data.dutyDates.length > 200)
        throw new Error("Bulk limit is 200 assignments");
      return data;
    },
  )
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.rosterManage);
    const db = context.supabase as any;
    const result = await db.rpc("bulk_assign_hr_duty_roster_with_leave_override", {
      _property_id: data.propertyId,
      _employee_ids: [...new Set(data.employeeIds)],
      _shift_id: data.shiftId,
      _duty_dates: [...new Set(data.dutyDates)],
      _department_id: data.departmentId || null,
      _work_location: data.workLocation?.trim() || null,
      _leave_override_reason: data.leaveOverrideReason?.trim() || null,
    });
    if (result.error) throw new Error(`Bulk assignment failed: ${result.error.message}`);
    await audit(context, data.propertyId, "create", "hr_duty_roster_bulk", data.propertyId, null, {
      created: result.data,
      leaveOverride: Boolean(data.leaveOverrideReason?.trim()),
      leaveOverrideReason: data.leaveOverrideReason?.trim() || null,
    });
    return { created: Number(result.data ?? 0) };
  });

export const copyRosterPeriod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { propertyId: string; sourceFrom: string; sourceTo: string; targetFrom: string }) => {
      propertyId(data.propertyId);
      return data;
    },
  )
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.rosterManage);
    const db = context.supabase as any;
    const result = await db.rpc("copy_hr_duty_roster_period", {
      _property_id: data.propertyId,
      _source_from: data.sourceFrom,
      _source_to: data.sourceTo,
      _target_from: data.targetFrom,
    });
    if (result.error) throw new Error(`Copy failed without changes: ${result.error.message}`);
    await audit(context, data.propertyId, "create", "hr_duty_roster_copy", data.propertyId, null, {
      sourceFrom: data.sourceFrom,
      sourceTo: data.sourceTo,
      targetFrom: data.targetFrom,
      created: result.data,
    });
    return { created: Number(result.data ?? 0) };
  });

export const setRosterPublication = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; ids: string[]; published: boolean }) => data)
  .handler(async ({ data, context }) => {
    propertyId(data.propertyId);
    await authorize(context, data.propertyId, HRM_PERMISSIONS.rosterPublish);
    const db = context.supabase as any;
    const rows = await db
      .from("hr_duty_roster")
      .select(
        "id,duty_date,employee:employee_id(staff_user_id),shift:shift_id(name,start_time,end_time)",
      )
      .eq("property_id", data.propertyId)
      .in("id", data.ids)
      .is("archived_at", null);
    if (rows.error) throw new Error(rows.error.message);
    const update = await db
      .from("hr_duty_roster")
      .update({
        publication_status: data.published ? "published" : "unpublished",
        published_by: data.published ? context.userId : null,
        published_at: data.published ? new Date().toISOString() : null,
        updated_by: context.userId,
      })
      .eq("property_id", data.propertyId)
      .in("id", data.ids);
    if (update.error) throw new Error(update.error.message);
    if (data.published) {
      for (const row of rows.data ?? []) {
        if (!row.employee?.staff_user_id) continue;
        await db.rpc("notify", {
          _property_id: data.propertyId,
          _user_id: row.employee.staff_user_id,
          _category: "duty_roster",
          _priority: "normal",
          _title: "Duty roster published",
          _body: `${row.shift?.name ?? "Shift"} on ${row.duty_date}`,
          _link: "/notifications",
          _metadata: { rosterId: row.id },
        });
      }
    }
    await audit(
      context,
      data.propertyId,
      data.published ? "approve" : "update",
      "hr_duty_roster_publication",
      data.ids[0] ?? data.propertyId,
      null,
      { published: data.published, rosterIds: data.ids },
    );
    return { updated: rows.data?.length ?? 0 };
  });

export const setRosterArchived = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; id: string; archived: boolean }) => data)
  .handler(async ({ data, context }) => {
    propertyId(data.propertyId);
    await authorize(context, data.propertyId, HRM_PERMISSIONS.rosterManage);
    const db = context.supabase as any;
    const current = await db.from("hr_duty_roster").select("*").eq("id", data.id).maybeSingle();
    if (current.error) throw new Error(current.error.message);
    assertPropertyRecord(current.data, data.propertyId);
    if (data.archived && current.data.duty_date < new Date().toISOString().slice(0, 10)) {
      throw new Error("Past roster entries cannot be removed");
    }
    const result = await db
      .from("hr_duty_roster")
      .update(
        data.archived
          ? { archived_at: new Date().toISOString(), archived_by: context.userId }
          : { archived_at: null, archived_by: null },
      )
      .eq("id", data.id)
      .eq("property_id", data.propertyId)
      .select("*")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      data.archived ? "delete" : "update",
      "hr_duty_roster",
      data.id,
      current.data,
      result.data,
    );
    return result.data;
  });

export const listHolidays = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.holidayView);
    const db = context.supabase as any;
    const range = pageRange(data.page, data.pageSize);
    let query = db
      .from("hr_holidays")
      .select("*,hr_holiday_departments(department_id)", { count: "exact" })
      .eq("property_id", data.propertyId)
      .order("holiday_date")
      .range(range.from, range.to);
    if (data.search) {
      const term = searchTerm(data.search);
      if (term) query = query.ilike("name", `%${term}%`);
    }
    if (data.from) query = query.gte("holiday_date", data.from);
    if (data.to) query = query.lte("holiday_date", data.to);
    if (data.status === "archived") query = query.not("archived_at", "is", null);
    else if (data.status === "inactive") query = query.eq("active", false).is("archived_at", null);
    else query = query.is("archived_at", null);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const saveHoliday = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      propertyId: string;
      id?: string;
      name: string;
      holidayDate: string;
      recurringAnnually: boolean;
      holidayType: string;
      treatment: string;
      scopeType: "property" | "departments";
      departmentIds?: string[];
      description?: string;
      active: boolean;
    }) => {
      propertyId(data.propertyId);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data.holidayDate))
        throw new Error("Valid holiday date required");
      if (data.scopeType === "departments" && !data.departmentIds?.length) {
        throw new Error("Choose at least one affected department");
      }
      return { ...data, name: validateRequiredText(data.name, "Holiday name", 160) };
    },
  )
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.holidayManage);
    const db = context.supabase as any;
    const current = data.id
      ? await db.from("hr_holidays").select("*").eq("id", data.id).maybeSingle()
      : { data: null, error: null };
    if (current.error) throw new Error(current.error.message);
    if (data.id) assertPropertyRecord(current.data, data.propertyId);
    const payload = {
      property_id: data.propertyId,
      name: data.name,
      holiday_date: data.holidayDate,
      recurring_annually: data.recurringAnnually,
      holiday_type: data.holidayType,
      treatment: data.treatment,
      scope_type: data.scopeType,
      description: data.description?.trim() || null,
      active: data.active,
    };
    const result = data.id
      ? await db.from("hr_holidays").update(payload).eq("id", data.id).select("*").single()
      : await db.from("hr_holidays").insert(payload).select("*").single();
    if (result.error) throw new Error(result.error.message);
    const removed = await db
      .from("hr_holiday_departments")
      .delete()
      .eq("holiday_id", result.data.id)
      .eq("property_id", data.propertyId);
    if (removed.error) throw new Error(removed.error.message);
    if (data.scopeType === "departments") {
      const inserted = await db.from("hr_holiday_departments").insert(
        [...new Set(data.departmentIds)].map((departmentId) => ({
          holiday_id: result.data.id,
          property_id: data.propertyId,
          department_id: departmentId,
        })),
      );
      if (inserted.error) throw new Error(inserted.error.message);
    }
    await audit(
      context,
      data.propertyId,
      data.id ? "update" : "create",
      "hr_holiday",
      result.data.id,
      current.data,
      { ...result.data, departmentIds: data.departmentIds ?? [] },
    );
    return result.data;
  });

export const setHolidayArchived = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; id: string; archived: boolean }) => data)
  .handler(async ({ data, context }) => {
    propertyId(data.propertyId);
    await authorize(context, data.propertyId, HRM_PERMISSIONS.holidayManage);
    const db = context.supabase as any;
    const current = await db.from("hr_holidays").select("*").eq("id", data.id).maybeSingle();
    if (current.error) throw new Error(current.error.message);
    assertPropertyRecord(current.data, data.propertyId);
    const result = await db
      .from("hr_holidays")
      .update(
        data.archived
          ? { archived_at: new Date().toISOString(), archived_by: context.userId, active: false }
          : { archived_at: null, archived_by: null, active: true },
      )
      .eq("id", data.id)
      .eq("property_id", data.propertyId)
      .select("*")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      data.archived ? "delete" : "update",
      "hr_holiday",
      data.id,
      current.data,
      result.data,
    );
    return result.data;
  });
