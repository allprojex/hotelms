import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  freshDb,
  migrationSql,
  DISCOUNT_MIGRATION,
  applySql,
  reverseSql,
  rateTotal,
  folioTotal,
  outstanding,
  discountRows,
  chargeRows,
  auditRows,
  num,
  PROP_GHS,
  PROP_AUD,
  USER_GM,
  USER_OWNER,
  USER_SUPER,
  USER_FRONT_DESK,
  USER_RESERVATIONS,
  USER_GM_AUD,
  RES_CONFIRMED,
  RES_CHECKED_IN,
  RES_PART_PAID,
  RES_FULLY_PAID,
  RES_CHECKED_OUT,
  RES_CANCELLED,
  RES_WITH_POS,
  RES_REFUNDED,
  RES_ROUNDING,
  RES_AUD,
  type Db,
} from "./helpers/reservation-discount-db";

// Behavioural tests for Reservation Discounts Phase 1, executed against a real
// PostgreSQL (PGlite, in-process) so they run the actual migration SQL and the
// actual plpgsql RPC bodies -- RLS, roles, CHECK constraints, advisory locks
// and SELECT ... FOR UPDATE included.

let db: Db;
beforeEach(async () => {
  db = await freshDb();
}, 120_000);
afterEach(async () => {
  await db?.close();
});

/** THE Phase 1 invariant, asserted as one reusable check. */
async function assertInvariant(reservationId: string, originalRoomValue: number) {
  const rows = await discountRows(db, reservationId);
  const activeSum = rows
    .filter((r) => r.status === "active")
    .reduce((a, r) => a + num(r.calculated_amount), 0);

  // original eligible room value - active discounts = rate_total
  expect(await rateTotal(db, reservationId)).toBeCloseTo(originalRoomValue - activeSum, 2);

  // ...and each active discount appears in the folio exactly once.
  const charges = await chargeRows(db, reservationId);
  for (const d of rows.filter((r) => r.status === "active")) {
    const matches = charges.filter(
      (c) =>
        num(c.amount) === -num(d.calculated_amount) &&
        String(c.description).startsWith("Discount ·"),
    );
    expect(matches.length).toBeGreaterThanOrEqual(1);
  }
  const discountLines = charges.filter((c) => String(c.description).startsWith("Discount ·"));
  expect(discountLines).toHaveLength(rows.length); // one negative line per discount ever applied
}

// ---------------------------------------------------------------------------
describe("amount discount", () => {
  it("applies a fixed amount, posts one negative folio line and reduces rate_total", async () => {
    await db.callAs(USER_GM, applySql(RES_CONFIRMED, "amount", 100));

    expect(await rateTotal(db, RES_CONFIRMED)).toBe(900);
    expect(await folioTotal(db, RES_CONFIRMED)).toBe(900);
    expect(await outstanding(db, RES_CONFIRMED)).toBe(900);

    const [d] = await discountRows(db, RES_CONFIRMED);
    expect(d.discount_type).toBe("amount");
    expect(num(d.entered_value)).toBe(100);
    expect(num(d.basis_amount)).toBe(1000);
    expect(num(d.calculated_amount)).toBe(100);
    expect(d.status).toBe("active");
    expect(d.charge_id).toBeTruthy();

    const lines = await chargeRows(db, RES_CONFIRMED);
    const discountLine = lines.find((l) => String(l.description).startsWith("Discount ·"))!;
    expect(num(discountLine.amount)).toBe(-100);
    await assertInvariant(RES_CONFIRMED, 1000);
  });

  it("stacks two discounts against the remaining basis, never the original", async () => {
    await db.callAs(USER_GM, applySql(RES_CONFIRMED, "amount", 100));
    await db.callAs(USER_GM, applySql(RES_CONFIRMED, "amount", 50));
    expect(await rateTotal(db, RES_CONFIRMED)).toBe(850);
    const rows = await discountRows(db, RES_CONFIRMED);
    expect(num(rows[1].basis_amount)).toBe(900); // second saw the reduced basis
    await assertInvariant(RES_CONFIRMED, 1000);
  });
});

