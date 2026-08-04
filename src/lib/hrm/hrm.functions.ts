/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase types are regenerated only after the additive HRM migration is applied locally. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { captureAuditEvent } from "@/lib/audit.server";
import { assertServerPermission } from "@/lib/permissions.server";
import { pageRange } from "@/lib/query-state";
import {
  assertNoDepartmentCycle,
  assertPropertyRecord,
  employeeDocumentStoragePath,
  employeeProfileCompleteness,
  normalizeHrmCode,
  safeStorageSegment,
  validateEmployeeDates,
  validateEmployeeDocument,
  validateIsoDate,
  validateRequiredText,
} from "@/lib/hrm/domain";
import { HRM_ADMIN_ROLES, HRM_PERMISSIONS } from "@/lib/hrm/permissions";

type HrmContext = {
  userId: string;
  supabase: any;
};

type ListInput = {
  propertyId: string;
  search?: string;
  page?: number;
  pageSize?: number;
  status?: string;
  departmentId?: string;
  designationId?: string;
  from?: string;
  to?: string;
};

function requirePropertyId(propertyId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(propertyId)) {
    throw new Error("A valid property is required");
  }
  return propertyId;
}

function listInput(data: ListInput): ListInput {
  requirePropertyId(data.propertyId);
  return {
    ...data,
    search: data.search?.trim().slice(0, 200) ?? "",
    page: Math.max(1, Math.trunc(data.page ?? 1)),
    pageSize: [10, 25, 50, 100].includes(data.pageSize ?? 25) ? data.pageSize : 25,
    from: validateIsoDate(data.from, "From date") ?? undefined,
    to: validateIsoDate(data.to, "To date") ?? undefined,
  };
}

function filterTerm(value: string): string {
  return value
    .replace(/[%_(),.*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function authorize(
  context: HrmContext,
  propertyId: string,
  permission: { module: string; capability: any },
): Promise<void> {
  await assertServerPermission(context, {
    propertyId,
    ...permission,
    defaultRoles: HRM_ADMIN_ROLES,
  });
}

async function audit(
  context: HrmContext,
  propertyId: string,
  action: string,
  resourceType: string,
  resourceId: string,
  oldValues: unknown,
  newValues: unknown,
): Promise<void> {
  await captureAuditEvent(context, {
    propertyId,
    action,
    resourceType,
    resourceId,
    oldValues,
    newValues,
    sourceModule: "hrm",
  });
}

export const getHrmDashboard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; departmentId?: string }) => {
    requirePropertyId(data.propertyId);
    return data;
  })
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.dashboardView);
    const db = context.supabase as any;
    let employeesQuery = db
      .from("hr_employees")
      .select(
        "id,first_name,last_name,employee_number,employment_status,hire_date,department_id,designation_id,work_email,profile_photo_path,department:department_id(name),designation:designation_id(title)",
      )
      .eq("property_id", data.propertyId)
      .order("hire_date", { ascending: false });
    if (data.departmentId) employeesQuery = employeesQuery.eq("department_id", data.departmentId);

    const [employeesResult, privateResult, documentsResult, announcementsResult] =
      await Promise.all([
        employeesQuery,
        db
          .from("hr_employee_private")
          .select("employee_id,primary_phone,emergency_contact_name,emergency_contact_phone")
          .eq("property_id", data.propertyId),
        db
          .from("hr_employee_documents")
          .select("id,title,file_name,created_at,employee_id")
          .eq("property_id", data.propertyId)
          .is("archived_at", null)
          .order("created_at", { ascending: false })
          .limit(8),
        db
          .from("hr_staff_announcements")
          .select("id,title,priority,publish_date,expiry_date")
          .eq("property_id", data.propertyId)
          .eq("publication_status", "published")
          .is("archived_at", null)
          .lte("publish_date", new Date().toISOString())
          .or(`expiry_date.is.null,expiry_date.gt.${new Date().toISOString()}`)
          .order("publish_date", { ascending: false })
          .limit(8),
      ]);
    for (const result of [employeesResult, privateResult, documentsResult, announcementsResult]) {
      if (result.error) throw new Error(result.error.message);
    }

    const privateByEmployee = new Map(
      (privateResult.data ?? []).map((row: any) => [row.employee_id, row]),
    );
    const employees = (employeesResult.data ?? []).map((row: any) => ({
      ...row,
      profileCompleteness: employeeProfileCompleteness({
        ...row,
        ...(privateByEmployee.get(row.id) ?? {}),
      }),
    }));
    const active = employees.filter(
      (row: any) => row.employment_status === "active" || row.employment_status === "probation",
    );
    const group = (key: string, label: string) =>
      Object.entries(
        active.reduce((counts: Record<string, number>, row: any) => {
          const relation = row[key];
          const value = Array.isArray(relation) ? relation[0]?.[label] : relation?.[label];
          const name = value ?? "Unassigned";
          counts[name] = (counts[name] ?? 0) + 1;
          return counts;
        }, {}),
      ).map(([name, count]) => ({ name, count: Number(count) }));

    return {
      activeCount: active.length,
      inactiveCount: employees.length - active.length,
      byDepartment: group("department", "name"),
      byDesignation: group("designation", "title"),
      recentEmployees: employees.slice(0, 8),
      incompleteEmployees: employees
        .filter((row: any) => row.profileCompleteness < 80)
        .sort((a: any, b: any) => a.profileCompleteness - b.profileCompleteness)
        .slice(0, 8),
      recentDocuments: documentsResult.data ?? [],
      activeAnnouncements: announcementsResult.data ?? [],
    };
  });

