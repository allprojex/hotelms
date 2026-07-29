import { describe, expect, it } from "vitest";
import {
  calculatePayroll,
  decimalUnits,
  evaluateStatutoryRule,
  orderCalculationComponents,
  roundUnits,
  unitsToString,
  validateStatutoryRule,
  type CalculatePayrollInput,
  type CalculationComponent,
  type StatutoryRule,
} from "../src/lib/hrm/payroll-calculation";
import { preparePayrollInputs } from "../src/lib/hrm/payroll-inputs";

const component = (
  code: string,
  method: CalculationComponent["method"],
  lineType: CalculationComponent["lineType"],
  extra: Partial<CalculationComponent> = {},
): CalculationComponent => ({
  id: `id-${code}`,
  propertyId: "property-a",
  code,
  name: code,
  method,
  lineType,
  amount: "0",
  displayOrder: 1,
  sourceType: "structure",
  sourceId: `source-${code}`,
  effectiveFrom: "2026-01-01",
  ...extra,
});

const baseInput = (components: CalculationComponent[] = []): CalculatePayrollInput => ({
  propertyId: "property-a",
  currency: "GHS",
  precision: 2,
  roundingMethod: "half_up",
  allowNegativeNetPay: false,
  blockUnverifiedStatutoryRules: true,
  period: { startDate: "2026-07-01", endDate: "2026-07-31", totalDays: 31 },
  compensation: {
    id: "comp-1",
    propertyId: "property-a",
    baseSalary: "3100",
    employmentPercentage: "100",
    effectiveFrom: "2026-01-01",
  },
  components,
  statutoryRules: [],
  inputs: {
    scheduledWorkingDays: "22",
    attendedDays: "20",
    paidAttendanceDays: "20",
    unpaidAbsenceDays: "0",
    workedHours: "160",
    paidLeaveDays: "2",
    unpaidLeaveDays: "1",
    overtimeHours: "4",
    incompleteAttendance: false,
    sourceReferences: [],
    warnings: [],
  },
});

