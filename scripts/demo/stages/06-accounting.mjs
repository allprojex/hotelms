// Stage 6 — procurement, expenses and the receivable/payable ledgers.
//
// Everything here runs through the application's own RPCs, in the same order
// the screens call them and as the role that is actually allowed to:
//
//   general manager   raises purchase orders and receives them
//                     (receive_purchase_order, apply_adjustment,
//                      execute_transfer — the storekeeper role has no write
//                      access to inventory anywhere in this schema, reported)
//   accountant        bills, pays, invoices, receipts and expenses
//                     (create_ap_bill/post_ap_bill, create_ar_invoice/
//                      post_ar_invoice, post_ar_receipt, expense_*)
//
// Every journal entry is written by those functions, never by this file.

import { randomUUID } from "node:crypto";
import { makeRandom, day, atTime } from "../lib/random.mjs";
import { simpleReceiptPdf } from "../lib/receipt-pdf.mjs";
import { loadStaffClients } from "./04-operations.mjs";

const PO_WEEKS = 12;

const AR_CUSTOMERS = [
  { account_code: "AR-001", name: "Ridge Energy Ghana Ltd", email: "accounts@ridgeenergy.example", phone: "+233 30 000 2101", address: "5 Independence Avenue, Accra" },
  { account_code: "AR-002", name: "Sankofa Travel & Tours", email: "finance@sankofatours.example", phone: "+233 30 000 2102", address: "22 Oxford Street, Osu, Accra" },
  { account_code: "AR-003", name: "West Coast Telecom", email: "payables@westcoasttelecom.example", phone: "+233 30 000 2103", address: "Airport City, Accra" },
  { account_code: "AR-004", name: "Volta Development Partners", email: "admin@voltadevelopment.example", phone: "+233 30 000 2104", address: "14 Liberation Road, Accra" },
];

const EXPENSE_NARRATIVES = {
  "EXP-UTIL": ["Monthly ECG electricity bill", "Ghana Water Company invoice", "Generator diesel top-up", "Standby generator servicing fuel"],
  "EXP-MAINT": ["Guest lift annual service", "Room 214 plumbing repair", "Kitchen extractor fan repair", "Pool pump replacement"],
  "EXP-SUPPL": ["Guest amenity restock", "Replacement bath linen", "Housekeeping trolley consumables", "In-room stationery restock"],
  "EXP-MKT": ["Online travel agent listing fees", "Corporate rate card printing", "Social media campaign — Independence weekend", "Trade show stand, Accra Hospitality Expo"],
  "EXP-TRAN": ["Airport shuttle fuel", "Staff bus monthly fuel", "Vehicle insurance instalment", "Shuttle tyre replacement"],
  "EXP-PROF": ["Quarterly external audit fee", "Legal retainer", "Payroll advisory fee"],
  "EXP-TRAIN": ["Food safety certification — kitchen team", "Front office upselling workshop", "First aid refresher"],
  "EXP-LIC": ["Ghana Tourism Authority licence renewal", "Liquor licence renewal", "Fire safety certificate"],
};

