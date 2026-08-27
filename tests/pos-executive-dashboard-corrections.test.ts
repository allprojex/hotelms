import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  dbWithMigrationChain,
  dbWithOriginalOnly,
  freshDb,
  migrationSql,
  returnColumns,
  dateKey,
  CORRECTION_MIGRATION,
  ORIGINAL_MIGRATION,
  PROP_A,
  PROP_B,
  OUTLET_A_BAR,
  OUTLET_A_QUIET,
  USER_EXEC,
  USER_ACCOUNTANT,
  USER_CASHIER,
  USER_SUPER,
  USER_RECEIVER_ONLY,
  USER_EXEC_B,
  MENU_COFFEE,
  MENU_COFFEE_TWIN,
  WINDOW_FROM,
  WINDOW_TO,
  type Db,
} from "./helpers/pos-exec-db";

// Behavioural tests for the exec_pos_* forward corrections (PR-A1), executed
// against a REAL PostgreSQL (PGlite, in-process) so they run the actual
// migration SQL and the actual plpgsql bodies -- including RLS and roles.
//
// Every suite below builds its database by replaying the REAL production
// upgrade path: 20260826090000 first (what production runs today), then
// 20260826133000 over it. The correction migration is never tested alone.

const W = `'${PROP_A}','${WINDOW_FROM}','${WINDOW_TO}'`;
const num = (v: unknown) => Number(v);

let db: Db;
beforeAll(async () => {
  db = await dbWithMigrationChain();
}, 120_000);
afterAll(async () => {
  await db?.close();
});

async function summary(uid = USER_EXEC, args = W) {
  return db.callAs<Record<string, unknown>>(uid, `SELECT * FROM exec_pos_summary(${args})`);
}

