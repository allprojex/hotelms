import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Archive, CalendarHeart, Pencil, Plus, RotateCcw } from "lucide-react";
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
  DataQueryState,
  ServerPagination,
  SharedListFilters,
} from "@/components/shared/data-query-controls";
import { HrmPageHeader, useHrmListState } from "@/components/hrm/shared";
import { useActiveProperty } from "@/hooks/use-active-property";
import { usePermission } from "@/hooks/use-permission";
import { HRM_ADMIN_ROLES } from "@/lib/hrm/permissions";
import {
  getHolidayDepartments,
  listHolidays,
  saveHoliday,
  setHolidayArchived,
} from "@/lib/hrm/workforce.functions";

type Department = { id: string; name: string };
type Holiday = {
  id: string;
  name: string;
  holiday_date: string;
  recurring_annually: boolean;
  holiday_type: string;
  treatment: string;
  scope_type: "property" | "departments";
  description: string | null;
  active: boolean;
  archived_at: string | null;
  hr_holiday_departments: { department_id: string }[];
};

export function HolidaysPage() {
  const propertyId = useActiveProperty();
  const list = useServerFn(listHolidays);
  const archive = useServerFn(setHolidayArchived);
  const getOptions = useServerFn(getHolidayDepartments);
  const queryClient = useQueryClient();
  const state = useHrmListState();
  const [editing, setEditing] = useState<Holiday | "new" | null>(null);
  const manage = usePermission({
    propertyId,
    module: "holidays",
    capability: "manage_settings",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const options = useQuery({
    queryKey: ["workforce-options", propertyId],
    enabled: !!propertyId,
    queryFn: () =>
      getOptions({ data: { propertyId: propertyId! } }) as Promise<{ departments: Department[] }>,
  });
  const query = useQuery({
    queryKey: [
      "holidays",
      propertyId,
      state.search,
      state.from,
      state.to,
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
          from: state.from ?? undefined,
          to: state.to ?? undefined,
          status: state.status,
          page: state.page,
          pageSize: state.pageSize,
        },
      }) as Promise<{ rows: Holiday[]; total: number }>,
  });
  async function toggleArchive(row: Holiday) {
    const archived = !row.archived_at;
    if (archived && !confirm(`Archive ${row.name}?`)) return;
    try {
      await archive({ data: { propertyId: propertyId!, id: row.id, archived } });
      toast.success(archived ? "Holiday archived" : "Holiday restored");
      queryClient.invalidateQueries({ queryKey: ["holidays"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update holiday");
    }
  }
  const rows = query.data?.rows ?? [];
  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Holiday Calendar"
        description="Property and department holidays used by future workforce calculations."
        actions={
          manage.allowed ? (
            <Button onClick={() => setEditing("new")}>
              <Plus className="mr-1 h-4 w-4" /> Add holiday
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
          onClear={state.clear}
        >
          <div className="space-y-1">
            <Label htmlFor="holiday-status">Status</Label>
            <Select
              value={state.status || "current"}
              onValueChange={(value) => state.setStatus(value === "current" ? "" : value)}
            >
              <SelectTrigger id="holiday-status" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="current">Current</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </SharedListFilters>
      </Card>
      <DataQueryState loading={query.isLoading} error={query.error} empty={!rows.length}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => (
            <Card key={row.id} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex gap-2">
                  <CalendarHeart className="mt-1 h-4 w-4 text-primary" />
                  <div>
                    <h3 className="font-semibold">{row.name}</h3>
                    <p className="text-sm">
                      {row.holiday_date}
                      {row.recurring_annually ? " · repeats annually" : ""}
                    </p>
                  </div>
                </div>
                <Badge variant={row.active ? "default" : "outline"}>
                  {row.archived_at ? "Archived" : row.active ? "Active" : "Inactive"}
                </Badge>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                {row.holiday_type} · {row.treatment} ·{" "}
                {row.scope_type === "property"
                  ? "All departments"
                  : `${row.hr_holiday_departments.length} departments`}
              </p>
              {row.description && <p className="mt-2 text-sm">{row.description}</p>}
              {manage.allowed && (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Edit holiday"
                    onClick={() => setEditing(row)}
                    disabled={!!row.archived_at}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={row.archived_at ? "Restore holiday" : "Archive holiday"}
                    onClick={() => toggleArchive(row)}
                  >
                    {row.archived_at ? (
                      <RotateCcw className="h-4 w-4" />
                    ) : (
                      <Archive className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      </DataQueryState>
      <ServerPagination
        page={state.page}
        pageSize={state.pageSize}
        totalRows={query.data?.total ?? 0}
        onPageChange={state.setPage}
        onPageSizeChange={state.setPageSize}
      />
      {editing && propertyId && (
        <HolidayDialog
          propertyId={propertyId}
          holiday={editing === "new" ? null : editing}
          departments={options.data?.departments ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function HolidayDialog({
  propertyId,
  holiday,
  departments,
  onClose,
}: {
  propertyId: string;
  holiday: Holiday | null;
  departments: Department[];
  onClose: () => void;
}) {
  const save = useServerFn(saveHoliday);
  const queryClient = useQueryClient();
  const [name, setName] = useState(holiday?.name ?? "");
  const [date, setDate] = useState(holiday?.holiday_date ?? "");
  const [recurring, setRecurring] = useState(holiday?.recurring_annually ?? false);
  const [type, setType] = useState(holiday?.holiday_type ?? "public");
  const [treatment, setTreatment] = useState(holiday?.treatment ?? "paid");
  const [scope, setScope] = useState<"property" | "departments">(holiday?.scope_type ?? "property");
  const [departmentIds, setDepartmentIds] = useState(
    holiday?.hr_holiday_departments.map((item) => item.department_id) ?? [],
  );
  const [description, setDescription] = useState(holiday?.description ?? "");
  const [active, setActive] = useState(holiday?.active ?? true);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await save({
        data: {
          propertyId,
          id: holiday?.id,
          name,
          holidayDate: date,
          recurringAnnually: recurring,
          holidayType: type,
          treatment,
          scopeType: scope,
          departmentIds,
          description,
          active,
        },
      });
      toast.success(holiday ? "Holiday updated" : "Holiday created");
      queryClient.invalidateQueries({ queryKey: ["holidays"] });
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save holiday");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{holiday ? "Edit holiday" : "Add holiday"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Field id="holiday-name" label="Name" value={name} onChange={setName} />
          <div className="space-y-1">
            <Label htmlFor="holiday-date">Date</Label>
            <Input
              id="holiday-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Choice
              id="holiday-type"
              label="Type"
              value={type}
              onChange={setType}
              values={["public", "company", "religious", "local", "other"]}
            />
            <Choice
              id="holiday-treatment"
              label="Treatment"
              value={treatment}
              onChange={setTreatment}
              values={["paid", "unpaid", "normal_placeholder"]}
            />
          </div>
          <Choice
            id="holiday-scope"
            label="Scope"
            value={scope}
            onChange={(value) => setScope(value as "property" | "departments")}
            values={["property", "departments"]}
          />
          {scope === "departments" && (
            <div className="space-y-1">
              <Label htmlFor="holiday-departments">Affected departments</Label>
              <select
                id="holiday-departments"
                multiple
                className="min-h-28 w-full rounded-md border bg-background p-2 text-sm"
                value={departmentIds}
                onChange={(event) =>
                  setDepartmentIds(
                    [...event.currentTarget.selectedOptions].map((item) => item.value),
                  )
                }
              >
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Field
            id="holiday-description"
            label="Description"
            value={description}
            onChange={setDescription}
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={recurring}
              onCheckedChange={(value) => setRecurring(value === true)}
            />{" "}
            Repeat annually
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={active} onCheckedChange={(value) => setActive(value === true)} />{" "}
            Active
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              busy || !name.trim() || !date || (scope === "departments" && !departmentIds.length)
            }
            onClick={submit}
          >
            {busy ? "Saving…" : "Save holiday"}
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
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
function Choice({
  id,
  label,
  value,
  onChange,
  values,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  values: string[];
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map((item) => (
            <SelectItem key={item} value={item}>
              {item}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
