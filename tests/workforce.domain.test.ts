import { describe, expect, it } from "vitest";
import {
  assertNoRosterOverlap,
  excessiveConsecutiveWorkdays,
  isValidIanaTimezone,
  recurringHolidayMatches,
  shiftDuration,
  validateWorkforceSettings,
} from "../src/lib/hrm/workforce-domain";

const validSettings = {
  timezone: "Africa/Accra",
  defaultWorkingDays: [1, 2, 3, 4, 5],
  standardStartTime: "08:00",
  standardEndTime: "17:00",
  gracePeriodMinutes: 5,
  lateThresholdMinutes: 10,
  minimumFullDayMinutes: 480,
  minimumHalfDayMinutes: 240,
  maximumOpenShiftMinutes: 960,
  allowOvernightShifts: true,
  biometricAttendanceEnabled: false,
  biometricIntegrationMode: "disabled",
};

describe("workforce time domain", () => {
  it("accepts valid IANA zones and rejects invalid zones", () => {
    expect(isValidIanaTimezone("Africa/Accra")).toBe(true);
    expect(isValidIanaTimezone("UTC")).toBe(true);
    expect(isValidIanaTimezone("Accra/Hotel")).toBe(false);
  });

  it("rejects contradictory workforce settings", () => {
    expect(() => validateWorkforceSettings(validSettings)).not.toThrow();
    expect(() =>
      validateWorkforceSettings({ ...validSettings, minimumHalfDayMinutes: 500 }),
    ).toThrow("Half-day minimum");
    expect(() => validateWorkforceSettings({ ...validSettings, lateThresholdMinutes: 2 })).toThrow(
      "Late threshold",
    );
  });

  it("detects overnight shifts and rejects zero or invalid durations", () => {
    expect(shiftDuration({ startTime: "22:00", endTime: "06:00", breakMinutes: 30 })).toEqual({
      overnight: true,
      elapsedMinutes: 480,
      expectedWorkMinutes: 450,
    });
    expect(() => shiftDuration({ startTime: "09:00", endTime: "09:00" })).toThrow("zero");
    expect(() => shiftDuration({ startTime: "09:00", endTime: "10:00", breakMinutes: 60 })).toThrow(
      "shorter",
    );
  });

  it("detects ordinary and overnight roster overlaps without silent replacement", () => {
    const overnight = {
      employeeId: "employee-1",
      startsAt: "2026-08-01T22:00:00Z",
      endsAt: "2026-08-02T06:00:00Z",
    };
    expect(() =>
      assertNoRosterOverlap(
        {
          employeeId: "employee-1",
          startsAt: "2026-08-02T05:00:00Z",
          endsAt: "2026-08-02T09:00:00Z",
        },
        [overnight],
      ),
    ).toThrow("overlaps");
    expect(() =>
      assertNoRosterOverlap({ ...overnight, employeeId: "employee-2" }, [overnight]),
    ).not.toThrow();
  });

  it("warns at the configured consecutive-day limit", () => {
    expect(
      excessiveConsecutiveWorkdays(
        "2026-08-08",
        [
          "2026-08-01",
          "2026-08-02",
          "2026-08-03",
          "2026-08-04",
          "2026-08-05",
          "2026-08-06",
          "2026-08-07",
        ],
        7,
      ),
    ).toBe(true);
  });

  it("matches recurring holidays by month and day", () => {
    expect(
      recurringHolidayMatches({ date: "2025-12-25", recurringAnnually: true }, "2026-12-25"),
    ).toBe(true);
    expect(
      recurringHolidayMatches({ date: "2025-12-25", recurringAnnually: false }, "2026-12-25"),
    ).toBe(false);
  });
});
