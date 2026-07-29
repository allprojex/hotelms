export type EffectiveAttendanceEvent = {
  id?: string;
  eventType: string;
  eventAt: string;
};

export function effectiveEventType(value: string): string {
  return value.replace(/^manual_/, "");
}

export function validateEventSequence(events: EffectiveAttendanceEvent[], nextType: string): void {
  const last = events.length ? effectiveEventType(events[events.length - 1].eventType) : null;
  const next = effectiveEventType(nextType);
  const valid =
    (next === "clock_in" && (last === null || last === "clock_out")) ||
    (next === "break_start" && (last === "clock_in" || last === "break_end")) ||
    (next === "break_end" && last === "break_start") ||
    (next === "clock_out" && (last === "clock_in" || last === "break_end"));
  if (!valid) throw new Error("Invalid attendance event sequence");
}

export function calculateAttendanceDurations(events: EffectiveAttendanceEvent[]): {
  firstClockIn: string | null;
  lastClockOut: string | null;
  workedMinutes: number;
  breakMinutes: number;
  incomplete: boolean;
} {
  const ordered = [...events].sort((a, b) => Date.parse(a.eventAt) - Date.parse(b.eventAt));
  let clockIn: number | null = null;
  let clockOut: number | null = null;
  let breakStart: number | null = null;
  let breaks = 0;
  for (const event of ordered) {
    const at = Date.parse(event.eventAt);
    if (!Number.isFinite(at)) throw new Error("Invalid event timestamp");
    const type = effectiveEventType(event.eventType);
    if (type === "clock_in" && clockIn === null) clockIn = at;
    if (type === "break_start" && breakStart === null) breakStart = at;
    if (type === "break_end" && breakStart !== null) {
      breaks += Math.max(0, Math.floor((at - breakStart) / 60_000));
      breakStart = null;
    }
    if (type === "clock_out" && clockIn !== null) clockOut = at;
  }
  const complete = clockIn !== null && clockOut !== null && breakStart === null;
  return {
    firstClockIn: clockIn === null ? null : new Date(clockIn).toISOString(),
    lastClockOut: clockOut === null ? null : new Date(clockOut).toISOString(),
    workedMinutes: complete ? Math.max(0, Math.floor((clockOut! - clockIn!) / 60_000) - breaks) : 0,
    breakMinutes: breaks,
    incomplete: !complete,
  };
}

export function neutralizeSpreadsheetFormula(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

export function attendanceCsv(
  rows: Record<string, unknown>[],
  columns: { key: string; label: string }[],
): string {
  const escape = (value: unknown) => `"${neutralizeSpreadsheetFormula(value).replace(/"/g, '""')}"`;
  return [
    columns.map((column) => escape(column.label)).join(","),
    ...rows.map((row) => columns.map((column) => escape(row[column.key])).join(",")),
  ].join("\r\n");
}

export function elapsedMinutes(from: string | null, now = Date.now()): number {
  if (!from) return 0;
  return Math.max(0, Math.floor((now - Date.parse(from)) / 60_000));
}
