// Stage 7 — the workforce: departments, designations, employees, shifts, the
// duty roster, attendance and leave.
//
// Written as the HR manager (hr.demo), because every HR table is gated by
// has_hrm_permission() rather than a plain role check, and the HR role is what
// the module is designed around. Where a table's policy demands the employee
// themselves (leave requests must be raised by the signed-in employee, with
// created_by = auth.uid()), the seeder signs in as that member of staff and
// raises their own request — which is why the demo's leave history belongs to
// the ten employees who have login accounts.
//
// Leave balances come from hr_initialize_leave_balances(), rosters from
// bulk_assign_hr_duty_roster(), leave decisions from hr_submit_leave_request()
// and hr_decide_leave_request(), and attendance summaries from
// recalculate_hr_attendance_summary() — no derived HR figure is written by
// hand.

import { makeRandom, FIRST_NAMES, LAST_NAMES, day, atTime } from "../lib/random.mjs";
import { ensureByKey, pool } from "../lib/env.mjs";
import { loadStaffClients } from "./04-operations.mjs";

export const DEPARTMENTS = [
  { code: "MGT", name: "Management", description: "Executive office and duty management" },
  { code: "FO", name: "Front Office", description: "Reception, reservations, concierge and cashiering" },
  { code: "HK", name: "Housekeeping", description: "Rooms, public areas and laundry" },
  { code: "FB", name: "Restaurant", description: "The Grand Restaurant service team" },
  { code: "BAR", name: "Bar", description: "Skyline Bar service team" },
  { code: "KIT", name: "Kitchen", description: "Main kitchen, pastry and stewarding" },
  { code: "FIN", name: "Finance", description: "Accounts, income audit and payroll" },
  { code: "STO", name: "Stores", description: "Receiving, stores and purchasing" },
  { code: "SEC", name: "Security", description: "Guest and asset protection" },
  { code: "ENG", name: "Maintenance", description: "Engineering and facilities" },
  { code: "HRA", name: "HR & Admin", description: "People, training and administration" },
];

// [department, code, title, rank, headcount, monthly gross range]
export const DESIGNATIONS = [
  ["MGT", "GM", "General Manager", 1, 1, [14000, 14000]],
  ["MGT", "DM", "Duty Manager", 2, 2, [6200, 7200]],
  ["FO", "FOM", "Front Office Manager", 2, 1, [7400, 7400]],
  ["FO", "FDO", "Front Desk Officer", 4, 4, [2600, 3400]],
  ["FO", "RSV", "Reservations Officer", 4, 2, [2800, 3300]],
  ["FO", "CSH", "Front Office Cashier", 4, 2, [2500, 3000]],
  ["HK", "HKS", "Housekeeping Supervisor", 3, 1, [4200, 4200]],
  ["HK", "RMA", "Room Attendant", 5, 6, [1800, 2400]],
  ["HK", "LAU", "Laundry Attendant", 5, 2, [1750, 2100]],
  ["FB", "RM", "Restaurant Manager", 2, 1, [6800, 6800]],
  ["FB", "WTR", "Waiter", 5, 4, [1900, 2500]],
  ["BAR", "BRM", "Bar Supervisor", 3, 1, [4000, 4000]],
  ["BAR", "BTD", "Bartender", 5, 2, [2100, 2600]],
  ["KIT", "EXC", "Executive Chef", 2, 1, [9200, 9200]],
  ["KIT", "SCH", "Sous Chef", 3, 1, [5600, 5600]],
  ["KIT", "CDP", "Chef de Partie", 4, 3, [2900, 3600]],
  ["KIT", "STW", "Steward", 5, 2, [1700, 2000]],
  ["FIN", "FC", "Financial Controller", 2, 1, [9800, 9800]],
  ["FIN", "ACC", "Accountant", 3, 2, [4600, 5400]],
  ["STO", "STK", "Storekeeper", 4, 2, [2400, 2900]],
  ["SEC", "SEC", "Security Officer", 5, 3, [2000, 2400]],
  ["ENG", "MNT", "Maintenance Technician", 4, 2, [2900, 3600]],
  ["HRA", "HRM", "HR Manager", 2, 1, [7600, 7600]],
  ["HRA", "ADM", "Administrative Officer", 4, 1, [2900, 2900]],
];

