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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { DataQueryState, ServerPagination } from "@/components/shared/data-query-controls";
import { HrmPageHeader, useHrmListState } from "@/components/hrm/shared";
import { useActiveProperty } from "@/hooks/use-active-property";
import { usePermission } from "@/hooks/use-permission";
import { HRM_ADMIN_ROLES } from "@/lib/hrm/permissions";
import {
  listShiftTemplates,
  saveShiftTemplate,
  setShiftArchived,
} from "@/lib/hrm/workforce.functions";

type Shift = {
  id: string;
  name: string;
  code: string;
  description: string | null;
  start_time: string;
  end_time: string;
  is_overnight: boolean;
  break_minutes: number;
  grace_period_minutes: number;
  expected_work_minutes: number;
  colour: string | null;
  active: boolean;
  archived_at: string | null;
};

export function ShiftsPage() {
  const propertyId = useActiveProperty();
  const list = useServerFn(listShiftTemplates);
  const archive = useServerFn(setShiftArchived);
  const state = useHrmListState();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Shift | null | undefined>(undefined);
  const manage = usePermission({
    propertyId,
    module: "shift_templates",
    capability: "manage_settings",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const query = useQuery({
    queryKey: [
      "shift-templates",
      propertyId,
      state.search,
      state.status,
      state.page,
      state.pageSize,
    ],
    enabled: !!propertyId,
    queryFn: async () =>
      (await list({
        data: {
          propertyId: propertyId!,
          search: state.search,
          status: state.status,
          page: state.page,
          pageSize: state.pageSize,
        },
      })) as { rows: Shift[]; total: number },
  });

  async function toggleArchive(shift: Shift) {
    const archived = !shift.archived_at;
    if (archived && !confirm(`Archive ${shift.name}? Existing roster entries will be preserved.`)) {
      return;
    }
    try {
      await archive({ data: { propertyId: propertyId!, id: shift.id, archived } });
      toast.success(archived ? "Shift archived" : "Shift restored");
      queryClient.invalidateQueries({ queryKey: ["shift-templates"] });
      queryClient.invalidateQueries({ queryKey: ["workforce-options"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update shift");
    }
  }

  const rows = query.data?.rows ?? [];
  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Shift Scheduling"
        description="Reusable property shift templates; no attendance calculations are performed."
        actions={
          manage.allowed ? (
            <Button onClick={() => setEditing(null)}>
              <Plus className="mr-1 h-4 w-4" /> New shift
            </Button>
          ) : undefined
        }
      />
      <Card className="flex flex-wrap items-end gap-3 p-3">
        <div className="min-w-52 flex-1 space-y-1">
          <Label htmlFor="shift-search">Search</Label>
          <Input
            id="shift-search"
            type="search"
            value={state.search}
            onChange={(event) => state.setSearch(event.target.value)}
            placeholder="Search shift name or code"
          />
        </div>
        <Button variant="outline" onClick={state.clear}>
          Clear
        </Button>
        <Button variant="outline" onClick={() => state.setStatus(state.status ? "" : "archived")}>
          {state.status === "archived" ? "Show current" : "Show archived"}
        </Button>
      </Card>
      <Card>
        <DataQueryState loading={query.isLoading} error={query.error} empty={rows.length === 0}>
          <div className="grid gap-3 p-3 md:grid-cols-2 xl:grid-cols-3">
            {rows.map((shift) => (
              <Card key={shift.id} className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="font-semibold">{shift.name}</h2>
                    <p className="text-xs text-muted-foreground">{shift.code}</p>
                  </div>
                  <span
                    className="h-5 w-5 rounded-full border"
                    style={{ backgroundColor: shift.colour ?? "var(--nav-brand-accent)" }}
                    aria-label="Shift colour"
                  />
                </div>
                <p className="mt-3 text-lg font-medium">
                  {trimTime(shift.start_time)}–{trimTime(shift.end_time)}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {shift.is_overnight && <Badge>Overnight</Badge>}
                  <Badge variant="outline">{shift.expected_work_minutes} working minutes</Badge>
                  <Badge variant="outline">{shift.break_minutes} minute break</Badge>
                </div>
                <div className="mt-4 flex justify-end">
                  {manage.allowed && !shift.archived_at && (
                    <Button size="icon" variant="ghost" onClick={() => setEditing(shift)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                  )}
                  {manage.allowed && (
                    <Button size="icon" variant="ghost" onClick={() => toggleArchive(shift)}>
                      {shift.archived_at ? (
                        <RotateCcw className="h-4 w-4" />
                      ) : (
                        <Archive className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
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
        <ShiftDialog
          propertyId={propertyId}
          shift={editing}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}

function ShiftDialog({
  propertyId,
  shift,
  onClose,
}: {
  propertyId: string;
  shift: Shift | null;
  onClose: () => void;
}) {
  const save = useServerFn(saveShiftTemplate);
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: shift?.name ?? "",
    code: shift?.code ?? "",
    description: shift?.description ?? "",
    startTime: trimTime(shift?.start_time ?? "08:00"),
    endTime: trimTime(shift?.end_time ?? "17:00"),
    breakMinutes: shift?.break_minutes ?? 60,
    gracePeriodMinutes: shift?.grace_period_minutes ?? 10,
    colour: shift?.colour ?? "#0E7490",
    active: shift?.active ?? true,
  });
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await save({ data: { propertyId, id: shift?.id, ...form } });
      toast.success(shift ? "Shift updated" : "Shift created");
      queryClient.invalidateQueries({ queryKey: ["shift-templates"] });
      queryClient.invalidateQueries({ queryKey: ["workforce-options"] });
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save shift");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{shift ? "Edit shift" : "New shift"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" value={form.name} onChange={(name) => setForm({ ...form, name })} />
          <Field label="Code" value={form.code} onChange={(code) => setForm({ ...form, code })} />
          <Field
            label="Start time"
            type="time"
            value={form.startTime}
            onChange={(startTime) => setForm({ ...form, startTime })}
          />
          <Field
            label="End time"
            type="time"
            value={form.endTime}
            onChange={(endTime) => setForm({ ...form, endTime })}
          />
          <Field
            label="Break minutes"
            type="number"
            value={String(form.breakMinutes)}
            onChange={(value) => setForm({ ...form, breakMinutes: Number(value) })}
          />
          <Field
            label="Grace period"
            type="number"
            value={String(form.gracePeriodMinutes)}
            onChange={(value) => setForm({ ...form, gracePeriodMinutes: Number(value) })}
          />
          <div className="space-y-1">
            <Label htmlFor="shift-colour">Colour</Label>
            <Input
              id="shift-colour"
              type="color"
              value={form.colour}
              onChange={(event) => setForm({ ...form, colour: event.target.value })}
            />
          </div>
          <label className="flex items-center justify-between rounded-md border p-3 text-sm">
            Active
            <Switch
              checked={form.active}
              onCheckedChange={(active) => setForm({ ...form, active })}
            />
          </label>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="shift-description">Description</Label>
            <Textarea
              id="shift-description"
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={submit}>
            {busy ? "Saving…" : "Save shift"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field(props: {
  label: string;
  value: string;
  type?: string;
  onChange: (value: string) => void;
}) {
  const id = `shift-${props.label.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{props.label}</Label>
      <Input
        id={id}
        type={props.type}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  );
}

function trimTime(value: string): string {
  return value.slice(0, 5);
}
