import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Archive, Copy, Pencil, Plus, RotateCcw, Send, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  DataQueryState,
  ServerPagination,
  SharedListFilters,
} from "@/components/shared/data-query-controls";
import { HrmPageHeader, OptionalSelect, useHrmListState } from "@/components/hrm/shared";
import { useActiveProperty } from "@/hooks/use-active-property";
import { usePermission } from "@/hooks/use-permission";
import { HRM_ADMIN_ROLES } from "@/lib/hrm/permissions";
import {
  bulkAssignRoster,
  copyRosterPeriod,
  getWorkforceOptions,
  listDutyRoster,
  saveRosterAssignment,
  setRosterArchived,
  setRosterPublication,
} from "@/lib/hrm/workforce.functions";

type Option = {
  id: string;
  name?: string;
  code?: string;
  employee_number?: string;
  first_name?: string;
  last_name?: string;
  department_id?: string | null;
  start_time?: string;
  end_time?: string;
};
type Options = { employees: Option[]; shifts: Option[]; departments: Option[] };
type Roster = {
  id: string;
  duty_date: string;
  work_location: string | null;
  publication_status: string;
  archived_at: string | null;
  starts_at: string;
  ends_at: string;
  employee?: Option;
  shift?: Option;
  department?: Option;
};

export function RosterPage() {
  const propertyId = useActiveProperty();
  const list = useServerFn(listDutyRoster);
  const getOptions = useServerFn(getWorkforceOptions);
  const publish = useServerFn(setRosterPublication);
  const archive = useServerFn(setRosterArchived);
  const state = useHrmListState();
  const queryClient = useQueryClient();
  const [employeeId, setEmployeeId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [assignOpen, setAssignOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [editing, setEditing] = useState<Roster | null>(null);
  const manage = usePermission({
    propertyId,
    module: "duty_roster",
    capability: "manage_settings",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const canPublish = usePermission({
    propertyId,
    module: "duty_roster",
    capability: "approve",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const options = useQuery({
    queryKey: ["workforce-options", propertyId],
    enabled: !!propertyId,
    queryFn: async () => (await getOptions({ data: { propertyId: propertyId! } })) as Options,
  });
  const query = useQuery({
    queryKey: [
      "duty-roster",
      propertyId,
      employeeId,
      departmentId,
      state.from,
      state.to,
      state.status,
      state.page,
      state.pageSize,
      state.search,
    ],
    enabled: !!propertyId,
    queryFn: async () =>
      (await list({
        data: {
          propertyId: propertyId!,
          employeeId,
          departmentId,
          from: state.from ?? undefined,
          to: state.to ?? undefined,
          status: state.status,
          search: state.search,
          page: state.page,
          pageSize: state.pageSize,
        },
      })) as { rows: Roster[]; total: number },
  });
  const rows = query.data?.rows ?? [];

  async function publication(published: boolean) {
    if (!selected.length) return;
    try {
      await publish({ data: { propertyId: propertyId!, ids: selected, published } });
      toast.success(published ? "Roster published" : "Roster unpublished");
      setSelected([]);
      queryClient.invalidateQueries({ queryKey: ["duty-roster"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update publication");
    }
  }

  async function toggleArchive(row: Roster) {
    const archived = !row.archived_at;
    if (archived && !confirm("Remove this future roster assignment?")) return;
    try {
      await archive({ data: { propertyId: propertyId!, id: row.id, archived } });
      toast.success(archived ? "Roster assignment archived" : "Roster assignment restored");
      queryClient.invalidateQueries({ queryKey: ["duty-roster"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update roster");
    }
  }

  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Duty Roster"
        description="Daily and weekly employee duty scheduling in the configured property timezone."
        actions={
          manage.allowed ? (
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setCopyOpen(true)}>
                <Copy className="mr-1 h-4 w-4" /> Copy period
              </Button>
              <Button onClick={() => setAssignOpen(true)}>
                <Plus className="mr-1 h-4 w-4" /> Assign duties
              </Button>
            </div>
          ) : undefined
        }
      />
      {selected.length > 0 && canPublish.allowed && (
        <Card className="flex flex-wrap items-center justify-between gap-2 p-3">
          <span className="text-sm">{selected.length} assignments selected</span>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => publication(true)}>
              <Send className="mr-1 h-4 w-4" /> Publish
            </Button>
            <Button size="sm" variant="outline" onClick={() => publication(false)}>
              <Undo2 className="mr-1 h-4 w-4" /> Unpublish
            </Button>
          </div>
        </Card>
      )}
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
            setEmployeeId("");
            setDepartmentId("");
          }}
        >
          <OptionalSelect
            id="roster-employee"
            label="Employee"
            value={employeeId}
            onChange={setEmployeeId}
            options={(options.data?.employees ?? []).map((employee) => ({
              value: employee.id,
              label: `${employee.employee_number} · ${employee.first_name} ${employee.last_name}`,
            }))}
            placeholder="All employees"
          />
          <OptionalSelect
            id="roster-department"
            label="Department"
            value={departmentId}
            onChange={setDepartmentId}
            options={(options.data?.departments ?? []).map((department) => ({
              value: department.id,
              label: department.name ?? "",
            }))}
            placeholder="All departments"
          />
          <div className="space-y-1">
            <Label htmlFor="roster-status">Publication</Label>
            <Select
              value={state.status || "all"}
              onValueChange={(value) => state.setStatus(value === "all" ? "" : value)}
            >
              <SelectTrigger id="roster-status" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All current</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="published">Published</SelectItem>
                <SelectItem value="unpublished">Unpublished</SelectItem>
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
                <TableHead className="w-10" />
                <TableHead>Date</TableHead>
                <TableHead>Employee</TableHead>
                <TableHead>Shift</TableHead>
                <TableHead>Department/location</TableHead>
                <TableHead>Publication</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Checkbox
                      aria-label="Select roster assignment"
                      checked={selected.includes(row.id)}
                      onCheckedChange={(checked) =>
                        setSelected(
                          checked ? [...selected, row.id] : selected.filter((id) => id !== row.id),
                        )
                      }
                    />
                  </TableCell>
                  <TableCell>{row.duty_date}</TableCell>
                  <TableCell>
                    <p className="font-medium">
                      {row.employee?.first_name} {row.employee?.last_name}
                    </p>
                    <p className="text-xs text-muted-foreground">{row.employee?.employee_number}</p>
                  </TableCell>
                  <TableCell>
                    <p>{row.shift?.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {trimTime(row.shift?.start_time)}–{trimTime(row.shift?.end_time)}
                    </p>
                  </TableCell>
                  <TableCell>
                    {row.department?.name ?? "—"}
                    <p className="text-xs text-muted-foreground">{row.work_location ?? ""}</p>
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.publication_status === "published" ? "default" : "outline"}>
                      {row.publication_status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {manage.allowed && (
                      <>
                        {!row.archived_at && (
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="Edit assignment"
                            onClick={() => setEditing(row)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={row.archived_at ? "Restore assignment" : "Archive assignment"}
                          onClick={() => toggleArchive(row)}
                        >
                          {row.archived_at ? (
                            <RotateCcw className="h-4 w-4" />
                          ) : (
                            <Archive className="h-4 w-4" />
                          )}
                        </Button>
                      </>
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
      {assignOpen && propertyId && options.data && (
        <AssignDialog
          propertyId={propertyId}
          options={options.data}
          onClose={() => setAssignOpen(false)}
        />
      )}
      {copyOpen && propertyId && (
        <CopyDialog propertyId={propertyId} onClose={() => setCopyOpen(false)} />
      )}
      {editing && propertyId && options.data && (
        <EditDialog
          propertyId={propertyId}
          row={editing}
          options={options.data}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function EditDialog({
  propertyId,
  row,
  options,
  onClose,
}: {
  propertyId: string;
  row: Roster;
  options: Options;
  onClose: () => void;
}) {
  const save = useServerFn(saveRosterAssignment);
  const queryClient = useQueryClient();
  const [employeeId, setEmployeeId] = useState(row.employee?.id ?? "");
  const [shiftId, setShiftId] = useState(row.shift?.id ?? "");
  const [departmentId, setDepartmentId] = useState(row.department?.id ?? "");
  const [dutyDate, setDutyDate] = useState(row.duty_date);
  const [workLocation, setWorkLocation] = useState(row.work_location ?? "");
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await save({
        data: {
          propertyId,
          id: row.id,
          employeeId,
          shiftId,
          departmentId: departmentId || null,
          dutyDate,
          workLocation,
        },
      });
      toast.success("Roster assignment updated");
      queryClient.invalidateQueries({ queryKey: ["duty-roster"] });
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Roster conflict");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit roster assignment</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <OptionalSelect
            id="edit-employee"
            label="Employee"
            value={employeeId}
            onChange={setEmployeeId}
            options={options.employees.map((item) => ({
              value: item.id,
              label: `${item.employee_number} · ${item.first_name} ${item.last_name}`,
            }))}
          />
          <OptionalSelect
            id="edit-shift"
            label="Shift"
            value={shiftId}
            onChange={setShiftId}
            options={options.shifts.map((item) => ({
              value: item.id,
              label: `${item.name} (${trimTime(item.start_time)}–${trimTime(item.end_time)})`,
            }))}
          />
          <DateField label="Duty date" value={dutyDate} onChange={setDutyDate} />
          <OptionalSelect
            id="edit-department"
            label="Department"
            value={departmentId}
            onChange={setDepartmentId}
            options={options.departments.map((item) => ({
              value: item.id,
              label: item.name ?? "",
            }))}
          />
          <div className="space-y-1">
            <Label htmlFor="edit-location">Work location</Label>
            <Input
              id="edit-location"
              value={workLocation}
              onChange={(event) => setWorkLocation(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !employeeId || !shiftId || !dutyDate} onClick={submit}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssignDialog({
  propertyId,
  options,
  onClose,
}: {
  propertyId: string;
  options: Options;
  onClose: () => void;
}) {
  const assign = useServerFn(bulkAssignRoster);
  const queryClient = useQueryClient();
  const [employeeIds, setEmployeeIds] = useState<string[]>([]);
  const [shiftId, setShiftId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [to, setTo] = useState(from);
  const [workLocation, setWorkLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const dates = useMemo(() => dateRange(from, to), [from, to]);

  async function submit() {
    setBusy(true);
    try {
      const result = await assign({
        data: {
          propertyId,
          employeeIds,
          shiftId,
          dutyDates: dates,
          departmentId: departmentId || null,
          workLocation,
        },
      });
      toast.success(`${result.created} roster assignments created`);
      queryClient.invalidateQueries({ queryKey: ["duty-roster"] });
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Roster conflict");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bulk duty assignment</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="assignment-employees">Employees</Label>
            <select
              id="assignment-employees"
              multiple
              className="min-h-36 w-full rounded-md border bg-background p-2 text-sm"
              value={employeeIds}
              onChange={(event) =>
                setEmployeeIds(
                  [...event.currentTarget.selectedOptions].map((option) => option.value),
                )
              }
            >
              {options.employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.employee_number} · {employee.first_name} {employee.last_name}
                </option>
              ))}
            </select>
          </div>
          <OptionalSelect
            id="assignment-shift"
            label="Shift"
            value={shiftId}
            onChange={setShiftId}
            options={options.shifts.map((shift) => ({
              value: shift.id,
              label: `${shift.name} (${trimTime(shift.start_time)}–${trimTime(shift.end_time)})`,
            }))}
            placeholder="Select shift"
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <DateField label="From" value={from} onChange={setFrom} />
            <DateField label="To" value={to} onChange={setTo} />
          </div>
          <OptionalSelect
            id="assignment-department"
            label="Department override"
            value={departmentId}
            onChange={setDepartmentId}
            options={options.departments.map((department) => ({
              value: department.id,
              label: department.name ?? "",
            }))}
          />
          <div className="space-y-1">
            <Label htmlFor="assignment-location">Work location</Label>
            <Input
              id="assignment-location"
              value={workLocation}
              onChange={(event) => setWorkLocation(event.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {employeeIds.length * dates.length} assignments. Any conflict rejects the entire batch.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !employeeIds.length || !shiftId || !dates.length}
            onClick={submit}
          >
            {busy ? "Assigning…" : "Create assignments"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CopyDialog({ propertyId, onClose }: { propertyId: string; onClose: () => void }) {
  const copy = useServerFn(copyRosterPeriod);
  const queryClient = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const [sourceFrom, setSourceFrom] = useState(today);
  const [sourceTo, setSourceTo] = useState(today);
  const [targetFrom, setTargetFrom] = useState(today);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      const result = await copy({ data: { propertyId, sourceFrom, sourceTo, targetFrom } });
      toast.success(`${result.created} assignments copied`);
      queryClient.invalidateQueries({ queryKey: ["duty-roster"] });
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Copy conflict");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy roster period</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-3">
          <DateField label="Source from" value={sourceFrom} onChange={setSourceFrom} />
          <DateField label="Source to" value={sourceTo} onChange={setSourceTo} />
          <DateField label="Target starts" value={targetFrom} onChange={setTargetFrom} />
        </div>
        <p className="text-xs text-muted-foreground">
          The copy is transactional. Any overlap or inactive record rejects all copied assignments.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={submit}>
            {busy ? "Copying…" : "Copy roster"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DateField(props: { label: string; value: string; onChange: (value: string) => void }) {
  const id = props.label.toLowerCase().replace(/\W+/g, "-");
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{props.label}</Label>
      <Input
        id={id}
        type="date"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  );
}

function dateRange(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || end < start) return [];
  const result: string[] = [];
  while (start <= end && result.length <= 200) {
    result.push(start.toISOString().slice(0, 10));
    start.setUTCDate(start.getUTCDate() + 1);
  }
  return result;
}

function trimTime(value?: string): string {
  return value?.slice(0, 5) ?? "";
}
