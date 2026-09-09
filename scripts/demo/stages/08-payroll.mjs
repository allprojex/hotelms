// Stage 8 — payroll configuration and the draft runs.
//
// Scope note, deliberately drawn here: this stage configures payroll and opens
// the runs, but it does NOT calculate them. The payroll engine lives in the
// application (src/lib/hrm/payroll-calculation.ts, driven by the
// calculateDraftPayrollRun server function): the database only stores what the
// application computes, through payroll_store_calculation_results(). Writing
// results any other way would produce payslips that change the moment anyone
// pressed Recalculate — the D1 audit's finding, and the reason this seeder
// stops at the draft run.
//
// The calculation, review, approval, finalisation and payslip publication are
// performed by driving the running application (see scripts/demo/README.md).
// Everything this stage writes is configuration, which is what the payroll
// setup screens write too.

import { randomUUID } from "node:crypto";
import { makeRandom, day, monthStart, monthEnd } from "../lib/random.mjs";
import { ensureByKey } from "../lib/env.mjs";
import { loadStaffClients } from "./04-operations.mjs";
import { DESIGNATIONS } from "./07-hrm.mjs";

const YEAR = 2026;

// The employee base salary is emitted by the calculation engine itself, from
// payroll_employee_compensations.base_salary, as a base_earning line. A
// "Basic Salary" component on top of it would add — and tax — the same money a
// second time, so the components below are only what sits ON TOP of base pay.
export const PAY_COMPONENTS = [
  { code: "HOUSE", name: "Housing Allowance", component_type: "earning", value_type: "fixed", calculation_method: "none",
    taxable_classification: "taxable", statutory_classification: "contributory", pensionable_classification: "pensionable",
    recurrence: "recurring", display_order: 20, payslip_visible: true, proration_enabled: true, attendance_sensitive: false },
  { code: "TRANS", name: "Transport Allowance", component_type: "earning", value_type: "fixed", calculation_method: "none",
    taxable_classification: "taxable", statutory_classification: "non_contributory", pensionable_classification: "non_pensionable",
    recurrence: "recurring", display_order: 30, payslip_visible: true, proration_enabled: true, attendance_sensitive: false },
  { code: "MEAL", name: "Meal Allowance", component_type: "earning", value_type: "fixed", calculation_method: "none",
    taxable_classification: "non_taxable", statutory_classification: "non_contributory", pensionable_classification: "non_pensionable",
    recurrence: "recurring", display_order: 40, payslip_visible: true, proration_enabled: true, attendance_sensitive: false },
  { code: "LOAN", name: "Staff Loan Repayment", component_type: "deduction", value_type: "fixed", calculation_method: "none",
    taxable_classification: "non_taxable", statutory_classification: "non_contributory", pensionable_classification: "non_pensionable",
    recurrence: "recurring", display_order: 90, payslip_visible: true, proration_enabled: false, attendance_sensitive: false },
];

// Percentages follow Ghana's published SSNIT split and PAYE bands; they are
// demonstration values maintained here, not tax advice, and the rule sets are
// marked unverified so the application shows them as needing review.
export const STATUTORY_RULES = [
  {
    name: "SSNIT Tier 1 & 2 — employee 5.5%",
    rule_category: "social_security_employee",
    version: "2026.1",
    calculation_order: 10,
    parameters: {
      resultType: "employee_statutory",
      structure: { type: "flat_percentage", percentage: "5.5", basis: "gross" },
    },
  },
  {
    name: "SSNIT Tier 1 & 2 — employer 13%",
    rule_category: "social_security_employer",
    version: "2026.1",
    calculation_order: 20,
    parameters: {
      resultType: "employer_statutory",
      structure: { type: "flat_percentage", percentage: "13", basis: "gross" },
    },
  },
  {
    name: "PAYE — monthly graduated scale",
    rule_category: "income_tax",
    version: "2026.1",
    calculation_order: 30,
    parameters: {
      resultType: "tax",
      structure: {
        type: "progressive_bands",
        basis: "taxable",
        bands: [
          { from: "0", to: "490", percentage: "0" },
          { from: "490", to: "600", percentage: "5" },
          { from: "600", to: "730", percentage: "10" },
          { from: "730", to: "3730", percentage: "17.5" },
          { from: "3730", to: "20125", percentage: "25" },
          { from: "20125", to: "50000", percentage: "30" },
          { from: "50000", to: null, percentage: "35" },
        ],
      },
    },
  },
];