export const SHIFTS = [
  { code: "AM", name: "Morning (06:00–14:00)", start_time: "06:00", end_time: "14:00", break_minutes: 30, expected_work_minutes: 450, colour: "#1B3A5C", is_overnight: false },
  { code: "PM", name: "Afternoon (14:00–22:00)", start_time: "14:00", end_time: "22:00", break_minutes: 30, expected_work_minutes: 450, colour: "#C8A951", is_overnight: false },
  { code: "NGT", name: "Night (22:00–06:00)", start_time: "22:00", end_time: "06:00", break_minutes: 30, expected_work_minutes: 450, colour: "#2F4858", is_overnight: true },
  { code: "OFF", name: "Office (08:00–17:00)", start_time: "08:00", end_time: "17:00", break_minutes: 60, expected_work_minutes: 480, colour: "#5B8266", is_overnight: false },
];

export const LEAVE_TYPES = [
  { code: "ANN", name: "Annual Leave", paid: true, annual_entitlement: 15, minimum_notice_days: 7, approval_required: true },
  { code: "SICK", name: "Sick Leave", paid: true, annual_entitlement: 10, minimum_notice_days: 0, approval_required: true },
  { code: "MAT", name: "Maternity Leave", paid: true, annual_entitlement: 84, minimum_notice_days: 30, approval_required: true },
  { code: "COMP", name: "Compassionate Leave", paid: true, annual_entitlement: 5, minimum_notice_days: 0, approval_required: true },
  { code: "UNP", name: "Unpaid Leave", paid: false, annual_entitlement: 0, minimum_notice_days: 14, approval_required: true },
];

export const HOLIDAYS = [
  { name: "Founders' Day", holiday_date: "2026-08-04" },
  { name: "Kwame Nkrumah Memorial Day", holiday_date: "2026-09-21" },
  { name: "Farmers' Day", holiday_date: "2026-12-04" },
  { name: "Christmas Day", holiday_date: "2026-12-25" },
  { name: "Boxing Day", holiday_date: "2026-12-26" },
];

const ROSTER_PAST_DAYS = 21;
const ROSTER_FUTURE_DAYS = 14;
const ATTENDANCE_DAYS = 14;