export const listHrmOptions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string }) => {
    requirePropertyId(data.propertyId);
    return data;
  })
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.employeeView);
    const db = context.supabase as any;
    const [departments, designations, employees, profiles] = await Promise.all([
      db
        .from("hr_departments")
        .select("id,name,code,parent_department_id")
        .eq("property_id", data.propertyId)
        .is("archived_at", null)
        .order("name"),
      db
        .from("hr_designations")
        .select("id,title,code,department_id")
        .eq("property_id", data.propertyId)
        .is("archived_at", null)
        .order("title"),
      db
        .from("hr_employees")
        .select(
          "id,employee_number,first_name,last_name,department_id,designation_id,staff_user_id",
        )
        .eq("property_id", data.propertyId)
        .is("archived_at", null)
        .order("last_name"),
      db.from("user_roles").select("user_id").eq("property_id", data.propertyId),
    ]);
    for (const result of [departments, designations, employees, profiles]) {
      if (result.error) throw new Error(result.error.message);
    }
    const userIds = [...new Set((profiles.data ?? []).map((row: any) => row.user_id))];
    const profileRows = userIds.length
      ? await db.from("profiles").select("id,full_name").in("id", userIds)
      : { data: [], error: null };
    if (profileRows.error) throw new Error(profileRows.error.message);
    return {
      departments: departments.data ?? [],
      designations: designations.data ?? [],
      employees: employees.data ?? [],
      profiles: profileRows.data ?? [],
    };
  });

export const listDepartments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.departmentView);
    const { from, to } = pageRange(data.page!, data.pageSize!);
    const db = context.supabase as any;
    let query = db
      .from("hr_departments")
      .select(
        "*,parent:parent_department_id(id,name),head:department_head_id(id,first_name,last_name)",
        { count: "exact" },
      )
      .eq("property_id", data.propertyId)
      .order("name")
      .range(from, to);
    if (data.search) {
      const term = filterTerm(data.search);
      if (term) query = query.or(`name.ilike.%${term}%,code.ilike.%${term}%`);
    }
    if (data.status === "archived") query = query.not("archived_at", "is", null);
    else if (data.status) query = query.eq("status", data.status).is("archived_at", null);
    else query = query.is("archived_at", null);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const saveDepartment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      propertyId: string;
      id?: string;
      name: string;
      code: string;
      description?: string;
      parentDepartmentId?: string | null;
      departmentHeadId?: string | null;
      status?: string;
    }) => {
      requirePropertyId(data.propertyId);
      return {
        ...data,
        name: validateRequiredText(data.name, "Department name", 120),
        code: normalizeHrmCode(validateRequiredText(data.code, "Department code", 40)),
      };
    },
  )
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.departmentManage);
    const db = context.supabase as any;
    const existing = data.id
      ? await db.from("hr_departments").select("*").eq("id", data.id).maybeSingle()
      : { data: null, error: null };
    if (existing.error) throw new Error(existing.error.message);
    if (data.id) assertPropertyRecord(existing.data, data.propertyId);

    const parentsResult = await db
      .from("hr_departments")
      .select("id,parent_department_id")
      .eq("property_id", data.propertyId);
    if (parentsResult.error) throw new Error(parentsResult.error.message);
    assertNoDepartmentCycle(
      data.id ?? null,
      data.parentDepartmentId ?? null,
      new Map(
        (parentsResult.data ?? []).map((row: any) => [row.id, row.parent_department_id ?? null]),
      ),
    );

    const payload = {
      property_id: data.propertyId,
      name: data.name,
      code: data.code,
      description: data.description?.trim() || null,
      parent_department_id: data.parentDepartmentId ?? null,
      department_head_id: data.departmentHeadId ?? null,
      status: data.status ?? "active",
    };
    const result = data.id
      ? await db.from("hr_departments").update(payload).eq("id", data.id).select("*").single()
      : await db.from("hr_departments").insert(payload).select("*").single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      data.id ? "update" : "create",
      "hr_department",
      result.data.id,
      existing.data,
      result.data,
    );
    return result.data;
  });

