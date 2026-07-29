/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase types follow local Phase 3C migration validation. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { captureAuditEvent } from "@/lib/audit.server";
import { assertServerPermission } from "@/lib/permissions.server";
import { pageRange } from "@/lib/query-state";
import { HRM_ADMIN_ROLES, HRM_PERMISSIONS } from "@/lib/hrm/permissions";
import { validateLeaveDocument, validateLeaveType } from "@/lib/hrm/leave-domain";

type Context = { userId: string; supabase: any };
const validId = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) throw new Error("Valid identifier required");
  return value;
};
async function allow(context: Context, propertyId: string, permission: any) {
  await assertServerPermission(context, {
    propertyId,
    ...permission,
    defaultRoles: HRM_ADMIN_ROLES,
  });
}
async function log(
  context: Context,
  propertyId: string,
  action: string,
  type: string,
  id: string,
  before: unknown,
  after: unknown,
) {
  await captureAuditEvent(context, {
    propertyId,
    action,
    resourceType: type,
    resourceId: id,
    oldValues: before,
    newValues: after,
    sourceModule: "leave_management",
  });
}
async function ownEmployee(context: Context, propertyId: string) {
  const result = await context.supabase
    .from("hr_employees")
    .select("id,employee_number,first_name,last_name,department_id,reporting_manager_id")
    .eq("property_id", propertyId)
    .eq("staff_user_id", context.userId)
    .is("archived_at", null)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return result.data;
}
function listInput(data: any) {
  validId(data.propertyId);
  return {
    ...data,
    search:
      data.search
        ?.trim()
        .replace(/[%_(),.*]/g, " ")
        .slice(0, 120) ?? "",
    page: Math.max(1, data.page ?? 1),
    pageSize: [10, 25, 50, 100].includes(data.pageSize) ? data.pageSize : 25,
  };
}

export const getLeaveBootstrap = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string }) => ({ propertyId: validId(data.propertyId) }))
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.ownLeaveView);
    const db = context.supabase as any;
    const employee = await ownEmployee(context, data.propertyId);
    const [types, departments, employees] = await Promise.all([
      db
        .from("hr_leave_types")
        .select("*")
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
      db
        .from("hr_employees")
        .select("id,employee_number,first_name,last_name,department_id")
        .eq("property_id", data.propertyId)
        .is("archived_at", null)
        .order("first_name"),
    ]);
    for (const result of [types, departments, employees])
      if (result.error) throw new Error(result.error.message);
    return {
      employee,
      types: types.data ?? [],
      departments: departments.data ?? [],
      employees: employees.data ?? [],
    };
  });

