// Stage 2 — the hotel itself: room types, rooms, rate plans, and the
// accounting scaffolding (cost centres, expense categories, monthly financial
// periods) that later stages post into.
//
// All of this is configuration, which the application's own admin screens
// write as plain table inserts — so plain inserts are the canonical path here.
// The financial periods are the exception: they are opened through the
// financial_period_open() RPC, because that function is what stamps
// opened_by/opened_at and enforces the no-overlap rule.

import { ensureByKey } from "../lib/env.mjs";
import { monthStart, monthEnd, day } from "../lib/random.mjs";

export const ROOM_TYPES = [
  { code: "STD", name: "Standard Queen", base_occupancy: 2, max_occupancy: 2, base_rate: 850,
    description: "A calm 24 m² room with a queen bed, work desk, rain shower and city view. Air-conditioned, with fast Wi-Fi and a Nespresso machine.",
    amenities: ["Queen bed", "Air conditioning", "Free Wi-Fi", "Rain shower", "Work desk", "Smart TV", "Safe"] },
  { code: "TWN", name: "Twin Executive", base_occupancy: 2, max_occupancy: 3, base_rate: 1100,
    description: "Two full-size single beds, a lounge chair and a generous desk — the room our corporate guests book most.",
    amenities: ["Two single beds", "Air conditioning", "Free Wi-Fi", "Work desk", "Smart TV", "Mini fridge", "Safe"] },
  { code: "DLX", name: "Deluxe King", base_occupancy: 2, max_occupancy: 3, base_rate: 1250,
    description: "A 32 m² king room with a seating nook, bathtub and floor-to-ceiling windows over the Accra skyline.",
    amenities: ["King bed", "Bathtub", "Air conditioning", "Free Wi-Fi", "Smart TV", "Mini bar", "Nespresso", "Safe"] },
  { code: "FAM", name: "Family Room", base_occupancy: 3, max_occupancy: 5, base_rate: 1650,
    description: "A king bed plus a separate bunk alcove, two bathrooms and a dining table — built for families on longer stays.",
    amenities: ["King bed", "Bunk alcove", "Two bathrooms", "Air conditioning", "Free Wi-Fi", "Kitchenette", "Smart TV"] },
  { code: "EXE", name: "Executive Suite", base_occupancy: 2, max_occupancy: 4, base_rate: 2200,
    description: "A one-bedroom suite with a private lounge, dining seating for four, and complimentary airport transfer.",
    amenities: ["King bed", "Separate lounge", "Bathtub", "Airport transfer", "Free Wi-Fi", "Nespresso", "Mini bar", "Safe"] },
  { code: "PRE", name: "Presidential Suite", base_occupancy: 2, max_occupancy: 4, base_rate: 4500,
    description: "The top-floor suite: 96 m², a wraparound terrace, private dining room, butler service and a dedicated check-in.",
    amenities: ["King bed", "Terrace", "Private dining", "Butler service", "Jacuzzi", "Free Wi-Fi", "Nespresso", "Safe"] },
];

const ROOM_PLAN = [
  { code: "STD", floor: "1", numbers: ["101","102","103","104","105","106","107","108","109","110","111","112"] },
  { code: "TWN", floor: "2", numbers: ["201","202","203","204","205","206","207","208"] },
  { code: "DLX", floor: "3", numbers: ["301","302","303","304","305","306","307","308","309","310","311","312"] },
  { code: "FAM", floor: "4", numbers: ["401","402","403","404","405","406"] },
  { code: "EXE", floor: "5", numbers: ["501","502","503","504"] },
  { code: "PRE", floor: "6", numbers: ["601"] },
];

export const COST_CENTRES = [
  { code: "CC-FO", name: "Front Office" },
  { code: "CC-HK", name: "Housekeeping" },
  { code: "CC-FB", name: "Food & Beverage" },
  { code: "CC-ENG", name: "Maintenance & Engineering" },
  { code: "CC-ADM", name: "Administration" },
  { code: "CC-SEC", name: "Security" },
];

export const EXPENSE_CATEGORIES = [
  { code: "EXP-UTIL", name: "Utilities", description: "Electricity, water and generator fuel", receipt_required: true, approval_threshold: 5000 },
  { code: "EXP-MAINT", name: "Repairs & Maintenance", description: "Plant, rooms and equipment upkeep", receipt_required: true, approval_threshold: 3000 },
  { code: "EXP-SUPPL", name: "Guest Supplies", description: "Amenities, linen and consumables", receipt_required: true, approval_threshold: 2500 },
  { code: "EXP-MKT", name: "Sales & Marketing", description: "Campaigns, print and online travel agents", receipt_required: true, approval_threshold: 4000 },
  { code: "EXP-TRAN", name: "Transport & Fuel", description: "Shuttle, airport transfers and vehicle fuel", receipt_required: true, approval_threshold: 2000 },
  { code: "EXP-PROF", name: "Professional Fees", description: "Audit, legal and consultancy", receipt_required: true, approval_threshold: 6000 },
  { code: "EXP-TRAIN", name: "Staff Training", description: "Courses, certification and workshops", receipt_required: false, approval_threshold: 2000 },
  { code: "EXP-LIC", name: "Licences & Permits", description: "Statutory operating licences", receipt_required: true, approval_threshold: 8000 },
];