export const setDepartmentArchived = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; id: string; archived: boolean }) => data)
  .handler(async ({ data, context }) => {
    requirePropertyId(data.propertyId);
    await authorize(context, data.propertyId, HRM_PERMISSIONS.departmentManage);
    const db = context.supabase as any;
    const current = await db.from("hr_departments").select("*").eq("id", data.id).maybeSingle();
    if (current.error) throw new Error(current.error.message);
    assertPropertyRecord(current.data, data.propertyId);
    if (data.archived) {
      const [employees, children] = await Promise.all([
        db
          .from("hr_employees")
          .select("id", { count: "exact", head: true })
          .eq("property_id", data.propertyId)
          .eq("department_id", data.id)
          .is("archived_at", null),
        db
          .from("hr_departments")
          .select("id", { count: "exact", head: true })
          .eq("property_id", data.propertyId)
          .eq("parent_department_id", data.id)
          .is("archived_at", null),
      ]);
      if (employees.error || children.error) {
        throw new Error(employees.error?.message ?? children.error?.message);
      }
      if ((employees.count ?? 0) > 0 || (children.count ?? 0) > 0) {
        throw new Error("Reassign active employees and child departments before archiving");
      }
    }
    const update = data.archived
      ? {
          archived_at: new Date().toISOString(),
          archived_by: context.userId,
          status: "archived",
        }
      : { archived_at: null, archived_by: null, status: "active" };
    const result = await db
      .from("hr_departments")
      .update(update)
      .eq("id", data.id)
      .eq("property_id", data.propertyId)
      .select("*")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      data.archived ? "delete" : "update",
      "hr_department",
      data.id,
      current.data,
      result.data,
    );
    return result.data;
  });

export const listDesignations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.designationView);
    const { from, to } = pageRange(data.page!, data.pageSize!);
    const db = context.supabase as any;
    let query = db
      .from("hr_designations")
      .select("*,department:department_id(id,name)", { count: "exact" })
      .eq("property_id", data.propertyId)
      .order("rank", { ascending: true, nullsFirst: false })
      .order("title")
      .range(from, to);
    if (data.search) {
      const term = filterTerm(data.search);
      if (term) query = query.or(`title.ilike.%${term}%,code.ilike.%${term}%`);
    }
    if (data.departmentId) query = query.eq("department_id", data.departmentId);
    if (data.status === "archived") query = query.not("archived_at", "is", null);
    else if (data.status) query = query.eq("status", data.status).is("archived_at", null);
    else query = query.is("archived_at", null);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const saveDesignation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      propertyId: string;
      id?: string;
      title: string;
      code: string;
      description?: string;
      departmentId?: string | null;
      rank?: number | null;
      status?: string;
    }) => {
      requirePropertyId(data.propertyId);
      return {
        ...data,
        title: validateRequiredText(data.title, "Designation title", 120),
        code: normalizeHrmCode(validateRequiredText(data.code, "Designation code", 40)),
      };
    },
  )
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.designationManage);
    const db = context.supabase as any;
    const existing = data.id
      ? await db.from("hr_designations").select("*").eq("id", data.id).maybeSingle()
      : { data: null, error: null };
    if (existing.error) throw new Error(existing.error.message);
    if (data.id) assertPropertyRecord(existing.data, data.propertyId);
    if (data.departmentId) {
      const department = await db
        .from("hr_departments")
        .select("property_id")
        .eq("id", data.departmentId)
        .maybeSingle();
      if (department.error) throw new Error(department.error.message);
      assertPropertyRecord(department.data, data.propertyId);
    }
    const payload = {
      property_id: data.propertyId,
      title: data.title,
      code: data.code,
      description: data.description?.trim() || null,
      department_id: data.departmentId ?? null,
      rank: data.rank ?? null,
      status: data.status ?? "active",
    };
    const result = data.id
      ? await db.from("hr_designations").update(payload).eq("id", data.id).select("*").single()
      : await db.from("hr_designations").insert(payload).select("*").single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      data.id ? "update" : "create",
      "hr_designation",
      result.data.id,
      existing.data,
      result.data,
    );
    return result.data;
  });

export const setDesignationArchived = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; id: string; archived: boolean }) => data)
  .handler(async ({ data, context }) => {
    requirePropertyId(data.propertyId);
    await authorize(context, data.propertyId, HRM_PERMISSIONS.designationManage);
    const db = context.supabase as any;
    const current = await db.from("hr_designations").select("*").eq("id", data.id).maybeSingle();
    if (current.error) throw new Error(current.error.message);
    assertPropertyRecord(current.data, data.propertyId);
    if (data.archived) {
      const assigned = await db
        .from("hr_employees")
        .select("id", { count: "exact", head: true })
        .eq("property_id", data.propertyId)
        .eq("designation_id", data.id)
        .is("archived_at", null);
      if (assigned.error) throw new Error(assigned.error.message);
      if ((assigned.count ?? 0) > 0) {
        throw new Error("Reassign active employees before archiving this designation");
      }
    }
    const update = data.archived
      ? {
          archived_at: new Date().toISOString(),
          archived_by: context.userId,
          status: "archived",
        }
      : { archived_at: null, archived_by: null, status: "active" };
    const result = await db
      .from("hr_designations")
      .update(update)
      .eq("id", data.id)
      .eq("property_id", data.propertyId)
      .select("*")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      data.archived ? "delete" : "update",
      "hr_designation",
      data.id,
      current.data,
      result.data,
    );
    return result.data;
  });

