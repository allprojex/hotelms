import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Archive, Eye, Pencil, Plus, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  DataQueryState,
  ServerPagination,
  SharedListFilters,
} from "@/components/shared/data-query-controls";
import { useActiveProperty } from "@/hooks/use-active-property";
import { usePermission } from "@/hooks/use-permission";
import {
  getEmployee,
  listEmployees,
  saveEmployee,
  setEmployeeArchived,
} from "@/lib/hrm/hrm.functions";
import {
  HrmPageHeader,
  OptionalSelect,
  useHrmListState,
  useHrmOptions,
} from "@/components/hrm/shared";
import { HRM_ADMIN_ROLES } from "@/lib/hrm/permissions";

type EmployeeRow = {
  id: string;
  employee_number: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  preferred_name: string | null;
  work_email: string | null;
  department_id: string | null;
  designation_id: string | null;
  employment_type: string;
  employment_status: string;
  hire_date: string;
  staff_user_id: string | null;
  archived_at: string | null;
  department?: { name?: string } | null;
  designation?: { title?: string } | null;
};

const EMPLOYMENT_TYPES = ["full_time", "part_time", "contract", "temporary", "casual", "intern"];

const EMPLOYMENT_STATUSES = ["active", "probation", "inactive", "suspended", "exited"];