// ---------------------------------------------------------------------------
describe("13. real migration chain — original applied, then corrected", () => {
  it("the ORIGINAL migration alone installs the old contract", async () => {
    const only = await dbWithOriginalOnly();
    try {
      const cols = await returnColumns(only, "exec_pos_summary");
      expect(cols).toContain("gross_sales");
      expect(cols).toContain("open_order_value");
      expect(cols).not.toContain("operational_sales");
      expect(cols).not.toContain("folio_posted_amount");
      expect(cols).not.toContain("open_order_line_value");
    } finally {
      await only.close();
    }
  }, 120_000);

  it("applying the correction over it replaces every definition", async () => {
    const cols = await returnColumns(db, "exec_pos_summary");
    expect(cols).toContain("operational_sales");
    expect(cols).toContain("operational_sales_net");
    expect(cols).toContain("operational_tax");
    expect(cols).toContain("void_order_count");
    expect(cols).toContain("open_order_line_value");
    expect(cols).toContain("till_payment_amount");
    expect(cols).toContain("folio_posted_count");
    expect(cols).toContain("folio_posted_amount");
    // The misleading names are gone.
    expect(cols).not.toContain("gross_sales");
    expect(cols).not.toContain("open_order_value");
  });

  it("all five functions exist exactly once after the chain", async () => {
    const rows = await db.callAs<{ proname: string; n: string }>(
      USER_SUPER,
      `SELECT proname, count(*)::text AS n FROM pg_proc
       WHERE pronamespace='public'::regnamespace AND proname LIKE 'exec_pos_%'
       GROUP BY proname ORDER BY proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual([
      "exec_pos_by_department",
      "exec_pos_by_user",
      "exec_pos_sales_by_period",
      "exec_pos_summary",
      "exec_pos_top_items",
    ]);
    expect(rows.every((r) => r.n === "1")).toBe(true);
  });

  it("the correction is a forward migration: it never edits the original file", () => {
    const correction = migrationSql(CORRECTION_MIGRATION);
    expect(correction).not.toContain("20260826090000_exec_pos_dashboard_rpcs.sql'");
    // No attempt to rewrite migration history.
    expect(correction).not.toMatch(/supabase_migrations/i);
    expect(correction).not.toMatch(
      /\bDROP TABLE\b|\bTRUNCATE\b|\bDELETE FROM\b|\bUPDATE\s+public\./i,
    );
  });
});

// ---------------------------------------------------------------------------
describe("3. folio settlements are excluded from till money", () => {
  it("the folio-settled order's 200 is NOT in any till bucket or till total", async () => {
    const [r] = await summary();
    // Till money is O1 only: cash 60 + card 50 = 110, plus O3 mobile money 50.
    expect(num(r.till_payment_amount)).toBe(160);
    expect(num(r.till_payment_count)).toBe(3);
    expect(num(r.cash_amount)).toBe(60);
    expect(num(r.card_amount)).toBe(50);
    expect(num(r.mobile_money_amount)).toBe(50);
    expect(num(r.other_amount)).toBe(0); // the folio row used method 'other'
    expect(num(r.bank_transfer_amount)).toBe(0);
    expect(num(r.wallet_amount)).toBe(0);
  });

  it("the folio order still counts as an operational sale — nothing is discarded", async () => {
    const [r] = await summary();
    // O1 110 + O2 200 (folio) + O3 50 = 360. The void O4's 990 is excluded.
    expect(num(r.operational_sales)).toBe(360);
    expect(num(r.closed_order_count)).toBe(3);
  });

  it("folio activity is reported separately, not silently dropped", async () => {
    const [r] = await summary();
    expect(num(r.folio_posted_count)).toBe(1);
    expect(num(r.folio_posted_amount)).toBe(200);
  });

  it("till + folio accounts for every non-void payment in the window", async () => {
    const [r] = await summary();
    expect(num(r.till_payment_amount) + num(r.folio_posted_amount)).toBe(360);
  });
});

// ---------------------------------------------------------------------------
describe("4/5. live orders: line value, and point-in-time snapshot", () => {
  it("live value comes from item lines, NOT pos_orders.total", async () => {
    const [r] = await summary();
    // O5 (3x25=75, opened pre-window) + O6 (2x15=30). Both carry total = 0.
    expect(num(r.open_order_line_value)).toBe(105);
    expect(num(r.open_order_count)).toBe(2);
  });

  it("A: an order opened BEFORE _from and still open is INCLUDED", async () => {
    const rows = await db.callAs<{ code: string }>(
      USER_EXEC,
      `SELECT o.code FROM pos_orders o
       WHERE o.property_id='${PROP_A}' AND o.status IN ('open','sent','served')
         AND o.opened_at::date <= '${WINDOW_TO}' ORDER BY o.code`,
    );
    expect(rows.map((x) => x.code)).toContain("O5");
    // and its 75 is inside the reported live value
    const [s] = await summary();
    expect(num(s.open_order_line_value)).toBeGreaterThanOrEqual(75);
  });

  it("B: an order opened AFTER _to is EXCLUDED (previously unproven)", async () => {
    const [r] = await summary();
    // O7 is 'sent', opened 2026-09-15, one item at 500. If the upper bound
    // were missing, count would be 3 and value 605.
    expect(num(r.open_order_count)).toBe(2);
    expect(num(r.open_order_line_value)).toBe(105);
    expect(num(r.open_order_line_value)).not.toBe(605);
  });

  it("widening _to to cover the later order brings it in — the bound is real", async () => {
    const [r] = await summary(USER_EXEC, `'${PROP_A}','${WINDOW_FROM}','2026-09-30'`);
    expect(num(r.open_order_count)).toBe(3);
    expect(num(r.open_order_line_value)).toBe(605);
  });
});

// ---------------------------------------------------------------------------
describe("6. summary additions: net, tax, void", () => {
  it("net and tax come from subtotal/tax on closed orders", async () => {
    const [r] = await summary();
    expect(num(r.operational_sales_net)).toBe(100 + 180 + 50);
    expect(num(r.operational_tax)).toBe(10 + 20 + 0);
    expect(num(r.operational_sales_net) + num(r.operational_tax)).toBe(num(r.operational_sales));
  });

  it("void orders are counted separately and never in sales or till", async () => {
    const [r] = await summary();
    expect(num(r.void_order_count)).toBe(1);
    expect(num(r.operational_sales)).not.toBe(360 + 990);
    expect(num(r.till_payment_amount)).not.toBe(160 + 990);
  });
});

// ---------------------------------------------------------------------------
describe("7. department: real outlets, truthful live metrics, quiet outlets visible", () => {
  it("returns every outlet of the property, including the zero-sales one", async () => {
    const rows = await db.callAs<Record<string, unknown>>(
      USER_EXEC,
      `SELECT * FROM exec_pos_by_department(${W}) ORDER BY outlet_name`,
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.outlet_name)).toEqual([
      "A Bar",
      "A Quiet Room Service",
      "A Restaurant",
    ]);
    const quiet = rows.find((r) => r.outlet_id === OUTLET_A_QUIET)!;
    expect(num(quiet.operational_sales)).toBe(0);
    expect(num(quiet.order_count)).toBe(0);
    expect(num(quiet.live_order_count)).toBe(0);
  });

  it("per-outlet live metrics use the same point-in-time bound", async () => {
    const rows = await db.callAs<Record<string, unknown>>(
      USER_EXEC,
      `SELECT * FROM exec_pos_by_department(${W})`,
    );
    const bar = rows.find((r) => r.outlet_id === OUTLET_A_BAR)!;
    // Bar: closed O1 110 + O3 50 = 160; live O5 (75) only -- O7 is after _to.
    expect(num(bar.operational_sales)).toBe(160);
    expect(num(bar.order_count)).toBe(2);
    expect(num(bar.live_order_count)).toBe(1);
    expect(num(bar.open_order_line_value)).toBe(75);
  });

  it("department sales sum to the summary's operational sales", async () => {
    const rows = await db.callAs<Record<string, unknown>>(
      USER_EXEC,
      `SELECT * FROM exec_pos_by_department(${W})`,
    );
    const total = rows.reduce((a, r) => a + num(r.operational_sales), 0);
    const [s] = await summary();
    expect(total).toBe(num(s.operational_sales));
  });
});

// ---------------------------------------------------------------------------
describe("8. user: creator and till receiver stay separate", () => {
  it("a payment-only receiver is still visible with zero created orders", async () => {
    const rows = await db.callAs<Record<string, unknown>>(
      USER_EXEC,
      `SELECT * FROM exec_pos_by_user(${W})`,
    );
    const receiver = rows.find((r) => r.user_id === USER_RECEIVER_ONLY)!;
    expect(receiver).toBeTruthy();
    expect(num(receiver.orders_created_count)).toBe(0);
    expect(num(receiver.orders_created_value)).toBe(0);
    expect(num(receiver.till_payments_received_count)).toBe(1);
    expect(num(receiver.till_payments_received_value)).toBe(50);
  });

  it("the creator's till receipts exclude the folio settlement", async () => {
    const rows = await db.callAs<Record<string, unknown>>(
      USER_EXEC,
      `SELECT * FROM exec_pos_by_user(${W})`,
    );
    const exec = rows.find((r) => r.user_id === USER_EXEC)!;
    // Created closed O1 (110) and O2 (200) = 310.
    expect(num(exec.orders_created_count)).toBe(2);
    expect(num(exec.orders_created_value)).toBe(310);
    // Received till: O1 cash 60 + card 50 only. The 200 folio row is excluded,
    // and the 990 void payment is excluded.
    expect(num(exec.till_payments_received_count)).toBe(2);
    expect(num(exec.till_payments_received_value)).toBe(110);
  });

  it("neither column is presented as a salesperson figure", () => {
    const sql = migrationSql(CORRECTION_MIGRATION).replace(/--[^\n]*/g, "");
    expect(sql).not.toMatch(/salesperson/i);
    expect(sql).toContain("orders_created_count");
    expect(sql).toContain("till_payments_received_count");
  });

  it("full_name is joined without changing the security boundary", async () => {
    const rows = await db.callAs<Record<string, unknown>>(
      USER_EXEC,
      `SELECT * FROM exec_pos_by_user(${W})`,
    );
    const exec = rows.find((r) => r.user_id === USER_EXEC)!;
    expect(exec.full_name).toBe("Ama Exec");

    // An accountant is NOT covered by profiles_admin_select, so names come
    // back NULL -- the row itself must survive rather than disappear.
    const asAccountant = await db.callAs<Record<string, unknown>>(
      USER_ACCOUNTANT,
      `SELECT * FROM exec_pos_by_user(${W})`,
    );
    expect(asAccountant.length).toBe(rows.length);
    const other = asAccountant.find((r) => r.user_id === USER_RECEIVER_ONLY)!;
    expect(other).toBeTruthy();
    expect(other.full_name).toBeNull();
    expect(num(other.till_payments_received_value)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
describe("9. top items: grouped by (menu_item_id, name_snapshot)", () => {
  it("two distinct products sharing a name are NOT merged", async () => {
    const rows = await db.callAs<Record<string, unknown>>(
      USER_EXEC,
      `SELECT * FROM exec_pos_top_items(${W}, 50)`,
    );
    const coffees = rows.filter((r) => r.item_name === "Coffee");
    expect(coffees).toHaveLength(2);
    expect(coffees.map((c) => c.menu_item_id).sort()).toEqual(
      [MENU_COFFEE, MENU_COFFEE_TWIN].sort(),
    );
  });

  it("a NULL menu_item_id historical row is preserved under its snapshot name", async () => {
    const rows = await db.callAs<Record<string, unknown>>(
      USER_EXEC,
      `SELECT * FROM exec_pos_top_items(${W}, 50)`,
    );
    const deleted = rows.find((r) => r.item_name === "Deleted Pastry")!;
    expect(deleted).toBeTruthy();
    expect(deleted.menu_item_id).toBeNull();
    expect(num(deleted.total_quantity)).toBe(1);
    expect(num(deleted.total_amount)).toBe(40);
  });

  it("value uses price_snapshot * quantity, closed non-void orders only", async () => {
    const rows = await db.callAs<Record<string, unknown>>(
      USER_EXEC,
      `SELECT * FROM exec_pos_top_items(${W}, 50)`,
    );
    const byName = Object.fromEntries(rows.map((r) => [`${r.item_name}|${r.menu_item_id}`, r]));
    expect(num(byName[`Coffee|${MENU_COFFEE}`].total_amount)).toBe(60); // 2 x 30
    expect(num(byName[`Coffee|${MENU_COFFEE_TWIN}`].total_amount)).toBe(180); // 2 x 90
    // The void order's 900 Coffee never appears.
    const total = rows.reduce((a, r) => a + num(r.total_amount), 0);
    expect(total).toBe(60 + 40 + 180);
    // Open orders' items are not top-items either (O5/O6 are not closed).
    expect(total).not.toBe(60 + 40 + 180 + 75 + 30);
  });

  it("the limit stays clamped between 1 and 100", async () => {
    const zero = await db.callAs(USER_EXEC, `SELECT * FROM exec_pos_top_items(${W}, 0)`);
    expect(zero).toHaveLength(1);
    const big = await db.callAs(USER_EXEC, `SELECT * FROM exec_pos_top_items(${W}, 9999)`);
    expect(big.length).toBeLessThanOrEqual(100);
    const nul = await db.callAs(USER_EXEC, `SELECT * FROM exec_pos_top_items(${W}, NULL)`);
    expect(nul.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe("10. sales by period", () => {
  it("day granularity gap-fills every day in the range", async () => {
    const rows = await db.callAs<Record<string, unknown>>(
      USER_EXEC,
      `SELECT * FROM exec_pos_sales_by_period('${PROP_A}','2026-08-04','2026-08-08','day')`,
    );
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => dateKey(r.period_start))).toEqual([
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
    ]);
    expect(num(rows[0].operational_sales)).toBe(0); // explicit zero, not a gap
    expect(num(rows[1].operational_sales)).toBe(110); // O1
    expect(num(rows[2].operational_sales)).toBe(200); // O2 (folio) still a sale
    expect(num(rows[3].operational_sales)).toBe(50); // O3
    expect(num(rows[4].operational_sales)).toBe(0); // O4 is void
  });

  it("payments_received_amount is till-only: folio and void excluded", async () => {
    const rows = await db.callAs<Record<string, unknown>>(
      USER_EXEC,
      `SELECT * FROM exec_pos_sales_by_period('${PROP_A}','2026-08-04','2026-08-08','day')`,
    );
    expect(num(rows[1].payments_received_amount)).toBe(110); // O1 cash+card
    expect(num(rows[2].payments_received_amount)).toBe(0); // O2 was folio
    expect(num(rows[3].payments_received_amount)).toBe(50); // O3 momo
    expect(num(rows[4].payments_received_amount)).toBe(0); // O4 void
  });

  it("month granularity gap-fills and anchors to the month of _from", async () => {
    const rows = await db.callAs<Record<string, unknown>>(
      USER_EXEC,
      `SELECT * FROM exec_pos_sales_by_period('${PROP_A}','2026-06-15','2026-08-31','month')`,
    );
    expect(rows.map((r) => dateKey(r.period_start))).toEqual([
      "2026-06-01",
      "2026-07-01",
      "2026-08-01",
    ]);
    expect(num(rows[0].operational_sales)).toBe(400); // O9, mid-month start still included
    expect(num(rows[1].operational_sales)).toBe(0); // empty month is an explicit zero
    expect(num(rows[2].operational_sales)).toBe(360);
  });

  it("a month bucket contains its WHOLE month, matching its own label", async () => {
    // Regression: filtering month rows by the raw _from while labelling the
    // bucket with the month's first day produced a row that said "June" but
    // held only 15--30 June. A bucket labelled 2026-06-01 must mean June.
    const rows = await db.callAs<Record<string, unknown>>(
      USER_EXEC,
      `SELECT * FROM exec_pos_sales_by_period('${PROP_A}','2026-06-15','2026-08-31','month')`,
    );
    const june = rows.find((r) => dateKey(r.period_start) === "2026-06-01")!;
    // O9 closed 2026-06-10 -- before _from, but inside the month the bucket names.
    expect(num(june.operational_sales)).toBe(400);
    expect(num(june.order_count)).toBe(1);
    expect(num(june.payments_received_amount)).toBe(400);
  });

  it("day granularity is NOT widened — a day bucket is exactly its own date", async () => {
    const rows = await db.callAs<Record<string, unknown>>(
      USER_EXEC,
      `SELECT * FROM exec_pos_sales_by_period('${PROP_A}','2026-06-11','2026-06-20','day')`,
    );
    expect(rows).toHaveLength(10);
    // O9 closed on the 10th, one day before the range: it must NOT appear.
    expect(rows.reduce((a, r) => a + num(r.operational_sales), 0)).toBe(0);
  });

  it("an invalid granularity is rejected, not silently defaulted", async () => {
    await expect(
      db.callAs(USER_EXEC, `SELECT * FROM exec_pos_sales_by_period(${W},'week')`),
    ).rejects.toThrow(/must be day or month/);
    const dflt = await db.callAs(
      USER_EXEC,
      `SELECT * FROM exec_pos_sales_by_period('${PROP_A}','2026-08-01','2026-08-03')`,
    );
    expect(dflt).toHaveLength(3); // defaults to 'day'
  });
});

// ---------------------------------------------------------------------------
describe("12. NULL _property_id returns NO rows, not a synthetic zero report", () => {
  it("every function returns an empty result set", async () => {
    for (const call of [
      `SELECT * FROM exec_pos_summary(NULL,'${WINDOW_FROM}','${WINDOW_TO}')`,
      `SELECT * FROM exec_pos_by_department(NULL,'${WINDOW_FROM}','${WINDOW_TO}')`,
      `SELECT * FROM exec_pos_by_user(NULL,'${WINDOW_FROM}','${WINDOW_TO}')`,
      `SELECT * FROM exec_pos_top_items(NULL,'${WINDOW_FROM}','${WINDOW_TO}',10)`,
      `SELECT * FROM exec_pos_sales_by_period(NULL,'${WINDOW_FROM}','${WINDOW_TO}','day')`,
    ]) {
      expect(await db.callAs(USER_EXEC, call)).toHaveLength(0);
    }
  });

  it("the ORIGINAL summary returned a misleading all-zero row for NULL", async () => {
    const only = await dbWithOriginalOnly();
    try {
      const rows = await only.callAs<Record<string, unknown>>(
        USER_SUPER,
        `SELECT * FROM exec_pos_summary(NULL,'${WINDOW_FROM}','${WINDOW_TO}')`,
      );
      expect(rows).toHaveLength(1); // the defect this correction removes
      expect(num(rows[0].gross_sales)).toBe(0);
    } finally {
      await only.close();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
describe("11. security: role gate, isolation, invoker, grants", () => {
  it("Executive roles can read the analytics", async () => {
    for (const uid of [USER_EXEC, USER_ACCOUNTANT, USER_SUPER]) {
      const rows = await summary(uid);
      expect(rows).toHaveLength(1);
      expect(num(rows[0].operational_sales)).toBe(360);
    }
  });

  it("a NON-Executive role (cashier) obtains NO analytics from any function", async () => {
    expect(await summary(USER_CASHIER)).toHaveLength(0);
    for (const call of [
      `SELECT * FROM exec_pos_by_department(${W})`,
      `SELECT * FROM exec_pos_by_user(${W})`,
      `SELECT * FROM exec_pos_top_items(${W},10)`,
      `SELECT * FROM exec_pos_sales_by_period(${W},'day')`,
    ]) {
      expect(await db.callAs(USER_CASHIER, call)).toHaveLength(0);
    }
  });

  it("an anonymous caller cannot execute any of the five", async () => {
    for (const fn of [
      `exec_pos_summary(${W})`,
      `exec_pos_by_department(${W})`,
      `exec_pos_by_user(${W})`,
      `exec_pos_top_items(${W},10)`,
      `exec_pos_sales_by_period(${W},'day')`,
    ]) {
      await expect(db.callAs(null, `SELECT * FROM ${fn}`, "anon")).rejects.toThrow(
        /permission denied/i,
      );
    }
  });

  it("cross-property: property A's executive gets nothing for property B", async () => {
    const rows = await db.callAs(
      USER_EXEC,
      `SELECT * FROM exec_pos_summary('${PROP_B}','${WINDOW_FROM}','${WINDOW_TO}')`,
    );
    expect(rows).toHaveLength(0);
  });

  it("property B's own executive sees only B's figures", async () => {
    const [b] = await db.callAs<Record<string, unknown>>(
      USER_EXEC_B,
      `SELECT * FROM exec_pos_summary('${PROP_B}','${WINDOW_FROM}','${WINDOW_TO}')`,
    );
    expect(num(b.operational_sales)).toBe(770);
    const [a] = await summary();
    expect(num(a.operational_sales)).toBe(360);
    expect(num(b.operational_sales)).not.toBe(num(a.operational_sales) + 770);
  });

  it("all five remain SECURITY INVOKER, STABLE and search_path-pinned", async () => {
    const rows = await db.callAs<Record<string, unknown>>(
      USER_SUPER,
      `SELECT proname, prosecdef, provolatile, proconfig::text AS cfg FROM pg_proc
       WHERE pronamespace='public'::regnamespace AND proname LIKE 'exec_pos_%' ORDER BY proname`,
    );
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.prosecdef).toBe(false);
      expect(r.provolatile).toBe("s");
      expect(String(r.cfg)).toContain("search_path=public");
    }
  });

  it("grants after the chain: authenticated yes, anon/PUBLIC no", async () => {
    const rows = await db.callAs<Record<string, unknown>>(
      USER_SUPER,
      `SELECT proname,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_ok,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_ok,
        has_function_privilege('public', p.oid, 'EXECUTE') AS public_ok
       FROM pg_proc p WHERE pronamespace='public'::regnamespace AND proname LIKE 'exec_pos_%'`,
    );
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.auth_ok).toBe(true);
      expect(r.anon_ok).toBe(false);
      expect(r.public_ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe("15. join multiplication — one order, many items, many payments", () => {
  it("each domain counts O1 exactly once", async () => {
    const [s] = await summary();
    // O1 has 2 items and 2 payments. If items multiplied revenue it would be
    // 220; if payments multiplied it, 220 as well.
    expect(num(s.operational_sales)).toBe(360);
    expect(num(s.closed_order_count)).toBe(3);
    expect(num(s.till_payment_count)).toBe(3); // 2 from O1 + 1 from O3
    expect(num(s.till_payment_amount)).toBe(160);
    expect(num(s.folio_posted_count)).toBe(1);
    expect(num(s.folio_posted_amount)).toBe(200);
  });

  it("department value for O1's outlet is not multiplied by its item rows", async () => {
    const rows = await db.callAs<Record<string, unknown>>(
      USER_EXEC,
      `SELECT * FROM exec_pos_by_department(${W})`,
    );
    const bar = rows.find((r) => r.outlet_id === OUTLET_A_BAR)!;
    expect(num(bar.operational_sales)).toBe(160); // not 270 (110*2 + 50)
    expect(num(bar.order_count)).toBe(2);
  });

  it("per-user values are not multiplied", async () => {
    const rows = await db.callAs<Record<string, unknown>>(
      USER_EXEC,
      `SELECT * FROM exec_pos_by_user(${W})`,
    );
    const exec = rows.find((r) => r.user_id === USER_EXEC)!;
    expect(num(exec.orders_created_value)).toBe(310); // not 420 (110*2 + 200)
    expect(num(exec.till_payments_received_value)).toBe(110);
  });

  it("item quantities are not multiplied by the order's payment rows", async () => {
    const rows = await db.callAs<Record<string, unknown>>(
      USER_EXEC,
      `SELECT * FROM exec_pos_top_items(${W},50)`,
    );
    const coffee = rows.find((r) => r.menu_item_id === MENU_COFFEE)!;
    expect(num(coffee.total_quantity)).toBe(2); // not 4
    expect(num(coffee.order_count)).toBe(1);
  });

  it("a period bucket is not multiplied by payments", async () => {
    const rows = await db.callAs<Record<string, unknown>>(
      USER_EXEC,
      `SELECT * FROM exec_pos_sales_by_period('${PROP_A}','2026-08-05','2026-08-05','day')`,
    );
    expect(num(rows[0].operational_sales)).toBe(110); // not 220
    expect(num(rows[0].order_count)).toBe(1);
    expect(num(rows[0].payments_received_amount)).toBe(110);
  });
});

// ---------------------------------------------------------------------------
describe("16. mutation tests — the suite fails when a correction is broken", () => {
  /** Apply a broken definition, assert the guarantee fails, then restore. */
  async function withMutation(mutatedSql: string, assertion: (d: Db) => Promise<void>) {
    const m = await dbWithMigrationChain();
    try {
      await m.admin(mutatedSql);
      await assertion(m);
    } finally {
      await m.close();
    }
  }

  const correction = migrationSql(CORRECTION_MIGRATION);
  function fnSource(name: string): string {
    const start = correction.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    const marker = "\n$$;";
    const end = correction.indexOf(marker, start) + marker.length;
    return correction.slice(start, end);
  }

  it("removing the folio exclusion breaks the till assertion", async () => {
    const broken = fnSource("exec_pos_summary").replaceAll("AND p.folio_charge_id IS NULL", "");
    await withMutation(broken, async (m) => {
      const [r] = await m.callAs<Record<string, unknown>>(
        USER_EXEC,
        `SELECT * FROM exec_pos_summary(${W})`,
      );
      expect(num(r.till_payment_amount)).toBe(360); // folio money leaks in
      expect(num(r.till_payment_amount)).not.toBe(160);
    });
  }, 120_000);

  it("reverting live value to pos_orders.total breaks the live assertion", async () => {
    const broken = fnSource("exec_pos_summary").replace(
      /COALESCE\(\(\s*SELECT SUM\(i\.price_snapshot \* i\.quantity\)[\s\S]*?\), 0\)::numeric AS line_value/,
      `COALESCE((SELECT SUM(o2.total) FROM pos_orders o2 WHERE o2.id IN (SELECT id FROM live_orders)), 0)::numeric AS line_value`,
    );
    await withMutation(broken, async (m) => {
      const [r] = await m.callAs<Record<string, unknown>>(
        USER_EXEC,
        `SELECT * FROM exec_pos_summary(${W})`,
      );
      expect(num(r.open_order_line_value)).toBe(0); // the original defect
      expect(num(r.open_order_line_value)).not.toBe(105);
    });
  }, 120_000);

  it("removing the opened_at <= _to bound lets a future order leak in", async () => {
    const broken = fnSource("exec_pos_summary").replaceAll("AND o.opened_at::date <= _to", "");
    await withMutation(broken, async (m) => {
      const [r] = await m.callAs<Record<string, unknown>>(
        USER_EXEC,
        `SELECT * FROM exec_pos_summary(${W})`,
      );
      expect(num(r.open_order_count)).toBe(3);
      expect(num(r.open_order_line_value)).toBe(605);
    });
  }, 120_000);

  it("removing the void exclusion inflates till money", async () => {
    const broken = fnSource("exec_pos_summary").replaceAll("AND o.status <> 'void'", "");
    await withMutation(broken, async (m) => {
      const [r] = await m.callAs<Record<string, unknown>>(
        USER_EXEC,
        `SELECT * FROM exec_pos_summary(${W})`,
      );
      expect(num(r.till_payment_amount)).toBe(1150); // 160 + the void 990
    });
  }, 120_000);

  it("switching to SECURITY DEFINER is detectable", async () => {
    const broken = fnSource("exec_pos_summary").replace("SECURITY INVOKER", "SECURITY DEFINER");
    await withMutation(broken, async (m) => {
      const [r] = await m.callAs<Record<string, unknown>>(
        USER_SUPER,
        `SELECT prosecdef FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='exec_pos_summary'`,
      );
      expect(r.prosecdef).toBe(true); // the shipped file must never do this
    });
  }, 120_000);

  it("granting anon is detectable", async () => {
    await withMutation(
      `GRANT EXECUTE ON FUNCTION public.exec_pos_summary(uuid,date,date) TO anon;`,
      async (m) => {
        const [r] = await m.callAs<Record<string, unknown>>(
          USER_SUPER,
          `SELECT has_function_privilege('anon','public.exec_pos_summary(uuid,date,date)','EXECUTE') AS ok`,
        );
        expect(r.ok).toBe(true); // the shipped file must never do this
      },
    );
  }, 120_000);

  it("removing the Executive role gate exposes analytics to a cashier", async () => {
    const broken = fnSource("exec_pos_summary").replace(
      /IF NOT public\.has_any_role\([\s\S]*?END IF;/,
      "",
    );
    await withMutation(broken, async (m) => {
      const rows = await m.callAs(USER_CASHIER, `SELECT * FROM exec_pos_summary(${W})`);
      expect(rows).toHaveLength(1); // gate gone -- a non-Executive now reads it
    });
  }, 120_000);

  it("the SHIPPED file contains none of those mutations", () => {
    const sql = correction.replace(/--[^\n]*/g, "");
    expect(sql).toContain("AND p.folio_charge_id IS NULL");
    expect(sql).toContain("AND o.opened_at::date <= _to");
    expect(sql).toContain("AND o.status <> 'void'");
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).not.toContain("SECURITY DEFINER");
    expect(sql).not.toMatch(/GRANT[\s\S]{0,80}TO\s+anon/i);
    expect((sql.match(/has_any_role/g) ?? []).length).toBe(5);
    expect((sql.match(/IF _property_id IS NULL THEN/g) ?? []).length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
describe("structural guarantees of the correction migration", () => {
  const sql = migrationSql(CORRECTION_MIGRATION).replace(/--[^\n]*/g, "");

  it("performs no writes and no dynamic SQL", () => {
    expect(sql).not.toMatch(
      /\bINSERT\s+INTO\b|\bUPDATE\s+public\.|\bDELETE\s+FROM\b|\bTRUNCATE\b/i,
    );
    expect(sql).not.toMatch(/\bEXECUTE\s+format\b|\bEXECUTE\s+'/i);
    expect(sql).not.toMatch(/CREATE\s+POLICY|ALTER\s+POLICY|ALTER\s+TABLE/i);
  });

  it("contains no currency literal or formatting", () => {
    expect(sql).not.toMatch(/'GHS'|'USD'|'EUR'|to_char\(/);
  });

  it("does not fabricate refunds or discounts", () => {
    expect(sql).not.toMatch(/refund|discount/i);
  });

  it("drops exactly the five old signatures before recreating them", () => {
    expect((sql.match(/DROP FUNCTION IF EXISTS public\.exec_pos_/g) ?? []).length).toBe(5);
    expect((sql.match(/CREATE OR REPLACE FUNCTION public\.exec_pos_/g) ?? []).length).toBe(5);
  });

  it("re-grants authenticated and re-revokes PUBLIC/anon for all five", () => {
    expect(
      (sql.match(/REVOKE ALL ON FUNCTION public\.exec_pos_[\s\S]{0,120}FROM PUBLIC, anon;/g) ?? [])
        .length,
    ).toBe(5);
    expect(
      (
        sql.match(/GRANT EXECUTE ON FUNCTION public\.exec_pos_[\s\S]{0,120}TO authenticated;/g) ??
        []
      ).length,
    ).toBe(5);
  });

  it("uses a collision-free timestamp after every migration on main", () => {
    expect(CORRECTION_MIGRATION).toContain("20260826133000");
    expect(ORIGINAL_MIGRATION).toContain("20260826090000");
    expect("20260826133000" > "20260826090000").toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("the original migration file is untouched by this change", () => {
  it("still declares the pre-correction contract verbatim", () => {
    const original = migrationSql(ORIGINAL_MIGRATION);
    expect(original).toContain("gross_sales numeric");
    expect(original).toContain("open_order_value numeric");
    expect(original).not.toContain("folio_charge_id");
    expect(original).not.toContain("open_order_line_value");
  });

  it("a fresh database with no migrations has no exec_pos_* functions", async () => {
    const bare = await freshDb();
    try {
      const rows = await bare.callAs(
        USER_SUPER,
        `SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'exec_pos_%'`,
      );
      expect(rows).toHaveLength(0);
    } finally {
      await bare.close();
    }
  }, 120_000);
});
