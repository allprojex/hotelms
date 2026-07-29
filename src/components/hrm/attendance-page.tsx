/* eslint-disable @typescript-eslint/no-explicit-any -- Detail/export join shapes will be generated with Phase 3B Supabase types. */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClientOnlyFn, useServerFn } from "@tanstack/react-start";
import { Check, Download, Eye, FileSpreadsheet, Pencil, Printer, X } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
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
import type { ReportDefinition, ReportFormat } from "@/lib/reports/report-core";
import { HRM_ADMIN_ROLES } from "@/lib/hrm/permissions";
import {
  createAttendanceAdjustment,
  getAttendanceDetails,
  getAttendanceExportData,
  getAttendanceOptions,
  listAttendance,
  reviewAttendanceAdjustment,
  setAttendanceApproval,
} from "@/lib/hrm/attendance.functions";

type Option = {
  id: string;
  name?: string;
  employee_number?: string;
  first_name?: string;
  last_name?: string;
};
type Summary = {
  id: string;
  employee_id: string;
  business_date: string;
  attendance_status: string;
  calculation_status: string;
  approval_status: string;
  first_clock_in: string | null;
  last_clock_out: string | null;
  worked_minutes: number;
  break_minutes: number;
  late_minutes: number;
  early_departure_minutes: number;
  overtime_minutes: number;
  employee?: Option & { department?: { name: string }; designation?: { name: string } };
  roster?: { shift?: { name: string } };
};

const exportAttendanceReport = createClientOnlyFn(
  async (definition: ReportDefinition<any>, format: ReportFormat) => {
    const { exportReport } = await import("@/lib/reports/report-export.client");
    return exportReport(definition, format);
  },
);

