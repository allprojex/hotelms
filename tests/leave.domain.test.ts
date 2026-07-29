import { describe, expect, it } from "vitest";
import {
  attendanceImpact,
  balanceEffect,
  calculateLeaveDays,
  hasRosterLeaveConflict,
  leaveRangesOverlap,
  policyPeriodFor,
  remainingLeaveBalance,
  stableLeaveCalculationKey,
  validateAvailableLeave,
  validateLeaveDocument,
  validateLeaveEligibility,
  validateLeaveType,
} from "../src/lib/hrm/leave-domain";

describe("leave policy and calculation domain", () => {
  it("excludes weekends and property holidays", () => {
    expect(
      calculateLeaveDays({
        startDate: "2026-08-03",
        endDate: "2026-08-09",
        workingDays: [1, 2, 3, 4, 5],
        holidayDates: ["2026-08-05"],
      }),
    ).toBe(4);
  });
  it("supports a single partial working day", () => {
    expect(
      calculateLeaveDays({
        startDate: "2026-08-03",
        endDate: "2026-08-03",
        workingDays: [1, 2, 3, 4, 5],
        holidayDates: [],
        partialDayMode: "morning",
      }),
    ).toBe(0.5);
    expect(() =>
      calculateLeaveDays({
        startDate: "2026-08-03",
        endDate: "2026-08-04",
        workingDays: [1, 2, 3, 4, 5],
        holidayDates: [],
        partialDayMode: "morning",
      }),
    ).toThrow();
    expect(() =>
      calculateLeaveDays({
        startDate: "2026-02-30",
        endDate: "2026-03-01",
        workingDays: [1, 2, 3, 4, 5],
        holidayDates: [],
      }),
    ).toThrow("Invalid leave date");
  });
  it("rejects invalid ranges and contradictory policies", () => {
    expect(() =>
      calculateLeaveDays({
        startDate: "2026-08-04",
        endDate: "2026-08-03",
        workingDays: [1],
        holidayDates: [],
      }),
    ).toThrow();
    expect(() =>
      validateLeaveType({
        carryForwardEnabled: true,
        maximumCarryForward: 0,
        partialDaySupported: true,
        minimumRequestDuration: 0.5,
      }),
    ).toThrow();
    expect(() =>
      validateLeaveType({
        carryForwardEnabled: false,
        maximumCarryForward: 0,
        partialDaySupported: false,
        minimumRequestDuration: 0.5,
      }),
    ).toThrow();
  });
  it("derives stable policy years and calculation inputs", () => {
    expect(policyPeriodFor("2026-02-01")).toEqual({ start: "2026-01-01", end: "2026-12-31" });
    const a = stableLeaveCalculationKey({
      employeeId: "e",
      leaveTypeId: "l",
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
      requestVersions: ["b", "a"],
    });
    const b = stableLeaveCalculationKey({
      employeeId: "e",
      leaveTypeId: "l",
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
      requestVersions: ["a", "b"],
    });
    expect(a).toBe(b);
  });
  it("validates notice, duration, probation, and service eligibility", () => {
    expect(() =>
      validateLeaveEligibility({
        requestDate: "2026-08-01",
        startDate: "2026-08-02",
        minimumNoticeDays: 3,
        requestedDays: 2,
        minimumDuration: 1,
        employmentStatus: "active",
        probationEligible: true,
        serviceDays: 100,
        minimumServiceDays: 0,
      }),
    ).toThrow("notice");
    expect(() =>
      validateLeaveEligibility({
        requestDate: "2026-08-01",
        startDate: "2026-08-10",
        minimumNoticeDays: 3,
        requestedDays: 2,
        minimumDuration: 1,
        employmentStatus: "probation",
        probationEligible: false,
        serviceDays: 100,
        minimumServiceDays: 0,
      }),
    ).toThrow("probation");
  });
  it("detects overlaps and negative balances", () => {
    expect(
      leaveRangesOverlap(
        { startDate: "2026-08-01", endDate: "2026-08-05" },
        { startDate: "2026-08-05", endDate: "2026-08-06" },
      ),
    ).toBe(true);
    expect(() => validateAvailableLeave(2, 3, false)).toThrow("Insufficient");
    expect(() => validateAvailableLeave(2, 3, true)).not.toThrow();
  });
  it("calculates pending, used, adjusted, and released balance effects", () => {
    expect(balanceEffect("submitted", 3)).toEqual({ pending: 3, used: 0 });
    expect(balanceEffect("approved", 3)).toEqual({ pending: 0, used: 3 });
    expect(balanceEffect("withdrawn", 3)).toEqual({ pending: 0, used: 0 });
    expect(balanceEffect("rejected", 3)).toEqual({ pending: 0, used: 0 });
    expect(balanceEffect("cancelled", 3)).toEqual({ pending: 0, used: 0 });
    expect(
      remainingLeaveBalance({
        opening: 2,
        accrued: 20,
        carried: 3,
        adjusted: 1,
        used: 4,
        pending: 2,
      }),
    ).toBe(20);
  });
  it("detects roster conflicts and preserves partial-day or real-event attendance", () => {
    expect(
      hasRosterLeaveConflict("2026-08-02", [
        { startDate: "2026-08-01", endDate: "2026-08-03", status: "approved" },
      ]),
    ).toBe(true);
    expect(attendanceImpact("none", false)).toBe("on_leave");
    expect(attendanceImpact("morning", false)).toBe("preserve");
    expect(attendanceImpact("none", true)).toBe("preserve");
  });
  it("validates private supporting documents", () => {
    expect(() =>
      validateLeaveDocument({
        propertyId: "p",
        employeeId: "e",
        path: "p/e/leave/a.pdf",
        mime: "application/pdf",
        size: 100,
      }),
    ).not.toThrow();
    expect(() =>
      validateLeaveDocument({
        propertyId: "p",
        employeeId: "e",
        path: "other/a.pdf",
        mime: "application/pdf",
        size: 100,
      }),
    ).toThrow("path");
    expect(() =>
      validateLeaveDocument({
        propertyId: "p",
        employeeId: "e",
        path: "p/e/a.exe",
        mime: "application/octet-stream",
        size: 100,
      }),
    ).toThrow("type");
    expect(() =>
      validateLeaveDocument({
        propertyId: "p",
        employeeId: "e",
        path: "p/e/a.pdf",
        mime: "application/pdf",
        size: 11 * 1024 * 1024,
      }),
    ).toThrow("10 MB");
  });
});