const GRADES = [
  { code: "G1", name: "Grade 1 — Executive", rank_order: 1, minimum_base_salary: 8000, midpoint_salary: 11000, maximum_base_salary: 16000 },
  { code: "G2", name: "Grade 2 — Head of Department", rank_order: 2, minimum_base_salary: 5000, midpoint_salary: 6500, maximum_base_salary: 8500 },
  { code: "G3", name: "Grade 3 — Supervisor", rank_order: 3, minimum_base_salary: 3400, midpoint_salary: 4200, maximum_base_salary: 5200 },
  { code: "G4", name: "Grade 4 — Officer", rank_order: 4, minimum_base_salary: 2300, midpoint_salary: 2900, maximum_base_salary: 3800 },
  { code: "G5", name: "Grade 5 — Associate", rank_order: 5, minimum_base_salary: 1600, midpoint_salary: 2000, maximum_base_salary: 2700 },
];

export async function run({ ctx, admin, signIn, log }) {
  const pid = ctx.propertyId;
  const rand = makeRandom(20260912);
  const { hr, gm } = await loadStaffClients({ ctx, admin, signIn });
  // Payroll configuration is super-admin/HR territory; the admin client is used
  // where a payroll permission is not granted to the HR role.
  const write = admin;

  if (ctx.dryRun) {
    log(`  · would configure ${PAY_COMPONENTS.length} pay components, ${STATUTORY_RULES.length} statutory rules, ${GRADES.length} grades and open draft runs`);
    return {};
  }

  const [settings] = await write.select("payroll_settings", `select=*&property_id=eq.${pid}&order=effective_from.desc&limit=1`);
  if (!settings) throw new Error("STOP: payroll_settings row is missing for this property");

  // ── pay frequency ─────────────────────────────────────────────────────────
  const frequencies = await ensureByKey(write, "payroll_pay_frequencies", `select=*&property_id=eq.${pid}`, [{
    property_id: pid,
    name: "Monthly",
    code: "MONTHLY",
    frequency_type: "monthly",
    periods_per_year: 12,
    interval_definition: { unit: "month", every: 1 },
    first_period_start: `${YEAR}-01-01`,
    cutoff_rule: { type: "day_of_month", day: 25 },
    payment_day_rule: { type: "last_working_day" },
    weekend_adjustment: "previous_working_day",
    holiday_adjustment: "previous_working_day",
    continuous_periods: true,
    active: true,
    created_by: write.userId,
    updated_by: write.userId,
  }], (r) => r.code);
  const monthly = frequencies.rows.find((f) => f.code === "MONTHLY");
  log(`  · pay frequency: ${frequencies.created} created, ${frequencies.existing} already present`);

  // The settings row is created by a trigger when the property is created, so
  // it is effective from the property's creation date and covers no earlier
  // period — payroll_create_draft_run() then refuses every historical month
  // with "Effective payroll settings are unavailable or disabled". Moving
  // effective_from back to the start of the payroll year is only possible on
  // the day the row was created (payroll_protect_effective_history blocks it
  // once effective_from is in the past), so a demo rebuilt later needs a
  // superseding settings row instead.
  const settingsPatch = {
    payroll_enabled: true,
    jurisdiction_code: "GH",
    default_pay_frequency_id: monthly.id,
    display_name: "Infinity Grand Hotel payroll",
    default_payment_method: "bank_transfer",
    updated_by: write.userId,
  };
  if (settings.effective_from > `${YEAR}-01-01`) settingsPatch.effective_from = `${YEAR}-01-01`;
  const settingsUpdate = await write.raw(`/rest/v1/payroll_settings?id=eq.${settings.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(settingsPatch),
  });
  if (!settingsUpdate.ok) {
    log(`  ! payroll settings update: ${JSON.stringify(settingsUpdate.body).slice(0, 220)}`);
    await write.update("payroll_settings", `id=eq.${settings.id}`, {
      payroll_enabled: true,
      jurisdiction_code: "GH",
      default_pay_frequency_id: monthly.id,
      updated_by: write.userId,
    });
  }
  log("  · payroll enabled for the property (jurisdiction GH, monthly frequency)");

  // ── calendar periods: the whole year, continuous ──────────────────────────
  const periodRows = [];
  for (let month = 1; month <= 12; month++) {
    const anchor = `${YEAR}-${String(month).padStart(2, "0")}-15`;
    const start = monthStart(anchor);
    const end = monthEnd(anchor);
    periodRows.push({
      property_id: pid,
      pay_frequency_id: monthly.id,
      payroll_year: YEAR,
      period_number: month,
      period_label: new Date(`${start}T00:00:00Z`).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
      start_date: start,
      end_date: end,
      cutoff_date: day(end, -5),
      expected_payment_date: end,
      status: end < ctx.asOf ? "open" : "planned",
      created_by: write.userId,
    });
  }
  const periods = await ensureByKey(write, "payroll_calendar_periods", `select=*&property_id=eq.${pid}`, periodRows, (r) => `${r.payroll_year}-${r.period_number}`);
  log(`  · calendar periods: ${periods.created} created, ${periods.existing} already present`);

  // ── pay components and their calculation rules ────────────────────────────
  const components = await ensureByKey(write, "payroll_pay_components", `select=*&property_id=eq.${pid}`,
    PAY_COMPONENTS.map((c) => ({
      ...c, property_id: pid, currency: "GHS", effective_from: `${YEAR}-01-01`, active: true,
      created_by: write.userId, updated_by: write.userId,
    })), (r) => r.code);
  const componentByCode = new Map(components.rows.map((c) => [c.code, c]));
  log(`  · pay components: ${components.created} created, ${components.existing} already present`);

  const ruleSpecs = [
    // Housing is fifteen per cent of the employee base salary.
    { code: "HOUSE", calculation_method: "percentage_base", percentage: 15 },
    { code: "TRANS", calculation_method: "fixed_amount", amount: 350 },
    { code: "MEAL", calculation_method: "fixed_amount", amount: 220 },
    { code: "LOAN", calculation_method: "manual_amount" },
  ];
  const existingRules = await write.select("payroll_component_calculation_rules", `select=id,pay_component_id&property_id=eq.${pid}`);
  const haveRule = new Set(existingRules.map((r) => r.pay_component_id));
  const ruleRows = ruleSpecs
    .filter((spec) => !haveRule.has(componentByCode.get(spec.code).id))
    .map((spec) => ({
      property_id: pid,
      pay_component_id: componentByCode.get(spec.code).id,
      calculation_method: spec.calculation_method,
      amount: spec.amount ?? null,
      percentage: spec.percentage ?? null,
      basis_component_id: spec.basis_component_id ?? null,
      parameters: {},
      effective_from: `${YEAR}-01-01`,
      active: true,
      created_by: write.userId,
      updated_by: write.userId,
    }));
  if (ruleRows.length) await write.insert("payroll_component_calculation_rules", ruleRows);
  log(`  · calculation rules: ${ruleRows.length} created, ${existingRules.length} already present`);

  // ── statutory rules ───────────────────────────────────────────────────────
  // payroll_prepare_effective_supersession() — one trigger function shared by
  // eight payroll tables — reaches the branch
  //   ELSIF TG_TABLE_NAME='payroll_payment_details' AND NEW.is_primary
  // for this table too, and PL/pgSQL evaluates that whole condition as a single
  // SQL expression, so NEW.is_primary is resolved against a row that has no
  // such column: every insert into payroll_statutory_rule_sets fails with
  // 42703 "record new has no field is_primary". SSNIT and PAYE therefore cannot
  // be configured on this schema at all. Reported with a focused fix; the
  // seeder records the attempt and carries on rather than aborting.
  const existingStatutory = await write.select(
    "payroll_statutory_rule_sets",
    `select=id,rule_category&property_id=eq.${pid}`,
  );
  const haveStatutory = new Set(existingStatutory.map((r) => r.rule_category));
  let statutoryCreated = 0;
  let statutoryError = null;
  for (const rule of STATUTORY_RULES) {
    if (haveStatutory.has(rule.rule_category)) continue;
    const r = await write.raw("/rest/v1/payroll_statutory_rule_sets", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([{
        property_id: pid,
        jurisdiction_code: "GH",
        name: rule.name,
        rule_category: rule.rule_category,
        version: rule.version,
        effective_from: `${YEAR}-01-01`,
        parameters: rule.parameters,
        calculation_order: rule.calculation_order,
        verification_status: "unverified",
        source_reference: { note: "Demonstration values maintained in scripts/demo" },
        active: true,
        created_by: write.userId,
        updated_by: write.userId,
      }]),
    });
    if (r.ok) statutoryCreated++;
    else if (!statutoryError) statutoryError = JSON.stringify(r.body).slice(0, 200);
  }
  log(`  · statutory rule sets: ${statutoryCreated} created, ${existingStatutory.length} already present`);
  if (statutoryError) log(`  ! payroll_statutory_rule_sets insert is failing: ${statutoryError}`);

  // ── salary structure and grades ───────────────────────────────────────────
  const structures = await ensureByKey(write, "payroll_salary_structures", `select=*&property_id=eq.${pid}`, [{
    property_id: pid, name: "Infinity Grand Hotel 2026", code: "IGH-2026", currency: "GHS",
    pay_frequency_id: monthly.id, effective_from: `${YEAR}-01-01`, active: true,
    description: "Single monthly structure covering every department",
    created_by: write.userId, updated_by: write.userId,
  }], (r) => r.code);
  const structure = structures.rows[0];

  const grades = await ensureByKey(write, "payroll_salary_grades", `select=*&property_id=eq.${pid}`,
    GRADES.map((g) => ({
      ...g, property_id: pid, salary_structure_id: structure.id, effective_from: `${YEAR}-01-01`,
      active: true, created_by: write.userId, updated_by: write.userId,
    })), (r) => r.code);
  const gradeByCode = new Map(grades.rows.map((g) => [g.code, g]));
  log(`  · salary structure and ${grades.created} grades (${grades.existing} already present)`);

  const structureComponents = await write.select("payroll_structure_components", `select=id,pay_component_id&property_id=eq.${pid}`);
  const haveStructureComponent = new Set(structureComponents.map((r) => r.pay_component_id));
  const structureComponentRows = ["HOUSE", "TRANS", "MEAL"]
    .filter((code) => !haveStructureComponent.has(componentByCode.get(code).id))
    .map((code, index) => ({
      property_id: pid,
      salary_structure_id: structure.id,
      pay_component_id: componentByCode.get(code).id,
      required: false,
      effective_from: `${YEAR}-01-01`,
      display_order: (index + 1) * 10,
      active: true,
      created_by: write.userId,
      updated_by: write.userId,
    }));
  if (structureComponentRows.length) await write.insert("payroll_structure_components", structureComponentRows);
  log(`  · structure components attached: ${structureComponentRows.length}`);

  // ── employee compensation ─────────────────────────────────────────────────
  const employees = await write.select(
    "hr_employees",
    `select=id,employee_number,designation_id,hire_date,employment_type&property_id=eq.${pid}&limit=500`,
  );
  const designations = await write.select("hr_designations", `select=id,code&property_id=eq.${pid}`);
  const designationCodeById = new Map(designations.map((d) => [d.id, d.code]));
  const salaryByDesignation = new Map(DESIGNATIONS.map(([, code, , , , range]) => [code, range]));
  const gradeFor = (designationCode) => {
    const rank = DESIGNATIONS.find((d) => d[1] === designationCode)?.[3] ?? 5;
    return gradeByCode.get(`G${Math.min(5, Math.max(1, rank))}`);
  };

  const existingComp = await write.select("payroll_employee_compensations", `select=id,employee_id&property_id=eq.${pid}&limit=500`);
  const haveComp = new Set(existingComp.map((c) => c.employee_id));
  const compRows = employees.filter((e) => !haveComp.has(e.id)).map((employee) => {
    const code = designationCodeById.get(employee.designation_id);
    const [low, high] = salaryByDesignation.get(code) ?? [2000, 2600];
    const grade = gradeFor(code);
    // payroll_validate_configuration() refuses a salary outside its grade band,
    // so the designation's own range is clamped into the band it maps to.
    const base = Math.min(
      Number(grade?.maximum_base_salary ?? high),
      Math.max(Number(grade?.minimum_base_salary ?? low), Math.round(rand.money(low, high, 50))),
    );
    return {
      property_id: pid,
      employee_id: employee.id,
      salary_structure_id: structure.id,
      salary_grade_id: grade?.id ?? null,
      base_salary: base,
      currency: "GHS",
      pay_frequency_id: monthly.id,
      effective_from: employee.hire_date > `${YEAR}-01-01` ? employee.hire_date : `${YEAR}-01-01`,
      employment_percentage: employee.employment_type === "part_time" ? 60 : 100,
      payment_method: "bank_transfer",
      reason_for_change: "Initial salary on record for the demonstration environment",
      approval_status: "approved",
      active: true,
      created_by: write.userId,
      updated_by: write.userId,
    };
  });
  const compensations = compRows.length ? await write.insert("payroll_employee_compensations", compRows) : [];
  const allCompensations = [...existingComp, ...compensations];
  log(`  · employee compensation: ${compensations.length} created, ${existingComp.length} already present`);

  // recurring allowances for everyone, and a staff loan for a few
  const existingEmployeeComponents = await write.select("payroll_employee_components", `select=id,compensation_id,pay_component_id&property_id=eq.${pid}&limit=1000`);
  const haveEmployeeComponent = new Set(existingEmployeeComponents.map((r) => `${r.compensation_id}|${r.pay_component_id}`));
  const employeeComponentRows = [];
  for (const compensation of allCompensations) {
    for (const code of ["HOUSE", "TRANS", "MEAL"]) {
      const key = `${compensation.id}|${componentByCode.get(code).id}`;
      if (haveEmployeeComponent.has(key)) continue;
      employeeComponentRows.push({
        property_id: pid,
        compensation_id: compensation.id,
        pay_component_id: componentByCode.get(code).id,
        fixed_amount_override: null,
        percentage_override: null,
        recurrence: "recurring",
        start_date: `${YEAR}-01-01`,
        end_date: null,
        reason: "Standard allowance package for all staff",
        active: true,
        created_by: write.userId,
      });
    }
    if (rand.chance(0.12)) {
      const key = `${compensation.id}|${componentByCode.get("LOAN").id}`;
      if (!haveEmployeeComponent.has(key)) {
        employeeComponentRows.push({
          property_id: pid,
          compensation_id: compensation.id,
          pay_component_id: componentByCode.get("LOAN").id,
          fixed_amount_override: rand.money(150, 600, 50),
          percentage_override: null,
          recurrence: "recurring",
          start_date: `${YEAR}-03-01`,
          end_date: `${YEAR}-12-31`,
          reason: "Staff loan repayment schedule agreed with Finance",
          active: true,
          created_by: write.userId,
        });
      }
    }
  }
  for (let i = 0; i < employeeComponentRows.length; i += 100) {
    await write.insert("payroll_employee_components", employeeComponentRows.slice(i, i + 100));
  }
  log(`  · employee components: ${employeeComponentRows.length} attached`);

  // ── draft runs, ready for the application to calculate ────────────────────
  const openPeriods = periods.rows
    .filter((p) => p.end_date < ctx.asOf && p.end_date >= day(ctx.asOf, -100))
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  const existingRuns = await write.select("payroll_runs", `select=id,calendar_period_id,status,run_code&property_id=eq.${pid}&limit=100`);
  const haveRun = new Set(existingRuns.map((r) => r.calendar_period_id));
  let runsCreated = 0;
  for (const period of openPeriods) {
    if (haveRun.has(period.id)) continue;
    const r = await write.tryRpc("payroll_create_draft_run", {
      _property_id: pid,
      _calendar_period_id: period.id,
      _run_type: "regular",
      _idempotency_key: randomUUID(),
    });
    if (r.ok) runsCreated++;
    else log(`  ! payroll_create_draft_run ${period.period_label}: ${JSON.stringify(r.body).slice(0, 220)}`);
  }
  log(`  · payroll runs: ${runsCreated} drafts opened, ${existingRuns.length} already present`);
  log("  · calculation, approval and payslips are performed by driving the application (see scripts/demo/README.md)");

  return {};
}
