// Stage 4 — the hotel's operating history, replayed day by day.
//
// This stage does not "insert a dataset". It plays the hotel forward one
// business date at a time, through the same paths the staff use:
//
//   reservations officer / front desk  create guests, bookings and folio charges
//   front desk                         check arrivals in
//   cashier                            opens POS orders, adds items, takes payments
//   general manager                    closes and posts POS orders, runs the night audit
//
// The night audit is what checks departures out and marks no-shows, exactly as
// it does in production — and checking a reservation out is what fires
// post_reservation_checkout(), so the folio journal, the payment journal and
// the POS journal are all written by the application's own posting logic. No
// journal entry in this demo is inserted by hand.
//
// One consequence is deliberate and worth knowing: the night audit is run as
// the general manager because post_journal() only accepts super_admin,
// hotel_owner, general_manager or accountant. A front-desk checkout silently
// posts nothing (post_reservation_checkout swallows the authorisation error) —
// that is production behaviour this seeder works with, not around.

import { pool } from "../lib/env.mjs";
import { makeRandom, FIRST_NAMES, LAST_NAMES, NATIONALITIES, GH_REGIONS, fakeEmail, fakePhone, fakeAddress, day, daysBetween, atTime } from "../lib/random.mjs";

const HISTORY_DAYS = 86;   // 2026-06-15 → 2026-09-09 when as-of is the default
const FUTURE_DAYS = 41;    // forward book to mid-October
const SOURCES = [
  ["direct", 0.30], ["booking_com", 0.20], ["walk_in", 0.14], ["phone", 0.12],
  ["expedia", 0.10], ["corporate", 0.09], ["airbnb", 0.05],
];
const PAYMENT_METHODS = [
  ["mobile_money", 0.32], ["card", 0.30], ["cash", 0.24], ["bank_transfer", 0.14],
];

function weighted(rand, table) {
  const roll = rand.next();
  let acc = 0;
  for (const [value, weight] of table) {
    acc += weight;
    if (roll <= acc) return value;
  }
  return table[table.length - 1][0];
}

async function insertChunked(client, table, rows, size = 100) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(...(await client.insert(table, rows.slice(i, i + size))));
  }
  return out;
}