// ---------------------------------------------------------------------------
describe("percentage discount", () => {
  it("calculates against the eligible room basis and freezes both figures", async () => {
    await db.callAs(USER_GM, applySql(RES_CONFIRMED, "percentage", 10));
    const [d] = await discountRows(db, RES_CONFIRMED);
    expect(d.discount_type).toBe("percentage");
    expect(num(d.entered_value)).toBe(10);
    expect(num(d.basis_amount)).toBe(1000);
    expect(num(d.calculated_amount)).toBe(100);
    expect(await rateTotal(db, RES_CONFIRMED)).toBe(900);
    await assertInvariant(RES_CONFIRMED, 1000);
  });

  it("does NOT float when charges change afterwards", async () => {
    await db.callAs(USER_GM, applySql(RES_CONFIRMED, "percentage", 10));
    // A later incidental must not re-price the already-applied discount.
    await db.admin(
      `INSERT INTO public.reservation_charges (reservation_id, description, amount)
       VALUES ('${RES_CONFIRMED}','POS · Late bar tab', 500.00)`,
    );
    const [d] = await discountRows(db, RES_CONFIRMED);
    expect(num(d.calculated_amount)).toBe(100); // frozen, not 150
    expect(num(d.basis_amount)).toBe(1000);
    expect(await rateTotal(db, RES_CONFIRMED)).toBe(900);
  });

  it("rounds the calculated amount to 2 decimal places", async () => {
    // 333.33 * 10% = 33.333 -> 33.33
    await db.callAs(USER_GM, applySql(RES_ROUNDING, "percentage", 10));
    const [d] = await discountRows(db, RES_ROUNDING);
    expect(num(d.calculated_amount)).toBe(33.33);
    expect(await rateTotal(db, RES_ROUNDING)).toBe(300);
    await assertInvariant(RES_ROUNDING, 333.33);
  });

  it("100% is allowed and takes the room value to zero", async () => {
    await db.callAs(USER_GM, applySql(RES_CONFIRMED, "percentage", 100));
    expect(await rateTotal(db, RES_CONFIRMED)).toBe(0);
    expect(await outstanding(db, RES_CONFIRMED)).toBe(0);
    await assertInvariant(RES_CONFIRMED, 1000);
  });
});

