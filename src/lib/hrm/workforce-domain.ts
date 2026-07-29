export function isValidIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value.trim().length > 0;
  } catch {
    return false;
  }
}

export function minutesFromTime(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error("Time must use HH:mm format");
  return Number(match[1]) * 60 + Number(match[2]);
}

export function shiftDuration(input: {
  startTime: string;
  endTime: string;
  breakMinutes?: number;
}): { overnight: boolean; elapsedMinutes: number; expectedWorkMinutes: number } {
  const start = minutesFromTime(input.startTime);
  const end = minutesFromTime(input.endTime);
  if (start === end) throw new Error("Shift cannot have zero duration");
  const overnight = end < start;
  const elapsedMinutes = (end - start + 1440) % 1440;
  const breakMinutes = Math.trunc(input.breakMinutes ?? 0);
  if (breakMinutes < 0 || breakMinutes >= elapsedMinutes) {
    throw new Error("Break duration must be shorter than the shift");
  }
  return {
    overnight,
    elapsedMinutes,
    expectedWorkMinutes: elapsedMinutes - breakMinutes,
  };
}

export function validateWorkforceSettings(input: {
  timezone: string;
  defaultWorkingDays: number[];
  standardStartTime: string;
  standardEndTime: string;
  gracePeriodMinutes: number;
  lateThresholdMinutes: number;
  minimumFullDayMinutes: number;
  minimumHalfDayMinutes: number;
  maximumOpenShiftMinutes: number;
  allowOvernightShifts: boolean;
  biometricAttendanceEnabled: boolean;
  biometricIntegrationMode: string;
}): void {
  if (!isValidIanaTimezone(input.timezone)) throw new Error("Invalid IANA timezone");
  const days = [...new Set(input.defaultWorkingDays)];
  if (days.length === 0 || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error("Working days must use values from 0 through 6");
  }
  const duration = shiftDuration({
    startTime: input.standardStartTime,
    endTime: input.standardEndTime,
  });
  if (duration.overnight && !input.allowOvernightShifts) {
    throw new Error("Overnight standard hours require overnight handling");
  }
  if (input.minimumHalfDayMinutes > input.minimumFullDayMinutes) {
    throw new Error("Half-day minimum cannot exceed full-day minimum");
  }
  if (input.lateThresholdMinutes < input.gracePeriodMinutes) {
    throw new Error("Late threshold cannot be shorter than the grace period");
  }
  if (duration.elapsedMinutes > input.maximumOpenShiftMinutes) {
    throw new Error("Standard workday exceeds the maximum open shift duration");
  }
  const biometricDisabled = input.biometricIntegrationMode === "disabled";
  if (input.biometricAttendanceEnabled === biometricDisabled) {
    throw new Error("Biometric flag and integration mode contradict each other");
  }
}

export type ShiftWindow = {
  id?: string;
  employeeId: string;
  startsAt: string;
  endsAt: string;
};

export function shiftsOverlap(left: ShiftWindow, right: ShiftWindow): boolean {
  if (
    left.employeeId !== right.employeeId ||
    (left.id !== undefined && right.id !== undefined && left.id === right.id)
  ) {
    return false;
  }
  return (
    Date.parse(left.startsAt) < Date.parse(right.endsAt) &&
    Date.parse(right.startsAt) < Date.parse(left.endsAt)
  );
}

export function assertNoRosterOverlap(candidate: ShiftWindow, existing: ShiftWindow[]): void {
  if (existing.some((entry) => shiftsOverlap(candidate, entry))) {
    throw new Error("This assignment overlaps an existing employee shift");
  }
}

export function localDutyWindow(input: {
  dutyDate: string;
  startTime: string;
  endTime: string;
  timezone: string;
}): { localStart: string; localEnd: string; overnight: boolean } {
  if (!isValidIanaTimezone(input.timezone)) throw new Error("Invalid IANA timezone");
  const { overnight } = shiftDuration({
    startTime: input.startTime,
    endTime: input.endTime,
  });
  const date = new Date(`${input.dutyDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid duty date");
  const endDate = new Date(date);
  if (overnight) endDate.setUTCDate(endDate.getUTCDate() + 1);
  return {
    localStart: `${input.dutyDate}T${input.startTime}:00[${input.timezone}]`,
    localEnd: `${endDate.toISOString().slice(0, 10)}T${input.endTime}:00[${input.timezone}]`,
    overnight,
  };
}

export function excessiveConsecutiveWorkdays(
  dutyDate: string,
  existingDates: readonly string[],
  limit: number,
): boolean {
  const dates = new Set(existingDates);
  const cursor = new Date(`${dutyDate}T00:00:00Z`);
  for (let offset = 1; offset <= limit; offset += 1) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    if (!dates.has(cursor.toISOString().slice(0, 10))) return false;
  }
  return true;
}

export function recurringHolidayMatches(
  holiday: { date: string; recurringAnnually: boolean },
  targetDate: string,
): boolean {
  return holiday.recurringAnnually
    ? holiday.date.slice(5) === targetDate.slice(5)
    : holiday.date === targetDate;
}
