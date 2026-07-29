export function calculateLeaveDays(input: {
  startDate: string;
  endDate: string;
  workingDays: number[];
  holidayDates: string[];
  partialDayMode?: string;
}): number {
  const start = parseIsoDate(input.startDate);
  const end = parseIsoDate(input.endDate);
  if (end < start) throw new Error("Invalid leave date range");
  const working = new Set(input.workingDays);
  const holidays = new Set(input.holidayDates);
  let days = 0;
  while (start <= end) {
    const date = start.toISOString().slice(0, 10);
    if (working.has(start.getUTCDay()) && !holidays.has(date)) days += 1;
    start.setUTCDate(start.getUTCDate() + 1);
  }
  if (input.partialDayMode && input.partialDayMode !== "none") {
    if (days !== 1) throw new Error("Partial-day leave must cover one working day");
    return 0.5;
  }
  return days;
}

function parseIsoDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Invalid leave date");
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error("Invalid leave date");
  }
  return date;
}

export function validateLeaveType(input: {
  carryForwardEnabled: boolean;
  maximumCarryForward: number;
  partialDaySupported: boolean;
  minimumRequestDuration: number;
  maximumConsecutiveDays?: number | null;
}): void {
  if (input.carryForwardEnabled && input.maximumCarryForward <= 0) {
    throw new Error("Carry-forward maximum is required");
  }
  if (!input.partialDaySupported && input.minimumRequestDuration < 1) {
    throw new Error("Partial-day minimum contradicts the policy");
  }
  if (
    input.maximumConsecutiveDays != null &&
    input.maximumConsecutiveDays < input.minimumRequestDuration
  ) {
    throw new Error("Maximum consecutive leave is shorter than the minimum request");
  }
}

export function remainingLeaveBalance(input: {
  opening: number;
  accrued: number;
  carried: number;
  adjusted: number;
  used: number;
  pending: number;
}): number {
  return (
    input.opening + input.accrued + input.carried + input.adjusted - input.used - input.pending
  );
}

export function policyPeriodFor(
  dateValue: string,
  startMonth = 1,
): {
  start: string;
  end: string;
} {
  const date = new Date(`${dateValue}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || startMonth < 1 || startMonth > 12) {
    throw new Error("Invalid policy period");
  }
  let year = date.getUTCFullYear();
  if (date.getUTCMonth() + 1 < startMonth) year -= 1;
  const start = new Date(Date.UTC(year, startMonth - 1, 1));
  const end = new Date(Date.UTC(year + 1, startMonth - 1, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export function validateLeaveEligibility(input: {
  requestDate: string;
  startDate: string;
  minimumNoticeDays: number;
  requestedDays: number;
  minimumDuration: number;
  maximumConsecutiveDays?: number | null;
  employmentStatus: string;
  probationEligible: boolean;
  serviceDays: number;
  minimumServiceDays: number;
}): void {
  const request = Date.parse(`${input.requestDate}T00:00:00Z`);
  const start = Date.parse(`${input.startDate}T00:00:00Z`);
  parseIsoDate(input.requestDate);
  parseIsoDate(input.startDate);
  if ((start - request) / 86_400_000 < input.minimumNoticeDays)
    throw new Error("Minimum notice not met");
  if (input.requestedDays < input.minimumDuration)
    throw new Error("Request is below the minimum duration");
  if (input.maximumConsecutiveDays != null && input.requestedDays > input.maximumConsecutiveDays) {
    throw new Error("Request exceeds maximum consecutive days");
  }
  if (input.employmentStatus === "probation" && !input.probationEligible) {
    throw new Error("Not eligible during probation");
  }
  if (input.serviceDays < input.minimumServiceDays)
    throw new Error("Minimum service duration not met");
}

export function leaveRangesOverlap(
  left: { startDate: string; endDate: string },
  right: { startDate: string; endDate: string },
): boolean {
  return left.startDate <= right.endDate && right.startDate <= left.endDate;
}

export function validateAvailableLeave(
  remaining: number,
  requested: number,
  negativeAllowed: boolean,
) {
  if (!negativeAllowed && remaining - requested < 0) throw new Error("Insufficient leave balance");
}

export function balanceEffect(status: string, days: number): { pending: number; used: number } {
  if (status === "submitted") return { pending: days, used: 0 };
  if (status === "approved") return { pending: 0, used: days };
  return { pending: 0, used: 0 };
}

export function hasRosterLeaveConflict(
  dutyDate: string,
  leaves: { startDate: string; endDate: string; status: string }[],
): boolean {
  return leaves.some(
    (leave) =>
      ["submitted", "approved"].includes(leave.status) &&
      dutyDate >= leave.startDate &&
      dutyDate <= leave.endDate,
  );
}

export function attendanceImpact(
  partialDayMode: string,
  hasClockEvents: boolean,
): "on_leave" | "preserve" {
  return partialDayMode === "none" && !hasClockEvents ? "on_leave" : "preserve";
}

export function stableLeaveCalculationKey(input: {
  employeeId: string;
  leaveTypeId: string;
  periodStart: string;
  periodEnd: string;
  requestVersions: readonly string[];
}): string {
  return [
    input.employeeId,
    input.leaveTypeId,
    input.periodStart,
    input.periodEnd,
    ...[...input.requestVersions].sort(),
  ].join("|");
}

export function validateLeaveDocument(input: {
  propertyId: string;
  employeeId: string;
  path: string;
  mime: string;
  size: number;
}): void {
  if (!["application/pdf", "image/jpeg", "image/png"].includes(input.mime)) {
    throw new Error("Unsupported leave document type");
  }
  if (input.size <= 0 || input.size > 10 * 1024 * 1024)
    throw new Error("Leave document exceeds 10 MB");
  if (!input.path.startsWith(`${input.propertyId}/${input.employeeId}/`)) {
    throw new Error("Invalid private document path");
  }
}