export const listEmployees = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.employeeView);
    const { from: start, to: end } = pageRange(data.page!, data.pageSize!);
    const db = context.supabase as any;
    let query = db
      .from("hr_employees")
      .select(
        "id,property_id,employee_number,first_name,middle_name,last_name,preferred_name,profile_photo_path,work_email,department_id,designation_id,employment_type,employment_status,hire_date,staff_user_id,archived_at,department:department_id(id,name),designation:designation_id(id,title)",
        { count: "exact" },
      )
      .eq("property_id", data.propertyId)
      .order("last_name")
      .order("first_name")
      .range(start, end);
    if (data.search) {
      const term = filterTerm(data.search);
      if (term) {
        query = query.or(
          `employee_number.ilike.%${term}%,first_name.ilike.%${term}%,last_name.ilike.%${term}%,work_email.ilike.%${term}%`,
        );
      }
    }
    if (data.departmentId) query = query.eq("department_id", data.departmentId);
    if (data.designationId) query = query.eq("designation_id", data.designationId);
    if (data.status === "archived") query = query.not("archived_at", "is", null);
    else if (data.status)
      query = query.eq("employment_status", data.status).is("archived_at", null);
    else query = query.is("archived_at", null);
    if (data.from) query = query.gte("hire_date", data.from);
    if (data.to) query = query.lte("hire_date", data.to);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const getEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; id: string }) => data)
  .handler(async ({ data, context }) => {
    requirePropertyId(data.propertyId);
    await authorize(context, data.propertyId, HRM_PERMISSIONS.employeeView);
    const db = context.supabase as any;
    const employee = await db
      .from("hr_employees")
      .select(
        "*,department:department_id(id,name),designation:designation_id(id,title),manager:reporting_manager_id(id,employee_number,first_name,last_name)",
      )
      .eq("id", data.id)
      .maybeSingle();
    if (employee.error) throw new Error(employee.error.message);
    assertPropertyRecord(employee.data, data.propertyId);
    let privateData = null;
    try {
      await authorize(context, data.propertyId, HRM_PERMISSIONS.sensitiveEmployeeView);
      const privateResult = await db
        .from("hr_employee_private")
        .select("*")
        .eq("employee_id", data.id)
        .eq("property_id", data.propertyId)
        .maybeSingle();
      if (privateResult.error) throw new Error(privateResult.error.message);
      privateData = privateResult.data;
    } catch {
      privateData = null;
    }
    const documents = await db
      .from("hr_employee_documents")
      .select("id,title,category,status,confidentiality_level,expiry_date,created_at")
      .eq("employee_id", data.id)
      .eq("property_id", data.propertyId)
      .is("archived_at", null)
      .order("created_at", { ascending: false });
    if (documents.error) throw new Error(documents.error.message);
    return {
      ...employee.data,
      private: privateData,
      documents: documents.data ?? [],
      profileCompleteness: employeeProfileCompleteness({
        ...employee.data,
        ...(privateData ?? {}),
      }),
    };
  });

