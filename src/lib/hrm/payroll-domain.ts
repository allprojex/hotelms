export type DateRange = { startDate: string; endDate?: string | null };

function isoDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Valid ISO date required");
  const date = new Date(`${value}T00:00:00Z`);
  if (date.toISOString().slice(0, 10) !== value) throw new Error("Valid ISO date required");
  return date;
}

export function rangesOverlap(left: DateRange, right: DateRange): boolean {
  const infinity = "9999-12-31";
  return (
    left.startDate <= (right.endDate ?? infinity) && right.startDate <= (left.endDate ?? infinity)
  );
}

export function validatePayrollSettings(input: {
  currency: string;
  propertyCurrency: string;
  timezone: string;
  monetaryPrecision: number;
  payrollEnabled: boolean;
  approvalRequired: boolean;
  finalizationRequiresApproval: boolean;
  payrollYearStartMonth: number;
}) {
  if (!/^[A-Z]{3}$/.test(input.currency) || input.currency !== input.propertyCurrency) {
    throw new Error("Payroll currency must match the property currency");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format();
  } catch {
    throw new Error("Invalid IANA timezone");
  }
  if (
    !Number.isInteger(input.monetaryPrecision) ||
    input.monetaryPrecision < 0 ||
    input.monetaryPrecision > 4
  )
    throw new Error("Invalid monetary precision");
  if (input.payrollEnabled && input.finalizationRequiresApproval && !input.approvalRequired)
    throw new Error("Finalization approval requires payroll approval");
  if (input.payrollYearStartMonth < 1 || input.payrollYearStartMonth > 12)
    throw new Error("Invalid payroll year start month");
}

function addDays(value: Date, days: number) {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function toIso(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function adjustPaymentDate(
  dateValue: string,
  weekendRule: "none" | "previous_working_day" | "next_working_day",
  holidayRule: "none" | "previous_working_day" | "next_working_day",
  holidays: readonly string[],
): string {
  let date = isoDate(dateValue);
  const holidaySet = new Set(holidays);
  for (let guard = 0; guard < 31; guard += 1) {
    const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
    const holiday = holidaySet.has(toIso(date));
    if (!weekend && !holiday) return toIso(date);
    const rule = weekend ? weekendRule : holidayRule;
    if (rule === "none") return toIso(date);
    date = addDays(date, rule === "previous_working_day" ? -1 : 1);
  }
  throw new Error("Unable to adjust payment date");
}

export function generatePayPeriods(input: {
  firstPeriodStart: string;
  payrollYear: number;
  periodsPerYear: number;
  intervalDays?: number;
  cutoffOffsetDays?: number;
  paymentOffsetDays?: number;
  weekendRule: "none" | "previous_working_day" | "next_working_day";
  holidayRule: "none" | "previous_working_day" | "next_working_day";
  holidays: readonly string[];
}) {
  if (
    !Number.isInteger(input.periodsPerYear) ||
    input.periodsPerYear < 1 ||
    input.periodsPerYear > 366
  )
    throw new Error("Invalid periods per year");
  const configuredFirst = isoDate(input.firstPeriodStart);
  const first = new Date(
    Date.UTC(input.payrollYear, configuredFirst.getUTCMonth(), configuredFirst.getUTCDate()),
  );
  const intervalDays = input.intervalDays ?? Math.floor(365 / input.periodsPerYear);
  if (intervalDays < 1 || intervalDays > 366) throw new Error("Invalid interval definition");
  return Array.from({ length: input.periodsPerYear }, (_, index) => {
    const start = addDays(first, index * intervalDays);
    const end = addDays(start, intervalDays - 1);
    const cutoff = addDays(end, input.cutoffOffsetDays ?? 0);
    const payment = addDays(end, input.paymentOffsetDays ?? 0);
    return {
      payrollYear: input.payrollYear,
      periodNumber: index + 1,
      periodLabel: `${input.payrollYear}-${String(index + 1).padStart(2, "0")}`,
      startDate: toIso(start),
      endDate: toIso(end),
      cutoffDate: toIso(cutoff),
      expectedPaymentDate: adjustPaymentDate(
        toIso(payment),
        input.weekendRule,
        input.holidayRule,
        input.holidays,
      ),
    };
  });
}

export function validateGradeBand(minimum: number, midpoint: number | null, maximum: number) {
  if (
    minimum < 0 ||
    maximum < minimum ||
    (midpoint != null && (midpoint < minimum || midpoint > maximum))
  )
    throw new Error("Salary grade minimum, midpoint, and maximum are inconsistent");
}

export function validateBaseSalary(
  baseSalary: number,
  band: { minimum: number; maximum: number } | null,
  override: boolean,
  overrideReason?: string,
) {
  if (baseSalary < 0) throw new Error("Base salary cannot be negative");
  if (band && (baseSalary < band.minimum || baseSalary > band.maximum)) {
    if (!override || (overrideReason?.trim().length ?? 0) < 5)
      throw new Error("Grade-band override requires an authorized reason");
  }
}

export function validatePayComponent(input: {
  calculationMethod: string;
  defaultAmount?: number | null;
  defaultPercentage?: number | null;
  percentageBasisCode?: string | null;
}) {
  if (input.calculationMethod === "fixed_amount" && input.defaultPercentage != null)
    throw new Error("Fixed components cannot define a percentage");
  if (
    input.calculationMethod === "percentage" &&
    (input.defaultAmount != null || !input.percentageBasisCode?.trim())
  )
    throw new Error("Percentage components require a basis and no fixed amount");
  if (
    input.defaultPercentage != null &&
    (input.defaultPercentage < 0 || input.defaultPercentage > 100)
  )
    throw new Error("Percentage must be between zero and one hundred");
}

export function validateStructuredRuleParameters(value: unknown): void {
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error("Rule parameters must be an object");
  const forbidden = /(script|executable|javascript|eval|function|formula)/i;
  const visit = (current: unknown, key = ""): void => {
    if (forbidden.test(key)) throw new Error("Executable statutory rules are forbidden");
    if (Array.isArray(current)) current.forEach((item) => visit(item));
    else if (current && typeof current === "object")
      Object.entries(current).forEach(([childKey, child]) => visit(child, childKey));
    else if (!["string", "number", "boolean"].includes(typeof current) && current !== null)
      throw new Error("Unsupported statutory parameter");
  };
  visit(value);
}

export function maskPaymentValue(value?: string | null): string {
  const clean = value?.replace(/\s+/g, "") ?? "";
  if (!clean) return "Not provided";
  return `•••• ${clean.slice(-4)}`;
}

export function validateOpeningBalance(input: {
  amount: number;
  currency: string;
  propertyCurrency: string;
  asOfDate: string;
  sourceSystem: string;
}) {
  if (!Number.isFinite(input.amount)) throw new Error("Opening balance amount is invalid");
  if (input.currency !== input.propertyCurrency)
    throw new Error("Opening balance currency mismatch");
  isoDate(input.asOfDate);
  if (input.sourceSystem.trim().length < 2) throw new Error("Source-system evidence is required");
}
