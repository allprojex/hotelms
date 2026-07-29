import { describe, expect, it } from "vitest";
import {
  adjustPaymentDate,
  generatePayPeriods,
  maskPaymentValue,
  rangesOverlap,
  validateBaseSalary,
  validateGradeBand,
  validateOpeningBalance,
  validatePayComponent,
  validatePayrollSettings,
  validateStructuredRuleParameters,
} from "../src/lib/hrm/payroll-domain";

const validSettings = {
  currency: "GHS",
  propertyCurrency: "GHS",
  timezone: "Africa/Accra",
  monetaryPrecision: 2,
  payrollEnabled: true,
  approvalRequired: true,
  finalizationRequiresApproval: true,
  payrollYearStartMonth: 1,
};

describe("Phase 4A payroll domain", () => {
  it("accepts property-aligned settings and rejects currency drift", () => {
    expect(() => validatePayrollSettings(validSettings)).not.toThrow();
    expect(() => validatePayrollSettings({ ...validSettings, currency: "USD" })).toThrow(
      /property currency/,
    );
  });

  it("validates IANA timezones and contradictory approval controls", () => {
    expect(() => validatePayrollSettings({ ...validSettings, timezone: "not/a-zone" })).toThrow(
      /IANA timezone/,
    );
    expect(() => validatePayrollSettings({ ...validSettings, approvalRequired: false })).toThrow(
      /requires payroll approval/,
    );
  });

  it("detects inclusive effective-date overlaps", () => {
    expect(
      rangesOverlap(
        { startDate: "2026-01-01", endDate: "2026-06-30" },
        { startDate: "2026-06-30" },
      ),
    ).toBe(true);
    expect(
      rangesOverlap(
        { startDate: "2026-01-01", endDate: "2026-06-29" },
        { startDate: "2026-06-30" },
      ),
    ).toBe(false);
  });

  it("generates continuous planned periods in the requested year", () => {
    const rows = generatePayPeriods({
      firstPeriodStart: "2025-01-05",
      payrollYear: 2027,
      periodsPerYear: 3,
      intervalDays: 7,
      weekendRule: "none",
      holidayRule: "none",
      holidays: [],
    });
    expect(rows).toHaveLength(3);
    expect(rows[0].startDate).toBe("2027-01-05");
    expect(rows[1].startDate).toBe("2027-01-12");
    expect(rows[0].endDate).toBe("2027-01-11");
  });

  it("adjusts weekend and holiday payment dates", () => {
    expect(adjustPaymentDate("2026-08-01", "previous_working_day", "none", [])).toBe("2026-07-31");
    expect(adjustPaymentDate("2026-07-31", "none", "previous_working_day", ["2026-07-31"])).toBe(
      "2026-07-30",
    );
  });

  it("validates grade ordering and authorized base-salary overrides", () => {
    expect(() => validateGradeBand(1_000, 1_500, 2_000)).not.toThrow();
    expect(() => validateGradeBand(2_000, 1_500, 1_000)).toThrow(/inconsistent/);
    expect(() => validateBaseSalary(2_500, { minimum: 1_000, maximum: 2_000 }, false)).toThrow(
      /override/,
    );
    expect(() =>
      validateBaseSalary(
        2_500,
        { minimum: 1_000, maximum: 2_000 },
        true,
        "Board-approved market adjustment",
      ),
    ).not.toThrow();
  });

  it("rejects incompatible component fields", () => {
    expect(() =>
      validatePayComponent({
        calculationMethod: "fixed_amount",
        defaultPercentage: 10,
      }),
    ).toThrow(/Fixed components/);
    expect(() =>
      validatePayComponent({
        calculationMethod: "percentage",
        defaultPercentage: 10,
        percentageBasisCode: "BASE",
      }),
    ).not.toThrow();
  });

  it("allows structured parameters but rejects executable formula keys", () => {
    expect(() =>
      validateStructuredRuleParameters({ bands: [{ threshold: 1000, rateLabel: "draft" }] }),
    ).not.toThrow();
    expect(() => validateStructuredRuleParameters({ formula: "gross * 0.1" })).toThrow(
      /Executable statutory rules/,
    );
    expect(() => validateStructuredRuleParameters({ nested: { javascript: "x" } })).toThrow(
      /Executable statutory rules/,
    );
  });

  it("masks payment destinations and validates opening-balance evidence", () => {
    expect(maskPaymentValue("1234 5678 9012")).toBe("•••• 9012");
    expect(() =>
      validateOpeningBalance({
        amount: 100,
        currency: "GHS",
        propertyCurrency: "GHS",
        asOfDate: "2026-01-01",
        sourceSystem: "Legacy payroll",
      }),
    ).not.toThrow();
    expect(() =>
      validateOpeningBalance({
        amount: 100,
        currency: "USD",
        propertyCurrency: "GHS",
        asOfDate: "2026-01-01",
        sourceSystem: "Legacy payroll",
      }),
    ).toThrow(/currency mismatch/);
  });
});