export const saveEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      propertyId: string;
      id?: string;
      employeeNumber: string;
      firstName: string;
      middleName?: string;
      lastName: string;
      preferredName?: string;
      workEmail?: string;
      departmentId?: string | null;
      designationId?: string | null;
      employmentType: string;
      employmentStatus: string;
      hireDate: string;
      probationEndDate?: string | null;
      confirmationDate?: string | null;
      exitDate?: string | null;
      reportingManagerId?: string | null;
      workLocation?: string;
      staffUserId?: string | null;
      notes?: string;
      tags?: string[];
      private?: Record<string, string | null | undefined>;
    }) => {
      requirePropertyId(data.propertyId);
      validateEmployeeDates(data);
      return {
        ...data,
        employeeNumber: validateRequiredText(data.employeeNumber, "Employee number", 50),
        firstName: validateRequiredText(data.firstName, "First name", 100),
        lastName: validateRequiredText(data.lastName, "Last name", 100),
      };
    },
  )
  .handler(async ({ data, context }) => {
    await authorize(
      context,
      data.propertyId,
      data.id ? HRM_PERMISSIONS.employeeEdit : HRM_PERMISSIONS.employeeCreate,
    );
    const db = context.supabase as any;
    const existing = data.id
      ? await db.from("hr_employees").select("*").eq("id", data.id).maybeSingle()
      : { data: null, error: null };
    if (existing.error) throw new Error(existing.error.message);
    if (data.id) assertPropertyRecord(existing.data, data.propertyId);
    for (const [table, id] of [
      ["hr_departments", data.departmentId],
      ["hr_designations", data.designationId],
      ["hr_employees", data.reportingManagerId],
    ] as const) {
      if (!id) continue;
      const related = await db.from(table).select("property_id").eq("id", id).maybeSingle();
      if (related.error) throw new Error(related.error.message);
      assertPropertyRecord(related.data, data.propertyId);
    }
    if (data.reportingManagerId && data.reportingManagerId === data.id) {
      throw new Error("An employee cannot report to themselves");
    }
    if (data.staffUserId) {
      const linked = await db
        .from("hr_employees")
        .select("id")
        .eq("property_id", data.propertyId)
        .eq("staff_user_id", data.staffUserId)
        .is("archived_at", null)
        .neq("id", data.id ?? "00000000-0000-0000-0000-000000000000")
        .maybeSingle();
      if (linked.error) throw new Error(linked.error.message);
      if (linked.data)
        throw new Error("This staff account is already linked to an active employee");
    }
    const payload = {
      property_id: data.propertyId,
      employee_number: data.employeeNumber.trim(),
      first_name: data.firstName,
      middle_name: data.middleName?.trim() || null,
      last_name: data.lastName,
      preferred_name: data.preferredName?.trim() || null,
      work_email: data.workEmail?.trim() || null,
      department_id: data.departmentId ?? null,
      designation_id: data.designationId ?? null,
      employment_type: data.employmentType,
      employment_status: data.employmentStatus,
      hire_date: data.hireDate,
      probation_end_date: data.probationEndDate || null,
      confirmation_date: data.confirmationDate || null,
      exit_date: data.exitDate || null,
      reporting_manager_id: data.reportingManagerId ?? null,
      work_location: data.workLocation?.trim() || null,
      staff_user_id: data.staffUserId ?? null,
      notes: data.notes?.trim() || null,
      tags: (data.tags ?? [])
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 30),
      updated_by: context.userId,
      ...(data.id ? {} : { created_by: context.userId }),
    };
    const result = data.id
      ? await db.from("hr_employees").update(payload).eq("id", data.id).select("*").single()
      : await db.from("hr_employees").insert(payload).select("*").single();
    if (result.error) throw new Error(result.error.message);

    if (data.private && Object.values(data.private).some((value) => value)) {
      await authorize(context, data.propertyId, HRM_PERMISSIONS.sensitiveEmployeeView);
      const privatePayload = {
        employee_id: result.data.id,
        property_id: data.propertyId,
        date_of_birth: data.private.dateOfBirth || null,
        gender: data.private.gender?.trim() || null,
        nationality: data.private.nationality?.trim() || null,
        marital_status: data.private.maritalStatus?.trim() || null,
        personal_email: data.private.personalEmail?.trim() || null,
        primary_phone: data.private.primaryPhone?.trim() || null,
        alternate_phone: data.private.alternatePhone?.trim() || null,
        residential_address: data.private.residentialAddress?.trim() || null,
        emergency_contact_name: data.private.emergencyContactName?.trim() || null,
        emergency_contact_relationship: data.private.emergencyContactRelationship?.trim() || null,
        emergency_contact_phone: data.private.emergencyContactPhone?.trim() || null,
      };
      const privateResult = await db
        .from("hr_employee_private")
        .upsert(privatePayload, { onConflict: "employee_id" });
      if (privateResult.error) throw new Error(privateResult.error.message);
      await audit(context, data.propertyId, "update", "hr_employee_private", result.data.id, null, {
        restrictedDetailsUpdated: true,
      });
    }
    await audit(
      context,
      data.propertyId,
      data.id ? "update" : "create",
      "hr_employee",
      result.data.id,
      existing.data,
      result.data,
    );
    return result.data;
  });

export const setEmployeeArchived = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; id: string; archived: boolean }) => data)
  .handler(async ({ data, context }) => {
    requirePropertyId(data.propertyId);
    await authorize(context, data.propertyId, HRM_PERMISSIONS.employeeArchive);
    const db = context.supabase as any;
    const current = await db.from("hr_employees").select("*").eq("id", data.id).maybeSingle();
    if (current.error) throw new Error(current.error.message);
    assertPropertyRecord(current.data, data.propertyId);
    const result = await db
      .from("hr_employees")
      .update(
        data.archived
          ? {
              archived_at: new Date().toISOString(),
              archived_by: context.userId,
              employment_status: "archived",
              updated_by: context.userId,
            }
          : {
              archived_at: null,
              archived_by: null,
              employment_status: "active",
              updated_by: context.userId,
            },
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
      "hr_employee",
      data.id,
      current.data,
      result.data,
    );
    return result.data;
  });

export const createEmployeePhotoTicket = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      propertyId: string;
      employeeId: string;
      fileName: string;
      fileType: string;
      fileSize: number;
    }) => data,
  )
  .handler(async ({ data, context }) => {
    requirePropertyId(data.propertyId);
    await authorize(context, data.propertyId, HRM_PERMISSIONS.employeeEdit);
    validateEmployeeDocument({ type: data.fileType, size: data.fileSize });
    if (!data.fileType.startsWith("image/")) throw new Error("Profile photos must be JPEG or PNG");
    const db = context.supabase as any;
    const employee = await db
      .from("hr_employees")
      .select("property_id")
      .eq("id", data.employeeId)
      .maybeSingle();
    if (employee.error) throw new Error(employee.error.message);
    assertPropertyRecord(employee.data, data.propertyId);
    const path = `${data.propertyId}/employees/${data.employeeId}/profile/${crypto.randomUUID()}-${safeStorageSegment(data.fileName)}`;
    return { bucket: "employee-documents", path };
  });