export async function run({ ctx, admin, signIn, log }) {
  const pid = ctx.propertyId;
  const rand = makeRandom(20260911);
  const staff = await loadStaffClients({ ctx, admin, signIn });
  const hr = staff.hr;

  if (ctx.dryRun) {
    const headcount = DESIGNATIONS.reduce((n, d) => n + d[4], 0);
    log(`  · would create ${DEPARTMENTS.length} departments, ${DESIGNATIONS.length} designations and ${headcount} employees`);
    return {};
  }

  // A helper that falls back to the super admin if an HR permission is missing,
  // and says so, rather than silently seeding as the wrong person.
  const fallbacks = new Set();
  const asHr = async (label, fn) => {
    try {
      return await fn(hr);
    } catch (error) {
      fallbacks.add(label);
      return fn(admin);
    }
  };

  // ── structure ─────────────────────────────────────────────────────────────
  const departments = await asHr("departments", (c) =>
    ensureByKey(c, "hr_departments", `select=*&property_id=eq.${pid}`,
      DEPARTMENTS.map((d) => ({ ...d, property_id: pid, status: "active" })), (r) => r.code),
  );
  const deptByCode = new Map(departments.rows.map((d) => [d.code, d]));
  log(`  · departments: ${departments.created} created, ${departments.existing} already present`);

  const designations = await asHr("designations", (c) =>
    ensureByKey(c, "hr_designations", `select=*&property_id=eq.${pid}`,
      DESIGNATIONS.map(([dept, code, title, rank]) => ({
        property_id: pid, department_id: deptByCode.get(dept).id, code, title, rank, status: "active",
      })), (r) => r.code),
  );
  const desigByCode = new Map(designations.rows.map((d) => [d.code, d]));
  log(`  · designations: ${designations.created} created, ${designations.existing} already present`);

  const shifts = await asHr("shifts", (c) =>
    ensureByKey(c, "hr_shift_templates", `select=*&property_id=eq.${pid}`,
      SHIFTS.map((s) => ({ ...s, property_id: pid, active: true, grace_period_minutes: 10 })), (r) => r.code),
  );
  const shiftByCode = new Map(shifts.rows.map((s) => [s.code, s]));
  log(`  · shift templates: ${shifts.created} created, ${shifts.existing} already present`);

  const leaveTypes = await asHr("leave types", (c) =>
    ensureByKey(c, "hr_leave_types", `select=*&property_id=eq.${pid}`,
      LEAVE_TYPES.map((t) => ({
        ...t, property_id: pid, active: true, entitlement_unit: "days", accrual_method: "annual",
        accrual_frequency: "yearly", leave_year_start_month: 1, carry_forward_enabled: t.code === "ANN",
        maximum_carry_forward: t.code === "ANN" ? 5 : 0, partial_day_supported: true,
      })), (r) => r.code),
  );
  const leaveByCode = new Map(leaveTypes.rows.map((t) => [t.code, t]));
  log(`  · leave types: ${leaveTypes.created} created, ${leaveTypes.existing} already present`);

  await asHr("holidays", (c) =>
    ensureByKey(c, "hr_holidays", `select=*&property_id=eq.${pid}`,
      HOLIDAYS.map((h) => ({ ...h, property_id: pid, active: true, holiday_type: "public", treatment: "paid", scope_type: "property" })),
      (r) => r.name),
  );

  // ── people ────────────────────────────────────────────────────────────────
  // The ten staff accounts created in stage 1 become real employees, so the
  // demo can show "this login is that person on the roster".
  const accountByDesignation = {
    GM: "gm.demo", HRM: "hr.demo", ACC: "accounts.demo", FDO: "frontdesk.demo",
    RSV: "reservations.demo", CSH: "cashier.demo", RM: "restaurant.demo",
    WTR: "waiter.demo", HKS: "housekeeping.demo", STK: "stores.demo",
  };
  const profiles = await admin.select("profiles", "select=id,identifier,full_name,identifier_normalized&limit=200");
  const profileByIdentifier = new Map(profiles.map((p) => [p.identifier_normalized, p]));

  const existingEmployees = await asHr("employees read", (c) =>
    c.select("hr_employees", `select=id,employee_number,designation_id,department_id,first_name,last_name,staff_user_id&property_id=eq.${pid}&limit=500`),
  );
  const employeeRows = [];
  let seq = existingEmployees.length;
  const usedAccounts = new Set(existingEmployees.map((e) => e.staff_user_id).filter(Boolean));
  for (const [deptCode, code, title, , headcount] of DESIGNATIONS) {
    const already = existingEmployees.filter((e) => e.designation_id === desigByCode.get(code)?.id).length;
    for (let i = already; i < headcount; i++) {
      const linkedIdentifier = i === 0 ? accountByDesignation[code] : null;
      const profile = linkedIdentifier ? profileByIdentifier.get(linkedIdentifier) : null;
      const link = profile && !usedAccounts.has(profile.id) ? profile : null;
      if (link) usedAccounts.add(link.id);
      const [first, last] = link
        ? link.full_name.split(" ").length > 1
          ? [link.full_name.split(" ").slice(0, -1).join(" "), link.full_name.split(" ").slice(-1)[0]]
          : [link.full_name, "Mensah"]
        : [rand.pick(FIRST_NAMES), rand.pick(LAST_NAMES)];
      const hireDate = day(ctx.asOf, -rand.int(60, 2400));
      const probation = rand.chance(0.08) && hireDate > day(ctx.asOf, -180);
      employeeRows.push({
        property_id: pid,
        employee_number: `IGH-${String(++seq).padStart(4, "0")}`,
        first_name: first,
        last_name: last,
        work_email: `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, "") + `${seq}@staff.infinitygrand.example`,
        department_id: deptByCode.get(deptCode).id,
        designation_id: desigByCode.get(code).id,
        employment_type: rand.chance(0.86) ? "full_time" : rand.chance(0.5) ? "part_time" : "contract",
        employment_status: probation ? "probation" : "active",
        hire_date: hireDate,
        probation_end_date: day(hireDate, 180),
        confirmation_date: probation ? null : day(hireDate, 180),
        work_location: "Infinity Grand Hotel, Accra",
        staff_user_id: link?.id ?? null,
        notes: null,
        created_by: hr.userId,
      });
    }
  }
  const created = employeeRows.length
    ? await asHr("employees", (c) => c.insert("hr_employees", employeeRows))
    : [];
  const employees = [...existingEmployees, ...created];
  log(`  · employees: ${created.length} created, ${existingEmployees.length} already present (${employees.length} total)`);

  // reporting lines: everyone reports to their department head, heads to the GM
  const gmEmployee = employees.find((e) => e.designation_id === desigByCode.get("GM")?.id);
  const headByDept = new Map();
  for (const [deptCode, code] of DESIGNATIONS) {
    const head = employees.find((e) => e.designation_id === desigByCode.get(code)?.id);
    if (head && !headByDept.has(deptCode)) headByDept.set(deptCode, head);
  }
  let lines = 0;
  for (const employee of employees) {
    const deptCode = [...deptByCode.entries()].find(([, d]) => d.id === employee.department_id)?.[0];
    const head = headByDept.get(deptCode);
    const manager = head && head.id !== employee.id ? head : gmEmployee;
    if (!manager || manager.id === employee.id) continue;
    await asHr("reporting lines", (c) => c.update("hr_employees", `id=eq.${employee.id}`, { reporting_manager_id: manager.id }));
    lines++;
  }
  for (const [deptCode, head] of headByDept) {
    const dept = deptByCode.get(deptCode);
    if (dept && head) await asHr("department heads", (c) => c.update("hr_departments", `id=eq.${dept.id}`, { department_head_id: head.id }));
  }
  log(`  · reporting lines set for ${lines} employees; ${headByDept.size} department heads recorded`);

  // private personal details, kept in the separate restricted table
  const privateExisting = await asHr("private read", (c) => c.select("hr_employee_private", `select=employee_id&property_id=eq.${pid}&limit=500`));
  const havePrivate = new Set(privateExisting.map((p) => p.employee_id));
  const privateRows = employees.filter((e) => !havePrivate.has(e.id)).map((e) => ({
    employee_id: e.id,
    property_id: pid,
    date_of_birth: day(ctx.asOf, -rand.int(8000, 20000)),
    gender: rand.pick(["female", "male"]),
    nationality: "Ghanaian",
    marital_status: rand.pick(["single", "married", "single", "married", "divorced"]),
    personal_email: `${e.first_name}.${e.last_name}`.toLowerCase().replace(/[^a-z.]/g, "") + "@personal.example",
    primary_phone: `+233 30 000 ${rand.int(3000, 3999)}`,
    residential_address: `${rand.int(1, 90)} ${rand.pick(["Dansoman Road", "Adenta Housing Down", "Teshie Nungua Estate", "Madina Estates", "Achimota Mile 7"])}, Accra`,
    emergency_contact_name: `${rand.pick(FIRST_NAMES)} ${e.last_name}`,
    emergency_contact_relationship: rand.pick(["Spouse", "Parent", "Sibling", "Cousin"]),
    emergency_contact_phone: `+233 30 000 ${rand.int(4000, 4999)}`,
  }));
  if (privateRows.length) await asHr("private details", (c) => c.insert("hr_employee_private", privateRows));
  log(`  · personal details recorded for ${privateRows.length} employees`);

  // ── leave balances ────────────────────────────────────────────────────────
  // hr_initialize_leave_balances() is the intended entry point but fails on
  // this schema with 42702 "column reference period_start is ambiguous", so
  // every employee's entitlement would be missing. The per-type
  // recalculate_hr_leave_balance() is tried as the fallback; whichever works is
  // reported, and the defect is raised separately.
  let balances = 0;
  let balanceFallback = 0;
  let balanceError = null;
  const leaveYear = { start: `${ctx.asOf.slice(0, 4)}-01-01`, end: `${ctx.asOf.slice(0, 4)}-12-31` };
  await pool(employees, 6, async (employee) => {
    const r = await hr.tryRpc("hr_initialize_leave_balances", { _property_id: pid, _employee_id: employee.id });
    if (r.ok) {
      balances++;
      return;
    }
    if (!balanceError) balanceError = JSON.stringify(r.body).slice(0, 200);
    for (const type of leaveTypes.rows) {
      const alt = await hr.tryRpc("recalculate_hr_leave_balance", {
        _property_id: pid,
        _employee_id: employee.id,
        _leave_type_id: type.id,
        _period_start: leaveYear.start,
        _period_end: leaveYear.end,
      });
      if (alt.ok) balanceFallback++;
    }
  });
  log(`  · leave balances: ${balances} via hr_initialize_leave_balances, ${balanceFallback} via recalculate_hr_leave_balance`);
  if (balanceError) log(`  ! hr_initialize_leave_balances is failing: ${balanceError}`);

  // ── duty roster ───────────────────────────────────────────────────────────
  const rosterDates = [];
  for (let i = -ROSTER_PAST_DAYS; i <= ROSTER_FUTURE_DAYS; i++) rosterDates.push(day(ctx.asOf, i));
  const shiftForDept = {
    MGT: ["OFF"], FO: ["AM", "PM", "NGT"], HK: ["AM", "PM"], FB: ["AM", "PM"],
    BAR: ["PM"], KIT: ["AM", "PM"], FIN: ["OFF"], STO: ["AM"], SEC: ["AM", "NGT"], ENG: ["AM"], HRA: ["OFF"],
  };
  // Each employee gets two rotating rest days a week: hr_workforce_settings
  // caps consecutive workdays (6 here) and bulk_assign_hr_duty_roster refuses
  // the whole batch if any employee would exceed it. Dates already on the
  // roster are skipped so this can be rerun.
  const alreadyRostered = await hr.select(
    "hr_duty_roster",
    `select=employee_id,duty_date&property_id=eq.${pid}&duty_date=gte.${rosterDates[0]}&duty_date=lte.${rosterDates[rosterDates.length - 1]}&limit=5000`,
  );
  const rosterHas = new Set(alreadyRostered.map((r) => `${r.employee_id}|${r.duty_date}`));
  let rostered = 0;
  let rosterDays = 0;
  for (const [deptCode, shiftCodes] of Object.entries(shiftForDept)) {
    const dept = deptByCode.get(deptCode);
    const team = employees.filter((e) => e.department_id === dept.id);
    if (!team.length) continue;
    for (const [position, employee] of team.entries()) {
      const shiftCode = shiftCodes[position % shiftCodes.length];
      const restA = position % 7;
      const restB = (position + 3) % 7;
      const dates = rosterDates.filter((d) => {
        const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
        if (shiftCode === "OFF") return dow >= 1 && dow <= 5;
        return dow !== restA && dow !== restB;
      }).filter((d) => !rosterHas.has(`${employee.id}|${d}`));
      if (!dates.length) continue;
      const r = await hr.tryRpc("bulk_assign_hr_duty_roster", {
        _property_id: pid,
        _employee_ids: [employee.id],
        _shift_id: shiftByCode.get(shiftCode).id,
        _duty_dates: dates,
        _department_id: dept.id,
        _work_location: "Infinity Grand Hotel, Accra",
      });
      if (r.ok) {
        rostered++;
        rosterDays += dates.length;
      } else if (rostered === 0) {
        log(`  ! roster ${deptCode}/${shiftCode}: ${JSON.stringify(r.body).slice(0, 180)}`);
      }
    }
  }
  log(`  · roster: ${rosterDays} shifts assigned for ${rostered} employees`);
  const publish = await hr.raw(
    `/rest/v1/hr_duty_roster?property_id=eq.${pid}&publication_status=eq.draft`,
    { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ publication_status: "published", published_by: hr.userId, published_at: new Date().toISOString() }) },
  );
  log(publish.ok ? "  · roster published to staff" : `  ! roster publish: ${JSON.stringify(publish.body).slice(0, 160)}`);

  // ── attendance ────────────────────────────────────────────────────────────
  // hr_attendance_events has a read policy and no insert policy at all: the
  // only ways in are record_hr_time_clock_event() (the signed-in employee,
  // clocking in now) and the biometric pipeline. Historic attendance therefore
  // arrives the way a real property backfills it — through a biometric device,
  // an import batch, normalized events, and hr_convert_biometric_event().
  const [device] = await (async () => {
    const existing = await hr.select("hr_biometric_devices", `select=id,name&property_id=eq.${pid}&limit=1`);
    if (existing.length) return existing;
    return hr.insert("hr_biometric_devices", [{
      property_id: pid,
      name: "Staff entrance terminal",
      location: "Back of house, staff entrance",
      provider_adapter: "generic_csv",
      capability: ["clock_in", "clock_out"],
      status: "online_placeholder",
      active: true,
    }]);
  })();

  const mappingRows = await hr.select("hr_biometric_employee_mappings", `select=employee_id&property_id=eq.${pid}&limit=500`);
  const mapped = new Set(mappingRows.map((m) => m.employee_id));
  const newMappings = employees.filter((e) => !mapped.has(e.id)).map((e) => ({
    property_id: pid,
    device_id: device.id,
    employee_id: e.id,
    external_employee_identifier: e.employee_number,
    active: true,
  }));
  if (newMappings.length) await hr.insert("hr_biometric_employee_mappings", newMappings);
  log(`  · biometric device configured, ${newMappings.length} employee mappings added`);

  const rosterRows = await hr.select(
    "hr_duty_roster",
    `select=id,employee_id,duty_date,starts_at,ends_at&property_id=eq.${pid}&duty_date=gte.${day(ctx.asOf, -ATTENDANCE_DAYS)}&duty_date=lte.${day(ctx.asOf, -1)}&limit=2000`,
  );
  const employeeNumberById = new Map(employees.map((e) => [e.id, e.employee_number]));
  const [batch] = await hr.insert("hr_biometric_import_batches", [{
    property_id: pid,
    device_id: device.id,
    adapter_type: "generic_csv",
    status: "processing",
    safe_provider_reference: `demo-backfill-${ctx.asOf}`,
    imported_by: hr.userId,
  }]);

  const normalized = [];
  for (const shiftRow of rosterRows) {
    if (rand.chance(0.04)) continue; // genuine absence
    const start = new Date(shiftRow.starts_at);
    const end = new Date(shiftRow.ends_at);
    // Clock times are never earlier than the scheduled shift: an early
    // clock-in makes recalculate_hr_attendance_summary() compute a negative
    // late_minutes and the summary INSERT then fails the
    // hr_attendance_summaries_late_minutes_check constraint (reported).
    const late = rand.chance(0.22) ? rand.int(4, 35) : rand.int(0, 3);
    const clockIn = new Date(start.getTime() + late * 60000);
    const clockOut = new Date(end.getTime() + (rand.chance(0.2) ? rand.int(10, 70) : rand.int(0, 6)) * 60000);
    const identifier = employeeNumberById.get(shiftRow.employee_id);
    for (const [type, at] of [["clock_in", clockIn], ["clock_out", clockOut]]) {
      normalized.push({
        property_id: pid,
        device_id: device.id,
        batch_id: batch.id,
        external_employee_identifier: identifier,
        employee_id: shiftRow.employee_id,
        source_event_id: `${identifier}-${shiftRow.duty_date}-${type}`,
        event_at: at.toISOString(),
        event_type: type,
        deduplication_key: `${identifier}-${shiftRow.duty_date}-${type}`,
        processing_status: "pending",
      });
    }
  }
  const seenKeys = new Set();
  const uniqueNormalized = normalized.filter((e) => {
    if (seenKeys.has(e.deduplication_key)) return false;
    seenKeys.add(e.deduplication_key);
    return true;
  });
  let ingested = [];
  for (let i = 0; i < uniqueNormalized.length; i += 100) {
    const slice = uniqueNormalized.slice(i, i + 100);
    const r = await hr.raw("/rest/v1/hr_biometric_normalized_events", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(slice),
    });
    if (r.ok) ingested.push(...r.body);
    else if (!ingested.length) log(`  ! biometric events: ${JSON.stringify(r.body).slice(0, 220)}`);
  }
  log(`  · biometric events ingested: ${ingested.length}`);

  let events = 0;
  await pool(ingested, 8, async (event) => {
    const r = await hr.tryRpc("hr_convert_biometric_event", { _property_id: pid, _event_id: event.id });
    if (r.ok && r.body) events++;
    else if (events === 0 && !r.ok) log(`  ! hr_convert_biometric_event: ${JSON.stringify(r.body).slice(0, 200)}`);
  });
  await hr.update("hr_biometric_import_batches", `id=eq.${batch.id}`, { status: "completed", completed_at: new Date().toISOString() });
  log(`  · attendance events created from the import: ${events}`);

  const summaryTargets = [...new Set(rosterRows.map((r) => `${r.employee_id}|${r.duty_date}`))].map((key) => {
    const [employee_id, business_date] = key.split("|");
    return { employee_id, business_date };
  });
  let summaries = 0;
  await pool(summaryTargets, 8, async (target) => {
    const r = await hr.tryRpc("recalculate_hr_attendance_summary", {
      _property_id: pid, _employee_id: target.employee_id, _business_date: target.business_date, _trigger_source: "explicit_recalculation",
    });
    if (r.ok) summaries++;
    else if (summaries === 0) log(`  ! recalculate_hr_attendance_summary: ${JSON.stringify(r.body).slice(0, 200)}`);
  });
  log(`  · attendance summaries calculated: ${summaries}`);

  // ── leave requests, raised by the employees who have logins ───────────────
  const linkable = employees.filter((e) => e.staff_user_id);
  const accountByUserId = new Map(Object.values(staff).filter((s) => s?.userId).map((s) => [s.userId, s]));
  const existingLeave = await hr.select("hr_leave_requests", `select=id&property_id=eq.${pid}&status=neq.draft&limit=200`);
  const leaveTarget = 18;
  let requests = 0;
  let decided = 0;
  for (const employee of existingLeave.length >= leaveTarget ? [] : linkable) {
    const client = accountByUserId.get(employee.staff_user_id);
    if (!client) continue;
    for (let n = 0; n < rand.int(1, 3); n++) {
      // hr_submit_leave_request measures notice from today, so a backdated
      // request can never be submitted — every demo request is forward-dated,
      // which is also what a leave planner would really contain.
      const type = rand.pick([leaveByCode.get("ANN"), leaveByCode.get("ANN"), leaveByCode.get("SICK"), leaveByCode.get("COMP")]);
      const startOffset = rand.int(9, 60);
      const start = day(ctx.asOf, startOffset);
      const days = type.code === "ANN" ? rand.int(2, 7) : rand.int(1, 3);
      const inserted = await client.raw(`/rest/v1/hr_leave_requests`, {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify([{
          property_id: pid, employee_id: employee.id, leave_type_id: type.id,
          start_date: start, end_date: day(start, days - 1), partial_day_mode: "none",
          total_requested_days: days,
          reason: rand.pick([
            "Family visit to Kumasi.", "Medical appointment and recovery.", "Annual rest days.",
            "Attending a relative's funeral.", "Personal matters.", "Short break after peak season.",
          ]),
          status: "draft", created_by: client.userId,
        }]),
      });
      if (!inserted.ok) {
        if (requests === 0) log(`  ! leave request insert: ${JSON.stringify(inserted.body).slice(0, 220)}`);
        break;
      }
      const requestId = inserted.body[0].id;
      requests++;
      const submitted = await client.tryRpc("hr_submit_leave_request", { _property_id: pid, _request_id: requestId });
      if (!submitted.ok) {
        if (decided === 0) log(`  ! hr_submit_leave_request: ${JSON.stringify(submitted.body).slice(0, 200)}`);
        continue;
      }
      // Requests that start in the past are already decided; future ones are
      // left in the approval queue for the demonstration.
      if (rand.chance(0.7)) {
        const decision = rand.chance(0.85) ? "approved" : "rejected";
        const r = await hr.tryRpc("hr_decide_leave_request", {
          _property_id: pid, _request_id: requestId, _decision: decision,
          _reason: decision === "rejected" ? "Cover could not be arranged for those dates." : "Approved — cover arranged.",
        });
        if (r.ok) decided++;
        else if (decided === 0) log(`  ! hr_decide_leave_request: ${JSON.stringify(r.body).slice(0, 200)}`);
      }
    }
  }
  log(`  · leave: ${requests} requests raised, ${decided} decided, ${requests - decided} awaiting approval`);

  // ── announcements ─────────────────────────────────────────────────────────
  await ensureByKey(hr, "hr_staff_announcements", `select=*&property_id=eq.${pid}`, [
    {
      property_id: pid, title: "Peak season briefing — Friday 16:00",
      content: "All heads of department to attend the peak season briefing in the boardroom. Bring your October roster drafts and outstanding leave requests.",
      audience_type: "all_staff", publication_status: "published", priority: "high",
      publish_date: atTime(day(ctx.asOf, -3), 9, 0), created_by: hr.userId,
    },
    {
      property_id: pid, title: "Payroll cut-off — 25th of each month",
      content: "Overtime and allowance claims must reach Finance by the 25th. Anything later is carried to the following month's payroll run.",
      audience_type: "all_staff", publication_status: "published", priority: "normal",
      publish_date: atTime(day(ctx.asOf, -12), 10, 0), created_by: hr.userId,
    },
    {
      property_id: pid, title: "Food safety refresher — kitchen and stewarding",
      content: "The annual food safety refresher runs next Tuesday and Wednesday. Attendance is mandatory for all kitchen and stewarding staff.",
      audience_type: "all_staff", publication_status: "published", priority: "normal",
      publish_date: atTime(day(ctx.asOf, -6), 8, 30), created_by: hr.userId,
    },
  ], (r) => r.title);
  log("  · 3 staff announcements published");

  if (fallbacks.size) log(`  ! seeded as super admin instead of HR for: ${[...fallbacks].join(", ")}`);
  return { state: { employees, deptByCode, desigByCode } };
}
