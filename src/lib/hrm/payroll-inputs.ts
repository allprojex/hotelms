import type { NormalizedPayrollInputs } from "@/lib/hrm/payroll-calculation";

export type AttendanceInputRow = {
  id: string;
  propertyId: string;
  businessDate: string;
  scheduled: boolean;
  attendanceStatus: string;
  calculationStatus: string;
  approvalStatus: string;
  workedMinutes: number;
  lateMinutes?: number;
  earlyDepartureMinutes?: number;
  overtimeMinutes: number;
};

export type LeaveInputRow = {
  id: string;
  propertyId: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  partialDayMode: "none" | "morning" | "afternoon";
  status: string;
  paid: boolean;
};

function overlapDays(start: string, end: string, periodStart: string, periodEnd: string): number {
  const first = start > periodStart ? start : periodStart;
  const last = end < periodEnd ? end : periodEnd;
  if (last < first) return 0;
  return (
    Math.floor((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) +
    1
  );
}

export function preparePayrollInputs(input: {
  propertyId: string;
  periodStart: string;
  periodEnd: string;
  attendance: AttendanceInputRow[];
  leave: LeaveInputRow[];
}): NormalizedPayrollInputs {
  if (
    input.attendance.some((row) => row.propertyId !== input.propertyId) ||
    input.leave.some((row) => row.propertyId !== input.propertyId)
  )
    throw new Error("Cross-property payroll input is forbidden");
  const authoritativeAttendance = input.attendance.filter(
    (row) =>
      row.businessDate >= input.periodStart &&
      row.businessDate <= input.periodEnd &&
      ["approved", "not_required"].includes(row.approvalStatus),
  );
  const scheduled = authoritativeAttendance.filter((row) => row.scheduled);
  const incomplete = scheduled.filter(
    (row) =>
      row.attendanceStatus === "incomplete" ||
      ["incomplete", "error"].includes(row.calculationStatus),
  );
  const attended = authoritativeAttendance.filter((row) =>
    ["present", "late", "half_day"].includes(row.attendanceStatus),
  );
  const recordedAbsences = authoritativeAttendance.filter(
    (row) => row.scheduled && row.attendanceStatus === "absent",
  );
  const approvedLeave = input.leave.filter(
    (row) =>
      row.status === "approved" &&
      row.endDate >= input.periodStart &&
      row.startDate <= input.periodEnd,
  );
  let paidLeaveDays = 0;
  let unpaidLeaveDays = 0;
  for (const leave of approvedLeave) {
    const requestSpan = overlapDays(leave.startDate, leave.endDate, leave.startDate, leave.endDate);
    const overlap = overlapDays(leave.startDate, leave.endDate, input.periodStart, input.periodEnd);
    const days = requestSpan > 0 ? (leave.totalDays * overlap) / requestSpan : 0;
    if (leave.paid) paidLeaveDays += days;
    else unpaidLeaveDays += days;
  }
  const warnings: string[] = [];
  if (incomplete.length)
    warnings.push(`${incomplete.length} scheduled attendance record(s) are incomplete`);
  if (scheduled.length === 0)
    warnings.push("No authoritative scheduled attendance records were available");
  const overlappingLeave = approvedLeave.some((left, index) =>
    approvedLeave
      .slice(index + 1)
      .some((right) => left.startDate <= right.endDate && right.startDate <= left.endDate),
  );
  if (overlappingLeave) warnings.push("Approved leave requests overlap within the payroll period");
  return {
    scheduledWorkingDays: String(scheduled.length),
    attendedDays: String(attended.length),
    paidAttendanceDays: String(
      attended.reduce((total, row) => total + (row.attendanceStatus === "half_day" ? 0.5 : 1), 0) +
        paidLeaveDays,
    ),
    unpaidAbsenceDays: String(recordedAbsences.length),
    workedHours: String(
      authoritativeAttendance.reduce((total, row) => total + row.workedMinutes, 0) / 60,
    ),
    lateHours: String(
      authoritativeAttendance.reduce((total, row) => total + (row.lateMinutes ?? 0), 0) / 60,
    ),
    earlyDepartureHours: String(
      authoritativeAttendance.reduce((total, row) => total + (row.earlyDepartureMinutes ?? 0), 0) /
        60,
    ),
    paidLeaveDays: String(paidLeaveDays),
    unpaidLeaveDays: String(unpaidLeaveDays),
    overtimeHours: String(
      authoritativeAttendance.reduce((total, row) => total + row.overtimeMinutes, 0) / 60,
    ),
    incompleteAttendance: incomplete.length > 0 || scheduled.length === 0,
    sourceReferences: [
      ...authoritativeAttendance.map((row) => ({ type: "attendance_summary", id: row.id })),
      ...approvedLeave.map((row) => ({ type: "leave_request", id: row.id })),
    ],
    warnings,
  };
}
