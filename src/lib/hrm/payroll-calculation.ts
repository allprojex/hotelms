export type DecimalInput = string | number | bigint;
export type RoundingMethod = "half_up" | "half_even" | "down" | "up";

const INTERNAL_SCALE = 8;
const INTERNAL_FACTOR = 10n ** BigInt(INTERNAL_SCALE);

function decimalText(value: DecimalInput): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Finite decimal value required");
    return value.toLocaleString("en-US", {
      useGrouping: false,
      maximumFractionDigits: INTERNAL_SCALE,
    });
  }
  return value.trim();
}

export function decimalUnits(value: DecimalInput): bigint {
  const text = decimalText(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`Invalid decimal value: ${text}`);
  const fraction = (match[3] ?? "").padEnd(INTERNAL_SCALE, "0").slice(0, INTERNAL_SCALE);
  const units = BigInt(match[2]) * INTERNAL_FACTOR + BigInt(fraction || "0");
  return match[1] ? -units : units;
}

function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("Division by zero");
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const rounded = quotient + ((n % d) * 2n >= d ? 1n : 0n);
  return negative ? -rounded : rounded;
}

export function multiplyUnits(left: bigint, right: bigint): bigint {
  return divideRounded(left * right, INTERNAL_FACTOR);
}

export function divideUnits(left: bigint, right: bigint): bigint {
  return divideRounded(left * INTERNAL_FACTOR, right);
}

export function roundUnits(units: bigint, precision: number, method: RoundingMethod): bigint {
  if (!Number.isInteger(precision) || precision < 0 || precision > INTERNAL_SCALE)
    throw new Error("Decimal precision is outside the supported range");
  const divisor = 10n ** BigInt(INTERNAL_SCALE - precision);
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  let quotient = absolute / divisor;
  const remainder = absolute % divisor;
  if (remainder > 0n) {
    if (method === "up") quotient += 1n;
    if (method === "half_up" && remainder * 2n >= divisor) quotient += 1n;
    if (
      method === "half_even" &&
      (remainder * 2n > divisor || (remainder * 2n === divisor && quotient % 2n === 1n))
    )
      quotient += 1n;
  }
  return (negative ? -quotient : quotient) * divisor;
}

export function unitsToString(units: bigint, precision = 2): string {
  const rounded = roundUnits(units, precision, "down");
  const negative = rounded < 0n;
  const absolute = negative ? -rounded : rounded;
  const whole = absolute / INTERNAL_FACTOR;
  const fraction = (absolute % INTERNAL_FACTOR)
    .toString()
    .padStart(INTERNAL_SCALE, "0")
    .slice(0, precision);
  return `${negative ? "-" : ""}${whole}${precision ? `.${fraction}` : ""}`;
}

export type PayrollCalculationMethod =
  | "fixed_amount"
  | "percentage_base"
  | "percentage_gross"
  | "percentage_component"
  | "attendance_day"
  | "worked_hour"
  | "unpaid_day_deduction"
  | "fixed_one_time"
  | "manual_amount"
  | "statutory_rule"
  | "informational_overtime";

export type PayrollLineType =
  | "base_earning"
  | "earning"
  | "reimbursement"
  | "pre_tax_deduction"
  | "employee_statutory"
  | "employer_statutory"
  | "tax"
  | "post_tax_deduction"
  | "informational";

export type CalculationComponent = {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  method: PayrollCalculationMethod;
  lineType: PayrollLineType;
  amount?: DecimalInput | null;
  manualQuantity?: DecimalInput | null;
  percentage?: DecimalInput | null;
  basisComponentCode?: string | null;
  minimum?: DecimalInput | null;
  maximum?: DecimalInput | null;
  displayOrder: number;
  taxable?: boolean;
  pensionable?: boolean;
  prorate?: boolean;
  sourceType: "structure" | "employee" | "manual" | "statutory";
  sourceId: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
};

export type NormalizedPayrollInputs = {
  scheduledWorkingDays: DecimalInput;
  attendedDays: DecimalInput;
  paidAttendanceDays: DecimalInput;
  unpaidAbsenceDays: DecimalInput;
  workedHours: DecimalInput;
  lateHours?: DecimalInput;
  earlyDepartureHours?: DecimalInput;
  paidLeaveDays: DecimalInput;
  unpaidLeaveDays: DecimalInput;
  overtimeHours: DecimalInput;
  incompleteAttendance: boolean;
  sourceReferences: Array<{ type: string; id: string }>;
  warnings: string[];
};