export const updateEmployeePhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; employeeId: string; storagePath: string }) => data)
  .handler(async ({ data, context }) => {
    requirePropertyId(data.propertyId);
    await authorize(context, data.propertyId, HRM_PERMISSIONS.employeeEdit);
    const prefix = `${data.propertyId}/employees/${data.employeeId}/profile/`;
    if (!data.storagePath.startsWith(prefix) || data.storagePath.includes("..")) {
      throw new Error("Invalid profile photo path");
    }
    const db = context.supabase as any;
    const current = await db
      .from("hr_employees")
      .select("property_id,profile_photo_path")
      .eq("id", data.employeeId)
      .maybeSingle();
    if (current.error) throw new Error(current.error.message);
    assertPropertyRecord(current.data, data.propertyId);
    const result = await db
      .from("hr_employees")
      .update({ profile_photo_path: data.storagePath, updated_by: context.userId })
      .eq("id", data.employeeId)
      .eq("property_id", data.propertyId);
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      "update",
      "hr_employee_photo",
      data.employeeId,
      { profilePhoto: current.data.profile_photo_path },
      { profilePhoto: data.storagePath },
    );
    return { ok: true };
  });

export const listEmployeeDocuments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.documentView);
    const { from: start, to: end } = pageRange(data.page!, data.pageSize!);
    const db = context.supabase as any;
    let query = db
      .from("hr_employee_documents")
      .select("*,employee:employee_id(id,employee_number,first_name,last_name)", { count: "exact" })
      .eq("property_id", data.propertyId)
      .order("created_at", { ascending: false })
      .range(start, end);
    if (data.search) {
      const term = filterTerm(data.search);
      if (term) query = query.or(`title.ilike.%${term}%,file_name.ilike.%${term}%`);
    }
    if (data.status === "archived") query = query.not("archived_at", "is", null);
    else if (data.status === "expiring") {
      const horizon = new Date();
      horizon.setDate(horizon.getDate() + 30);
      query = query
        .is("archived_at", null)
        .gte("expiry_date", new Date().toISOString().slice(0, 10))
        .lte("expiry_date", horizon.toISOString().slice(0, 10));
    } else if (data.status === "expired") {
      query = query
        .is("archived_at", null)
        .lt("expiry_date", new Date().toISOString().slice(0, 10));
    } else query = query.is("archived_at", null);
    if (data.departmentId) query = query.eq("employee_id", data.departmentId);
    if (data.from) query = query.gte("created_at", `${data.from}T00:00:00.000Z`);
    if (data.to) query = query.lte("created_at", `${data.to}T23:59:59.999Z`);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const createDocumentUploadTicket = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      propertyId: string;
      employeeId: string;
      fileName: string;
      fileType: string;
      fileSize: number;
    }) => data,
  )
  .handler(async ({ data, context }) => {
    requirePropertyId(data.propertyId);
    await authorize(context, data.propertyId, HRM_PERMISSIONS.documentUpload);
    validateEmployeeDocument({ type: data.fileType, size: data.fileSize });
    const db = context.supabase as any;
    const employee = await db
      .from("hr_employees")
      .select("property_id")
      .eq("id", data.employeeId)
      .maybeSingle();
    if (employee.error) throw new Error(employee.error.message);
    assertPropertyRecord(employee.data, data.propertyId);
    const documentId = crypto.randomUUID();
    return {
      bucket: "employee-documents",
      documentId,
      storagePath: employeeDocumentStoragePath({
        propertyId: data.propertyId,
        employeeId: data.employeeId,
        documentId,
        fileName: data.fileName,
      }),
    };
  });

export const registerEmployeeDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      propertyId: string;
      id: string;
      employeeId: string;
      category: string;
      title: string;
      description?: string;
      storagePath: string;
      fileName: string;
      fileType: string;
      fileSize: number;
      issueDate?: string | null;
      expiryDate?: string | null;
      confidentialityLevel: "internal" | "confidential";
    }) => {
      requirePropertyId(data.propertyId);
      validateEmployeeDocument({ type: data.fileType, size: data.fileSize });
      return { ...data, title: validateRequiredText(data.title, "Document title", 160) };
    },
  )
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.documentUpload);
    const expectedPath = employeeDocumentStoragePath({
      propertyId: data.propertyId,
      employeeId: data.employeeId,
      documentId: data.id,
      fileName: data.fileName,
    });
    if (expectedPath !== data.storagePath) throw new Error("Invalid document storage path");
    const db = context.supabase as any;
    const employee = await db
      .from("hr_employees")
      .select("property_id")
      .eq("id", data.employeeId)
      .maybeSingle();
    if (employee.error) throw new Error(employee.error.message);
    assertPropertyRecord(employee.data, data.propertyId);
    const result = await db
      .from("hr_employee_documents")
      .insert({
        id: data.id,
        property_id: data.propertyId,
        employee_id: data.employeeId,
        category: data.category,
        title: data.title,
        description: data.description?.trim() || null,
        storage_path: data.storagePath,
        file_name: data.fileName,
        file_type: data.fileType,
        file_size: data.fileSize,
        issue_date: validateIsoDate(data.issueDate, "Issue date"),
        expiry_date: validateIsoDate(data.expiryDate, "Expiry date"),
        confidentiality_level: data.confidentialityLevel,
        uploaded_by: context.userId,
      })
      .select("*")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(context, data.propertyId, "create", "hr_employee_document", result.data.id, null, {
      employeeId: data.employeeId,
      category: data.category,
      title: data.title,
      fileName: data.fileName,
      fileType: data.fileType,
      fileSize: data.fileSize,
      confidentialityLevel: data.confidentialityLevel,
    });
    return result.data;
  });

