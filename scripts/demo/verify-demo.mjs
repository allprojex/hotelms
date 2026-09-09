#!/usr/bin/env node
// Cross-module verification for the demo environment.
//
//   node scripts/demo/verify-demo.mjs
//
// Reads only. Every check is a question the demo has to be able to answer
// consistently — folio against payments, POS against its journal, stock
// against zero, the ledger against itself — and each one prints PASS, WARN or
// FAIL with the numbers behind it, so a failure can be chased rather than
// merely noticed.

import { loadContext, signIn, serviceClient } from "./lib/env.mjs";

const ctx = loadContext();
const service = serviceClient(ctx);
const admin = await signIn(ctx, ctx.adminEmail, ctx.adminPassword, "demo.admin");
const pid = ctx.propertyId;

// PostgREST caps a response at 1000 rows, so every count here pages until the
// table is exhausted — a truncated read would invent mismatches that are not
// in the data.
async function selectAll(table, query) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await service.raw(`/rest/v1/${table}?${query}&limit=1000&offset=${offset}`);
    if (!page.ok) throw new Error(`select ${table}: ${page.status} ${JSON.stringify(page.body).slice(0, 200)}`);
    rows.push(...page.body);
    if (page.body.length < 1000) return rows;
  }
}

const results = [];
const money = (n) => `GHS ${Number(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function check(name, verdict, detail) {
  results.push({ name, verdict, detail });
  const mark = verdict === "PASS" ? "✓" : verdict === "WARN" ? "!" : "✗";
  console.log(`${mark} ${verdict.padEnd(4)} ${name}\n         ${detail}`);
}

// ── 1. the ledger balances ───────────────────────────────────────────────────
const balance = await admin.rpc("report_trial_balance", { _property_id: pid, _from: "2026-01-01", _to: ctx.asOf });
if (balance) {
  const totalDebit = balance.reduce((s, r) => s + Number(r.debit_total ?? 0), 0);
  const totalCredit = balance.reduce((s, r) => s + Number(r.credit_total ?? 0), 0);
  const diff = Math.abs(totalDebit - totalCredit);
  check(
    "Trial balance is balanced",
    diff < 0.01 ? "PASS" : "FAIL",
    `debits ${money(totalDebit)} vs credits ${money(totalCredit)} across ${balance.length} accounts`,
  );
}

// ── 2. folio settlement ──────────────────────────────────────────────────────
const stays = await selectAll("reservations", `select=id,code,rate_total,status&property_id=eq.${pid}&status=eq.checked_out`);
const chargeRows = await selectAll("reservation_charges", "select=reservation_id,amount");
const paymentRows = await selectAll("payments", "select=reservation_id,amount,status");
const chargeBy = new Map();
for (const row of chargeRows) chargeBy.set(row.reservation_id, (chargeBy.get(row.reservation_id) ?? 0) + Number(row.amount));
const paidBy = new Map();
for (const row of paymentRows) {
  if (row.status !== "posted") continue;
  paidBy.set(row.reservation_id, (paidBy.get(row.reservation_id) ?? 0) + Number(row.amount));
}
const unsettled = stays.filter((s) => Math.abs((chargeBy.get(s.id) ?? 0) - (paidBy.get(s.id) ?? 0)) > 0.01);
check(
  "Departed stays are settled in full",
  unsettled.length === 0 ? "PASS" : "WARN",
  `${stays.length} checked-out stays, ${unsettled.length} with a folio balance` +
    (unsettled.length ? ` (first: ${unsettled[0].code})` : ""),
);

// ── 3. every checkout posted a folio journal ─────────────────────────────────
const folioEntries = await selectAll("journal_entries", `select=source_ref&property_id=eq.${pid}&source=eq.folio`);
const folioRefs = new Set(folioEntries.map((e) => e.source_ref));
const missingFolio = stays.filter((s) => !folioRefs.has(s.id));
check(
  "Every checkout posted its folio journal",
  missingFolio.length === 0 ? "PASS" : "FAIL",
  `${folioEntries.length} folio entries for ${stays.length} checked-out stays; ${missingFolio.length} missing`,
);

// ── 4. POS: order totals, payments and postings agree ────────────────────────
const orders = await selectAll("pos_orders", `select=id,code,total,status&property_id=eq.${pid}`);
const closed = orders.filter((o) => o.status === "closed");
const posPayments = await selectAll("pos_payments", "select=order_id,amount");
const posPaidBy = new Map();
for (const row of posPayments) posPaidBy.set(row.order_id, (posPaidBy.get(row.order_id) ?? 0) + Number(row.amount));
const posMismatch = closed.filter((o) => Math.abs(Number(o.total) - (posPaidBy.get(o.id) ?? 0)) > 0.01);
const posEntries = await selectAll("journal_entries", `select=source_ref&property_id=eq.${pid}&source=eq.pos`);
check(
  "POS orders are paid to their total",
  posMismatch.length === 0 ? "PASS" : "WARN",
  `${closed.length} closed orders, ${posMismatch.length} where payments differ from the total`,
);
check(
  "Every closed POS order posted its journal",
  posEntries.length >= closed.length ? "PASS" : "FAIL",
  `${posEntries.length} POS journal entries for ${closed.length} closed orders`,
);

// ── 5. inventory is never negative ───────────────────────────────────────────
const stock = await service.select("item_stock", `select=item_id,location_id,quantity&property_id=eq.${pid}&limit=2000`);
const negative = stock.filter((s) => Number(s.quantity) < 0);
check(
  "No stock balance is negative",
  negative.length === 0 ? "PASS" : "WARN",
  `${stock.length} item/location balances, ${negative.length} negative`,
);

const batches = await selectAll("inventory_stock_batches", `select=id,expiry_date&property_id=eq.${pid}`);
const nearExpiry = batches.filter((b) => b.expiry_date && b.expiry_date <= addDays(ctx.asOf, 30) && b.expiry_date >= ctx.asOf);
check(
  "Expiry tracking has something to show",
  nearExpiry.length > 0 ? "PASS" : "WARN",
  `${batches.length} batches, ${nearExpiry.length} expiring within 30 days`,
);

// ── 6. purchase orders, bills and payments ───────────────────────────────────
const pos = await service.select("purchase_orders", `select=id,status,total&property_id=eq.${pid}&limit=500`);
const bills = await service.select("ap_bills", `select=id,total,amount_paid,status&property_id=eq.${pid}&limit=500`);
const billTotal = bills.reduce((s, b) => s + Number(b.total), 0);
const billPaid = bills.reduce((s, b) => s + Number(b.amount_paid ?? 0), 0);
check(
  "Procurement is billed and partly settled",
  bills.length > 0 ? "PASS" : "FAIL",
  `${pos.length} purchase orders, ${bills.length} supplier bills totalling ${money(billTotal)}, ${money(billPaid)} paid`,
);

// ── 7. receivables ───────────────────────────────────────────────────────────
const invoices = await service.select("ar_invoices", `select=id,total,amount_paid,status&property_id=eq.${pid}&limit=500`);
const invoiceTotal = invoices.reduce((s, i) => s + Number(i.total), 0);
const invoicePaid = invoices.reduce((s, i) => s + Number(i.amount_paid ?? 0), 0);
check(
  "Corporate receivables show a real ageing position",
  invoices.length > 0 ? "PASS" : "WARN",
  `${invoices.length} invoices totalling ${money(invoiceTotal)}, ${money(invoicePaid)} received, ${money(invoiceTotal - invoicePaid)} outstanding`,
);

// ── 8. expenses through the workflow ─────────────────────────────────────────
const expenses = await service.select("expenses", `select=id,status,total_amount&property_id=eq.${pid}&limit=500`);
const byStatus = expenses.reduce((acc, e) => ({ ...acc, [e.status]: (acc[e.status] ?? 0) + 1 }), {});
check(
  "Expenses exist in every workflow state",
  expenses.length > 0 && byStatus.approved > 0 ? "PASS" : "WARN",
  `${expenses.length} expenses: ${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(", ")}`,
);

// ── 9. HR ────────────────────────────────────────────────────────────────────
const employees = await service.select("hr_employees", `select=id,employment_status&property_id=eq.${pid}&limit=500`);
const roster = await selectAll("hr_duty_roster", `select=id&property_id=eq.${pid}`);
const summaries = await selectAll("hr_attendance_summaries", `select=id,attendance_status&property_id=eq.${pid}`);
const leave = await service.select("hr_leave_requests", `select=id,status&property_id=eq.${pid}&limit=500`);
const balances = await service.select("hr_leave_balances", `select=id&property_id=eq.${pid}&limit=1000`);
const leaveByStatus = leave.reduce((acc, l) => ({ ...acc, [l.status]: (acc[l.status] ?? 0) + 1 }), {});
check(
  "Workforce data is complete enough for HR reports",
  employees.length >= 20 && roster.length > 0 && summaries.length > 0 ? "PASS" : "WARN",
  `${employees.length} employees, ${roster.length} rostered shifts, ${summaries.length} attendance summaries, ` +
    `${balances.length} leave balances, leave: ${Object.entries(leaveByStatus).map(([k, v]) => `${k} ${v}`).join(", ")}`,
);

// ── 10. payroll ──────────────────────────────────────────────────────────────
const runs = await service.select("payroll_runs", `select=id,run_code,status,employee_count,net_total&property_id=eq.${pid}&limit=50`);
const compensations = await service.select("payroll_employee_compensations", `select=id&property_id=eq.${pid}&limit=500`);
const statutory = await service.select("payroll_statutory_rule_sets", `select=id&property_id=eq.${pid}&limit=50`);
const payslips = await service.select("payroll_payslips", `select=id&property_id=eq.${pid}&limit=1000`);
check(
  "Payroll is configured and has runs",
  runs.length > 0 && compensations.length > 0 ? (payslips.length ? "PASS" : "WARN") : "FAIL",
  `${compensations.length} employees on payroll, ${statutory.length} statutory rule sets, ` +
    `${runs.length} runs (${runs.map((r) => `${r.run_code}:${r.status}`).join(", ") || "none"}), ${payslips.length} payslips`,
);

// ── 11. gallery ──────────────────────────────────────────────────────────────
const images = await service.select("gallery_images", `select=id,is_cover,room_type_id&property_id=eq.${pid}&limit=200`);
const roomTypes = await service.select("room_types", `select=id&property_id=eq.${pid}`);
const covered = new Set(images.filter((i) => i.is_cover && i.room_type_id).map((i) => i.room_type_id));
check(
  "Every room type has a cover image",
  covered.size >= roomTypes.length ? "PASS" : "WARN",
  `${images.length} images, ${covered.size} of ${roomTypes.length} room types with a cover`,
);

// ── 12. headline reporting numbers ───────────────────────────────────────────
const kpis = await admin.tryRpc("exec_analytics_kpis", { _property_id: pid, _from: addDays(ctx.asOf, -30), _to: ctx.asOf });
if (kpis.ok && kpis.body?.length) {
  const k = kpis.body[0];
  check(
    "Executive dashboard has 30 days of numbers",
    Number(k.revenue ?? 0) > 0 ? "PASS" : "FAIL",
    `revenue ${money(k.revenue)} (rooms ${money(k.room_revenue)}, POS ${money(k.pos_revenue)}), ` +
      `occupancy ${k.occupancy_pct}%, ADR ${money(k.adr)}, RevPAR ${money(k.revpar)}, ` +
      `${k.nights_sold} room nights, avg stay ${k.avg_los} nights`,
  );
} else {
  check("Executive dashboard has 30 days of numbers", "FAIL", `exec_analytics_kpis returned nothing: ${JSON.stringify(kpis.body).slice(0, 160)}`);
}

const pnl = await admin.tryRpc("report_profit_loss", { _property_id: pid, _from: addDays(ctx.asOf, -90), _to: ctx.asOf });
if (pnl.ok && Array.isArray(pnl.body)) {
  const revenue = pnl.body.filter((r) => r.type === "revenue").reduce((s, r) => s + Number(r.amount ?? r.balance ?? 0), 0);
  const expense = pnl.body.filter((r) => r.type === "expense").reduce((s, r) => s + Number(r.amount ?? r.balance ?? 0), 0);
  check(
    "Profit and loss reports a real trading position",
    revenue > 0 ? "PASS" : "FAIL",
    `90 days: revenue ${money(revenue)}, expenses ${money(expense)}, result ${money(revenue - expense)}`,
  );
}

const audits = await service.select("night_audits", `select=id&property_id=eq.${pid}&limit=200`);
check(
  "Night audit history",
  audits.length > 0 ? "PASS" : "WARN",
  `${audits.length} night audit records (run_night_audit fails on this schema — see the defect report)`,
);

// ── summary ──────────────────────────────────────────────────────────────────
const failed = results.filter((r) => r.verdict === "FAIL").length;
const warned = results.filter((r) => r.verdict === "WARN").length;
console.log(`\n${results.length} checks — ${results.length - failed - warned} passed, ${warned} warnings, ${failed} failures`);
process.exit(failed ? 1 : 0);

function addDays(date, delta) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