export type StatutoryRule = {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  version: string;
  status: "draft" | "unverified" | "verified" | "rejected";
  resultType: "employee_statutory" | "employer_statutory" | "tax" | "earning";
  order: number;
  structure:
    | { type: "fixed"; amount: DecimalInput }
    | { type: "flat_percentage"; percentage: DecimalInput; basis: "taxable" | "gross" | "base" }
    | {
        type: "progressive_bands";
        basis: "taxable" | "gross" | "base";
        bands: Array<{ from: DecimalInput; to?: DecimalInput | null; percentage: DecimalInput }>;
      }
    | {
        type: "threshold_percentage";
        threshold: DecimalInput;
        percentage: DecimalInput;
        basis: "taxable" | "gross" | "base";
        applyTo: "full_basis" | "excess";
      }
    | {
        type: "capped_percentage";
        percentage: DecimalInput;
        basis: "taxable" | "gross" | "base";
        floor?: DecimalInput | null;
        cap?: DecimalInput | null;
      };
};

export type PayrollLine = {
  componentId?: string | null;
  statutoryRuleId?: string | null;
  statutoryRuleVersion?: string | null;
  lineType: PayrollLineType;
  code: string;
  name: string;
  quantity: string;
  rate: string;
  unroundedAmount: string;
  roundedAmount: string;
  taxableAmount: string;
  contributionBasis: string;
  displayOrder: number;
  sourceType: string;
  sourceId: string;
  explanation: Record<string, unknown>;
};

export type PayrollFinding = {
  severity: "informational" | "warning" | "blocking";
  code: string;
  message: string;
  sourceType?: string;
  sourceId?: string;
};