export const listLeaveTypes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.leaveSettingsView);
    const range = pageRange(data.page, data.pageSize);
    let query = (context.supabase as any)
      .from("hr_leave_types")
      .select("*", { count: "exact" })
      .eq("property_id", data.propertyId)
      .order("name")
      .range(range.from, range.to);
    if (data.search) query = query.or(`name.ilike.%${data.search}%,code.ilike.%${data.search}%`);
    if (data.status === "archived") query = query.not("archived_at", "is", null);
    else query = query.is("archived_at", null);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const saveLeaveType = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => {
    validId(data.propertyId);
    const normalized = {
      ...data,
      paid: data.paid ?? true,
      annualEntitlement: Number(data.annualEntitlement ?? 0),
      entitlementUnit: "days",
      accrualMethod: data.accrualMethod ?? "annual",
      accrualFrequency: data.accrualFrequency ?? "yearly",
      leaveYearStartMonth: Number(data.leaveYearStartMonth ?? 1),
      carryForwardEnabled: Boolean(data.carryForwardEnabled),
      maximumCarryForward: Number(data.maximumCarryForward ?? 0),
      carryForwardExpiryDays:
        data.carryForwardExpiryDays == null ? null : Number(data.carryForwardExpiryDays),
      minimumNoticeDays: Number(data.minimumNoticeDays ?? 0),
      maximumConsecutiveDays:
        data.maximumConsecutiveDays == null ? null : Number(data.maximumConsecutiveDays),
      minimumRequestDuration: Number(data.minimumRequestDuration ?? 0.5),
      partialDaySupported: data.partialDaySupported ?? true,
      supportingDocumentRequired: Boolean(data.supportingDocumentRequired),
      negativeBalanceAllowed: Boolean(data.negativeBalanceAllowed),
      probationEligible: Boolean(data.probationEligible),
      minimumServiceDays: Number(data.minimumServiceDays ?? 0),
      approvalRequired: true,
      active: data.active ?? true,
    };
    validateLeaveType(normalized);
    if (!normalized.name?.trim() || !normalized.code?.trim())
      throw new Error("Name and code are required");
    if (
      normalized.leaveYearStartMonth < 1 ||
      normalized.leaveYearStartMonth > 12 ||
      normalized.annualEntitlement < 0 ||
      normalized.minimumNoticeDays < 0 ||
      normalized.minimumServiceDays < 0
    )
      throw new Error("Leave policy values are outside the allowed range");
    return normalized;
  })
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.leaveSettingsManage);
    const db = context.supabase as any;
    const before = data.id
      ? await db
          .from("hr_leave_types")
          .select("*")
          .eq("property_id", data.propertyId)
          .eq("id", data.id)
          .single()
      : { data: null };
    const payload = {
      property_id: data.propertyId,
      name: data.name.trim(),
      code: data.code.trim().toUpperCase(),
      description: data.description?.trim() || null,
      paid: data.paid,
      annual_entitlement: data.annualEntitlement,
      entitlement_unit: data.entitlementUnit,
      accrual_method: data.accrualMethod,
      accrual_frequency: data.accrualFrequency,
      leave_year_start_month: data.leaveYearStartMonth,
      carry_forward_enabled: data.carryForwardEnabled,
      maximum_carry_forward: data.maximumCarryForward,
      carry_forward_expiry_days: data.carryForwardExpiryDays || null,
      minimum_notice_days: data.minimumNoticeDays,
      maximum_consecutive_days: data.maximumConsecutiveDays || null,
      minimum_request_duration: data.minimumRequestDuration,
      partial_day_supported: data.partialDaySupported,
      supporting_document_required: data.supportingDocumentRequired,
      negative_balance_allowed: data.negativeBalanceAllowed,
      probation_eligible: data.probationEligible,
      minimum_service_days: data.minimumServiceDays,
      approval_required: data.approvalRequired,
      active: data.active,
    };
    const result = data.id
      ? await db
          .from("hr_leave_types")
          .update(payload)
          .eq("property_id", data.propertyId)
          .eq("id", data.id)
          .select("*")
          .single()
      : await db.from("hr_leave_types").insert(payload).select("*").single();
    if (result.error) throw new Error(result.error.message);
    await log(
      context,
      data.propertyId,
      data.id ? "update" : "create",
      "hr_leave_type",
      result.data.id,
      before.data,
      result.data,
    );
    return result.data;
  });

export const setLeaveTypeArchived = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; id: string; archived: boolean }) => data)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.leaveSettingsManage);
    const db = context.supabase as any;
    const before = await db
      .from("hr_leave_types")
      .select("*")
      .eq("property_id", data.propertyId)
      .eq("id", data.id)
      .single();
    if (before.error) throw new Error(before.error.message);
    const result = await db
      .from("hr_leave_types")
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
    await log(
      context,
      data.propertyId,
      data.archived ? "delete" : "update",
      "hr_leave_type",
      data.id,
      before.data,
      result.data,
    );
    return result.data;
  });