describe("Phase 4B decimal-safe payroll calculation", () => {
  it("parses decimal money without binary floating-point totals", () => {
    expect(unitsToString(decimalUnits("0.1") + decimalUnits("0.2"), 2)).toBe("0.30");
  });

  it("supports configured half-up and half-even rounding", () => {
    expect(unitsToString(roundUnits(decimalUnits("1.235"), 2, "half_up"), 2)).toBe("1.24");
    expect(unitsToString(roundUnits(decimalUnits("1.245"), 2, "half_even"), 2)).toBe("1.24");
  });

  it("is deterministic for identical inputs", () => {
    const input = baseInput([component("MEAL", "fixed_amount", "earning", { amount: "125.50" })]);
    expect(calculatePayroll(input)).toEqual(calculatePayroll(input));
  });

  it("calculates fixed and percentage-of-base components", () => {
    const result = calculatePayroll(
      baseInput([
        component("MEAL", "fixed_amount", "earning", { amount: "100" }),
        component("PENSION", "percentage_base", "employee_statutory", {
          percentage: "5",
          displayOrder: 2,
        }),
      ]),
    );
    expect(result.totals.gross).toBe("3200.00");
    expect(result.lines.find((line) => line.code === "PENSION")?.roundedAmount).toBe("155.00");
    expect(result.totals.net).toBe("3045.00");
  });

  it("multiplies controlled manual quantities by the configured component rate", () => {
    const result = calculatePayroll(
      baseInput([
        component("MANUAL_HOURS", "manual_amount", "earning", {
          amount: "12.50",
          manualQuantity: "3",
          sourceType: "manual",
        }),
      ]),
    );
    expect(result.lines.find((line) => line.code === "MANUAL_HOURS")?.roundedAmount).toBe("37.50");
  });

  it("deducts only source-recorded unpaid absence and approved unpaid leave", () => {
    const input = baseInput([
      component("UNPAID", "unpaid_day_deduction", "post_tax_deduction", { amount: "100" }),
    ]);
    input.inputs.unpaidAbsenceDays = "2";
    input.inputs.unpaidLeaveDays = "1";
    const result = calculatePayroll(input);
    expect(result.lines.find((line) => line.code === "UNPAID")?.roundedAmount).toBe("300.00");
  });

  it("calculates a percentage of a selected component in dependency order", () => {
    const result = calculatePayroll(
      baseInput([
        component("BONUS_TAX", "percentage_component", "tax", {
          percentage: "10",
          basisComponentCode: "BONUS",
          displayOrder: 1,
        }),
        component("BONUS", "fixed_amount", "earning", { amount: "500", displayOrder: 2 }),
      ]),
    );
    expect(result.lines.map((line) => line.code)).toEqual(["BASE", "BONUS", "BONUS_TAX"]);
    expect(result.lines.find((line) => line.code === "BONUS_TAX")?.roundedAmount).toBe("50.00");
  });

  it("rejects cyclic and incompatible dependencies", () => {
    expect(() =>
      orderCalculationComponents([
        component("A", "percentage_component", "earning", { basisComponentCode: "B" }),
        component("B", "percentage_component", "earning", { basisComponentCode: "A" }),
      ]),
    ).toThrow(/Cyclic/);
    expect(() =>
      orderCalculationComponents([
        component("INFO", "informational_overtime", "informational"),
        component("A", "percentage_component", "earning", { basisComponentCode: "INFO" }),
      ]),
    ).toThrow(/informational/);
  });

  it("calculates attendance-day, worked-hour, and unpaid-day lines", () => {
    const result = calculatePayroll(
      baseInput([
        component("DAY", "attendance_day", "earning", { amount: "2" }),
        component("HOUR", "worked_hour", "earning", { amount: "1.5", displayOrder: 2 }),
        component("UNPAID", "unpaid_day_deduction", "post_tax_deduction", {
          amount: "100",
          displayOrder: 3,
        }),
      ]),
    );
    expect(result.lines.find((line) => line.code === "DAY")?.roundedAmount).toBe("40.00");
    expect(result.lines.find((line) => line.code === "HOUR")?.roundedAmount).toBe("240.00");
    expect(result.lines.find((line) => line.code === "UNPAID")?.roundedAmount).toBe("100.00");
  });

  it("applies component minimum and maximum limits", () => {
    const result = calculatePayroll(
      baseInput([
        component("CAPPED", "fixed_amount", "earning", {
          amount: "500",
          minimum: "100",
          maximum: "250",
        }),
      ]),
    );
    expect(result.lines.find((line) => line.code === "CAPPED")?.roundedAmount).toBe("250.00");
  });

  it("prorates mid-period starts, ends, and employment percentage", () => {
    const start = baseInput();
    start.compensation.effectiveFrom = "2026-07-16";
    start.compensation.employmentPercentage = "50";
    expect(calculatePayroll(start).totals.base).toBe("800.00");
    const end = baseInput();
    end.compensation.effectiveTo = "2026-07-15";
    expect(calculatePayroll(end).totals.base).toBe("1500.00");
  });

  it("keeps overtime informational unless a payable component exists", () => {
    const result = calculatePayroll(
      baseInput([component("OT_INFO", "informational_overtime", "informational")]),
    );
    expect(result.lines.find((line) => line.code === "OT_INFO")?.roundedAmount).toBe("0.00");
    expect(result.totals.gross).toBe("3100.00");
  });

  it("rejects cross-property components", () => {
    expect(() =>
      calculatePayroll(
        baseInput([component("FOREIGN", "fixed_amount", "earning", { propertyId: "property-b" })]),
      ),
    ).toThrow(/Cross-property/);
  });
});