export async function run({ ctx, admin, signIn, log }) {
  const pid = ctx.propertyId;
  const rand = makeRandom(20260909);

  const existing = await admin.select("reservations", `select=id&property_id=eq.${pid}&limit=1`);
  if (existing.length && !ctx.allowTransactionalRerun) {
    throw new Error(
      "STOP: this property already has reservations. Rerunning would double the demo's revenue. " +
        "Pass --allow-transactional-rerun only if that is genuinely intended.",
    );
  }

  const start = day(ctx.asOf, -HISTORY_DAYS);
  const futureEnd = day(ctx.asOf, FUTURE_DAYS);
  log(`  · operating window ${start} → ${ctx.asOf} (live) → ${futureEnd} (on the books)`);

  // ── the people doing the work ─────────────────────────────────────────────
  const staff = await loadStaffClients({ ctx, admin, signIn });
  const { frontdesk, reservationsOfficer, cashier, gm, housekeeping } = staff;

  if (ctx.dryRun) {
    log("  · dry run — no operating history written");
    return {};
  }

  // ── reference data ────────────────────────────────────────────────────────
  const roomTypes = await admin.select("room_types", `select=id,code,name,base_rate,max_occupancy&property_id=eq.${pid}`);
  const rooms = await admin.select("rooms", `select=id,number,room_type_id&property_id=eq.${pid}`);
  const idTypes = await admin.select("guest_id_types", "select=id,name");
  const outlets = await admin.select("pos_outlets", `select=id,name,kind,tax_rate&property_id=eq.${pid}`);
  const posTables = await admin.select("pos_tables", `select=id,label,outlet_id&property_id=eq.${pid}`);
  const menuItems = await admin.select("pos_menu_items", `select=id,name,price,outlet_id,inventory_item_id&property_id=eq.${pid}`);
  const stockLocations = await admin.select("stock_locations", `select=id,name,kind&property_id=eq.${pid}`);
  const inventoryItems = await admin.select("inventory_items", `select=id,sku&property_id=eq.${pid}&limit=500`);
  const typeById = new Map(roomTypes.map((t) => [t.id, t]));

  // ── 1. plan every stay, room by room, so no room is ever double-booked ────
  const plan = [];
  for (const room of rooms) {
    const type = typeById.get(room.room_type_id);
    const suite = type.code === "PRE" || type.code === "EXE";
    let cursor = day(start, -rand.int(0, 3));
    while (cursor < futureEnd) {
      cursor = day(cursor, suite ? rand.int(1, 6) : rand.int(0, 3));
      const nights = weighted(rand, [[1, 0.18], [2, 0.28], [3, 0.22], [4, 0.14], [5, 0.09], [6, 0.05], [7, 0.04]]);
      const checkIn = cursor;
      const checkOut = day(cursor, nights);
      if (checkIn >= futureEnd) break;
      plan.push({ room, type, checkIn, checkOut, nights });
      cursor = day(checkOut, 0);
    }
  }
  log(`  · planned ${plan.length} stays across ${rooms.length} rooms`);

  // ── 2. guests ─────────────────────────────────────────────────────────────
  const guestCount = Math.round(plan.length * 0.82);
  const guestRows = [];
  for (let i = 0; i < guestCount; i++) {
    const first = rand.pick(FIRST_NAMES);
    const last = rand.pick(LAST_NAMES);
    const [code, nationality] = rand.pick(NATIONALITIES);
    const [regionCode, regionCapital] = rand.pick(GH_REGIONS);
    const idType = rand.pick(idTypes);
    guestRows.push({
      property_id: pid,
      first_name: first,
      last_name: last,
      email: fakeEmail(first, last, i),
      phone: fakePhone(rand),
      id_type: idType?.name ?? null,
      id_type_id: idType?.id ?? null,
      id_number: `${String(rand.int(100000, 999999))}-${rand.int(10, 99)}`,
      nationality,
      nationality_code: code,
      region_code: code === "GH" ? regionCode : null,
      region_capital: code === "GH" ? regionCapital : null,
      address: fakeAddress(rand),
      vip: rand.chance(0.06),
      notes: rand.chance(0.12) ? rand.pick(["Prefers a high floor.", "Allergic to shellfish.", "Late arrival expected.", "Corporate account guest.", "Anniversary stay."]) : null,
      created_by: frontdesk.userId,
    });
  }
  const guests = await insertChunked(frontdesk, "guests", guestRows, 100);
  log(`  · guests: ${guests.length} created`);

  // ── 3. reservations (all created 'confirmed', as the application does) ────
  const reservationRows = [];
  for (const stay of plan) {
    const guest = guests[rand.int(0, guests.length - 1)];
    const source = weighted(rand, SOURCES);
    // Nightly rate: base, plus a weekend uplift, minus a length-of-stay discount.
    let total = 0;
    for (let n = 0; n < stay.nights; n++) {
      const date = new Date(`${day(stay.checkIn, n)}T00:00:00Z`);
      const weekend = date.getUTCDay() === 5 || date.getUTCDay() === 6;
      let rate = stay.type.base_rate * (weekend ? 1.12 : 1);
      if (stay.nights >= 4) rate *= 0.88;
      if (source === "booking_com" || source === "expedia") rate *= 0.92;
      if (source === "corporate") rate *= 0.85;
      total += Math.round(rate * 100) / 100;
    }
    const leadDays = source === "walk_in" ? 0 : rand.int(1, 45);
    const createdAt = atTime(day(stay.checkIn, -leadDays), rand.int(8, 20), rand.int(0, 59));
    reservationRows.push({
      property_id: pid,
      // gen_reservation_code() fills an empty code with
      // RES-YYMMDD-<5 hex of md5(random())> — only ~1M values, which collides
      // on a run of this size (reported). The seeder therefore supplies its
      // own codes in the identical format, uniquely numbered.
      code: `RES-${createdAt.slice(2, 4)}${createdAt.slice(5, 7)}${createdAt.slice(8, 10)}-${String(reservationRows.length + 1).padStart(5, "0")}`,
      guest_id: guest.id,
      room_type_id: stay.type.id,
      room_id: stay.room.id,
      check_in: stay.checkIn,
      check_out: stay.checkOut,
      adults: Math.min(stay.type.max_occupancy, rand.chance(0.68) ? 2 : rand.int(1, 3)),
      children: rand.chance(0.18) ? rand.int(1, 2) : 0,
      status: "confirmed",
      source,
      rate_total: Math.round(total * 100) / 100,
      notes: rand.chance(0.1) ? rand.pick(["Airport pickup requested.", "Quiet room please.", "Extra bed requested.", "Early check-in requested."]) : null,
      created_by: source === "walk_in" ? frontdesk.userId : reservationsOfficer.userId,
      created_at: createdAt,
      checked_in_at: stay.checkIn <= ctx.asOf ? atTime(stay.checkIn, rand.int(13, 21), rand.int(0, 59)) : null,
      checked_out_at: stay.checkOut <= ctx.asOf ? atTime(stay.checkOut, rand.int(6, 11), rand.int(0, 59)) : null,
      confirmation_code: null,
      confirmation_email: null,
    });
  }
  // Walk-ins are created by the front desk, everything else by reservations.
  const byReservations = reservationRows.filter((r) => r.created_by === reservationsOfficer.userId);
  const byFrontDesk = reservationRows.filter((r) => r.created_by === frontdesk.userId);
  const reservations = [
    ...(await insertChunked(reservationsOfficer, "reservations", byReservations, 100)),
    ...(await insertChunked(frontdesk, "reservations", byFrontDesk, 100)),
  ];
  log(`  · reservations: ${reservations.length} created (${byReservations.length} booked ahead, ${byFrontDesk.length} walk-in)`);

  // ── 4. the room charge on every folio ─────────────────────────────────────
  const charges = reservations.map((r) => ({
    reservation_id: r.id,
    description: `Room charge · ${daysBetween(r.check_in, r.check_out)} night${daysBetween(r.check_in, r.check_out) > 1 ? "s" : ""} · ${typeById.get(r.room_type_id).name}`,
    amount: r.rate_total,
    posted_at: atTime(r.check_in, 15, 0),
    posted_by: frontdesk.userId,
  }));
  await insertChunked(frontdesk, "reservation_charges", charges, 100);
  log(`  · folio room charges: ${charges.length} posted`);

  // ── 5. decide who cancels and who never turns up ──────────────────────────
  const arrivals = new Map();      // date -> [reservation]
  const departures = new Map();    // date -> [reservation]
  const cancellations = new Map(); // date -> [reservation]
  const noShows = new Set();
  for (const r of reservations) {
    if (rand.chance(0.045)) {
      // cancelled a few days before arrival
      const when = day(r.check_in, -rand.int(1, 7));
      if (when >= start && when <= ctx.asOf) {
        (cancellations.get(when) ?? cancellations.set(when, []).get(when)).push(r);
        continue;
      }
    }
    if (r.check_in < ctx.asOf && rand.chance(0.022)) {
      noShows.add(r.id); // left 'confirmed' — the night audit will mark it
      continue;
    }
    (arrivals.get(r.check_in) ?? arrivals.set(r.check_in, []).get(r.check_in)).push(r);
    (departures.get(r.check_out) ?? departures.set(r.check_out, []).get(r.check_out)).push(r);
  }

  // ── 6. replay the operating days ──────────────────────────────────────────
  const restaurant = outlets.find((o) => o.kind === "restaurant");
  const bar = outlets.find((o) => o.kind === "bar");
  const roomService = outlets.find((o) => o.kind === "room_service");
  const menuByOutlet = new Map(outlets.map((o) => [o.id, menuItems.filter((m) => m.outlet_id === o.id)]));
  const tablesByOutlet = new Map(outlets.map((o) => [o.id, posTables.filter((t) => t.outlet_id === o.id)]));

  const outletById = new Map(outlets.map((o) => [o.id, o]));
  const inventoryByMenuItem = new Map(menuItems.filter((m) => m.inventory_item_id).map((m) => [m.id, m.inventory_item_id]));
  const locationByName = new Map(stockLocations.map((l) => [l.name, l.id]));
  // close_pos_order() deducts stock from "any location for the property" (the
  // first one created). The seeder deducts from the store the item actually
  // lives in, so a bar sale never draws a kitchen item out of the bar. The
  // application limitation is reported rather than worked around in the app.
  const itemSkuById = new Map(inventoryItems.map((i) => [i.id, i.sku]));
  const storeForItem = (itemId) => {
    const sku = itemSkuById.get(itemId) ?? "";
    if (sku.startsWith("ALC") || sku.startsWith("BEV")) return locationByName.get("Bar Store");
    if (sku.startsWith("FD")) return locationByName.get("Kitchen Store");
    if (sku.startsWith("HKS") || sku.startsWith("AMN")) return locationByName.get("Housekeeping Store");
    return locationByName.get("Main Store");
  };

  // Folio ledger held in memory: what each stay owes and what it has paid, so
  // settling a departure needs no round trip per reservation.
  const owed = new Map(reservations.map((r) => [r.id, Number(r.rate_total)]));
  const paid = new Map();
  const round2 = (n) => Math.round(n * 100) / 100;

  const stockDelta = new Map();

  let posSequence = 0;
  let posOrders = 0;
  let posClosed = 0;
  let paymentsPosted = 0;
  let audits = 0;
  const inHouseByDate = (date) =>
    reservations.filter((r) => r.check_in <= date && r.check_out > date && !noShows.has(r.id));

  for (let i = 0; i <= HISTORY_DAYS; i++) {
    const date = day(start, i);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();

    // cancellations first — they must never look checked in
    const cancelled = cancellations.get(date) ?? [];
    if (cancelled.length) {
      await reservationsOfficer.update(
        "reservations",
        `id=in.(${cancelled.map((r) => r.id).join(",")})`,
        { status: "cancelled" },
      );
    }

    // arrivals
    const arriving = (arrivals.get(date) ?? []).filter((r) => r.check_in === date);
    for (let c = 0; c < arriving.length; c += 40) {
      const slice = arriving.slice(c, c + 40);
      await frontdesk.update("reservations", `id=in.(${slice.map((r) => r.id).join(",")})`, { status: "checked_in" });
    }

    // POS trade for the day
    const inHouse = inHouseByDate(date);
    const orderCount = Math.round((dow === 5 || dow === 6 ? 11 : 7) * (0.7 + rand.next() * 0.7));
    const orderPlans = [];
    for (let o = 0; o < orderCount; o++) {
      const outlet = weighted(rand, [[restaurant.id, 0.52], [bar.id, 0.33], [roomService.id, 0.15]]);
      const menu = menuByOutlet.get(outlet);
      if (!menu?.length) continue;
      const lines = rand.picks(menu, rand.int(1, 4)).map((m) => ({
        menu_item_id: m.id,
        name_snapshot: m.name,
        price_snapshot: m.price,
        quantity: rand.chance(0.75) ? 1 : rand.int(2, 3),
      }));
      const resident = outlet === roomService.id || rand.chance(0.35) ? inHouse[rand.int(0, Math.max(0, inHouse.length - 1))] : null;
      const tables = tablesByOutlet.get(outlet) ?? [];
      orderPlans.push({
        outlet,
        lines,
        resident,
        table: outlet === roomService.id || !tables.length ? null : rand.pick(tables),
        hour: outlet === bar.id ? rand.int(17, 23) : rand.chance(0.4) ? rand.int(7, 10) : rand.int(12, 21),
        // A few in-house orders are charged to the room instead of paid at the outlet.
        toFolio: outlet === roomService.id && resident && rand.chance(0.35),
        method: weighted(rand, PAYMENT_METHODS),
        leaveOpen: date === ctx.asOf && rand.chance(0.3),
      });
    }

    await pool(orderPlans, 6, async (p) => {
      const openedAt = atTime(date, p.hour, rand.int(0, 59));
      const [order] = await cashier.insert("pos_orders", [{
        property_id: pid,
        outlet_id: p.outlet,
        table_id: p.table?.id ?? null,
        // Same collision-prone generator as reservations — supplied explicitly.
        code: `ORD-${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}-${String(++posSequence).padStart(5, "0")}`,
        status: "open",
        guest_name: p.resident ? null : rand.pick(["Walk-in guest", "Table booking", "Corporate lunch", "Bar guest"]),
        opened_at: openedAt,
        created_by: cashier.userId,
        created_at: openedAt,
      }]);
      posOrders++;
      await cashier.insert(
        "pos_order_items",
        p.lines.map((l) => ({ ...l, order_id: order.id, created_at: openedAt })),
      );
      if (p.table) await cashier.update("pos_tables", `id=eq.${p.table.id}`, { status: "occupied" });
      if (p.leaveOpen) return;

      const subtotal = round2(p.lines.reduce((sum, l) => sum + l.price_snapshot * l.quantity, 0));
      const taxRate = Number(outletById.get(p.outlet)?.tax_rate ?? 0);
      const tax = round2((subtotal * taxRate) / 100);
      const total = round2(subtotal + tax);
      const closedAt = atTime(date, Math.min(23, p.hour + 1), rand.int(0, 59));

      // Stock consumption — the same movement close_pos_order() makes through
      // apply_stock_delta(). That helper carries no EXECUTE grant for
      // 'authenticated' (it is only ever called from inside SECURITY DEFINER
      // functions), so the deltas are accumulated here and written to
      // item_stock in one pass at the end of the stage, which also avoids a
      // lost update between concurrent orders.
      for (const line of p.lines) {
        const itemId = inventoryByMenuItem.get(line.menu_item_id);
        const locationId = itemId ? storeForItem(itemId) : null;
        if (!itemId || !locationId) continue;
        const key = itemId + "|" + locationId;
        stockDelta.set(key, (stockDelta.get(key) ?? 0) - line.quantity);
      }

      let folioChargeId = null;
      if (p.toFolio && p.resident) {
        const [charge] = await cashier.insert("reservation_charges", [{
          reservation_id: p.resident.id,
          description: `POS ${order.code}`,
          amount: total,
          posted_at: closedAt,
          posted_by: cashier.userId,
        }]);
        folioChargeId = charge.id;
        owed.set(p.resident.id, (owed.get(p.resident.id) ?? 0) + total);
      }

      await cashier.insert("pos_payments", [{
        order_id: order.id,
        method: p.toFolio ? "other" : p.method,
        amount: total,
        reference: null,
        folio_charge_id: folioChargeId,
        received_by: cashier.userId,
        received_at: closedAt,
      }]);

      // The general manager closes the till. Closing the order is what fires
      // tg_autopost_pos → post_pos_order_close → post_journal, and post_journal
      // accepts only super_admin/hotel_owner/general_manager/accountant — a
      // cashier closing an order posts no revenue at all (reported separately).
      // closed_at is set in the same statement so the journal entry lands on
      // the business date rather than the date the seeder ran.
      await gm.update("pos_orders", `id=eq.${order.id}`, {
        subtotal,
        tax,
        total,
        status: "closed",
        closed_at: closedAt,
        reservation_id: p.toFolio && p.resident ? p.resident.id : null,
      });
      if (p.table) await cashier.update("pos_tables", `id=eq.${p.table.id}`, { status: "free" });
      posClosed++;
    });

    // departures settle their folio before the night audit runs
    const leaving = (departures.get(date) ?? []).filter((r) => !noShows.has(r.id));
    if (leaving.length) {
      const paymentRows = [];
      for (const r of leaving) {
        const due = round2((owed.get(r.id) ?? Number(r.rate_total)) - (paid.get(r.id) ?? 0));
        if (due <= 0.005) continue;
        paymentRows.push({
          reservation_id: r.id,
          method: weighted(rand, PAYMENT_METHODS),
          amount: due,
          reference: `FOLIO-${r.id.slice(0, 8).toUpperCase()}`,
          received_by: cashier.userId,
          received_at: atTime(date, rand.int(6, 11), rand.int(0, 59)),
        });
        paid.set(r.id, (paid.get(r.id) ?? 0) + due);
      }
      for (let c = 0; c < paymentRows.length; c += 25) {
        await cashier.insert("payments", paymentRows.slice(c, c + 25));
      }
      paymentsPosted += paymentRows.length;
    }

    // deposits taken on bookings made today for a future stay
    const bookedToday = reservations.filter(
      (r) => r.created_at.slice(0, 10) === date && r.check_in > date && !noShows.has(r.id) && rand.chance(0.45),
    );
    if (bookedToday.length) {
      const deposits = bookedToday.map((r) => {
        const amount = round2(Number(r.rate_total) * 0.3);
        paid.set(r.id, (paid.get(r.id) ?? 0) + amount);
        return {
          reservation_id: r.id,
          method: weighted(rand, PAYMENT_METHODS),
          amount,
          reference: `DEP-${r.id.slice(0, 8).toUpperCase()}`,
          received_by: cashier.userId,
          received_at: atTime(date, rand.int(9, 18), rand.int(0, 59)),
        };
      });
      for (let c = 0; c < deposits.length; c += 25) await cashier.insert("payments", deposits.slice(c, c + 25));
      paymentsPosted += deposits.length;
    }

    // the night audit closes the day: departures out, no-shows marked, metrics
    const audit = await gm.tryRpc("run_night_audit", { _property_id: pid, _business_date: date, _lock_period: false });
    if (audit.ok) audits++;
    else if (i % 20 === 0) log(`  ! night audit ${date}: ${JSON.stringify(audit.body).slice(0, 160)}`);

    if (i % 20 === 0) log(`    ${date}: ${inHouse.length} in house, ${orderPlans.length} POS orders, ${leaving.length} departures`);
  }
  log(`  · POS: ${posOrders} orders opened, ${posClosed} closed and posted`);
  log(`  · payments: ${paymentsPosted} taken`);
  log(`  · night audits: ${audits} of ${HISTORY_DAYS + 1} business dates`);

  // ── 6b. write back the stock consumed by POS sales ────────────────────────
  if (stockDelta.size) {
    const stockRows = await gm.select("item_stock", `select=id,item_id,location_id,quantity&property_id=eq.${pid}`);
    const byKey = new Map(stockRows.map((r) => [`${r.item_id}|${r.location_id}`, r]));
    let moved = 0;
    for (const [key, delta] of stockDelta) {
      const [itemId, locationId] = key.split("|");
      const current = byKey.get(key);
      if (current) {
        await gm.update("item_stock", `id=eq.${current.id}`, { quantity: round2(Number(current.quantity) + delta) });
      } else {
        await gm.insert("item_stock", [{ property_id: pid, item_id: itemId, location_id: locationId, quantity: round2(delta) }]);
      }
      moved++;
    }
    log(`  · stock: ${moved} item/location balances updated for POS consumption`);
  }

  // ── 7. room and housekeeping state for "now" ──────────────────────────────
  const occupiedRoomIds = new Set(inHouseByDate(ctx.asOf).map((r) => r.room_id));
  const departedToday = new Set((departures.get(ctx.asOf) ?? []).map((r) => r.room_id));
  for (const room of rooms) {
    const occupied = occupiedRoomIds.has(room.id);
    const hk = occupied
      ? rand.chance(0.25) ? "dirty" : "clean"
      : departedToday.has(room.id)
        ? "dirty"
        : rand.chance(0.2) ? "inspected" : "clean";
    await housekeeping.update("rooms", `id=eq.${room.id}`, {
      status: occupied ? "occupied" : "available",
      housekeeping_status: hk,
    });
  }
  // one room genuinely out of service, so the maintenance state is visible
  const outOfOrder = rooms.find((r) => !occupiedRoomIds.has(r.id));
  if (outOfOrder) {
    await housekeeping.update("rooms", `id=eq.${outOfOrder.id}`, {
      status: "out_of_order",
      housekeeping_status: "maintenance",
      notes: "Air-conditioning unit awaiting replacement compressor (job #IGH-1184).",
    });
  }
  log(`  · rooms: ${occupiedRoomIds.size} occupied, 1 out of order, remainder available`);

  return { state: { reservations, guests, staff } };
}

export async function loadStaffClients({ ctx, admin, signIn }) {
  const file = process.env.DEMO_CREDENTIAL_FILE;
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(file, "utf8");
  const creds = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/identifier:\s*(\S+)\s+password:\s*(\S+)/);
    if (m) creds.set(m[1], m[2]);
  }
  const domain = process.env.DEMO_ACCOUNTS_EMAIL_DOMAIN ?? "accounts.infinitygrand.invalid";
  const emailFor = (identifier) => `${identifier.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, ".")}@${domain}`;
  const open = async (identifier) => {
    const password = creds.get(identifier);
    if (!password) throw new Error(`STOP: no stored password for ${identifier} — run the users stage first`);
    return signIn(emailFor(identifier), password, identifier);
  };
  return {
    admin,
    gm: await open("gm.demo"),
    hr: await open("hr.demo"),
    accountant: await open("accounts.demo"),
    frontdesk: await open("frontdesk.demo"),
    reservationsOfficer: await open("reservations.demo"),
    cashier: await open("cashier.demo"),
    restaurant: await open("restaurant.demo"),
    waiter: await open("waiter.demo"),
    housekeeping: await open("housekeeping.demo"),
    stores: await open("stores.demo"),
  };
}