export const listLeaveRequests = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    const db = context.supabase as any;
    const own = await ownEmployee(context, data.propertyId);
    let broad = true;
    try {
      await allow(context, data.propertyId, HRM_PERMISSIONS.propertyLeaveView);
    } catch {
      broad = false;
    }
    let team = false;
    if (!broad) {
      try {
        await allow(context, data.propertyId, HRM_PERMISSIONS.teamLeaveView);
        team = true;
      } catch {
        team = false;
      }
    }
    if (!broad && !team) await allow(context, data.propertyId, HRM_PERMISSIONS.ownLeaveView);
    const range = pageRange(data.page, data.pageSize);
    let query = db
      .from("hr_leave_requests")
      .select(
        "*,employee:employee_id!inner(id,employee_number,first_name,last_name,department_id,reporting_manager_id),leave_type:leave_type_id(id,name,code,paid),hr_roster_leave_conflicts(id,status)",
        { count: "exact" },
      )
      .eq("property_id", data.propertyId)
      .order("created_at", { ascending: false })
      .range(range.from, range.to);
    if (!broad && team) {
      if (!own) throw new Error("Linked manager employee required");
      query = query.eq("employee.reporting_manager_id", own.id);
    } else if (!broad) {
      if (!own) throw new Error("Linked employee required");
      query = query.eq("employee_id", own.id);
    }
    if (data.employeeId) query = query.eq("employee_id", data.employeeId);
    if (data.departmentId) query = query.eq("employee.department_id", data.departmentId);
    if (data.leaveTypeId) query = query.eq("leave_type_id", data.leaveTypeId);
    if (data.search) {
      const matchingEmployees = await db
        .from("hr_employees")
        .select("id")
        .eq("property_id", data.propertyId)
        .or(
          `employee_number.ilike.%${data.search}%,first_name.ilike.%${data.search}%,last_name.ilike.%${data.search}%`,
        )
        .limit(200);
      if (matchingEmployees.error) throw new Error(matchingEmployees.error.message);
      const employeeIds = (matchingEmployees.data ?? []).map(
        (employee: { id: string }) => employee.id,
      );
      if (!employeeIds.length) {
        return { rows: [], total: 0, ownEmployeeId: own?.id ?? null, broad };
      }
      query = query.in("employee_id", employeeIds);
    }
    if (data.status) query = query.eq("status", data.status);
    if (data.from) query = query.gte("start_date", data.from);
    if (data.to) query = query.lte("end_date", data.to);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return {
      rows: result.data ?? [],
      total: result.count ?? 0,
      ownEmployeeId: own?.id ?? null,
      broad,
    };
  });

export const saveLeaveDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => {
    validId(data.propertyId);
    validId(data.leaveTypeId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.startDate) || data.endDate < data.startDate)
      throw new Error("Invalid date range");
    if (!data.reason?.trim()) throw new Error("Reason required");
    return data;
  })
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.ownLeaveCreate);
    const db = context.supabase as any;
    const own = await ownEmployee(context, data.propertyId);
    if (!own) throw new Error("Linked employee required");
    const current = data.id
      ? await db
          .from("hr_leave_requests")
          .select("*")
          .eq("property_id", data.propertyId)
          .eq("id", data.id)
          .single()
      : { data: null };
    if (
      current.data &&
      (current.data.employee_id !== own.id || !["draft", "returned"].includes(current.data.status))
    )
      throw new Error("Only your editable draft may be changed");
    const total = await db.rpc("hr_calculate_leave_days", {
      _property_id: data.propertyId,
      _start: data.startDate,
      _end: data.endDate,
      _partial_mode: data.partialDayMode || "none",
    });
    if (total.error) throw new Error(total.error.message);
    const payload = {
      property_id: data.propertyId,
      employee_id: own.id,
      leave_type_id: data.leaveTypeId,
      start_date: data.startDate,
      end_date: data.endDate,
      partial_day_mode: data.partialDayMode || "none",
      partial_day_date:
        data.partialDayMode && data.partialDayMode !== "none" ? data.startDate : null,
      total_requested_days: total.data,
      reason: data.reason.trim(),
      created_by: current.data?.created_by ?? context.userId,
    };
    const result = data.id
      ? await db.from("hr_leave_requests").update(payload).eq("id", data.id).select("*").single()
      : await db.from("hr_leave_requests").insert(payload).select("*").single();
    if (result.error) throw new Error(result.error.message);
    await log(
      context,
      data.propertyId,
      data.id ? "update" : "create",
      "hr_leave_request",
      result.data.id,
      current.data,
      result.data,
    );
    return result.data;
  });