export async function run({ ctx, admin, log }) {
  const pid = ctx.propertyId;

  if (ctx.dryRun) {
    log(`  · would ensure ${ROOM_TYPES.length} room types, ${ROOM_PLAN.reduce((n, r) => n + r.numbers.length, 0)} rooms,`);
    log(`    ${COST_CENTRES.length} cost centres, ${EXPENSE_CATEGORIES.length} expense categories and 4 financial periods`);
    return {};
  }

  // ── room types ────────────────────────────────────────────────────────────
  const types = await ensureByKey(
    admin,
    "room_types",
    `select=*&property_id=eq.${pid}`,
    ROOM_TYPES.map((t) => ({ ...t, property_id: pid, is_public: true })),
    (r) => r.code,
  );
  log(`  · room types: ${types.created} created, ${types.existing} already present`);
  const typeByCode = new Map(types.rows.map((t) => [t.code, t]));

  // ── rooms ─────────────────────────────────────────────────────────────────
  const roomRows = ROOM_PLAN.flatMap((block) =>
    block.numbers.map((number) => ({
      property_id: pid,
      room_type_id: typeByCode.get(block.code).id,
      number,
      floor: block.floor,
      status: "available",
      housekeeping_status: "clean",
    })),
  );
  const rooms = await ensureByKey(admin, "rooms", `select=*&property_id=eq.${pid}`, roomRows, (r) => r.number);
  log(`  · rooms: ${rooms.created} created, ${rooms.existing} already present`);

  // ── rate plans ────────────────────────────────────────────────────────────
  const seasonStart = "2026-01-01";
  const seasonEnd = "2026-12-31";
  const ratePlanRows = ROOM_TYPES.flatMap((t) => [
    {
      property_id: pid, room_type_id: typeByCode.get(t.code).id,
      name: `Rack Rate 2026 — ${t.name}`, start_date: seasonStart, end_date: seasonEnd,
      rate: t.base_rate, min_stay: 1,
    },
    {
      property_id: pid, room_type_id: typeByCode.get(t.code).id,
      name: `Long Stay (4+ nights) — ${t.name}`, start_date: seasonStart, end_date: seasonEnd,
      rate: Math.round(t.base_rate * 0.88), min_stay: 4,
    },
  ]);
  const plans = await ensureByKey(admin, "rate_plans", `select=*&property_id=eq.${pid}`, ratePlanRows, (r) => r.name);
  log(`  · rate plans: ${plans.created} created, ${plans.existing} already present`);

  // ── cost centres and expense categories ───────────────────────────────────
  const centres = await ensureByKey(
    admin, "cost_centres", `select=*&property_id=eq.${pid}`,
    COST_CENTRES.map((c) => ({ ...c, property_id: pid, active: true })), (r) => r.code,
  );
  log(`  · cost centres: ${centres.created} created, ${centres.existing} already present`);

  const accounts = await admin.select("accounts", `select=id,system_key&property_id=eq.${pid}`);
  const opex = accounts.find((a) => a.system_key === "opex")?.id ?? null;
  const centreByCode = new Map(centres.rows.map((c) => [c.code, c]));
  const categories = await ensureByKey(
    admin, "expense_categories", `select=*&property_id=eq.${pid}`,
    EXPENSE_CATEGORIES.map((c) => ({
      ...c,
      property_id: pid,
      active: true,
      accounting_mapping_account_id: opex,
      default_cost_centre_id: centreByCode.get("CC-ADM")?.id ?? null,
    })),
    (r) => r.code,
  );
  log(`  · expense categories: ${categories.created} created, ${categories.existing} already present`);

  // ── financial periods ─────────────────────────────────────────────────────
  // Opened through the RPC so opened_by/opened_at and the overlap rule apply.
  const existingPeriods = await admin.select("accounting_periods", `select=id,start_date,end_date,status,name&property_id=eq.${pid}`);
  const have = new Set(existingPeriods.map((p) => p.start_date));
  let openedPeriods = 0;
  for (let i = 3; i >= 0; i--) {
    const anchor = day(ctx.asOf, -i * 30);
    const start = monthStart(anchor);
    const end = monthEnd(anchor);
    if (have.has(start)) continue;
    const name = new Date(`${start}T00:00:00Z`).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
    const r = await admin.tryRpc("financial_period_open", {
      _property_id: pid, _name: name, _code: start.slice(0, 7), _start_date: start, _end_date: end,
    });
    if (!r.ok) {
      log(`  ! could not open period ${start}..${end}: ${JSON.stringify(r.body).slice(0, 200)}`);
      continue;
    }
    have.add(start);
    openedPeriods++;
  }
  log(`  · financial periods: ${openedPeriods} opened, ${existingPeriods.length} already present`);

  return {
    state: {
      roomTypes: types.rows,
      rooms: rooms.rows,
      costCentres: centres.rows,
      expenseCategories: categories.rows,
      accounts,
    },
  };
}
