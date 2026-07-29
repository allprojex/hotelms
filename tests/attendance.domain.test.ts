import { describe, expect, it } from "vitest";
import {
  attendanceCsv,
  calculateAttendanceDurations,
  effectiveEventType,
  neutralizeSpreadsheetFormula,
  validateEventSequence,
} from "../src/lib/hrm/attendance-domain";

describe("attendance event sequencing and calculations", () => {
  it("accepts a full clock and break sequence", () => {
    const events = [{ eventType: "clock_in", eventAt: "2026-08-01T08:00:00Z" }];
    expect(() => validateEventSequence(events, "break_start")).not.toThrow();
    expect(() =>
      validateEventSequence(
        [...events, { eventType: "break_start", eventAt: "2026-08-01T12:00:00Z" }],
        "break_end",
      ),
    ).not.toThrow();
  });

  it("rejects duplicate clock-in, duplicate break, and clock-out during a break", () => {
    expect(() =>
      validateEventSequence(
        [{ eventType: "clock_in", eventAt: "2026-08-01T08:00:00Z" }],
        "clock_in",
      ),
    ).toThrow();
    expect(() =>
      validateEventSequence(
        [{ eventType: "break_start", eventAt: "2026-08-01T12:00:00Z" }],
        "break_start",
      ),
    ).toThrow();
    expect(() =>
      validateEventSequence(
        [{ eventType: "break_start", eventAt: "2026-08-01T12:00:00Z" }],
        "clock_out",
      ),
    ).toThrow();
  });

  it("calculates worked and break duration from immutable events", () => {
    expect(
      calculateAttendanceDurations([
        { eventType: "clock_in", eventAt: "2026-08-01T08:00:00Z" },
        { eventType: "break_start", eventAt: "2026-08-01T12:00:00Z" },
        { eventType: "break_end", eventAt: "2026-08-01T12:30:00Z" },
        { eventType: "clock_out", eventAt: "2026-08-01T17:00:00Z" },
      ]),
    ).toMatchObject({ workedMinutes: 510, breakMinutes: 30, incomplete: false });
  });

  it("does not count an incomplete or overnight open session as completed work", () => {
    expect(
      calculateAttendanceDurations([
        { eventType: "clock_in", eventAt: "2026-08-01T22:00:00Z" },
        { eventType: "break_start", eventAt: "2026-08-02T02:00:00Z" },
      ]),
    ).toMatchObject({ workedMinutes: 0, incomplete: true });
  });

  it("normalizes manual events without changing their stored classification", () => {
    expect(effectiveEventType("manual_clock_in")).toBe("clock_in");
  });

  it("neutralizes spreadsheet formulas in CSV exports", () => {
    for (const value of ["=1+1", "+SUM(A1:A2)", "-2+3", "@IMPORT"]) {
      expect(neutralizeSpreadsheetFormula(value)).toBe(`'${value}`);
    }
    expect(
      attendanceCsv([{ employee: "=CMD" }], [{ key: "employee", label: "Employee" }]),
    ).toContain("'=CMD");
  });
});