export const getEmployeeDocumentDownload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; id: string }) => data)
  .handler(async ({ data, context }) => {
    requirePropertyId(data.propertyId);
    await authorize(context, data.propertyId, HRM_PERMISSIONS.documentView);
    const db = context.supabase as any;
    const document = await db
      .from("hr_employee_documents")
      .select("id,property_id,storage_path,confidentiality_level,file_name")
      .eq("id", data.id)
      .maybeSingle();
    if (document.error) throw new Error(document.error.message);
    assertPropertyRecord(document.data, data.propertyId);
    if (document.data.confidentiality_level === "confidential") {
      await authorize(context, data.propertyId, HRM_PERMISSIONS.confidentialDocumentView);
    }
    const signed = await db.storage
      .from("employee-documents")
      .createSignedUrl(document.data.storage_path, 60, {
        download: document.data.file_name,
      });
    if (signed.error) throw new Error(signed.error.message);
    await audit(context, data.propertyId, "view", "hr_employee_document", data.id, null, {
      downloaded: true,
      confidentialityLevel: document.data.confidentiality_level,
    });
    return { url: signed.data.signedUrl };
  });

export const updateEmployeeDocumentMetadata = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      propertyId: string;
      id: string;
      category: string;
      title: string;
      description?: string;
      issueDate?: string | null;
      expiryDate?: string | null;
      confidentialityLevel: "internal" | "confidential";
    }) => {
      requirePropertyId(data.propertyId);
      return { ...data, title: validateRequiredText(data.title, "Document title", 160) };
    },
  )
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.documentEdit);
    const db = context.supabase as any;
    const current = await db
      .from("hr_employee_documents")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (current.error) throw new Error(current.error.message);
    assertPropertyRecord(current.data, data.propertyId);
    const result = await db
      .from("hr_employee_documents")
      .update({
        category: data.category,
        title: data.title,
        description: data.description?.trim() || null,
        issue_date: validateIsoDate(data.issueDate, "Issue date"),
        expiry_date: validateIsoDate(data.expiryDate, "Expiry date"),
        confidentiality_level: data.confidentialityLevel,
      })
      .eq("id", data.id)
      .eq("property_id", data.propertyId)
      .select("*")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      "update",
      "hr_employee_document",
      data.id,
      {
        category: current.data.category,
        title: current.data.title,
        description: current.data.description,
        issueDate: current.data.issue_date,
        expiryDate: current.data.expiry_date,
        confidentialityLevel: current.data.confidentiality_level,
      },
      {
        category: result.data.category,
        title: result.data.title,
        description: result.data.description,
        issueDate: result.data.issue_date,
        expiryDate: result.data.expiry_date,
        confidentialityLevel: result.data.confidentiality_level,
      },
    );
    return result.data;
  });

export const setEmployeeDocumentArchived = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; id: string; archived: boolean }) => data)
  .handler(async ({ data, context }) => {
    requirePropertyId(data.propertyId);
    await authorize(context, data.propertyId, HRM_PERMISSIONS.documentArchive);
    const db = context.supabase as any;
    const current = await db
      .from("hr_employee_documents")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (current.error) throw new Error(current.error.message);
    assertPropertyRecord(current.data, data.propertyId);
    const result = await db
      .from("hr_employee_documents")
      .update(
        data.archived
          ? {
              archived_at: new Date().toISOString(),
              archived_by: context.userId,
              status: "archived",
            }
          : { archived_at: null, archived_by: null, status: "active" },
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
      "hr_employee_document",
      data.id,
      { status: current.data.status, archivedAt: current.data.archived_at },
      { status: result.data.status, archivedAt: result.data.archived_at },
    );
    return result.data;
  });

export const listStaffAnnouncements = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.announcementView);
    const { from: start, to: end } = pageRange(data.page!, data.pageSize!);
    const db = context.supabase as any;
    let query = db
      .from("hr_staff_announcements")
      .select(
        "*,hr_announcement_departments(department_id),hr_announcement_designations(designation_id),hr_announcement_employees(employee_id)",
        { count: "exact" },
      )
      .eq("property_id", data.propertyId)
      .order("created_at", { ascending: false })
      .range(start, end);
    if (data.search) {
      const term = filterTerm(data.search);
      if (term) query = query.or(`title.ilike.%${term}%,content.ilike.%${term}%`);
    }
    if (data.status === "archived") query = query.not("archived_at", "is", null);
    else if (data.status)
      query = query.eq("publication_status", data.status).is("archived_at", null);
    else query = query.is("archived_at", null);
    if (data.from) query = query.gte("created_at", `${data.from}T00:00:00.000Z`);
    if (data.to) query = query.lte("created_at", `${data.to}T23:59:59.999Z`);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return { rows: result.data ?? [], total: result.count ?? 0 };
  });