export async function run({ ctx, admin, signIn, log }) {
  const pid = ctx.propertyId;
  const rand = makeRandom(20260910);
  const { gm, accountant } = await loadStaffClients({ ctx, admin, signIn });

  if (ctx.dryRun) {
    log(`  · would raise ${PO_WEEKS} purchase orders, bill and pay them, post ~45 expenses and ${AR_CUSTOMERS.length} corporate accounts`);
    return {};
  }

  const guard = await admin.select("purchase_orders", `select=id&property_id=eq.${pid}&limit=1`);
  const skipProcurement = guard.length > 0;
  if (skipProcurement) log("  · procurement history already present — leaving it alone and continuing with expenses and receivables");

  const suppliers = await admin.select("suppliers", `select=id,name,vendor_code&property_id=eq.${pid}`);
  const locations = await admin.select("stock_locations", `select=id,name&property_id=eq.${pid}`);
  const items = await admin.select("inventory_items", `select=id,sku,name,cost,category_id&property_id=eq.${pid}`);
  const categories = await admin.select("expense_categories", `select=id,code,name&property_id=eq.${pid}`);
  const centres = await admin.select("cost_centres", `select=id,code,name&property_id=eq.${pid}`);
  const locationByName = new Map(locations.map((l) => [l.name, l.id]));

  // Which supplier sells what, so a bill's contents make sense.
  const supplierFor = (sku) => {
    if (sku.startsWith("ALC") || sku.startsWith("BEV")) return suppliers.find((s) => s.vendor_code === "SUP-002");
    if (sku.startsWith("FDF")) return suppliers.find((s) => s.vendor_code === "SUP-005");
    if (sku.startsWith("FDD")) return suppliers.find((s) => s.vendor_code === "SUP-001");
    if (sku.startsWith("HKS")) return suppliers.find((s) => s.vendor_code === "SUP-003");
    if (sku.startsWith("AMN")) return suppliers.find((s) => s.vendor_code === "SUP-004");
    return suppliers.find((s) => s.vendor_code === "SUP-006");
  };
  const locationFor = (sku) =>
    sku.startsWith("ALC") || sku.startsWith("BEV")
      ? locationByName.get("Bar Store")
      : sku.startsWith("FD")
        ? locationByName.get("Kitchen Store")
        : sku.startsWith("HKS") || sku.startsWith("AMN")
          ? locationByName.get("Housekeeping Store")
          : locationByName.get("Main Store");
  const shelfLife = (sku) => (sku.startsWith("FDF") ? rand.int(4, 21) : sku.startsWith("FDD") || sku.startsWith("BEV") ? rand.int(120, 400) : null);

  // ── A. weekly purchase orders, received into stock, then billed ───────────
  let posRaised = 0;
  let received = 0;
  let bills = 0;
  let billPayments = 0;
  for (let w = skipProcurement ? 0 : PO_WEEKS; w >= 1; w--) {
    const orderedOn = day(ctx.asOf, -w * 7);
    // two orders a week: one for the kitchen/bar, one for everything else
    for (const group of [["FDF", "FDD", "BEV", "ALC"], ["HKS", "AMN", "MNT", "STA"]]) {
      const pool = items.filter((i) => group.some((p) => i.sku.startsWith(p)));
      const chosen = rand.picks(pool, rand.int(4, 8));
      if (!chosen.length) continue;
      const supplier = supplierFor(chosen[0].sku);
      const locationId = locationFor(chosen[0].sku);
      const lines = chosen.map((item) => ({
        item,
        quantity: rand.int(6, 40),
        unit_cost: Math.round(Number(item.cost) * (0.96 + rand.next() * 0.12) * 100) / 100,
      }));
      const total = Math.round(lines.reduce((s, l) => s + l.quantity * l.unit_cost, 0) * 100) / 100;

      const [po] = await gm.insert("purchase_orders", [{
        property_id: pid,
        supplier_id: supplier.id,
        location_id: locationId,
        code: `PO-${orderedOn.slice(2, 4)}${orderedOn.slice(5, 7)}${orderedOn.slice(8, 10)}-${String(++posRaised).padStart(4, "0")}`,
        status: "sent",
        ordered_at: atTime(orderedOn, 9, rand.int(0, 59)),
        expected_at: day(orderedOn, 3),
        total,
        notes: `Weekly replenishment — ${supplier.name}`,
        created_by: gm.userId,
        created_at: atTime(orderedOn, 9, rand.int(0, 59)),
      }]);
      const poLines = await gm.insert(
        "purchase_order_lines",
        lines.map((l) => ({ po_id: po.id, item_id: l.item.id, quantity: l.quantity, unit_cost: l.unit_cost, received_qty: 0 })),
      );

      // Receive it two to four days later, with expiry dates for perishables.
      const receivedOn = day(orderedOn, rand.int(2, 4));
      if (receivedOn <= ctx.asOf) {
        const expiry = {};
        for (const line of poLines) {
          const item = items.find((i) => i.id === line.item_id);
          const life = shelfLife(item.sku);
          if (life) expiry[line.id] = day(receivedOn, life);
        }
        const r = await gm.tryRpc("receive_purchase_order", { _po_id: po.id, _line_expiry: expiry });
        if (r.ok) {
          received++;
          await gm.update("purchase_orders", `id=eq.${po.id}`, { status: "received", received_at: atTime(receivedOn, 11, rand.int(0, 59)) });
        } else {
          log(`  ! receive PO ${po.code}: ${JSON.stringify(r.body).slice(0, 180)}`);
        }

        // The accountant bills it against the supplier.
        const bill = await accountant.rpc("create_ap_bill", {
          _property_id: pid,
          _supplier_id: supplier.id,
          _supplier_name: supplier.name,
          _reference: po.code,
          _bill_date: receivedOn,
          _due_date: day(receivedOn, 30),
          _currency: "GHS",
          _notes: `Goods received against ${po.code}`,
          _lines: lines.map((l) => ({
            description: `${l.item.name} × ${l.quantity}`,
            quantity: l.quantity,
            unit_price: l.unit_cost,
            tax_rate: 0,
          })),
        });
        const billId = typeof bill === "string" ? bill : bill?.id ?? bill;
        await accountant.rpc("post_ap_bill", { _id: billId });
        bills++;

        // Most bills are settled inside the demo window; the rest stay open
        // so the AP ageing report has something in it.
        if (w > 2 && rand.chance(0.75)) {
          const paidOn = day(receivedOn, rand.int(10, 28));
          if (paidOn <= ctx.asOf) {
            await accountant.insert("ap_payments", [{
              property_id: pid,
              bill_id: billId,
              paid_at: atTime(paidOn, 14, rand.int(0, 59)),
              amount: total,
              method: rand.pick(["bank_transfer", "mobile_money", "cash"]),
              reference: `AP-${po.code}`,
              created_by: accountant.userId,
            }]);
            billPayments++;
          }
        }
      }
    }
  }
  log(`  · purchase orders: ${posRaised} raised, ${received} received into stock`);
  log(`  · supplier bills: ${bills} posted, ${billPayments} paid`);

  // ── B. stock adjustments, a transfer and an expiry correction ─────────────
  const mainStore = locationByName.get("Main Store");
  const kitchen = locationByName.get("Kitchen Store");
  let adjustments = 0;
  for (const [reason, note, pick] of skipProcurement ? [] : [
    ["Monthly stock count variance", "Cycle count — kitchen dry goods", ["FDD", "FDF"]],
    ["Breakage", "Glassware and bottle breakage written off", ["ALC", "BEV"]],
    ["Damaged in storage", "Water damage in the housekeeping store", ["HKS", "AMN"]],
  ]) {
    const chosen = rand.picks(items.filter((i) => pick.some((p) => i.sku.startsWith(p))), 3);
    if (!chosen.length) continue;
    const adjustedOn = day(ctx.asOf, -rand.int(5, 60));
    const [adj] = await gm.insert("stock_adjustments", [{
      property_id: pid,
      location_id: locationFor(chosen[0].sku) ?? mainStore,
      code: `ADJ-${adjustedOn.slice(2, 4)}${adjustedOn.slice(5, 7)}${adjustedOn.slice(8, 10)}-${String(++adjustments).padStart(3, "0")}`,
      reason,
      notes: note,
      // adjusted_at is apply_adjustment()'s "already applied" marker, not a
      // date to supply: setting it here would make the RPC a silent no-op and
      // the stock would never move. It is stamped after the RPC instead.
      adjusted_at: null,
      created_by: gm.userId,
    }]);
    await gm.insert("stock_adjustment_lines", chosen.map((i) => ({ adjustment_id: adj.id, item_id: i.id, delta: -rand.int(1, 6) })));
    const applied = await gm.tryRpc("apply_adjustment", { _id: adj.id });
    if (!applied.ok) log(`  ! apply_adjustment: ${JSON.stringify(applied.body).slice(0, 160)}`);
    else await gm.update("stock_adjustments", `id=eq.${adj.id}`, { adjusted_at: atTime(adjustedOn, 16, 0) });
  }
  log(`  · stock adjustments: ${adjustments} raised and applied`);

  const transferItems = skipProcurement ? [] : rand.picks(items.filter((i) => i.sku.startsWith("BEV")), 2);
  if (transferItems.length && mainStore && kitchen) {
    const movedOn = day(ctx.asOf, -9);
    const [transfer] = await gm.insert("stock_transfers", [{
      property_id: pid,
      from_location_id: locationByName.get("Bar Store"),
      to_location_id: kitchen,
      code: `TRF-${movedOn.slice(2, 4)}${movedOn.slice(5, 7)}${movedOn.slice(8, 10)}-001`,
      status: "draft",
      transferred_at: atTime(movedOn, 10, 0),
      notes: "Soft drinks moved to the kitchen store for banqueting",
      created_by: gm.userId,
    }]);
    await gm.insert("stock_transfer_lines", transferItems.map((i) => ({ transfer_id: transfer.id, item_id: i.id, quantity: rand.int(6, 24) })));
    const done = await gm.tryRpc("execute_transfer", { _id: transfer.id });
    log(done.ok ? "  · stock transfer executed between stores" : `  ! transfer failed: ${JSON.stringify(done.body).slice(0, 160)}`);
  }

  // Bring one batch forward so the near-expiry warning has a subject.
  const batches = skipProcurement ? [] : await gm.select("inventory_stock_batches", `select=id,expiry_date&property_id=eq.${pid}&expiry_date=not.is.null&order=expiry_date.asc&limit=3`);
  for (const [index, batch] of batches.entries()) {
    const r = await gm.tryRpc("update_batch_expiry", { _batch_id: batch.id, _expiry_date: day(ctx.asOf, 5 + index * 6) });
    if (!r.ok) log(`  ! update_batch_expiry: ${JSON.stringify(r.body).slice(0, 160)}`);
  }
  log(`  · ${batches.length} batches brought into the near-expiry window`);

  // ── C. expenses through the full approval workflow ────────────────────────
  const categoryByCode = new Map(categories.map((c) => [c.code, c]));
  const centreFor = (code) =>
    ({ "EXP-UTIL": "CC-ADM", "EXP-MAINT": "CC-ENG", "EXP-SUPPL": "CC-HK", "EXP-MKT": "CC-ADM", "EXP-TRAN": "CC-FO", "EXP-PROF": "CC-ADM", "EXP-TRAIN": "CC-ADM", "EXP-LIC": "CC-ADM" })[code];
  const centreByCode = new Map(centres.map((c) => [c.code, c]));

  let created = 0;
  let approved = 0;
  let rejected = 0;
  let pending = 0;
  for (let m = 2; m >= 0; m--) {
    for (const [code, narratives] of Object.entries(EXPENSE_NARRATIVES)) {
      if (rand.chance(0.25)) continue;
      const category = categoryByCode.get(code);
      if (!category) continue;
      const expenseDate = day(ctx.asOf, -(m * 30 + rand.int(1, 27)));
      const net = rand.money(320, 9800, 10);
      const tax = Math.round(net * 0.1 * 100) / 100;
      const result = await accountant.tryRpc("expense_create", {
        _property_id: pid,
        _expense_date: expenseDate,
        _vendor_id: null,
        _category_id: category.id,
        _cost_centre_id: centreByCode.get(centreFor(code))?.id ?? null,
        _department_id: null,
        _currency: "GHS",
        _amount_before_tax: net,
        _tax_amount: tax,
        _description: rand.pick(narratives),
        _business_purpose: "Routine operating cost for Infinity Grand Hotel",
        _payment_method: rand.pick(["bank_transfer", "mobile_money", "cash"]),
        _payment_reference: `EXP-${expenseDate.replace(/-/g, "")}-${rand.int(100, 999)}`,
      });
      if (!result.ok) {
        if (created === 0) log(`  ! expense_create: ${JSON.stringify(result.body).slice(0, 220)}`);
        break;
      }
      created++;
    }
  }

  // Every category here requires a receipt before an expense may be submitted,
  // so each draft gets a generated demo receipt PDF uploaded to the
  // expense-receipts bucket on the application's own storage path
  // ({property}/expenses/{expense}/{receipt}-{file}) and registered through
  // expense_receipt_register — the same two steps the upload dialog performs.
  const drafts = await accountant.select(
    "expenses",
    `select=id,expense_number,expense_date,total_amount,description,category_id,status&property_id=eq.${pid}&status=eq.draft&limit=500`,
  );
  const receipted = await accountant.select("expense_receipts", "select=expense_id&archived_at=is.null&limit=1000");
  const haveReceipt = new Set(receipted.map((r) => r.expense_id));
  let attached = 0;
  for (const expense of drafts) {
    if (!haveReceipt.has(expense.id)) {
      const receiptId = randomUUID();
      const fileName = `receipt-${expense.expense_number}.pdf`;
      const bytes = simpleReceiptPdf({
        title: "DEMO DATA — Infinity Grand Hotel",
        lines: [
          `Receipt for: ${expense.description ?? "Operating expense"}`,
          `Expense number: ${expense.expense_number}`,
          `Date: ${expense.expense_date}`,
          `Total: GHS ${Number(expense.total_amount).toFixed(2)}`,
          "",
          "This document is generated demonstration data.",
          "It represents no real transaction or vendor.",
        ],
        footer: "Infinity Grand Hotel demo environment",
      });
      const path = `${pid}/expenses/${expense.id}/${receiptId}-${fileName}`;
      const up = await accountant.upload("expense-receipts", path, bytes, "application/pdf");
      if (!up.ok) {
        if (attached === 0) log(`  ! receipt upload: ${up.status} ${up.body}`);
        continue;
      }
      const reg = await accountant.tryRpc("expense_receipt_register", {
        _expense_id: expense.id,
        _file_name: fileName,
        _mime_type: "application/pdf",
        _file_size: bytes.byteLength,
        _storage_path: path,
        _receipt_type: "receipt",
      });
      if (!reg.ok) {
        if (attached === 0) log(`  ! expense_receipt_register: ${JSON.stringify(reg.body).slice(0, 200)}`);
        continue;
      }
      attached++;
    }

    const submitted = await accountant.tryRpc("expense_submit", { _expense_id: expense.id });
    if (!submitted.ok) {
      if (pending + approved + rejected === 0) log(`  ! expense_submit: ${JSON.stringify(submitted.body).slice(0, 200)}`);
      continue;
    }
    // The newest claims stay in the approval queue so the demo has something
    // to approve live; everything older is decided.
    if (expense.expense_date > day(ctx.asOf, -20) && rand.chance(0.55)) {
      pending++;
      continue;
    }
    const decision = rand.chance(0.88) ? "approved" : "rejected";
    const decided = await gm.tryRpc("expense_decide", {
      _expense_id: expense.id,
      _decision: decision,
      _reason: decision === "rejected" ? "Duplicate of an earlier claim — resubmit with the original receipt." : null,
    });
    if (decided.ok) decision === "approved" ? approved++ : rejected++;
    else if (approved + rejected === 0) log(`  ! expense_decide: ${JSON.stringify(decided.body).slice(0, 200)}`);
  }
  log(`  · expenses: ${created} raised, ${attached} receipts attached — ${approved} approved, ${rejected} rejected, ${pending} awaiting approval`);

  // ── D. corporate receivables ──────────────────────────────────────────────
  const existingCustomers = await accountant.select("ar_customers", `select=id,account_code&property_id=eq.${pid}`);
  const haveCustomers = new Set(existingCustomers.map((c) => c.account_code));
  const newCustomers = AR_CUSTOMERS.filter((c) => !haveCustomers.has(c.account_code)).map((c) => ({
    ...c, property_id: pid, active: true, created_by: accountant.userId,
  }));
  const customers = [...existingCustomers, ...(newCustomers.length ? await accountant.insert("ar_customers", newCustomers) : [])];
  log(`  · corporate accounts: ${newCustomers.length} created`);

  let invoices = 0;
  let receipts = 0;
  for (const customer of customers) {
    for (let n = 0; n < 2; n++) {
      const issued = day(ctx.asOf, -rand.int(8, 80));
      const nights = rand.int(3, 14);
      const rate = rand.money(850, 1400, 10);
      const result = await accountant.tryRpc("create_ar_invoice", {
        _property_id: pid,
        _customer_id: customer.id,
        _issue_date: issued,
        _due_date: day(issued, 30),
        _currency: "GHS",
        _notes: "Corporate accommodation — monthly statement",
        _lines: [
          { description: `Accommodation — ${nights} room nights`, quantity: nights, unit_price: rate, tax_rate: 10 },
          { description: "Meeting room hire", quantity: rand.int(1, 3), unit_price: rand.money(400, 900, 50), tax_rate: 10 },
        ],
      });
      if (!result.ok) {
        if (invoices === 0) log(`  ! create_ar_invoice: ${JSON.stringify(result.body).slice(0, 220)}`);
        break;
      }
      const invoiceId = result.body?.id ?? result.body;
      await accountant.tryRpc("post_ar_invoice", { _id: invoiceId });
      invoices++;

      // Two thirds are settled; the rest age on the receivables report.
      if (rand.chance(0.65)) {
        const invoice = await accountant.select("ar_invoices", `select=id,total&id=eq.${invoiceId}`);
        const amount = Number(invoice[0]?.total ?? 0);
        if (amount > 0) {
          const paidOn = day(issued, rand.int(12, 34));
          if (paidOn <= ctx.asOf) {
            const r = await accountant.tryRpc("post_ar_receipt", {
              _property_id: pid,
              _receipt_date: paidOn,
              _method: rand.pick(["bank_transfer", "mobile_money"]),
              _reference: `RCT-${invoiceId.slice(0, 8).toUpperCase()}`,
              _notes: null,
              _idempotency_key: `demo-${invoiceId}`,
              _allocations: [{ invoice_id: invoiceId, amount: rand.chance(0.85) ? amount : Math.round(amount * 0.6 * 100) / 100 }],
            });
            if (r.ok) receipts++;
            else if (receipts === 0) log(`  ! post_ar_receipt: ${JSON.stringify(r.body).slice(0, 200)}`);
          }
        }
      }
    }
  }
  log(`  · corporate invoices: ${invoices} posted, ${receipts} receipted`);

  return {};
}