describe("Phase 4B attendance and leave inputs", () => {
  it("uses approved attendance and approved leave only", () => {
    const result = preparePayrollInputs({
      propertyId: "property-a",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      attendance: [
        {
          id: "a1",
          propertyId: "property-a",
          businessDate: "2026-07-01",
          scheduled: true,
          attendanceStatus: "present",
          calculationStatus: "calculated",
          approvalStatus: "approved",
          workedMinutes: 480,
          overtimeMinutes: 60,
        },
        {
          id: "a2",
          propertyId: "property-a",
          businessDate: "2026-07-02",
          scheduled: true,
          attendanceStatus: "absent",
          calculationStatus: "calculated",
          approvalStatus: "pending",
          workedMinutes: 0,
          overtimeMinutes: 0,
        },
      ],
      leave: [
        {
          id: "l1",
          propertyId: "property-a",
          startDate: "2026-07-02",
          endDate: "2026-07-02",
          totalDays: 0.5,
          partialDayMode: "morning",
          status: "approved",
          paid: true,
        },
        {
          id: "l2",
          propertyId: "property-a",
          startDate: "2026-07-03",
          endDate: "2026-07-03",
          totalDays: 1,
          partialDayMode: "none",
          status: "cancelled",
          paid: false,
        },
      ],
    });
    expect(result.scheduledWorkingDays).toBe("1");
    expect(result.paidLeaveDays).toBe("0.5");
    expect(result.unpaidLeaveDays).toBe("0");
    expect(result.overtimeHours).toBe("1");
    expect(result.unpaidAbsenceDays).toBe("0");
  });

  it("warns on incomplete attendance without fabricating absence", () => {
    const result = preparePayrollInputs({
      propertyId: "property-a",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      attendance: [],
      leave: [],
    });
    expect(result.incompleteAttendance).toBe(true);
    expect(result.unpaidAbsenceDays).toBe("0");
    expect(result.warnings[0]).toMatch(/No authoritative/);
  });

  it("rejects cross-property input rows", () => {
    expect(() =>
      preparePayrollInputs({
        propertyId: "property-a",
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
        attendance: [],
        leave: [
          {
            id: "foreign",
            propertyId: "property-b",
            startDate: "2026-07-01",
            endDate: "2026-07-01",
            totalDays: 1,
            partialDayMode: "none",
            status: "approved",
            paid: false,
          },
        ],
      }),
    ).toThrow(/Cross-property/);
  });
});

describe("Phase 4B structured statutory evaluator", () => {
  const rule = (structure: StatutoryRule["structure"]): StatutoryRule => ({
    id: "rule-1",
    propertyId: "property-a",
    code: "RULE",
    name: "Configured rule",
    version: "v1",
    status: "verified",
    resultType: "tax",
    order: 1,
    structure,
  });
  const basis = {
    taxable: decimalUnits("1000"),
    gross: decimalUnits("1200"),
    base: decimalUnits("900"),
  };

  it("evaluates fixed and flat percentage rules", () => {
    expect(
      unitsToString(evaluateStatutoryRule(rule({ type: "fixed", amount: "25" }), basis).amount, 2),
    ).toBe("25.00");
    expect(
      unitsToString(
        evaluateStatutoryRule(
          rule({ type: "flat_percentage", percentage: "10", basis: "taxable" }),
          basis,
        ).amount,
        2,
      ),
    ).toBe("100.00");
  });

  it("evaluates progressive bands deterministically", () => {
    const progressive = rule({
      type: "progressive_bands",
      basis: "taxable",
      bands: [
        { from: "0", to: "500", percentage: "10" },
        { from: "500", percentage: "20" },
      ],
    });
    expect(unitsToString(evaluateStatutoryRule(progressive, basis).amount, 2)).toBe("150.00");
    expect(evaluateStatutoryRule(progressive, basis).trace).toEqual(
      evaluateStatutoryRule(progressive, basis).trace,
    );
  });

  it("applies thresholds, caps, and floors", () => {
    expect(
      unitsToString(
        evaluateStatutoryRule(
          rule({
            type: "threshold_percentage",
            threshold: "500",
            percentage: "10",
            basis: "taxable",
            applyTo: "excess",
          }),
          basis,
        ).amount,
        2,
      ),
    ).toBe("50.00");
    expect(
      unitsToString(
        evaluateStatutoryRule(
          rule({
            type: "capped_percentage",
            percentage: "20",
            basis: "taxable",
            cap: "120",
          }),
          basis,
        ).amount,
        2,
      ),
    ).toBe("120.00");
  });

  it("rejects overlapping statutory bands", () => {
    expect(() =>
      validateStatutoryRule(
        rule({
          type: "progressive_bands",
          basis: "taxable",
          bands: [
            { from: "0", to: "700", percentage: "10" },
            { from: "600", percentage: "20" },
          ],
        }),
      ),
    ).toThrow(/Overlapping/);
  });

  it("blocks unverified required rules without inventing an output", () => {
    const input = baseInput();
    input.statutoryRules = [{ ...rule({ type: "fixed", amount: "20" }), status: "draft" }];
    const result = calculatePayroll(input);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: "blocking", code: "UNVERIFIED_STATUTORY_RULE" }),
    );
    expect(result.lines.some((line) => line.code === "RULE")).toBe(false);
  });
});