export const saveStaffAnnouncement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      propertyId: string;
      id?: string;
      title: string;
      content: string;
      audienceType: "all_staff" | "departments" | "designations" | "employees";
      audienceIds?: string[];
      publishDate?: string | null;
      expiryDate?: string | null;
      priority: "low" | "normal" | "high" | "urgent";
    }) => {
      requirePropertyId(data.propertyId);
      return {
        ...data,
        title: validateRequiredText(data.title, "Announcement title", 180),
        content: validateRequiredText(data.content, "Announcement content", 10000),
      };
    },
  )
  .handler(async ({ data, context }) => {
    await authorize(context, data.propertyId, HRM_PERMISSIONS.announcementManage);
    const db = context.supabase as any;
    const existing = data.id
      ? await db.from("hr_staff_announcements").select("*").eq("id", data.id).maybeSingle()
      : { data: null, error: null };
    if (existing.error) throw new Error(existing.error.message);
    if (data.id) assertPropertyRecord(existing.data, data.propertyId);
    const payload = {
      property_id: data.propertyId,
      title: data.title,
      content: data.content,
      audience_type: data.audienceType,
      publish_date: data.publishDate || null,
      expiry_date: data.expiryDate || null,
      priority: data.priority,
      created_by: existing.data?.created_by ?? context.userId,
    };
    const result = data.id
      ? await db
          .from("hr_staff_announcements")
          .update(payload)
          .eq("id", data.id)
          .select("*")
          .single()
      : await db.from("hr_staff_announcements").insert(payload).select("*").single();
    if (result.error) throw new Error(result.error.message);

    const junctions = {
      departments: ["hr_announcement_departments", "department_id"],
      designations: ["hr_announcement_designations", "designation_id"],
      employees: ["hr_announcement_employees", "employee_id"],
    } as const;
    for (const [audience, [table]] of Object.entries(junctions) as [
      keyof typeof junctions,
      readonly [string, string],
    ][]) {
      const removed = await db
        .from(table)
        .delete()
        .eq("announcement_id", result.data.id)
        .eq("property_id", data.propertyId);
      if (removed.error) throw new Error(removed.error.message);
      if (data.audienceType === audience && (data.audienceIds?.length ?? 0) > 0) {
        const key = junctions[audience][1];
        const rows = [...new Set(data.audienceIds)].map((id) => ({
          announcement_id: result.data.id,
          property_id: data.propertyId,
          [key]: id,
        }));
        const inserted = await db.from(table).insert(rows);
        if (inserted.error) throw new Error(inserted.error.message);
      }
    }
    await audit(
      context,
      data.propertyId,
      data.id ? "update" : "create",
      "hr_staff_announcement",
      result.data.id,
      existing.data,
      { ...result.data, audienceIds: data.audienceIds ?? [] },
    );
    return result.data;
  });

export const setAnnouncementPublication = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      propertyId: string;
      id: string;
      action: "publish" | "unpublish" | "archive" | "restore";
    }) => data,
  )
  .handler(async ({ data, context }) => {
    requirePropertyId(data.propertyId);
    await authorize(
      context,
      data.propertyId,
      data.action === "publish" || data.action === "unpublish"
        ? HRM_PERMISSIONS.announcementPublish
        : HRM_PERMISSIONS.announcementManage,
    );
    const db = context.supabase as any;
    const current = await db
      .from("hr_staff_announcements")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (current.error) throw new Error(current.error.message);
    assertPropertyRecord(current.data, data.propertyId);
    const updates = {
      publish: {
        publication_status: "published",
        publish_date: current.data.publish_date ?? new Date().toISOString(),
        archived_at: null,
        archived_by: null,
      },
      unpublish: { publication_status: "unpublished" },
      archive: {
        publication_status: "archived",
        archived_at: new Date().toISOString(),
        archived_by: context.userId,
      },
      restore: {
        publication_status: "draft",
        archived_at: null,
        archived_by: null,
      },
    };
    const result = await db
      .from("hr_staff_announcements")
      .update(updates[data.action])
      .eq("id", data.id)
      .eq("property_id", data.propertyId)
      .select("*")
      .single();
    if (result.error) throw new Error(result.error.message);
    if (data.action === "publish") {
      const notificationResult = await db.rpc("publish_hrm_announcement_notifications", {
        _announcement_id: data.id,
      });
      if (notificationResult.error) throw new Error(notificationResult.error.message);
    }
    await audit(
      context,
      data.propertyId,
      data.action === "publish" ? "approve" : "update",
      "hr_staff_announcement",
      data.id,
      { publicationStatus: current.data.publication_status },
      { publicationStatus: result.data.publication_status },
    );
    return result.data;
  });

export const listHrmAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { propertyId: string; resourceType: string; resourceId?: string; limit?: number }) =>
      data,
  )
  .handler(async ({ data, context }) => {
    requirePropertyId(data.propertyId);
    await authorize(context, data.propertyId, HRM_PERMISSIONS.employeeView);
    const db = context.supabase as any;
    let query = db
      .from("admin_action_logs")
      .select("id,action,entity_type,entity_id,actor_id,created_at,success,remarks")
      .eq("property_id", data.propertyId)
      .eq("entity_type", data.resourceType)
      .order("created_at", { ascending: false })
      .limit(Math.min(100, Math.max(1, data.limit ?? 20)));
    if (data.resourceId) query = query.eq("entity_id", data.resourceId);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return result.data ?? [];
  });