// ---------------------------------------------------------------------------
describe("scope — room accommodation only", () => {
  it("a POS/incidental charge never widens the percentage basis", async () => {
    // Folio is 1250 (room 1000 + POS 250) but the basis must be 1000.
    expect(await folioTotal(db, RES_WITH_POS)).toBe(1250);
    await db.callAs(USER_GM, applySql(RES_WITH_POS, "percentage", 10));
    const [d] = await discountRows(db, RES_WITH_POS);
    expect(num(d.basis_amount)).toBe(1000); // NOT 1250
    expect(num(d.calculated_amount)).toBe(100); // NOT 125
    expect(await rateTotal(db, RES_WITH_POS)).toBe(900);
    expect(await folioTotal(db, RES_WITH_POS)).toBe(1150); // POS untouched
  });

  it("an amount discount cannot reach past the room value into POS charges", async () => {
    await expect(db.callAs(USER_GM, applySql(RES_WITH_POS, "amount", 1100))).rejects.toThrow(
      /exceeds the eligible room amount/i,
    );
    expect(await rateTotal(db, RES_WITH_POS)).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
describe("input validation", () => {
  it("rejects a percentage over 100", async () => {
    await expect(db.callAs(USER_GM, applySql(RES_CONFIRMED, "percentage", 101))).rejects.toThrow(
      /cannot exceed 100/i,
    );
  });

  it("rejects zero and negative values for both types", async () => {
    for (const type of ["amount", "percentage"] as const) {
      await expect(db.callAs(USER_GM, applySql(RES_CONFIRMED, type, 0))).rejects.toThrow(
        /greater than zero/i,
      );
      await expect(db.callAs(USER_GM, applySql(RES_CONFIRMED, type, -5))).rejects.toThrow(
        /greater than zero/i,
      );
    }
  });

  it("rejects an amount larger than the eligible room basis", async () => {
    await expect(db.callAs(USER_GM, applySql(RES_CONFIRMED, "amount", 1000.01))).rejects.toThrow(
      /exceeds the eligible room amount|exceeds the outstanding balance/i,
    );
  });

  it("requires a reason", async () => {
    await expect(db.callAs(USER_GM, applySql(RES_CONFIRMED, "amount", 50, "   "))).rejects.toThrow(
      /reason is required/i,
    );
  });

  it("rejects an unknown discount type", async () => {
    await expect(
      db.callAs(USER_GM, applySql(RES_CONFIRMED, "freebie" as never, 50)),
    ).rejects.toThrow(/amount or percentage/i);
  });

  it("rejects a percentage that rounds to zero", async () => {
    await db.admin(
      `UPDATE public.reservations SET rate_total = 0.01 WHERE id = '${RES_CONFIRMED}'`,
    );
    await expect(db.callAs(USER_GM, applySql(RES_CONFIRMED, "percentage", 1))).rejects.toThrow(
      /rounds to zero/i,
    );
  });
});

// ---------------------------------------------------------------------------
describe("payment state boundaries", () => {
  it("partially paid: allowed up to the outstanding balance", async () => {
    expect(await outstanding(db, RES_PART_PAID)).toBe(300);
    await db.callAs(USER_GM, applySql(RES_PART_PAID, "amount", 300));
    expect(await outstanding(db, RES_PART_PAID)).toBe(0);
    expect(await rateTotal(db, RES_PART_PAID)).toBe(700);
    await assertInvariant(RES_PART_PAID, 1000);
  });

  it("partially paid: rejected one cent beyond the outstanding balance", async () => {
    await expect(db.callAs(USER_GM, applySql(RES_PART_PAID, "amount", 300.01))).rejects.toThrow(
      /exceeds the outstanding balance/i,
    );
    expect(await rateTotal(db, RES_PART_PAID)).toBe(1000); // unchanged
  });

  it("fully paid: rejected, and the message points at the refund process", async () => {
    expect(await outstanding(db, RES_FULLY_PAID)).toBe(0);
    await expect(db.callAs(USER_GM, applySql(RES_FULLY_PAID, "amount", 1))).rejects.toThrow(
      /Use a refund to return money already collected/i,
    );
  });

  it("a discount can never create a credit balance", async () => {
    await expect(db.callAs(USER_GM, applySql(RES_PART_PAID, "percentage", 100))).rejects.toThrow(
      /exceeds the outstanding balance/i,
    );
    expect(await outstanding(db, RES_PART_PAID)).toBe(300);
  });

  it("refunded payments restore discountable headroom", async () => {
    // Paid 1000, refunded 400 -> outstanding 400.
    expect(await outstanding(db, RES_REFUNDED)).toBe(400);
    await db.callAs(USER_GM, applySql(RES_REFUNDED, "amount", 400));
    expect(await outstanding(db, RES_REFUNDED)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("reservation status gate", () => {
  it("allows confirmed and checked_in", async () => {
    await db.callAs(USER_GM, applySql(RES_CONFIRMED, "amount", 10));
    await db.callAs(USER_GM, applySql(RES_CHECKED_IN, "amount", 10));
    expect(await rateTotal(db, RES_CONFIRMED)).toBe(990);
    expect(await rateTotal(db, RES_CHECKED_IN)).toBe(990);
  });

  it("rejects checked_out — the journal is already posted and idempotent", async () => {
    await expect(db.callAs(USER_GM, applySql(RES_CHECKED_OUT, "amount", 10))).rejects.toThrow(
      /cannot be applied to a checked_out reservation/i,
    );
    expect(await rateTotal(db, RES_CHECKED_OUT)).toBe(1000);
  });

  it("rejects cancelled", async () => {
    await expect(db.callAs(USER_GM, applySql(RES_CANCELLED, "amount", 10))).rejects.toThrow(
      /cannot be applied to a cancelled reservation/i,
    );
    expect(await rateTotal(db, RES_CANCELLED)).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
describe("authorisation", () => {
  it("allows general_manager, hotel_owner and super_admin", async () => {
    for (const [uid, res] of [
      [USER_GM, RES_CONFIRMED],
      [USER_OWNER, RES_CHECKED_IN],
      [USER_SUPER, RES_PART_PAID],
    ] as const) {
      const rows = await db.callAs<{ id: string }>(uid, applySql(res, "amount", 10));
      expect(rows[0].id).toBeTruthy();
    }
  });

  it("denies front_desk and reservations — NOT inherited from res_write", async () => {
    for (const uid of [USER_FRONT_DESK, USER_RESERVATIONS]) {
      await expect(db.callAs(uid, applySql(RES_CONFIRMED, "amount", 10))).rejects.toThrow(
        /Not authorised/i,
      );
    }
    expect(await rateTotal(db, RES_CONFIRMED)).toBe(1000);
  });

  it("denies an anonymous caller at the grant level", async () => {
    await expect(db.callAs(null, applySql(RES_CONFIRMED, "amount", 10), "anon")).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("enforces property isolation: a GHS manager cannot discount an AUD reservation", async () => {
    await expect(db.callAs(USER_GM, applySql(RES_AUD, "amount", 10))).rejects.toThrow(
      /Not authorised/i,
    );
    expect(await rateTotal(db, RES_AUD)).toBe(1000);
  });

  it("the AUD property's own manager can, and cannot reach the GHS property", async () => {
    await db.callAs(USER_GM_AUD, applySql(RES_AUD, "amount", 10));
    expect(await rateTotal(db, RES_AUD)).toBe(990);
    await expect(db.callAs(USER_GM_AUD, applySql(RES_CONFIRMED, "amount", 10))).rejects.toThrow(
      /Not authorised/i,
    );
  });
});

// ---------------------------------------------------------------------------
describe("currency independence", () => {
  it("the same arithmetic holds for a GHS and an AUD property", async () => {
    await db.callAs(USER_GM, applySql(RES_CONFIRMED, "percentage", 10));
    await db.callAs(USER_GM_AUD, applySql(RES_AUD, "percentage", 10));
    expect(await rateTotal(db, RES_CONFIRMED)).toBe(900);
    expect(await rateTotal(db, RES_AUD)).toBe(900);
  });

  it("stores no currency code — money is a bare numeric, formatted by the caller", async () => {
    await db.callAs(USER_GM_AUD, applySql(RES_AUD, "amount", 100));
    const [d] = await discountRows(db, RES_AUD);
    expect(Object.keys(d)).not.toContain("currency");
    expect(JSON.stringify(d)).not.toMatch(/GHS|AUD|GH₵|\$/);
  });

  it("the AUD property's currency and base_currency genuinely disagree in the fixture", async () => {
    const [p] = await db.callAs<Record<string, unknown>>(
      USER_SUPER,
      `SELECT currency, base_currency FROM properties WHERE id = '${PROP_AUD}'`,
    );
    expect(p.currency).toBe("GHS");
    expect(p.base_currency).toBe("AUD"); // exactly the ThesKwoff Bar hazard
  });
});

// ---------------------------------------------------------------------------
describe("idempotency and concurrency", () => {
  it("the same request_id applies the discount exactly once", async () => {
    const rid = "eeee0000-0000-4000-8000-000000000001";
    const [a] = await db.callAs<{ id: string }>(
      USER_GM,
      applySql(RES_CONFIRMED, "amount", 100, "Loyalty", rid),
    );
    const [b] = await db.callAs<{ id: string }>(
      USER_GM,
      applySql(RES_CONFIRMED, "amount", 100, "Loyalty", rid),
    );
    expect(b.id).toBe(a.id);
    expect(await discountRows(db, RES_CONFIRMED)).toHaveLength(1);
    expect(await rateTotal(db, RES_CONFIRMED)).toBe(900); // not 800
    await assertInvariant(RES_CONFIRMED, 1000);
  });

  it("a double submission posts exactly one folio line", async () => {
    const rid = "eeee0000-0000-4000-8000-000000000002";
    await db.callAs(USER_GM, applySql(RES_CONFIRMED, "percentage", 25, "Promo", rid));
    await db.callAs(USER_GM, applySql(RES_CONFIRMED, "percentage", 25, "Promo", rid));
    const lines = (await chargeRows(db, RES_CONFIRMED)).filter((c) =>
      String(c.description).startsWith("Discount ·"),
    );
    expect(lines).toHaveLength(1);
    expect(num(lines[0].amount)).toBe(-250);
  });

  it("two different requests cannot both spend the same headroom", async () => {
    // 300 outstanding; two 300 discounts must not both succeed.
    await db.callAs(USER_GM, applySql(RES_PART_PAID, "amount", 300, "First"));
    await expect(
      db.callAs(USER_GM, applySql(RES_PART_PAID, "amount", 300, "Second")),
    ).rejects.toThrow(/exceeds the outstanding balance/i);
    expect(await rateTotal(db, RES_PART_PAID)).toBe(700);
  });

  it("a failed attempt leaves nothing behind — the write is atomic", async () => {
    const before = await chargeRows(db, RES_CONFIRMED);
    await expect(db.callAs(USER_GM, applySql(RES_CONFIRMED, "amount", 99999))).rejects.toThrow();
    expect(await chargeRows(db, RES_CONFIRMED)).toHaveLength(before.length);
    expect(await discountRows(db, RES_CONFIRMED)).toHaveLength(0);
    expect(await rateTotal(db, RES_CONFIRMED)).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
describe("reversal", () => {
  async function applyOne(res = RES_CONFIRMED, value = 100) {
    const [row] = await db.callAs<{ id: string }>(USER_GM, applySql(res, "amount", value));
    return row.id;
  }

  it("preserves the original, marks it reversed and posts a compensating charge", async () => {
    const id = await applyOne();
    await db.callAs(USER_GM, reverseSql(id, "Applied in error"));

    const rows = await discountRows(db, RES_CONFIRMED);
    expect(rows).toHaveLength(1); // original preserved, never deleted
    const d = rows[0];
    expect(d.status).toBe("reversed");
    expect(d.reversal_reason).toBe("Applied in error");
    expect(d.reversed_by).toBe(USER_GM);
    expect(d.reversed_at).toBeTruthy();
    expect(d.reversal_charge_id).toBeTruthy();
    expect(num(d.calculated_amount)).toBe(100); // untouched evidence

    const lines = await chargeRows(db, RES_CONFIRMED);
    expect(lines.some((l) => num(l.amount) === -100)).toBe(true); // original negative kept
    expect(
      lines.some(
        (l) => num(l.amount) === 100 && String(l.description).startsWith("Discount reversed ·"),
      ),
    ).toBe(true);

    expect(await rateTotal(db, RES_CONFIRMED)).toBe(1000); // restored
    expect(await folioTotal(db, RES_CONFIRMED)).toBe(1000);
    await assertInvariant(RES_CONFIRMED, 1000);
  });

  it("requires a reversal reason", async () => {
    const id = await applyOne();
    await expect(db.callAs(USER_GM, reverseSql(id, "  "))).rejects.toThrow(/reason is required/i);
  });

  it("is idempotent on its own request_id", async () => {
    const id = await applyOne();
    const rid = "ffff0000-0000-4000-8000-000000000001";
    await db.callAs(USER_GM, reverseSql(id, "Error", rid));
    await db.callAs(USER_GM, reverseSql(id, "Error", rid));
    const lines = (await chargeRows(db, RES_CONFIRMED)).filter((l) =>
      String(l.description).startsWith("Discount reversed ·"),
    );
    expect(lines).toHaveLength(1); // not two compensating charges
    expect(await rateTotal(db, RES_CONFIRMED)).toBe(1000);
  });

  it("refuses to reverse the same discount twice with a new request", async () => {
    const id = await applyOne();
    await db.callAs(USER_GM, reverseSql(id, "Error"));
    await expect(db.callAs(USER_GM, reverseSql(id, "Again"))).rejects.toThrow(
      /already been reversed/i,
    );
  });

  it("denies an unauthorised role", async () => {
    const id = await applyOne();
    await expect(db.callAs(USER_FRONT_DESK, reverseSql(id, "Nope"))).rejects.toThrow(
      /Not authorised/i,
    );
  });

  it("refuses reversal once the reservation is checked out", async () => {
    const id = await applyOne();
    await db.admin(
      `UPDATE public.reservations SET status = 'checked_out' WHERE id = '${RES_CONFIRMED}'`,
    );
    await expect(db.callAs(USER_GM, reverseSql(id, "Too late"))).rejects.toThrow(
      /cannot be reversed on a checked_out reservation/i,
    );
  });

  it("re-opens headroom so a corrected discount can be applied", async () => {
    const id = await applyOne(RES_PART_PAID, 300);
    expect(await outstanding(db, RES_PART_PAID)).toBe(0);
    await db.callAs(USER_GM, reverseSql(id, "Wrong amount"));
    expect(await outstanding(db, RES_PART_PAID)).toBe(300);
    await db.callAs(USER_GM, applySql(RES_PART_PAID, "amount", 150, "Corrected"));
    expect(await rateTotal(db, RES_PART_PAID)).toBe(850);
    await assertInvariant(RES_PART_PAID, 1000);
  });
});

// ---------------------------------------------------------------------------
describe("audit trail", () => {
  it("records an entry on apply, with the financial detail", async () => {
    const [row] = await db.callAs<{ id: string }>(
      USER_GM,
      applySql(RES_CONFIRMED, "percentage", 10, "Loyalty"),
    );
    const logs = await auditRows(db, row.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("create");
    expect(logs[0].actor_id).toBe(USER_GM);
    expect(String(logs[0].memo)).toContain("R-CONF");
    const after = logs[0].after_snapshot as Record<string, unknown>;
    expect(num(after.calculated_amount)).toBe(100);
    expect(num(after.basis_amount)).toBe(1000);
    expect(after.reason).toBe("Loyalty");
  });

  it("records a second entry on reversal", async () => {
    const [row] = await db.callAs<{ id: string }>(USER_GM, applySql(RES_CONFIRMED, "amount", 100));
    await db.callAs(USER_OWNER, reverseSql(row.id, "Applied in error"));
    const logs = await auditRows(db, row.id);
    expect(logs.map((l) => l.action)).toEqual(["create", "delete"]);
    expect(logs[1].actor_id).toBe(USER_OWNER);
    expect((logs[1].after_snapshot as Record<string, unknown>).status).toBe("reversed");
  });

  it("writes no audit entry when the operation is rejected", async () => {
    await expect(
      db.callAs(USER_FRONT_DESK, applySql(RES_CONFIRMED, "amount", 10)),
    ).rejects.toThrow();
    expect(await auditRows(db)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("structural guarantees of the migration", () => {
  const sql = migrationSql(DISCOUNT_MIGRATION).replace(/--[^\n]*/g, "");

  it("both RPCs are SECURITY DEFINER with a pinned search_path", () => {
    expect(
      (sql.match(/SECURITY DEFINER SET search_path = public/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("revokes PUBLIC/anon and grants only authenticated", () => {
    expect((sql.match(/REVOKE ALL ON FUNCTION[\s\S]{0,120}FROM PUBLIC, anon;/g) ?? []).length).toBe(
      3,
    );
    expect(
      (sql.match(/GRANT EXECUTE ON FUNCTION[\s\S]{0,120}TO authenticated;/g) ?? []).length,
    ).toBe(3);
    expect(sql).not.toMatch(/GRANT[\s\S]{0,80}TO\s+anon/i);
  });

  it("never physically deletes a discount", () => {
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.reservation_discounts/i);
    expect(sql).not.toMatch(/FOR\s+DELETE/i);
  });

  it("uses no dynamic SQL", () => {
    expect(sql).not.toMatch(/\bEXECUTE\s+format\b|\bEXECUTE\s+'/i);
  });

  it("gates on the three approved roles only", () => {
    const gates =
      sql.match(/ARRAY\['super_admin','hotel_owner','general_manager'\]::app_role\[\]/g) ?? [];
    expect(gates.length).toBeGreaterThanOrEqual(3); // RLS + both RPCs
    expect(sql).not.toMatch(/'front_desk'/);
    expect(sql).not.toMatch(/'reservations'/);
  });

  it("locks the reservation row and the request before deciding", () => {
    expect((sql.match(/pg_advisory_xact_lock/g) ?? []).length).toBe(2);
    expect((sql.match(/FOR UPDATE/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("hardcodes no currency", () => {
    expect(sql).not.toMatch(/'GHS'|'USD'|'AUD'|GH₵/);
  });
});