export function EmployeesPage() {
  const propertyId = useActiveProperty();
  const list = useServerFn(listEmployees);
  const archive = useServerFn(setEmployeeArchived);
  const getOne = useServerFn(getEmployee);
  const options = useHrmOptions(propertyId);
  const qc = useQueryClient();
  const canCreate = usePermission({
    propertyId,
    module: "employees",
    capability: "create",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const canEdit = usePermission({
    propertyId,
    module: "employees",
    capability: "edit",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const canArchive = usePermission({
    propertyId,
    module: "employees",
    capability: "delete_or_archive",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const state = useHrmListState();
  const [departmentId, setDepartmentId] = useState("");
  const [designationId, setDesignationId] = useState("");
  const [editing, setEditing] = useState<Record<string, unknown> | null | undefined>(undefined);
  const query = useQuery({
    queryKey: [
      "hrm-employees",
      propertyId,
      state.search,
      state.from,
      state.to,
      state.status,
      departmentId,
      designationId,
      state.page,
      state.pageSize,
    ],
    enabled: !!propertyId,
    queryFn: () =>
      list({
        data: {
          propertyId: propertyId!,
          search: state.search,
          from: state.from ?? undefined,
          to: state.to ?? undefined,
          status: state.status,
          departmentId,
          designationId,
          page: state.page,
          pageSize: state.pageSize,
        },
      }),
  });
  const rows = (query.data?.rows ?? []) as EmployeeRow[];

  async function edit(row: EmployeeRow) {
    try {
      setEditing(await getOne({ data: { propertyId: propertyId!, id: row.id } }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load employee");
    }
  }

  async function toggleArchive(row: EmployeeRow) {
    const archived = !row.archived_at;
    if (archived && !confirm(`Archive ${row.first_name} ${row.last_name}?`)) return;
    try {
      await archive({ data: { propertyId: propertyId!, id: row.id, archived } });
      toast.success(archived ? "Employee archived" : "Employee restored");
      qc.invalidateQueries({ queryKey: ["hrm-employees"] });
      qc.invalidateQueries({ queryKey: ["hrm-options"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update employee");
    }
  }

  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Employees"
        description="Manage employee records without requiring or creating login accounts."
        actions={
          canCreate.allowed ? (
            <Button onClick={() => setEditing(null)}>
              <Plus className="mr-1 h-4 w-4" /> New employee
            </Button>
          ) : undefined
        }
      />
      <Card className="p-3">
        <SharedListFilters
          search={state.search}
          from={state.from}
          to={state.to}
          onSearchChange={state.setSearch}
          onFromChange={state.setFrom}
          onToChange={state.setTo}
          onClear={() => {
            state.clear();
            setDepartmentId("");
            setDesignationId("");
          }}
        >
          <OptionalSelect
            id="employee-department-filter"
            label="Department"
            value={departmentId}
            onChange={(value) => {
              setDepartmentId(value);
              state.setPage(1);
            }}
            options={(options.data?.departments ?? []).map((row) => ({
              value: row.id,
              label: row.name ?? "",
            }))}
            placeholder="All departments"
          />
          <OptionalSelect
            id="employee-designation-filter"
            label="Designation"
            value={designationId}
            onChange={(value) => {
              setDesignationId(value);
              state.setPage(1);
            }}
            options={(options.data?.designations ?? []).map((row) => ({
              value: row.id,
              label: row.title ?? "",
            }))}
            placeholder="All designations"
          />
          <div className="space-y-1">
            <Label htmlFor="employee-status-filter">Status</Label>
            <Select
              value={state.status || "current"}
              onValueChange={(value) => state.setStatus(value === "current" ? "" : value)}
            >
              <SelectTrigger id="employee-status-filter" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="current">Current</SelectItem>
                {EMPLOYMENT_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {label(status)}
                  </SelectItem>
                ))}
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </SharedListFilters>
      </Card>
      <Card>
        <DataQueryState loading={query.isLoading} error={query.error} empty={rows.length === 0}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Designation</TableHead>
                <TableHead>Employment</TableHead>
                <TableHead>Hire date</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <p className="font-medium">
                      {row.first_name} {row.last_name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {row.employee_number}
                      {row.work_email ? ` · ${row.work_email}` : ""}
                    </p>
                  </TableCell>
                  <TableCell>{row.department?.name ?? "—"}</TableCell>
                  <TableCell>{row.designation?.title ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={row.archived_at ? "secondary" : "outline"}>
                      {label(row.employment_status)}
                    </Badge>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {label(row.employment_type)}
                    </p>
                  </TableCell>
                  <TableCell>{row.hire_date}</TableCell>
                  <TableCell className="text-right">
                    <Button asChild size="icon" variant="ghost">
                      <Link
                        to="/hrm/employees/$employeeId"
                        params={{ employeeId: row.id }}
                        aria-label={`View ${row.first_name} ${row.last_name}`}
                      >
                        <Eye className="h-4 w-4" />
                      </Link>
                    </Button>
                    {canEdit.allowed && !row.archived_at && (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Edit ${row.first_name} ${row.last_name}`}
                        onClick={() => edit(row)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                    {canArchive.allowed && (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={row.archived_at ? "Restore employee" : "Archive employee"}
                        onClick={() => toggleArchive(row)}
                      >
                        {row.archived_at ? (
                          <RotateCcw className="h-4 w-4" />
                        ) : (
                          <Archive className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DataQueryState>
      </Card>
      <ServerPagination
        page={state.page}
        pageSize={state.pageSize}
        totalRows={query.data?.total ?? 0}
        onPageChange={state.setPage}
        onPageSizeChange={state.setPageSize}
      />
      {editing !== undefined && propertyId && (
        <EmployeeDialog
          propertyId={propertyId}
          employee={editing}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}

function EmployeeDialog({
  propertyId,
  employee,
  onClose,
}: {
  propertyId: string;
  employee: Record<string, unknown> | null;
  onClose: () => void;
}) {
  const save = useServerFn(saveEmployee);
  const options = useHrmOptions(propertyId);
  const qc = useQueryClient();
  const privateData = (employee?.private ?? {}) as Record<string, string | null>;
  const [form, setForm] = useState({
    employeeNumber: String(employee?.employee_number ?? ""),
    firstName: String(employee?.first_name ?? ""),
    middleName: String(employee?.middle_name ?? ""),
    lastName: String(employee?.last_name ?? ""),
    preferredName: String(employee?.preferred_name ?? ""),
    workEmail: String(employee?.work_email ?? ""),
    departmentId: String(employee?.department_id ?? ""),
    designationId: String(employee?.designation_id ?? ""),
    employmentType: String(employee?.employment_type ?? "full_time"),
    employmentStatus: String(employee?.employment_status ?? "active"),
    hireDate: String(employee?.hire_date ?? new Date().toISOString().slice(0, 10)),
    probationEndDate: String(employee?.probation_end_date ?? ""),
    confirmationDate: String(employee?.confirmation_date ?? ""),
    exitDate: String(employee?.exit_date ?? ""),
    reportingManagerId: String(employee?.reporting_manager_id ?? ""),
    workLocation: String(employee?.work_location ?? ""),
    staffUserId: String(employee?.staff_user_id ?? ""),
    notes: String(employee?.notes ?? ""),
    tags: Array.isArray(employee?.tags) ? employee.tags.join(", ") : "",
    personalEmail: privateData.personal_email ?? "",
    primaryPhone: privateData.primary_phone ?? "",
    residentialAddress: privateData.residential_address ?? "",
    emergencyContactName: privateData.emergency_contact_name ?? "",
    emergencyContactRelationship: privateData.emergency_contact_relationship ?? "",
    emergencyContactPhone: privateData.emergency_contact_phone ?? "",
  });
  const [busy, setBusy] = useState(false);
  const field = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });

  async function submit() {
    setBusy(true);
    try {
      await save({
        data: {
          propertyId,
          id: employee?.id ? String(employee.id) : undefined,
          employeeNumber: form.employeeNumber,
          firstName: form.firstName,
          middleName: form.middleName,
          lastName: form.lastName,
          preferredName: form.preferredName,
          workEmail: form.workEmail,
          departmentId: form.departmentId || null,
          designationId: form.designationId || null,
          employmentType: form.employmentType,
          employmentStatus: form.employmentStatus,
          hireDate: form.hireDate,
          probationEndDate: form.probationEndDate || null,
          confirmationDate: form.confirmationDate || null,
          exitDate: form.exitDate || null,
          reportingManagerId: form.reportingManagerId || null,
          workLocation: form.workLocation,
          staffUserId: form.staffUserId || null,
          notes: form.notes,
          tags: form.tags.split(",").map((tag) => tag.trim()),
          private: {
            personalEmail: form.personalEmail,
            primaryPhone: form.primaryPhone,
            residentialAddress: form.residentialAddress,
            emergencyContactName: form.emergencyContactName,
            emergencyContactRelationship: form.emergencyContactRelationship,
            emergencyContactPhone: form.emergencyContactPhone,
          },
        },
      });
      toast.success(employee ? "Employee updated" : "Employee created");
      qc.invalidateQueries({ queryKey: ["hrm-employees"] });
      qc.invalidateQueries({ queryKey: ["hrm-options"] });
      qc.invalidateQueries({ queryKey: ["hrm-dashboard"] });
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save employee");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{employee ? "Edit employee" : "New employee"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <EmployeeField
            id="employee-number"
            label="Employee number"
            value={form.employeeNumber}
            onChange={field("employeeNumber")}
          />
          <EmployeeField
            id="employee-work-email"
            label="Work email"
            type="email"
            value={form.workEmail}
            onChange={field("workEmail")}
          />
          <EmployeeField
            id="employee-first-name"
            label="First name"
            value={form.firstName}
            onChange={field("firstName")}
          />
          <EmployeeField
            id="employee-last-name"
            label="Last name"
            value={form.lastName}
            onChange={field("lastName")}
          />
          <EmployeeField
            id="employee-middle-name"
            label="Middle name"
            value={form.middleName}
            onChange={field("middleName")}
          />
          <EmployeeField
            id="employee-preferred-name"
            label="Preferred name"
            value={form.preferredName}
            onChange={field("preferredName")}
          />
          <OptionalSelect
            id="employee-department"
            label="Department"
            value={form.departmentId}
            onChange={field("departmentId")}
            options={(options.data?.departments ?? []).map((item) => ({
              value: item.id,
              label: item.name ?? "",
            }))}
          />
          <OptionalSelect
            id="employee-designation"
            label="Designation"
            value={form.designationId}
            onChange={field("designationId")}
            options={(options.data?.designations ?? []).map((item) => ({
              value: item.id,
              label: item.title ?? "",
            }))}
          />
          <Choice
            id="employee-type"
            label="Employment type"
            value={form.employmentType}
            onChange={field("employmentType")}
            options={EMPLOYMENT_TYPES}
          />
          <Choice
            id="employee-status"
            label="Employment status"
            value={form.employmentStatus}
            onChange={field("employmentStatus")}
            options={EMPLOYMENT_STATUSES}
          />
          <EmployeeField
            id="employee-hire-date"
            label="Hire date"
            type="date"
            value={form.hireDate}
            onChange={field("hireDate")}
          />
          <EmployeeField
            id="employee-probation-date"
            label="Probation end date"
            type="date"
            value={form.probationEndDate}
            onChange={field("probationEndDate")}
          />
          <EmployeeField
            id="employee-confirmation-date"
            label="Confirmation date"
            type="date"
            value={form.confirmationDate}
            onChange={field("confirmationDate")}
          />
          <EmployeeField
            id="employee-exit-date"
            label="Exit date"
            type="date"
            value={form.exitDate}
            onChange={field("exitDate")}
          />
          <OptionalSelect
            id="employee-manager"
            label="Reporting manager"
            value={form.reportingManagerId}
            onChange={field("reportingManagerId")}
            options={(options.data?.employees ?? [])
              .filter((item) => item.id !== employee?.id)
              .map((item) => ({
                value: item.id,
                label: `${item.first_name ?? ""} ${item.last_name ?? ""}`,
              }))}
          />
          <OptionalSelect
            id="employee-account"
            label="Existing staff account"
            value={form.staffUserId}
            onChange={field("staffUserId")}
            options={(options.data?.profiles ?? []).map((item) => ({
              value: item.id,
              label: item.full_name ?? item.id,
            }))}
            placeholder="No linked account"
          />
          <EmployeeField
            id="employee-location"
            label="Work location"
            value={form.workLocation}
            onChange={field("workLocation")}
          />
          <EmployeeField
            id="employee-tags"
            label="Tags"
            value={form.tags}
            onChange={field("tags")}
          />
          <h3 className="border-t pt-3 font-medium sm:col-span-2">Restricted contact details</h3>
          <EmployeeField
            id="employee-personal-email"
            label="Personal email"
            type="email"
            value={form.personalEmail}
            onChange={field("personalEmail")}
          />
          <EmployeeField
            id="employee-phone"
            label="Primary phone"
            value={form.primaryPhone}
            onChange={field("primaryPhone")}
          />
          <EmployeeField
            id="employee-emergency-name"
            label="Emergency contact"
            value={form.emergencyContactName}
            onChange={field("emergencyContactName")}
          />
          <EmployeeField
            id="employee-emergency-relationship"
            label="Relationship"
            value={form.emergencyContactRelationship}
            onChange={field("emergencyContactRelationship")}
          />
          <EmployeeField
            id="employee-emergency-phone"
            label="Emergency phone"
            value={form.emergencyContactPhone}
            onChange={field("emergencyContactPhone")}
          />
          <EmployeeField
            id="employee-address"
            label="Residential address"
            value={form.residentialAddress}
            onChange={field("residentialAddress")}
          />
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="employee-notes">Notes</Label>
            <Textarea
              id="employee-notes"
              value={form.notes}
              onChange={(event) => field("notes")(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={submit}>
            {busy ? "Saving…" : "Save employee"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmployeeField({
  id,
  label,
  value,
  type = "text",
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  type?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function Choice({
  id,
  label: choiceLabel,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{choiceLabel}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {label(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function label(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