export function orderCalculationComponents(
  components: readonly CalculationComponent[],
): CalculationComponent[] {
  const byCode = new Map(components.map((component) => [component.code, component]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: CalculationComponent[] = [];
  const visit = (component: CalculationComponent) => {
    if (visited.has(component.code)) return;
    if (visiting.has(component.code))
      throw new Error(`Cyclic payroll component dependency at ${component.code}`);
    visiting.add(component.code);
    if (component.method === "percentage_component") {
      const dependency = byCode.get(component.basisComponentCode ?? "");
      if (!dependency) throw new Error(`Missing component dependency for ${component.code}`);
      if (dependency.lineType === "informational")
        throw new Error(`Component ${component.code} cannot depend on informational output`);
      visit(dependency);
    }
    visiting.delete(component.code);
    visited.add(component.code);
    ordered.push(component);
  };
  [...components]
    .sort((a, b) => a.displayOrder - b.displayOrder || a.code.localeCompare(b.code))
    .forEach(visit);
  return ordered;
}

function clamp(
  units: bigint,
  minimum?: DecimalInput | null,
  maximum?: DecimalInput | null,
): bigint {
  if (minimum != null && units < decimalUnits(minimum)) units = decimalUnits(minimum);
  if (maximum != null && units > decimalUnits(maximum)) units = decimalUnits(maximum);
  return units;
}

function percentageOf(basis: bigint, percentage: DecimalInput): bigint {
  return divideRounded(basis * decimalUnits(percentage), 100n * INTERNAL_FACTOR);
}

function ruleBasis(
  basis: "taxable" | "gross" | "base",
  values: { taxable: bigint; gross: bigint; base: bigint },
): bigint {
  return basis === "taxable" ? values.taxable : basis === "gross" ? values.gross : values.base;
}

export function validateStatutoryRule(rule: StatutoryRule): void {
  const structure = rule.structure as StatutoryRule["structure"] | undefined;
  if (
    !structure ||
    ![
      "fixed",
      "flat_percentage",
      "progressive_bands",
      "threshold_percentage",
      "capped_percentage",
    ].includes(structure.type)
  )
    throw new Error(`Unsupported statutory rule structure in ${rule.code}`);
  if (structure.type === "fixed") {
    decimalUnits(structure.amount);
    return;
  }
  if (!["taxable", "gross", "base"].includes(structure.basis))
    throw new Error(`Invalid statutory basis in ${rule.code}`);
  if (structure.type === "flat_percentage") {
    decimalUnits(structure.percentage);
    return;
  }
  if (structure.type === "threshold_percentage") {
    decimalUnits(structure.threshold);
    decimalUnits(structure.percentage);
    if (!["full_basis", "excess"].includes(structure.applyTo))
      throw new Error(`Invalid threshold application in ${rule.code}`);
    return;
  }
  if (structure.type === "capped_percentage") {
    decimalUnits(structure.percentage);
    if (structure.floor != null) decimalUnits(structure.floor);
    if (structure.cap != null) decimalUnits(structure.cap);
    return;
  }
  if (!Array.isArray(structure.bands) || structure.bands.length === 0)
    throw new Error(`Progressive statutory bands are required in ${rule.code}`);
  if (structure.type !== "progressive_bands")
    throw new Error(`Unsupported statutory rule structure in ${rule.code}`);
  const ordered = [...structure.bands].sort((a, b) =>
    decimalUnits(a.from) < decimalUnits(b.from) ? -1 : 1,
  );
  ordered.forEach((band, index) => {
    const from = decimalUnits(band.from);
    const to = band.to == null ? null : decimalUnits(band.to);
    if (to != null && to <= from) throw new Error(`Invalid statutory band in ${rule.code}`);
    if (index > 0) {
      const previous = ordered[index - 1];
      if (previous.to == null || decimalUnits(previous.to) > from)
        throw new Error(`Overlapping or ambiguous statutory bands in ${rule.code}`);
    }
  });
}

export function evaluateStatutoryRule(
  rule: StatutoryRule,
  basisValues: { taxable: bigint; gross: bigint; base: bigint },
): { amount: bigint; trace: Record<string, unknown> } {
  validateStatutoryRule(rule);
  const structure = rule.structure;
  if (structure.type === "fixed")
    return { amount: decimalUnits(structure.amount), trace: { method: "fixed" } };
  const basis = ruleBasis(structure.basis, basisValues);
  if (structure.type === "flat_percentage")
    return {
      amount: percentageOf(basis, structure.percentage),
      trace: { method: structure.type, basis: unitsToString(basis, 8) },
    };
  if (structure.type === "threshold_percentage") {
    const threshold = decimalUnits(structure.threshold);
    const appliedBasis =
      basis <= threshold ? 0n : structure.applyTo === "full_basis" ? basis : basis - threshold;
    return {
      amount: percentageOf(appliedBasis, structure.percentage),
      trace: {
        method: structure.type,
        basis: unitsToString(basis, 8),
        appliedBasis: unitsToString(appliedBasis, 8),
      },
    };
  }
  if (structure.type === "capped_percentage") {
    let amount = percentageOf(basis, structure.percentage);
    amount = clamp(amount, structure.floor, structure.cap);
    return {
      amount,
      trace: { method: structure.type, basis: unitsToString(basis, 8) },
    };
  }
  let amount = 0n;
  const bandTrace: Array<Record<string, string>> = [];
  for (const band of structure.bands) {
    const from = decimalUnits(band.from);
    const to = band.to == null ? basis : decimalUnits(band.to);
    const bandBasis = basis > from ? (basis < to ? basis : to) - from : 0n;
    if (bandBasis > 0n) amount += percentageOf(bandBasis, band.percentage);
    bandTrace.push({
      from: unitsToString(from, 8),
      to: band.to == null ? "open" : unitsToString(to, 8),
      applied: unitsToString(bandBasis, 8),
    });
  }
  return { amount, trace: { method: structure.type, bands: bandTrace } };
}

export type CalculatePayrollInput = {
  propertyId: string;
  currency: string;
  precision: number;
  roundingMethod: RoundingMethod;
  allowNegativeNetPay: boolean;
  blockUnverifiedStatutoryRules: boolean;
  period: { startDate: string; endDate: string; totalDays: number };
  compensation: {
    id: string;
    propertyId: string;
    baseSalary: DecimalInput;
    employmentPercentage: DecimalInput;
    effectiveFrom: string;
    effectiveTo?: string | null;
  };
  components: CalculationComponent[];
  statutoryRules: StatutoryRule[];
  inputs: NormalizedPayrollInputs;
};

export function calculatePayroll(input: CalculatePayrollInput) {
  if (input.compensation.propertyId !== input.propertyId)
    throw new Error("Cross-property compensation is forbidden");
  for (const component of input.components)
    if (component.propertyId !== input.propertyId)
      throw new Error(`Cross-property component ${component.code} is forbidden`);
  for (const rule of input.statutoryRules)
    if (rule.propertyId !== input.propertyId)
      throw new Error(`Cross-property statutory rule ${rule.code} is forbidden`);

  const findings: PayrollFinding[] = input.inputs.warnings.map((message) => ({
    severity: "warning",
    code: "INPUT_WARNING",
    message,
  }));
  if (input.inputs.incompleteAttendance)
    findings.push({
      severity: "warning",
      code: "INCOMPLETE_ATTENDANCE",
      message: "Attendance inputs are incomplete; no absence was fabricated.",
    });

  const periodStart = input.period.startDate;
  const periodEnd = input.period.endDate;
  const activeStart =
    input.compensation.effectiveFrom > periodStart ? input.compensation.effectiveFrom : periodStart;
  const activeEnd =
    input.compensation.effectiveTo && input.compensation.effectiveTo < periodEnd
      ? input.compensation.effectiveTo
      : periodEnd;
  const activeDays =
    activeEnd < activeStart
      ? 0
      : Math.floor(
          (Date.parse(`${activeEnd}T00:00:00Z`) - Date.parse(`${activeStart}T00:00:00Z`)) /
            86_400_000,
        ) + 1;
  const periodRatio = divideUnits(decimalUnits(activeDays), decimalUnits(input.period.totalDays));
  const employmentRatio = divideUnits(
    decimalUnits(input.compensation.employmentPercentage),
    decimalUnits(100),
  );
  const baseUnrounded = multiplyUnits(
    multiplyUnits(decimalUnits(input.compensation.baseSalary), periodRatio),
    employmentRatio,
  );
  const lines: PayrollLine[] = [];
  const lineAmounts = new Map<string, bigint>();
  const addLine = (
    source: CalculationComponent | StatutoryRule,
    lineType: PayrollLineType,
    amount: bigint,
    quantity: bigint,
    rate: bigint,
    explanation: Record<string, unknown>,
  ) => {
    const rounded = roundUnits(amount, input.precision, input.roundingMethod);
    const component = "method" in source ? source : null;
    const rule = "structure" in source ? source : null;
    lines.push({
      componentId: lineType === "base_earning" ? null : (component?.id ?? null),
      statutoryRuleId: rule?.id ?? null,
      statutoryRuleVersion: rule?.version ?? null,
      lineType,
      code: source.code,
      name: source.name,
      quantity: unitsToString(quantity, 8),
      rate: unitsToString(rate, 8),
      unroundedAmount: unitsToString(amount, 8),
      roundedAmount: unitsToString(rounded, input.precision),
      taxableAmount:
        component?.taxable || lineType === "base_earning"
          ? unitsToString(rounded, input.precision)
          : unitsToString(0n, input.precision),
      contributionBasis: component?.pensionable
        ? unitsToString(rounded, input.precision)
        : unitsToString(0n, input.precision),
      displayOrder: component?.displayOrder ?? rule?.order ?? 0,
      sourceType: component?.sourceType ?? "statutory",
      sourceId: component?.sourceId ?? rule!.id,
      explanation,
    });
    lineAmounts.set(source.code, rounded);
  };

  const baseSource: CalculationComponent = {
    id: input.compensation.id,
    propertyId: input.propertyId,
    code: "BASE",
    name: "Prorated base earnings",
    method: "fixed_amount",
    lineType: "base_earning",
    displayOrder: -1,
    taxable: true,
    pensionable: true,
    sourceType: "employee",
    sourceId: input.compensation.id,
    effectiveFrom: input.compensation.effectiveFrom,
  };
  addLine(
    baseSource,
    "base_earning",
    baseUnrounded,
    periodRatio,
    decimalUnits(input.compensation.baseSalary),
    {
      activeDays,
      periodDays: input.period.totalDays,
      employmentPercentage: decimalText(input.compensation.employmentPercentage),
    },
  );

  const inputUnits = {
    attendanceDays: decimalUnits(input.inputs.paidAttendanceDays),
    workedHours: decimalUnits(input.inputs.workedHours),
    unpaidDays:
      decimalUnits(input.inputs.unpaidLeaveDays) + decimalUnits(input.inputs.unpaidAbsenceDays),
    overtimeHours: decimalUnits(input.inputs.overtimeHours),
  };
  for (const component of orderCalculationComponents(input.components)) {
    if (
      component.effectiveFrom > periodEnd ||
      (component.effectiveTo && component.effectiveTo < periodStart)
    )
      continue;
    const rate =
      component.amount != null
        ? decimalUnits(component.amount)
        : component.percentage != null
          ? decimalUnits(component.percentage)
          : 0n;
    const grossSoFar = lines
      .filter((line) => line.lineType === "base_earning" || line.lineType === "earning")
      .reduce((sum, line) => sum + decimalUnits(line.roundedAmount), 0n);
    let amount = 0n;
    let quantity = decimalUnits(1);
    if (component.method === "fixed_amount" || component.method === "fixed_one_time") amount = rate;
    else if (component.method === "percentage_base")
      amount = percentageOf(baseUnrounded, component.percentage ?? 0);
    else if (component.method === "percentage_gross")
      amount = percentageOf(grossSoFar, component.percentage ?? 0);
    else if (component.method === "percentage_component") {
      const basis = lineAmounts.get(component.basisComponentCode ?? "");
      if (basis == null) throw new Error(`Component basis unavailable for ${component.code}`);
      amount = percentageOf(basis, component.percentage ?? 0);
    } else if (component.method === "attendance_day") {
      quantity = inputUnits.attendanceDays;
      amount = multiplyUnits(quantity, rate);
    } else if (component.method === "worked_hour") {
      quantity = inputUnits.workedHours;
      amount = multiplyUnits(quantity, rate);
    } else if (component.method === "unpaid_day_deduction") {
      quantity = inputUnits.unpaidDays;
      amount = multiplyUnits(quantity, rate);
    } else if (component.method === "manual_amount") {
      quantity = decimalUnits(component.manualQuantity ?? 1);
      amount = multiplyUnits(quantity, rate);
    } else if (component.method === "informational_overtime") {
      quantity = inputUnits.overtimeHours;
      amount = 0n;
    }
    if (component.prorate && ["fixed_amount", "fixed_one_time"].includes(component.method))
      amount = multiplyUnits(amount, periodRatio);
    amount = clamp(amount, component.minimum, component.maximum);
    addLine(component, component.lineType, amount, quantity, rate, { method: component.method });
  }

  const basisValues = {
    base: roundUnits(baseUnrounded, input.precision, input.roundingMethod),
    gross: lines
      .filter((line) => line.lineType === "base_earning" || line.lineType === "earning")
      .reduce((sum, line) => sum + decimalUnits(line.roundedAmount), 0n),
    taxable: lines.reduce((sum, line) => sum + decimalUnits(line.taxableAmount), 0n),
  };
  for (const rule of [...input.statutoryRules].sort((a, b) => a.order - b.order)) {
    if (rule.status !== "verified") {
      findings.push({
        severity: input.blockUnverifiedStatutoryRules ? "blocking" : "warning",
        code: "UNVERIFIED_STATUTORY_RULE",
        message: `${rule.code} is ${rule.status}`,
        sourceType: "statutory_rule",
        sourceId: rule.id,
      });
      if (input.blockUnverifiedStatutoryRules) continue;
    }
    const evaluated = evaluateStatutoryRule(rule, basisValues);
    addLine(
      rule,
      rule.resultType,
      evaluated.amount,
      decimalUnits(1),
      evaluated.amount,
      evaluated.trace,
    );
  }

  const gross = basisValues.gross;
  const reimbursements = lines
    .filter((line) => line.lineType === "reimbursement")
    .reduce((sum, line) => sum + decimalUnits(line.roundedAmount), 0n);
  const deductions = lines
    .filter((line) =>
      ["pre_tax_deduction", "employee_statutory", "tax", "post_tax_deduction"].includes(
        line.lineType,
      ),
    )
    .reduce((sum, line) => sum + decimalUnits(line.roundedAmount), 0n);
  const employerContributions = lines
    .filter((line) => line.lineType === "employer_statutory")
    .reduce((sum, line) => sum + decimalUnits(line.roundedAmount), 0n);
  const net = gross + reimbursements - deductions;
  const employerCost = gross + reimbursements + employerContributions;
  if (gross < 0n)
    findings.push({
      severity: "blocking",
      code: "NEGATIVE_GROSS",
      message: "Gross pay is negative",
    });
  if (net < 0n && !input.allowNegativeNetPay)
    findings.push({
      severity: "blocking",
      code: "NEGATIVE_NET",
      message: "Net pay is negative and the property policy forbids it",
    });
  if (net > gross + reimbursements)
    findings.push({
      severity: "warning",
      code: "NET_EXCEEDS_GROSS",
      message: "Net pay exceeds gross plus reimbursements",
    });

  return {
    currency: input.currency,
    lines,
    findings,
    totals: {
      base: unitsToString(basisValues.base, input.precision),
      gross: unitsToString(gross, input.precision),
      deductions: unitsToString(deductions, input.precision),
      employerContributions: unitsToString(employerContributions, input.precision),
      net: unitsToString(net, input.precision),
      employerCost: unitsToString(employerCost, input.precision),
    },
    trace: {
      calculationVersion: "phase-4b-v1",
      activeDays,
      periodDays: input.period.totalDays,
      componentOrder: lines.map((line) => line.code),
      sourceReferences: input.inputs.sourceReferences,
    },
  };
}