export const transitionLeaveRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { propertyId: string; id: string; action: string; reason?: string }) => data,
  )
  .handler(async ({ data, context }) => {
    validId(data.propertyId);
    validId(data.id);
    if (data.action === "submitted")
      await allow(context, data.propertyId, HRM_PERMISSIONS.ownLeaveCreate);
    else if (data.action === "withdrawn")
      await allow(context, data.propertyId, HRM_PERMISSIONS.ownLeaveWithdraw);
    else
      await allow(
        context,
        data.propertyId,
        data.action === "cancelled" ? HRM_PERMISSIONS.leaveCancel : HRM_PERMISSIONS.leaveApprove,
      );
    const db = context.supabase as any;
    const before = await db
      .from("hr_leave_requests")
      .select("status,employee_id")
      .eq("property_id", data.propertyId)
      .eq("id", data.id)
      .single();
    if (before.error) throw new Error(before.error.message);
    const result =
      data.action === "submitted"
        ? await db.rpc("hr_submit_leave_request", {
            _property_id: data.propertyId,
            _request_id: data.id,
          })
        : await db.rpc("hr_decide_leave_request", {
            _property_id: data.propertyId,
            _request_id: data.id,
            _decision: data.action,
            _reason: data.reason?.trim() || null,
          });
    if (result.error) throw new Error(result.error.message);
    await log(
      context,
      data.propertyId,
      data.action === "approved" ? "approve" : "update",
      "hr_leave_request",
      data.id,
      before.data,
      { status: data.action, reason: data.reason?.trim() || null },
    );
    return result.data;
  });

export const listLeaveBalances = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    const db = context.supabase as any;
    const own = await ownEmployee(context, data.propertyId);
    let broad = true;
    try {
      await allow(context, data.propertyId, HRM_PERMISSIONS.leaveBalancesView);
    } catch {
      broad = false;
      await allow(context, data.propertyId, HRM_PERMISSIONS.ownLeaveView);
    }
    const initialized = await db.rpc("hr_initialize_leave_balances", {
      _property_id: data.propertyId,
      _employee_id: broad ? null : own?.id,
    });
    if (initialized.error) throw new Error(initialized.error.message);
    const range = pageRange(data.page, data.pageSize);
    let query = db
      .from("hr_leave_balances")
      .select(
        "*,employee:employee_id(employee_number,first_name,last_name),leave_type:leave_type_id(name,code)",
        { count: "exact" },
      )
      .eq("property_id", data.propertyId)
      .order("period_start", { ascending: false })
      .range(range.from, range.to);
    if (!broad) {
      if (!own) throw new Error("Linked employee required");
      query = query.eq("employee_id", own.id);
    }
    if (data.employeeId) query = query.eq("employee_id", data.employeeId);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const adjustLeaveBalance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { propertyId: string; balanceId: string; amount: number; reason: string }) => {
      if (data.reason.trim().length < 5) throw new Error("Adjustment reason required");
      return data;
    },
  )
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.leaveBalancesAdjust);
    const db = context.supabase as any;
    const balance = await db
      .from("hr_leave_balances")
      .select("*")
      .eq("property_id", data.propertyId)
      .eq("id", data.balanceId)
      .single();
    if (balance.error) throw new Error(balance.error.message);
    const adjustment = await db.rpc("hr_adjust_leave_balance", {
      _property_id: data.propertyId,
      _balance_id: data.balanceId,
      _amount: data.amount,
      _reason: data.reason.trim(),
    });
    if (adjustment.error) throw new Error(adjustment.error.message);
    await log(
      context,
      data.propertyId,
      "approve",
      "hr_leave_balance_adjustment",
      adjustment.data,
      { adjustedAmount: balance.data.adjusted_amount },
      { adjustedAmount: data.amount, reason: data.reason.trim() },
    );
    return { id: adjustment.data };
  });

