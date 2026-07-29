/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 3C joined records await generated database types. */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Archive,
  CalendarDays,
  Check,
  Download,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
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
import { Textarea } from "@/components/ui/textarea";
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
  adjustLeaveBalance,
  attachLeaveDocument,
  createLeaveDocumentTicket,
  getLeaveBootstrap,
  getLeaveCalendar,
  getLeaveDocumentDownload,
  listLeaveBalances,
  listLeaveRequests,
  listLeaveTypes,
  saveLeaveDraft,
  saveLeaveType,
  setLeaveTypeArchived,
  transitionLeaveRequest,
} from "@/lib/hrm/leave.functions";

export function LeaveManagementPage() {
  const propertyId = useActiveProperty();
  const list = useServerFn(listLeaveRequests);
  const bootstrap = useServerFn(getLeaveBootstrap);
  const transition = useServerFn(transitionLeaveRequest);
  const downloadDocument = useServerFn(getLeaveDocumentDownload);
  const queryClient = useQueryClient();
  const state = useHrmListState();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [departmentId, setDepartmentId] = useState("");
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const approve = usePermission({
    propertyId,
    module: "leave",
    capability: "approve",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const options = useQuery({
    queryKey: ["leave-bootstrap", propertyId],
    enabled: !!propertyId,
    queryFn: () => bootstrap({ data: { propertyId: propertyId! } }) as Promise<any>,
  });
  const query = useQuery({
    queryKey: [
      "leave-requests",
      propertyId,
      state.search,
      state.status,
      state.from,
      state.to,
      departmentId,
      leaveTypeId,
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
          from: state.from ?? undefined,
          to: state.to ?? undefined,
          departmentId: departmentId || undefined,
          leaveTypeId: leaveTypeId || undefined,
          page: state.page,
          pageSize: state.pageSize,
        },
      }) as Promise<any>,
  });
  async function act(row: any, action: string) {
    const needsReason = ["rejected", "returned", "withdrawn", "cancelled"].includes(action);
    const reason = needsReason ? (prompt(`Reason for ${action}:`) ?? "") : undefined;
    if (needsReason && reason!.trim().length < 5)
      return toast.error("A reason of at least 5 characters is required");
    try {
      await transition({ data: { propertyId: propertyId!, id: row.id, action, reason } });
      toast.success(`Request ${action}`);
      queryClient.invalidateQueries({ queryKey: ["leave-requests"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update request");
    }
  }
  async function download(row: any) {
    try {
      const result = await downloadDocument({
        data: { propertyId: propertyId!, requestId: row.id },
      });
      window.open(result.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to open supporting document");
    }
  }
  const rows = query.data?.rows ?? [];
  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Leave Management"
        description="Own requests, approval queue, supporting documents, and roster conflicts."
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="mr-1 h-4 w-4" />
            Request leave
          </Button>
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
          <StatusFilter value={state.status} onChange={state.setStatus} />
          <OptionalSelect
            id="leave-department-filter"
            label="Department"
            value={departmentId}
            onChange={setDepartmentId}
            options={(options.data?.departments ?? []).map((item: any) => ({
              value: item.id,
              label: item.name,
            }))}
            placeholder="All departments"
          />
          <OptionalSelect
            id="leave-type-filter"
            label="Leave type"
            value={leaveTypeId}
            onChange={setLeaveTypeId}
            options={(options.data?.types ?? []).map((item: any) => ({
              value: item.id,
              label: item.name,
            }))}
            placeholder="All leave types"
          />
        </SharedListFilters>
      </Card>
      <DataQueryState loading={query.isLoading} error={query.error} empty={!rows.length}>
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((row: any) => (
            <Card key={row.id} className="p-4">
              <div className="flex justify-between gap-2">
                <div>
                  <h3 className="font-semibold">
                    {row.employee?.first_name} {row.employee?.last_name}
                  </h3>
                  <p className="text-sm">
                    {row.leave_type?.name} · {row.start_date} – {row.end_date}
                  </p>
                </div>
                <Badge>{row.status}</Badge>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {row.total_requested_days} days · {row.partial_day_mode}
              </p>
              {row.hr_roster_leave_conflicts?.some((item: any) => item.status === "open") && (
                <p className="mt-2 text-sm text-destructive">
                  Conflicts with an existing roster assignment.
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {row.supporting_document_path && (
                  <Button size="sm" variant="outline" onClick={() => download(row)}>
                    <Download className="mr-1 h-3 w-3" />
                    Supporting document
                  </Button>
                )}
                {["draft", "returned"].includes(row.status) &&
                  row.employee_id === query.data?.ownEmployeeId && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditing(row);
                          setFormOpen(true);
                        }}
                      >
                        <Pencil className="mr-1 h-3 w-3" />
                        Edit
                      </Button>
                      <Button size="sm" onClick={() => act(row, "submitted")}>
                        <Send className="mr-1 h-3 w-3" />
                        Submit
                      </Button>
                    </>
                  )}
                {row.status === "submitted" && row.employee_id === query.data?.ownEmployeeId && (
                  <Button size="sm" variant="outline" onClick={() => act(row, "withdrawn")}>
                    <Undo2 className="mr-1 h-3 w-3" />
                    Withdraw
                  </Button>
                )}
                {approve.allowed && row.status === "submitted" && (
                  <>
                    <Button size="sm" onClick={() => act(row, "approved")}>
                      <Check className="mr-1 h-3 w-3" />
                      Approve
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => act(row, "rejected")}>
                      <X className="mr-1 h-3 w-3" />
                      Reject
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => act(row, "returned")}>
                      Return
                    </Button>
                  </>
                )}
                {approve.allowed && row.status === "approved" && (
                  <Button size="sm" variant="destructive" onClick={() => act(row, "cancelled")}>
                    Cancel leave
                  </Button>
                )}
              </div>
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
      {formOpen && propertyId && options.data && (
        <LeaveRequestDialog
          propertyId={propertyId}
          types={options.data.types}
          request={editing}
          onClose={() => setFormOpen(false)}
        />
      )}
    </div>
  );
}

function LeaveRequestDialog({
  propertyId,
  types,
  request,
  onClose,
}: {
  propertyId: string;
  types: any[];
  request: any;
  onClose: () => void;
}) {
  const save = useServerFn(saveLeaveDraft);
  const ticket = useServerFn(createLeaveDocumentTicket);
  const attach = useServerFn(attachLeaveDocument);
  const qc = useQueryClient();
  const [type, setType] = useState(request?.leave_type_id ?? "");
  const [from, setFrom] = useState(request?.start_date ?? "");
  const [to, setTo] = useState(request?.end_date ?? "");
  const [partial, setPartial] = useState(request?.partial_day_mode ?? "none");
  const [reason, setReason] = useState(request?.reason ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      const row = await save({
        data: {
          propertyId,
          id: request?.id,
          leaveTypeId: type,
          startDate: from,
          endDate: to,
          partialDayMode: partial,
          reason,
        },
      });
      if (file) {
        const t = await ticket({
          data: { propertyId, fileName: file.name, fileType: file.type, fileSize: file.size },
        });
        const upload = await supabase.storage.from(t.bucket).upload(t.path, file);
        if (upload.error) throw upload.error;
        try {
          await attach({
            data: {
              propertyId,
              requestId: row.id,
              path: t.path,
              fileName: file.name,
              fileType: file.type,
              fileSize: file.size,
            },
          });
        } catch (error) {
          await supabase.storage.from(t.bucket).remove([t.path]);
          throw error;
        }
      }
      toast.success("Leave draft saved");
      qc.invalidateQueries({ queryKey: ["leave-requests"] });
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save leave");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{request ? "Edit leave draft" : "Request leave"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <OptionalSelect
            id="leave-type"
            label="Leave type"
            value={type}
            onChange={setType}
            options={types.map((item) => ({
              value: item.id,
              label: `${item.name} (${item.code})`,
            }))}
            placeholder="Select type"
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <DateInput id="leave-from" label="Start date" value={from} onChange={setFrom} />
            <DateInput id="leave-to" label="End date" value={to} onChange={setTo} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="partial-mode">Partial day</Label>
            <Select value={partial} onValueChange={setPartial}>
              <SelectTrigger id="partial-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["none", "morning", "afternoon"].map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="leave-reason">Reason</Label>
            <Textarea
              id="leave-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="leave-document">
              Supporting document (private PDF/JPEG/PNG, 10 MB)
            </Label>
            <Input
              id="leave-document"
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !type || !from || !to || !reason.trim()} onClick={submit}>
            {busy ? "Saving…" : "Save draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LeaveTypesPage() {
  const propertyId = useActiveProperty();
  const list = useServerFn(listLeaveTypes);
  const archive = useServerFn(setLeaveTypeArchived);
  const state = useHrmListState();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<any | null>(null);
  const manage = usePermission({
    propertyId,
    module: "leave_settings",
    capability: "manage_settings",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const query = useQuery({
    queryKey: ["leave-types", propertyId, state.search, state.status, state.page, state.pageSize],
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
      }) as Promise<any>,
  });
  async function toggle(row: any) {
    try {
      await archive({ data: { propertyId: propertyId!, id: row.id, archived: !row.archived_at } });
      qc.invalidateQueries({ queryKey: ["leave-types"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unable to update type");
    }
  }
  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Leave Types"
        description="Configurable property leave policies; no labour rules are globally hard-coded."
        actions={
          manage.allowed ? (
            <Button onClick={() => setEditing("new")}>
              <Plus className="mr-1 h-4 w-4" />
              Add type
            </Button>
          ) : null
        }
      />
      <Card className="p-3">
        <SharedListFilters
          search={state.search}
          from={null}
          to={null}
          onSearchChange={state.setSearch}
          onFromChange={() => {}}
          onToChange={() => {}}
          onClear={state.clear}
        />
      </Card>
      <DataQueryState
        loading={query.isLoading}
        error={query.error}
        empty={!query.data?.rows.length}
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {query.data?.rows.map((row: any) => (
            <Card key={row.id} className="p-4">
              <div className="flex justify-between">
                <div>
                  <h3 className="font-semibold">{row.name}</h3>
                  <p className="text-sm">
                    {row.code} · {row.paid ? "Paid" : "Unpaid"}
                  </p>
                </div>
                <Badge variant="outline">
                  {row.archived_at ? "Archived" : row.active ? "Active" : "Inactive"}
                </Badge>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {row.annual_entitlement} {row.entitlement_unit} annually
              </p>
              {manage.allowed && (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setEditing(row)}
                    disabled={!!row.archived_at}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => toggle(row)}>
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
        <LeaveTypeDialog
          propertyId={propertyId}
          row={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
function LeaveTypeDialog({
  propertyId,
  row,
  onClose,
}: {
  propertyId: string;
  row: any;
  onClose: () => void;
}) {
  const save = useServerFn(saveLeaveType);
  const qc = useQueryClient();
  const [name, setName] = useState(row?.name ?? "");
  const [code, setCode] = useState(row?.code ?? "");
  const [entitlement, setEntitlement] = useState(row?.annual_entitlement ?? 20);
  const [notice, setNotice] = useState(row?.minimum_notice_days ?? 0);
  const [paid, setPaid] = useState(row?.paid ?? true);
  const [accrualMethod, setAccrualMethod] = useState(row?.accrual_method ?? "annual");
  const [accrualFrequency, setAccrualFrequency] = useState(row?.accrual_frequency ?? "yearly");
  const [leaveYearStartMonth, setLeaveYearStartMonth] = useState(row?.leave_year_start_month ?? 1);
  const [maximumConsecutiveDays, setMaximumConsecutiveDays] = useState(
    row?.maximum_consecutive_days ?? 0,
  );
  const [minimumServiceDays, setMinimumServiceDays] = useState(row?.minimum_service_days ?? 0);
  const [carry, setCarry] = useState(row?.carry_forward_enabled ?? false);
  const [carryMax, setCarryMax] = useState(row?.maximum_carry_forward ?? 0);
  const [carryExpiry, setCarryExpiry] = useState(row?.carry_forward_expiry_days ?? 0);
  const [partial, setPartial] = useState(row?.partial_day_supported ?? true);
  const [doc, setDoc] = useState(row?.supporting_document_required ?? false);
  const [negative, setNegative] = useState(row?.negative_balance_allowed ?? false);
  const [probation, setProbation] = useState(row?.probation_eligible ?? false);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await save({
        data: {
          propertyId,
          id: row?.id,
          name,
          code,
          paid,
          annualEntitlement: Number(entitlement),
          entitlementUnit: "days",
          accrualMethod,
          accrualFrequency,
          leaveYearStartMonth: Number(leaveYearStartMonth),
          carryForwardEnabled: carry,
          maximumCarryForward: Number(carryMax),
          carryForwardExpiryDays: carryExpiry <= 0 ? null : Number(carryExpiry),
          minimumNoticeDays: Number(notice),
          maximumConsecutiveDays:
            maximumConsecutiveDays <= 0 ? null : Number(maximumConsecutiveDays),
          minimumRequestDuration: partial ? 0.5 : 1,
          partialDaySupported: partial,
          supportingDocumentRequired: doc,
          negativeBalanceAllowed: negative,
          probationEligible: probation,
          minimumServiceDays: Number(minimumServiceDays),
          approvalRequired: true,
          active: true,
        },
      });
      qc.invalidateQueries({ queryKey: ["leave-types"] });
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unable to save type");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{row ? "Edit leave type" : "Add leave type"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput id="type-name" label="Name" value={name} onChange={setName} />
          <TextInput id="type-code" label="Code" value={code} onChange={setCode} />
          <NumberInput
            id="entitlement"
            label="Annual entitlement"
            value={entitlement}
            onChange={setEntitlement}
          />
          <NumberInput
            id="notice"
            label="Minimum notice days"
            value={notice}
            onChange={setNotice}
          />
          <NumberInput
            id="leave-year-month"
            label="Leave year start month"
            value={leaveYearStartMonth}
            onChange={setLeaveYearStartMonth}
          />
          <NumberInput
            id="maximum-consecutive"
            label="Maximum consecutive days"
            value={maximumConsecutiveDays}
            onChange={setMaximumConsecutiveDays}
          />
          <NumberInput
            id="minimum-service"
            label="Minimum service days"
            value={minimumServiceDays}
            onChange={setMinimumServiceDays}
          />
          <div className="space-y-1">
            <Label htmlFor="accrual-method">Accrual method</Label>
            <Select value={accrualMethod} onValueChange={setAccrualMethod}>
              <SelectTrigger id="accrual-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["annual", "periodic", "manual"].map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="accrual-frequency">Accrual frequency</Label>
            <Select value={accrualFrequency} onValueChange={setAccrualFrequency}>
              <SelectTrigger id="accrual-frequency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["monthly", "quarterly", "yearly", "none"].map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-2">
          <CheckLine label="Paid leave" value={paid} onChange={setPaid} />
          <CheckLine label="Carry forward" value={carry} onChange={setCarry} />
          {carry && (
            <NumberInput
              id="carry-max"
              label="Maximum carry forward"
              value={carryMax}
              onChange={setCarryMax}
            />
          )}
          {carry && (
            <NumberInput
              id="carry-expiry"
              label="Carry-forward expiry days (optional)"
              value={carryExpiry}
              onChange={setCarryExpiry}
            />
          )}
          <CheckLine label="Partial days" value={partial} onChange={setPartial} />
          <CheckLine label="Eligible during probation" value={probation} onChange={setProbation} />
          <CheckLine label="Supporting document required" value={doc} onChange={setDoc} />
          <CheckLine label="Negative balance allowed" value={negative} onChange={setNegative} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !name || !code} onClick={submit}>
            Save type
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LeaveBalancesPage() {
  const propertyId = useActiveProperty();
  const list = useServerFn(listLeaveBalances);
  const adjust = useServerFn(adjustLeaveBalance);
  const state = useHrmListState();
  const qc = useQueryClient();
  const canAdjust = usePermission({
    propertyId,
    module: "leave_balances",
    capability: "manage_settings",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const query = useQuery({
    queryKey: ["leave-balances", propertyId, state.page, state.pageSize],
    enabled: !!propertyId,
    queryFn: () =>
      list({
        data: { propertyId: propertyId!, page: state.page, pageSize: state.pageSize },
      }) as Promise<any>,
  });
  async function change(row: any) {
    const amount = prompt("New adjusted amount:", String(row.adjusted_amount));
    const reason = prompt("Reason for adjustment:");
    if (amount === null || !reason || reason.trim().length < 5) return;
    try {
      await adjust({
        data: { propertyId: propertyId!, balanceId: row.id, amount: Number(amount), reason },
      });
      qc.invalidateQueries({ queryKey: ["leave-balances"] });
      toast.success("Balance adjusted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unable to adjust balance");
    }
  }
  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Leave Balances"
        description="Authoritative pending, used, adjusted, and remaining leave balances."
      />
      <DataQueryState
        loading={query.isLoading}
        error={query.error}
        empty={!query.data?.rows.length}
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {query.data?.rows.map((row: any) => (
            <Card key={row.id} className="p-4">
              <h3 className="font-semibold">
                {row.employee?.first_name} {row.employee?.last_name}
              </h3>
              <p className="text-sm">
                {row.leave_type?.name} · {row.period_start.slice(0, 4)}
              </p>
              <p className="mt-3 text-3xl font-semibold">{row.remaining_balance}</p>
              <p className="text-xs text-muted-foreground">
                Pending {row.pending_amount} · Used {row.used_amount} · Adjusted{" "}
                {row.adjusted_amount}
              </p>
              {canAdjust.allowed && (
                <Button className="mt-3" size="sm" variant="outline" onClick={() => change(row)}>
                  Controlled adjustment
                </Button>
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
    </div>
  );
}

export function LeaveCalendarPage() {
  const propertyId = useActiveProperty();
  const get = useServerFn(getLeaveCalendar);
  const optionsFn = useServerFn(getLeaveBootstrap);
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [to, setTo] = useState(from);
  const [view, setView] = useState("monthly");
  const options = useQuery({
    queryKey: ["leave-bootstrap", propertyId],
    enabled: !!propertyId,
    queryFn: () => optionsFn({ data: { propertyId: propertyId! } }) as Promise<any>,
  });
  const query = useQuery({
    queryKey: ["leave-calendar", propertyId, from, to],
    enabled: !!propertyId,
    queryFn: () =>
      get({ data: { propertyId: propertyId!, from, to, includeSubmitted: false } }) as Promise<
        any[]
      >,
  });
  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Leave Calendar"
        description="Approved leave summaries only; confidential reasons and documents are not shown."
      />
      <Card className="flex flex-wrap items-end gap-3 p-3">
        <DateInput id="calendar-from" label="From" value={from} onChange={setFrom} />
        <DateInput id="calendar-to" label="To" value={to} onChange={setTo} />
        <div className="space-y-1">
          <Label htmlFor="calendar-view">View</Label>
          <Select value={view} onValueChange={setView}>
            <SelectTrigger id="calendar-view" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["daily", "weekly", "monthly"].map((v) => (
                <SelectItem key={v} value={v}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Card>
      <DataQueryState
        loading={query.isLoading || options.isLoading}
        error={query.error}
        empty={!query.data?.length}
      >
        <div
          className={view === "daily" ? "space-y-3" : "grid gap-3 sm:grid-cols-2 lg:grid-cols-3"}
        >
          {query.data?.map((row: any) => (
            <Card key={row.id} className="p-4">
              <CalendarDays className="mb-2 h-5 w-5 text-primary" />
              <h3 className="font-semibold">
                {row.employee?.first_name} {row.employee?.last_name}
              </h3>
              <p className="text-sm">{row.leave_type?.name}</p>
              <p className="text-sm text-muted-foreground">
                {row.start_date} – {row.end_date}
              </p>
            </Card>
          ))}
        </div>
      </DataQueryState>
    </div>
  );
}

function StatusFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label htmlFor="leave-status">Status</Label>
      <Select value={value || "all"} onValueChange={(v) => onChange(v === "all" ? "" : v)}>
        <SelectTrigger id="leave-status" className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All</SelectItem>
          {["draft", "submitted", "approved", "rejected", "returned", "withdrawn", "cancelled"].map(
            (v) => (
              <SelectItem key={v} value={v}>
                {v}
              </SelectItem>
            ),
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
function DateInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
function TextInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
function NumberInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
function CheckLine({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <Checkbox checked={value} onCheckedChange={(v) => onChange(v === true)} />
      {label}
    </label>
  );
}
