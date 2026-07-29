import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Archive, Pencil, Plus, RotateCcw } from "lucide-react";
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
import { DataQueryState, ServerPagination } from "@/components/shared/data-query-controls";
import { useActiveProperty } from "@/hooks/use-active-property";
import { usePermission } from "@/hooks/use-permission";
import {
  listDepartments,
  listDesignations,
  saveDepartment,
  saveDesignation,
  setDepartmentArchived,
  setDesignationArchived,
} from "@/lib/hrm/hrm.functions";
import { HrmPageHeader, OptionalSelect, useHrmListState, useHrmOptions } from "./shared";
import { HRM_ADMIN_ROLES } from "@/lib/hrm/permissions";

type DepartmentRow = {
  id: string;
  name: string;
  code: string;
  description: string | null;
  status: string;
  archived_at: string | null;
  parent_department_id: string | null;
  department_head_id: string | null;
  parent?: { name?: string } | null;
  head?: { first_name?: string; last_name?: string } | null;
};

type DesignationRow = {
  id: string;
  title: string;
  code: string;
  description: string | null;
  rank: number | null;
  status: string;
  archived_at: string | null;
  department_id: string | null;
  department?: { name?: string } | null;
};

export function DepartmentsPage() {
  const propertyId = useActiveProperty();
  const list = useServerFn(listDepartments);
  const archive = useServerFn(setDepartmentArchived);
  const qc = useQueryClient();
  const manage = usePermission({
    propertyId,
    module: "departments",
    capability: "manage_settings",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const state = useHrmListState();
  const [editing, setEditing] = useState<DepartmentRow | null | undefined>(undefined);
  const query = useQuery({
    queryKey: [
      "hrm-departments",
      propertyId,
      state.search,
      state.status,
      state.page,
      state.pageSize,
    ],
    enabled: !!propertyId,
    queryFn: () =>
      list({
        data: {
          propertyId: propertyId!,
          search: state.search,
          status: state.status,
          page: state.page,
          pageSize: state.pageSize,
        },
      }),
  });
  const rows = (query.data?.rows ?? []) as DepartmentRow[];

  async function toggleArchive(row: DepartmentRow) {
    const archived = !row.archived_at;
    if (archived && !confirm(`Archive ${row.name}?`)) return;
    try {
      await archive({ data: { propertyId: propertyId!, id: row.id, archived } });
      toast.success(archived ? "Department archived" : "Department restored");
      qc.invalidateQueries({ queryKey: ["hrm-departments"] });
      qc.invalidateQueries({ queryKey: ["hrm-options"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update department");
    }
  }

  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Departments"
        description="Manage the property’s organization structure and department heads."
        actions={
          manage.allowed ? (
            <Button onClick={() => setEditing(null)}>
              <Plus className="mr-1 h-4 w-4" /> New department
            </Button>
          ) : undefined
        }
      />
      <ListToolbar state={state} />
      <Card>
        <DataQueryState loading={query.isLoading} error={query.error} empty={rows.length === 0}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Department</TableHead>
                <TableHead>Parent</TableHead>
                <TableHead>Head</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <p className="font-medium">{row.name}</p>
                    <p className="text-xs text-muted-foreground">{row.code}</p>
                  </TableCell>
                  <TableCell>{row.parent?.name ?? "—"}</TableCell>
                  <TableCell>
                    {row.head ? `${row.head.first_name ?? ""} ${row.head.last_name ?? ""}` : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.archived_at ? "secondary" : "outline"}>{row.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {manage.allowed && !row.archived_at && (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Edit ${row.name}`}
                        onClick={() => setEditing(row)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                    {manage.allowed && (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={row.archived_at ? `Restore ${row.name}` : `Archive ${row.name}`}
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
        <DepartmentDialog
          propertyId={propertyId}
          row={editing}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}

export function DesignationsPage() {
  const propertyId = useActiveProperty();
  const list = useServerFn(listDesignations);
  const archive = useServerFn(setDesignationArchived);
  const qc = useQueryClient();
  const manage = usePermission({
    propertyId,
    module: "designations",
    capability: "manage_settings",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const state = useHrmListState();
  const [departmentId, setDepartmentId] = useState("");
  const [editing, setEditing] = useState<DesignationRow | null | undefined>(undefined);
  const query = useQuery({
    queryKey: [
      "hrm-designations",
      propertyId,
      state.search,
      state.status,
      departmentId,
      state.page,
      state.pageSize,
    ],
    enabled: !!propertyId,
    queryFn: () =>
      list({
        data: {
          propertyId: propertyId!,
          search: state.search,
          status: state.status,
          departmentId,
          page: state.page,
          pageSize: state.pageSize,
        },
      }),
  });
  const options = useHrmOptions(propertyId);
  const rows = (query.data?.rows ?? []) as DesignationRow[];

  async function toggleArchive(row: DesignationRow) {
    const archived = !row.archived_at;
    if (archived && !confirm(`Archive ${row.title}?`)) return;
    try {
      await archive({ data: { propertyId: propertyId!, id: row.id, archived } });
      toast.success(archived ? "Designation archived" : "Designation restored");
      qc.invalidateQueries({ queryKey: ["hrm-designations"] });
      qc.invalidateQueries({ queryKey: ["hrm-options"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update designation");
    }
  }

  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Designations"
        description="Manage job titles and optional department alignment."
        actions={
          manage.allowed ? (
            <Button onClick={() => setEditing(null)}>
              <Plus className="mr-1 h-4 w-4" /> New designation
            </Button>
          ) : undefined
        }
      />
      <ListToolbar state={state}>
        <OptionalSelect
          id="designation-department-filter"
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
      </ListToolbar>
      <Card>
        <DataQueryState loading={query.isLoading} error={query.error} empty={rows.length === 0}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Designation</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Rank</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <p className="font-medium">{row.title}</p>
                    <p className="text-xs text-muted-foreground">{row.code}</p>
                  </TableCell>
                  <TableCell>{row.department?.name ?? "Property-wide"}</TableCell>
                  <TableCell>{row.rank ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={row.archived_at ? "secondary" : "outline"}>{row.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {manage.allowed && !row.archived_at && (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Edit ${row.title}`}
                        onClick={() => setEditing(row)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                    {manage.allowed && (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={
                          row.archived_at ? `Restore ${row.title}` : `Archive ${row.title}`
                        }
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
        <DesignationDialog
          propertyId={propertyId}
          row={editing}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}

function ListToolbar({
  state,
  children,
}: {
  state: ReturnType<typeof useHrmListState>;
  children?: React.ReactNode;
}) {
  return (
    <Card className="flex flex-wrap items-end gap-3 p-3">
      <div className="min-w-52 flex-1 space-y-1">
        <Label htmlFor="structure-search">Search</Label>
        <Input
          id="structure-search"
          type="search"
          value={state.search}
          onChange={(event) => state.setSearch(event.target.value)}
          placeholder="Search name or code"
        />
      </div>
      <div className="min-w-40 space-y-1">
        <Label htmlFor="structure-status">Status</Label>
        <Select
          value={state.status || "current"}
          onValueChange={(value) => state.setStatus(value === "current" ? "" : value)}
        >
          <SelectTrigger id="structure-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="current">Current</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {children}
      <Button type="button" variant="outline" onClick={state.clear}>
        Clear
      </Button>
    </Card>
  );
}

function DepartmentDialog({
  propertyId,
  row,
  onClose,
}: {
  propertyId: string;
  row: DepartmentRow | null;
  onClose: () => void;
}) {
  const save = useServerFn(saveDepartment);
  const qc = useQueryClient();
  const options = useHrmOptions(propertyId);
  const [form, setForm] = useState({
    name: row?.name ?? "",
    code: row?.code ?? "",
    description: row?.description ?? "",
    parentDepartmentId: row?.parent_department_id ?? "",
    departmentHeadId: row?.department_head_id ?? "",
    status: row?.status ?? "active",
  });
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await save({ data: { propertyId, id: row?.id, ...form } });
      toast.success(row ? "Department updated" : "Department created");
      qc.invalidateQueries({ queryKey: ["hrm-departments"] });
      qc.invalidateQueries({ queryKey: ["hrm-options"] });
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save department");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{row ? "Edit department" : "New department"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id="department-name"
            label="Name"
            value={form.name}
            onChange={(name) => setForm({ ...form, name })}
          />
          <Field
            id="department-code"
            label="Code"
            value={form.code}
            onChange={(code) => setForm({ ...form, code })}
          />
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="department-description">Description</Label>
            <Textarea
              id="department-description"
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </div>
          <OptionalSelect
            id="department-parent"
            label="Parent department"
            value={form.parentDepartmentId}
            onChange={(parentDepartmentId) => setForm({ ...form, parentDepartmentId })}
            options={(options.data?.departments ?? [])
              .filter((item) => item.id !== row?.id)
              .map((item) => ({ value: item.id, label: item.name ?? "" }))}
          />
          <OptionalSelect
            id="department-head"
            label="Department head"
            value={form.departmentHeadId}
            onChange={(departmentHeadId) => setForm({ ...form, departmentHeadId })}
            options={(options.data?.employees ?? []).map((item) => ({
              value: item.id,
              label: `${item.first_name ?? ""} ${item.last_name ?? ""}`,
            }))}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={submit}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DesignationDialog({
  propertyId,
  row,
  onClose,
}: {
  propertyId: string;
  row: DesignationRow | null;
  onClose: () => void;
}) {
  const save = useServerFn(saveDesignation);
  const qc = useQueryClient();
  const options = useHrmOptions(propertyId);
  const [form, setForm] = useState({
    title: row?.title ?? "",
    code: row?.code ?? "",
    description: row?.description ?? "",
    departmentId: row?.department_id ?? "",
    rank: row?.rank?.toString() ?? "",
    status: row?.status ?? "active",
  });
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await save({
        data: {
          propertyId,
          id: row?.id,
          ...form,
          rank: form.rank ? Number(form.rank) : null,
        },
      });
      toast.success(row ? "Designation updated" : "Designation created");
      qc.invalidateQueries({ queryKey: ["hrm-designations"] });
      qc.invalidateQueries({ queryKey: ["hrm-options"] });
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save designation");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{row ? "Edit designation" : "New designation"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id="designation-title"
            label="Title"
            value={form.title}
            onChange={(title) => setForm({ ...form, title })}
          />
          <Field
            id="designation-code"
            label="Code"
            value={form.code}
            onChange={(code) => setForm({ ...form, code })}
          />
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="designation-description">Description</Label>
            <Textarea
              id="designation-description"
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </div>
          <OptionalSelect
            id="designation-department"
            label="Department"
            value={form.departmentId}
            onChange={(departmentId) => setForm({ ...form, departmentId })}
            options={(options.data?.departments ?? []).map((item) => ({
              value: item.id,
              label: item.name ?? "",
            }))}
          />
          <Field
            id="designation-rank"
            label="Level or rank"
            type="number"
            value={form.rank}
            onChange={(rank) => setForm({ ...form, rank })}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={submit}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
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
