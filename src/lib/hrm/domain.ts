export const EMPLOYEE_DOCUMENT_CATEGORIES = [
  "employment_contract",
  "identification",
  "certificate",
  "qualification",
  "appointment_letter",
  "confirmation_letter",
  "policy_acknowledgment",
  "medical_document",
  "immigration_or_work_permit",
  "other",
] as const;

export const EMPLOYEE_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

export const MAX_EMPLOYEE_DOCUMENT_BYTES = 10 * 1024 * 1024;

export function normalizeHrmCode(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, "-");
}

export function validateRequiredText(value: string, label: string, max = 160): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > max) throw new Error(`${label} must be ${max} characters or fewer`);
  return normalized;
}

export function validateIsoDate(value: string | null | undefined, label: string): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} must be a valid date`);
  }
  return value;
}

export function assertPropertyRecord(
  record: { property_id: string } | null | undefined,
  propertyId: string,
): asserts record is { property_id: string } {
  if (!record || record.property_id !== propertyId) {
    throw new Error("Record not found for this property");
  }
}

export function assertNoDepartmentCycle(
  departmentId: string | null,
  parentId: string | null,
  parents: ReadonlyMap<string, string | null>,
): void {
  if (!departmentId || !parentId) return;
  if (departmentId === parentId) throw new Error("A department cannot be its own parent");
  const seen = new Set<string>([departmentId]);
  let current: string | null | undefined = parentId;
  while (current) {
    if (seen.has(current)) throw new Error("Department parent cycle detected");
    seen.add(current);
    current = parents.get(current);
  }
}

export function employeeProfileCompleteness(employee: Record<string, unknown>): number {
  const fields = [
    "first_name",
    "last_name",
    "work_email",
    "primary_phone",
    "department_id",
    "designation_id",
    "employment_type",
    "hire_date",
    "emergency_contact_name",
    "emergency_contact_phone",
  ];
  const completed = fields.filter((field) => {
    const value = employee[field];
    return value !== null && value !== undefined && String(value).trim() !== "";
  }).length;
  return Math.round((completed / fields.length) * 100);
}

export function validateEmployeeDates(input: {
  hireDate: string;
  probationEndDate?: string | null;
  confirmationDate?: string | null;
  exitDate?: string | null;
}): void {
  const hire = validateIsoDate(input.hireDate, "Hire date");
  if (!hire) throw new Error("Hire date is required");
  for (const [label, value] of [
    ["Probation end date", input.probationEndDate],
    ["Confirmation date", input.confirmationDate],
    ["Exit date", input.exitDate],
  ] as const) {
    const parsed = validateIsoDate(value, label);
    if (parsed && parsed < hire) throw new Error(`${label} cannot be before hire date`);
  }
}

export function validateEmployeeDocument(file: { type: string; size: number }): void {
  if (
    !EMPLOYEE_DOCUMENT_MIME_TYPES.includes(
      file.type as (typeof EMPLOYEE_DOCUMENT_MIME_TYPES)[number],
    )
  ) {
    throw new Error("Unsupported document type");
  }
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_EMPLOYEE_DOCUMENT_BYTES) {
    throw new Error("Document must be between 1 byte and 10 MB");
  }
}

export function safeStorageSegment(value: string): string {
  const segment = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  if (!segment || segment === "." || segment === "..") return "file";
  return segment;
}

export function employeeDocumentStoragePath(input: {
  propertyId: string;
  employeeId: string;
  documentId: string;
  fileName: string;
}): string {
  const uuid = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
  if (![input.propertyId, input.employeeId, input.documentId].every((value) => uuid.test(value))) {
    throw new Error("Invalid storage identifier");
  }
  return `${input.propertyId}/employees/${input.employeeId}/documents/${input.documentId}-${safeStorageSegment(input.fileName)}`;
}

export function announcementIsActive(
  announcement: {
    publication_status: string;
    archived_at?: string | null;
    publish_date?: string | null;
    expiry_date?: string | null;
  },
  now = new Date(),
): boolean {
  if (announcement.publication_status !== "published" || announcement.archived_at) return false;
  const time = now.getTime();
  return (
    !!announcement.publish_date &&
    Date.parse(announcement.publish_date) <= time &&
    (!announcement.expiry_date || Date.parse(announcement.expiry_date) > time)
  );
}

export function announcementTargetsEmployee(
  announcement: {
    audience_type: string;
    department_ids?: readonly string[];
    designation_ids?: readonly string[];
    employee_ids?: readonly string[];
  },
  employee: { id: string; department_id?: string | null; designation_id?: string | null },
): boolean {
  if (announcement.audience_type === "all_staff") return true;
  if (announcement.audience_type === "departments") {
    return (
      !!employee.department_id && !!announcement.department_ids?.includes(employee.department_id)
    );
  }
  if (announcement.audience_type === "designations") {
    return (
      !!employee.designation_id && !!announcement.designation_ids?.includes(employee.designation_id)
    );
  }
  return (
    announcement.audience_type === "employees" && !!announcement.employee_ids?.includes(employee.id)
  );
}