export const getLeaveCalendar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.leaveCalendarView);
    let query = (context.supabase as any)
      .from("hr_leave_requests")
      .select(
        "id,start_date,end_date,partial_day_mode,status,employee:employee_id(id,first_name,last_name,department_id),leave_type:leave_type_id(name,code)",
      )
      .eq("property_id", data.propertyId)
      .in("status", data.includeSubmitted ? ["approved", "submitted"] : ["approved"])
      .order("start_date");
    if (data.from) query = query.gte("end_date", data.from);
    if (data.to) query = query.lte("start_date", data.to);
    if (data.departmentId) query = query.eq("employee.department_id", data.departmentId);
    if (data.leaveTypeId) query = query.eq("leave_type_id", data.leaveTypeId);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return result.data ?? [];
  });

export const createLeaveDocumentTicket = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => data)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.ownLeaveCreate);
    const own = await ownEmployee(context, data.propertyId);
    if (!own) throw new Error("Linked employee required");
    const path = `${data.propertyId}/${own.id}/leave/${crypto.randomUUID()}-${String(data.fileName).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    validateLeaveDocument({
      propertyId: data.propertyId,
      employeeId: own.id,
      path,
      mime: data.fileType,
      size: data.fileSize,
    });
    return { bucket: "employee-documents", path };
  });

export const attachLeaveDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => data)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.ownLeaveCreate);
    const own = await ownEmployee(context, data.propertyId);
    if (!own) throw new Error("Linked employee required");
    validateLeaveDocument({
      propertyId: data.propertyId,
      employeeId: own.id,
      path: data.path,
      mime: data.fileType,
      size: data.fileSize,
    });
    const result = await (context.supabase as any)
      .from("hr_leave_requests")
      .update({
        supporting_document_path: data.path,
        supporting_document_name: data.fileName,
        supporting_document_mime: data.fileType,
        supporting_document_size: data.fileSize,
      })
      .eq("property_id", data.propertyId)
      .eq("employee_id", own.id)
      .eq("id", data.requestId)
      .in("status", ["draft", "returned"])
      .select("id")
      .single();
    if (result.error) throw new Error(result.error.message);
    await log(context, data.propertyId, "update", "hr_leave_document", data.requestId, null, {
      fileName: data.fileName,
      fileType: data.fileType,
      fileSize: data.fileSize,
    });
    return { ok: true };
  });

export const getLeaveDocumentDownload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; requestId: string }) => data)
  .handler(async ({ data, context }) => {
    const db = context.supabase as any;
    const own = await ownEmployee(context, data.propertyId);
    const request = await db
      .from("hr_leave_requests")
      .select(
        "employee_id,supporting_document_path,supporting_document_name,employee:employee_id(reporting_manager_id)",
      )
      .eq("property_id", data.propertyId)
      .eq("id", data.requestId)
      .single();
    if (request.error) throw new Error(request.error.message);
    if (request.data.employee_id !== own?.id) {
      await allow(context, data.propertyId, HRM_PERMISSIONS.leaveDocumentsView);
      let broad = true;
      try {
        await allow(context, data.propertyId, HRM_PERMISSIONS.propertyLeaveView);
      } catch {
        broad = false;
      }
      if (!broad && (!own || request.data.employee?.reporting_manager_id !== own.id)) {
        throw new Error("Reviewer is outside the employee reporting scope");
      }
    }
    if (!request.data.supporting_document_path) throw new Error("No supporting document");
    const signed = await db.storage
      .from("employee-documents")
      .createSignedUrl(request.data.supporting_document_path, 60, {
        download: request.data.supporting_document_name,
      });
    if (signed.error) throw new Error(signed.error.message);
    await log(context, data.propertyId, "view", "hr_leave_document", data.requestId, null, {
      downloaded: true,
    });
    return { url: signed.data.signedUrl };
  });