export function AttendancePage() {
  const propertyId = useActiveProperty();
  const list = useServerFn(listAttendance);
  const getOptions = useServerFn(getAttendanceOptions);
  const approve = useServerFn(setAttendanceApproval);
  const getExport = useServerFn(getAttendanceExportData);
  const queryClient = useQueryClient();
  const state = useHrmListState();
  const [departmentId, setDepartmentId] = useState("");
  const [designationId, setDesignationId] = useState("");
  const [details, setDetails] = useState<Summary | null>(null);
  const [adjusting, setAdjusting] = useState<Summary | null>(null);
  const canApprove = usePermission({
    propertyId,
    module: "attendance",
    capability: "approve",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const canAdjust = usePermission({
    propertyId,
    module: "attendance_adjustments",
    capability: "create",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const canExport = usePermission({
    propertyId,
    module: "attendance",
    capability: "export",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const canPrint = usePermission({
    propertyId,
    module: "attendance",
    capability: "print",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const options = useQuery({
    queryKey: ["attendance-options", propertyId],
    enabled: !!propertyId,
    queryFn: () =>
      getOptions({ data: { propertyId: propertyId! } }) as Promise<{
        departments: Option[];
        designations: Option[];
        employees: Option[];
      }>,
  });
  const query = useQuery({
    queryKey: [
      "attendance",
      propertyId,
      state.search,
      departmentId,
      designationId,
      state.status,
      state.from,
      state.to,
      state.page,
      state.pageSize,
    ],
    enabled: !!propertyId,
    queryFn: () =>
      list({
        data: {
          propertyId: propertyId!,
          search: state.search,
          departmentId,
          designationId,
          status: state.status,
          from: state.from ?? undefined,
          to: state.to ?? undefined,
          page: state.page,
          pageSize: state.pageSize,
        },
      }) as Promise<{ rows: Summary[]; total: number }>,
  });
  async function decision(row: Summary, value: "approved" | "rejected" | "returned") {
    try {
      await approve({ data: { propertyId: propertyId!, summaryId: row.id, decision: value } });
      toast.success(`Attendance ${value}`);
      queryClient.invalidateQueries({ queryKey: ["attendance"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to review attendance");
    }
  }
  async function exportAttendance(format: ReportFormat) {
    try {
      const result = await getExport({
        data: {
          propertyId: propertyId!,
          format,
          from: state.from ?? undefined,
          to: state.to ?? undefined,
          status: state.status,
          search: state.search,
          departmentId,
          designationId,
        },
      });
      const rows = result.rows.map((row: any) => ({
        ...row,
        employeeName: `${row.employee?.first_name ?? ""} ${row.employee?.last_name ?? ""}`.trim(),
        employeeNumber: row.employee?.employee_number ?? "",
      }));
      await exportAttendanceReport(
        {
          title: "Attendance Report",
          slug: "attendance",
          propertyName: `ThesKwoff Hotel (${result.timezone})`,
          dateRange: state.from && state.to ? { from: state.from, to: state.to } : null,
          rows,
          columns: [
            {
              key: "business_date",
              label: "Business date",
              value: (row: any) => row.business_date,
            },
            {
              key: "employeeNumber",
              label: "Employee number",
              value: (row: any) => row.employeeNumber,
            },
            { key: "employeeName", label: "Employee", value: (row: any) => row.employeeName },
            {
              key: "attendance_status",
              label: "Status",
              value: (row: any) => row.attendance_status,
            },
            {
              key: "worked_minutes",
              label: "Worked minutes",
              value: (row: any) => row.worked_minutes,
            },
            {
              key: "break_minutes",
              label: "Break minutes",
              value: (row: any) => row.break_minutes,
            },
            { key: "late_minutes", label: "Late minutes", value: (row: any) => row.late_minutes },
            {
              key: "early_departure_minutes",
              label: "Early departure",
              value: (row: any) => row.early_departure_minutes,
            },
            {
              key: "overtime_minutes",
              label: "Informational overtime",
              value: (row: any) => row.overtime_minutes,
            },
          ],
        },
        format,
      );
      toast.success(
        format === "print" ? "Print view opened" : `${format.toUpperCase()} report created`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Export failed");
    }
  }
  const rows = query.data?.rows ?? [];
  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Attendance"
        description="Review calculated attendance, source events, adjustments, approvals and reports."
        actions={
          <div className="flex flex-wrap gap-2">
            {canExport.allowed && (
              <>
                <Button variant="outline" onClick={() => exportAttendance("csv")}>
                  <Download className="mr-1 h-4 w-4" /> CSV
                </Button>
                <Button variant="outline" onClick={() => exportAttendance("xlsx")}>
                  <FileSpreadsheet className="mr-1 h-4 w-4" /> XLSX
                </Button>
                <Button variant="outline" onClick={() => exportAttendance("pdf")}>
                  PDF
                </Button>
              </>
            )}
            {canPrint.allowed && (
              <Button variant="outline" onClick={() => exportAttendance("print")}>
                <Printer className="mr-1 h-4 w-4" /> Print
              </Button>
            )}
          </div>
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
            id="attendance-department"
            label="Department"
            value={departmentId}
            onChange={setDepartmentId}
            options={(options.data?.departments ?? []).map((item) => ({
              value: item.id,
              label: item.name ?? "",
            }))}
            placeholder="All departments"
          />
          <OptionalSelect
            id="attendance-designation"
            label="Designation"
            value={designationId}
            onChange={setDesignationId}
            options={(options.data?.designations ?? []).map((item) => ({
              value: item.id,
              label: item.name ?? "",
            }))}
            placeholder="All designations"
          />
          <div className="space-y-1">
            <Label htmlFor="attendance-status">Status</Label>
            <Select
              value={state.status || "all"}
              onValueChange={(value) => state.setStatus(value === "all" ? "" : value)}
            >
              <SelectTrigger id="attendance-status" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {[
                  "present",
                  "late",
                  "half_day",
                  "incomplete",
                  "absent",
                  "holiday",
                  "rest_day",
                  "excused",
                ].map((item) => (
                  <SelectItem key={item} value={item}>
                    {item.replaceAll("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SharedListFilters>
      </Card>
      <Card>
        <DataQueryState loading={query.isLoading} error={query.error} empty={!rows.length}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Employee</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Worked / break</TableHead>
                <TableHead>Exceptions</TableHead>
                <TableHead>Approval</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.business_date}</TableCell>
                  <TableCell>
                    <p className="font-medium">
                      {row.employee?.first_name} {row.employee?.last_name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {row.employee?.employee_number} ·{" "}
                      {row.employee?.department?.name ?? "No department"}
                    </p>
                  </TableCell>
                  <TableCell>
                    <Badge>{row.attendance_status.replaceAll("_", " ")}</Badge>
                  </TableCell>
                  <TableCell>
                    {minutes(row.worked_minutes)} / {minutes(row.break_minutes)}
                  </TableCell>
                  <TableCell className="text-xs">
                    Late {row.late_minutes}m · Early {row.early_departure_minutes}m<br />
                    Overtime {row.overtime_minutes}m informational
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{row.approval_status}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="View source events"
                      onClick={() => setDetails(row)}
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    {canAdjust.allowed && (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Create adjustment"
                        onClick={() => setAdjusting(row)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                    {canApprove.allowed && row.approval_status === "pending" && (
                      <>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="Approve attendance"
                          onClick={() => decision(row, "approved")}
                        >
                          <Check className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="Reject attendance"
                          onClick={() => decision(row, "rejected")}
                        >
                          <X className="h-4 w-4" />
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
      {details && propertyId && (
        <DetailsDialog propertyId={propertyId} row={details} onClose={() => setDetails(null)} />
      )}
      {adjusting && propertyId && (
        <AdjustmentDialog
          propertyId={propertyId}
          row={adjusting}
          onClose={() => setAdjusting(null)}
        />
      )}
    </div>
  );
}

function DetailsDialog({
  propertyId,
  row,
  onClose,
}: {
  propertyId: string;
  row: Summary;
  onClose: () => void;
}) {
  const getDetails = useServerFn(getAttendanceDetails);
  const review = useServerFn(reviewAttendanceAdjustment);
  const queryClient = useQueryClient();
  const canReview = usePermission({
    propertyId,
    module: "attendance_adjustments",
    capability: "approve",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const query = useQuery({
    queryKey: ["attendance-details", row.id],
    queryFn: () => getDetails({ data: { propertyId, summaryId: row.id } }) as Promise<any>,
  });
  async function decide(adjustmentId: string, decision: "approved" | "rejected" | "returned") {
    try {
      await review({ data: { propertyId, adjustmentId, decision } });
      toast.success(`Adjustment ${decision}`);
      await query.refetch();
      queryClient.invalidateQueries({ queryKey: ["attendance"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to review adjustment");
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Attendance calculation details</DialogTitle>
        </DialogHeader>
        <DataQueryState loading={query.isLoading} error={query.error} empty={!query.data}>
          <div className="space-y-4">
            <div>
              <h3 className="font-medium">Immutable source events</h3>
              {query.data?.events.map((event: any) => (
                <p key={event.id} className="mt-2 text-sm">
                  <Badge variant="outline">{event.event_type}</Badge> {event.event_at} UTC ·{" "}
                  {event.source}
                </p>
              ))}
            </div>
            <div>
              <h3 className="font-medium">Calculation history</h3>
              <p className="text-sm text-muted-foreground">
                {query.data?.calculations.length ?? 0} retained recalculations
              </p>
            </div>
            <div>
              <h3 className="font-medium">Adjustments</h3>
              {query.data?.adjustments.map((item: any) => (
                <div key={item.id} className="mt-2 rounded-md border p-2 text-sm">
                  <p>
                    {item.adjustment_type} · {item.approval_status} · {item.reason}
                  </p>
                  {canReview.allowed && item.approval_status === "pending" && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => decide(item.id, "approved")}>
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => decide(item.id, "rejected")}
                      >
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => decide(item.id, "returned")}
                      >
                        Return
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </DataQueryState>
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdjustmentDialog({
  propertyId,
  row,
  onClose,
}: {
  propertyId: string;
  row: Summary;
  onClose: () => void;
}) {
  const create = useServerFn(createAttendanceAdjustment);
  const queryClient = useQueryClient();
  const [type, setType] = useState("add_event");
  const [eventType, setEventType] = useState("manual_clock_in");
  const [eventAt, setEventAt] = useState("");
  const [status, setStatus] = useState("excused");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      const proposedValues =
        type === "add_event"
          ? { eventType, localEventAt: eventAt, rosterId: null }
          : { attendanceStatus: status };
      await create({
        data: {
          propertyId,
          employeeId: row.employee_id,
          businessDate: row.business_date,
          summaryId: row.id,
          adjustmentType: type,
          reason,
          proposedValues,
          previousValues: { attendanceStatus: row.attendance_status },
        },
      });
      toast.success("Adjustment submitted for approval");
      queryClient.invalidateQueries({ queryKey: ["attendance"] });
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to submit adjustment");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manual attendance adjustment</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="adjustment-type">Adjustment</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id="adjustment-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="add_event">Add missing event</SelectItem>
                <SelectItem value="summary_status">Correct summary status</SelectItem>
                <SelectItem value="excused_status">Mark excused</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {type === "add_event" ? (
            <>
              <div className="space-y-1">
                <Label htmlFor="manual-event-type">Event type</Label>
                <Select value={eventType} onValueChange={setEventType}>
                  <SelectTrigger id="manual-event-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[
                      "manual_clock_in",
                      "manual_clock_out",
                      "manual_break_start",
                      "manual_break_end",
                    ].map((item) => (
                      <SelectItem key={item} value={item}>
                        {item.replaceAll("_", " ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="manual-event-at">Property-local date and time</Label>
                <Input
                  id="manual-event-at"
                  type="datetime-local"
                  value={eventAt}
                  onChange={(event) => setEventAt(event.target.value)}
                />
              </div>
            </>
          ) : (
            <div className="space-y-1">
              <Label htmlFor="corrected-status">Corrected status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger id="corrected-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["present", "late", "half_day", "incomplete", "excused"].map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="adjustment-reason">Reason</Label>
            <Textarea
              id="adjustment-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Original events are never edited or deleted. The proposal retains previous and new
            values.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || reason.trim().length < 5 || (type === "add_event" && !eventAt)}
            onClick={submit}
          >
            {busy ? "Submitting…" : "Submit adjustment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
function minutes(value: number) {
  return `${Math.floor(value / 60)}h ${value % 60}m`;
}
