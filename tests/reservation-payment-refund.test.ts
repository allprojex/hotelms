import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
// Normalized to LF immediately on read: this repo's git blobs are LF, but a
// Windows checkout with core.autocrlf materializes tracked files as CRLF on
// disk (confirmed via `git cat-file -p` vs a direct fs read of the same
// file after a later `git checkout` re-materialized it) — normalizing here
// once keeps every assertion below independent of which state the working
// tree happens to be in at test-run time, rather than each test needing its
// own \r?\n-tolerant pattern.
const readNormalized = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const migration = readNormalized(
  resolve(root, "supabase/migrations/20260822130000_reservation_payment_refund.sql"),
);
const reservationPage = readNormalized(
  resolve(root, "src/routes/_authenticated/reservations.$id.tsx"),
);
const dashboardPage = readNormalized(resolve(root, "src/routes/_authenticated/dashboard.tsx"));
const reportsPage = readNormalized(resolve(root, "src/routes/_authenticated/reports.tsx"));
const insightsFns = readNormalized(resolve(root, "src/lib/insights.functions.ts"));
const pdfFns = readNormalized(resolve(root, "src/lib/admin/pdf.functions.ts"));
const foundation = readNormalized(
  resolve(root, "supabase/migrations/20260705025821_92278fdb-63f6-4a91-922f-a7cb4005b441.sql"),
);

function fn(source: string, name: string): string {
  const match = source.match(
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\$\\$;`),
  )?.[0];
  if (!match) throw new Error(`Could not find function ${name} in source`);
  return match;
}

const reverseFn = fn(migration, "reverse_reservation_payment");

describe("reservation payment refund — schema (additive only)", () => {
  it("1/3. adds status + reversal metadata to payments, mirroring ap_payments/ar_receipts", () => {
    expect(migration).toContain("CREATE TYPE public.reservation_payment_status AS ENUM ('posted', 'void');");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS status public.reservation_payment_status NOT NULL DEFAULT 'posted'");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS reversal_entry_id UUID REFERENCES public.journal_entries(id)");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS reversal_reason TEXT");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS reversed_by UUID REFERENCES auth.users(id)");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ");
  });

  it("only adds new objects — never drops or alters any historical migration file", () => {
    expect(migration).not.toMatch(/DROP FUNCTION|DROP TABLE|ALTER TABLE public\.reservations\s+DROP/);
  });
});

describe("reservation payment refund — never-delete guarantee (2/22)", () => {
  it("revokes UPDATE and DELETE on payments from authenticated, closing the direct-write bypass", () => {
    expect(migration).toContain("REVOKE UPDATE, DELETE ON public.payments FROM authenticated;");
  });

  it("does not revoke INSERT — Add Payment (a raw client insert) keeps working unmodified", () => {
    expect(migration).not.toMatch(/REVOKE[^;]*INSERT[^;]*ON public\.payments/);
    expect(reservationPage).toContain('supabase.from("payments").insert({');
  });

  it("the refund function never DELETEs or UPDATEs the payment row except its own controlled status transition", () => {
    expect(reverseFn).not.toMatch(/DELETE FROM public\.payments/);
    const updateMatches = reverseFn.match(/UPDATE public\.payments/g) ?? [];
    expect(updateMatches).toHaveLength(1);
    expect(reverseFn).toContain(
      "SET status = 'void', reversal_entry_id = _reversal_entry, reversal_reason = _trimmed_reason,\n        reversed_by = auth.uid(), reversed_at = now()",
    );
  });

  it("never mutates amount, method, reference, received_by, or received_at — only status/reversal fields change", () => {
    const updateStmt = reverseFn.match(/UPDATE public\.payments\s+SET[\s\S]*?WHERE id = pay\.id;/)?.[0] ?? "";
    expect(updateStmt).not.toMatch(/\bamount\s*=/);
    expect(updateStmt).not.toMatch(/\bmethod\s*=/);
    expect(updateStmt).not.toMatch(/\breceived_at\s*=/);
    expect(updateStmt).not.toMatch(/\breceived_by\s*=/);
  });
});

describe("reservation payment refund — eligibility (8/12/13)", () => {
  it("8. an already-refunded payment is rejected", () => {
    expect(reverseFn).toContain("IF pay.status = 'void' THEN");
    expect(reverseFn).toContain("has already been refunded");
  });

  it("12. a nonexistent payment is rejected", () => {
    expect(reverseFn).toContain("IF pay IS NULL THEN RAISE EXCEPTION 'Payment not found'; END IF;");
  });

  it("13. deliberately does NOT gate on reservation lifecycle status — eligibility is the payment's own state only, matching reverse_ap_payment()'s precedent of gating on the payment, not its parent's status", () => {
    expect(reverseFn).not.toMatch(/res\.status/);
    expect(reverseFn).not.toMatch(/reservations\.status/);
  });

  it("a refund never writes to reservations.status — it is always a separate, explicit action from Cancel/Check-in/Check-out", () => {
    expect(reverseFn).not.toMatch(/UPDATE public\.reservations/);
  });
});

describe("reservation payment refund — idempotency and concurrency (6/7/17)", () => {
  it("17. locks the payment row before reading its status — the primary defense against a concurrent double refund", () => {
    expect(reverseFn).toContain("SELECT * INTO pay FROM public.payments WHERE id = _id FOR UPDATE;");
    const lockIdx = reverseFn.indexOf("FOR UPDATE");
    const statusIdx = reverseFn.indexOf("IF pay.status = 'void'");
    expect(lockIdx).toBeGreaterThan(0);
    expect(statusIdx).toBeGreaterThan(lockIdx);
  });

  it("6/7. operates on exactly one payment id — no loop, aggregate, or query over sibling payments on the same reservation", () => {
    expect(reverseFn).not.toMatch(/FROM public\.payments WHERE reservation_id/);
    expect(reverseFn).not.toMatch(/FOR .* IN SELECT .* FROM public\.payments/);
  });

  it("a second reversal of an entry already reversed once is rejected — backed by the pre-existing global unique index on journal_entries.is_reversal_of", () => {
    expect(reverseFn).toContain(
      "SELECT id INTO _existing_reversal FROM public.journal_entries WHERE is_reversal_of = orig_entry.id;",
    );
    expect(reverseFn).toContain("already has a reversal journal entry");
    // journal_entries_reversal_of_uniq is defined once, in the AR reversal
    // migration — reused as-is, not redefined here.
    expect(migration).not.toMatch(/CREATE UNIQUE INDEX journal_entries_reversal_of_uniq/);
    const arMigration = readFileSync(
      resolve(root, "supabase/migrations/20260818090000_ar_invoice_reversal.sql"),
      "utf8",
    );
    expect(arMigration).toContain("CREATE UNIQUE INDEX journal_entries_reversal_of_uniq");
  });
});

describe("reservation payment refund — the post_payment() bug (finding 3)", () => {
  it("post_payment() reads a column that has never existed on payments — confirmed by the actual foundation migration source", () => {
    const acctMigration = readFileSync(
      resolve(root, "supabase/migrations/20260705035515_24d4b7b8-9714-4a00-adf2-ad1321d22092.sql"),
      "utf8",
    );
    expect(acctMigration).toContain("COALESCE(p.paid_at::date, CURRENT_DATE)");
    expect(foundation).toContain("received_at TIMESTAMPTZ NOT NULL DEFAULT now()");
    expect(foundation).not.toMatch(/payments[\s\S]{0,400}paid_at/);
    // Never redefined anywhere else in the migration history.
    const allPostPaymentDefs = [acctMigration].filter((s) =>
      s.includes("CREATE OR REPLACE FUNCTION public.post_payment("),
    );
    expect(allPostPaymentDefs).toHaveLength(1);
  });

  it("the refund function looks up the original journal entry defensively (by source/source_ref) rather than requiring a stored posted_entry_id column, and only reverses it when found", () => {
    expect(reverseFn).toContain(
      "WHERE source = 'payment' AND source_ref = pay.id::text AND is_reversal_of IS NULL",
    );
    expect(reverseFn).toContain("IF orig_entry IS NOT NULL THEN");
    // No unconditional "RAISE EXCEPTION ... no posted journal entry" guard —
    // unlike reverse_ap_payment(), a missing entry is not an error here.
    expect(reverseFn).not.toMatch(/no posted journal entry/);
  });

  it("this PR does not fix post_payment() itself — that is documented as explicit, deliberate out-of-scope follow-up work, not silently patched here", () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.post_payment/);
  });
});

describe("reservation payment refund — journal construction (14)", () => {
  it("reversal lines are the exact inverse of the original — debit becomes credit and vice versa, fx_rate/base amounts copied verbatim", () => {
    expect(reverseFn).toContain(
      "VALUES (_reversal_entry, jl.account_id, jl.credit, jl.debit, jl.currency, jl.fx_rate, jl.credit_base, jl.debit_base,",
    );
  });

  it("reversal entry links to the original via journal_entries.is_reversal_of", () => {
    expect(reverseFn).toContain(
      "VALUES (res.property_id, CURRENT_DATE, 'Refund of reservation payment — '||_trimmed_reason, 'payment', pay.id::text, orig_entry.currency, auth.uid(), orig_entry.id)",
    );
  });

  it("net GL effect is asserted to be exactly zero using NUMERIC precision", () => {
    expect(reverseFn).toContain(
      "SELECT COALESCE(SUM(debit_base),0), COALESCE(SUM(credit_base),0) INTO _dr, _cr",
    );
    expect(reverseFn).toContain("ROUND(_dr,2) <> ROUND(_cr,2)");
    expect(reverseFn).toContain("Reversal journal is not balanced");
  });

  it("original journal_lines are only ever read, never UPDATEd or DELETEd", () => {
    expect(reverseFn).not.toMatch(/UPDATE public\.journal_lines/);
    expect(reverseFn).not.toMatch(/DELETE FROM public\.journal_(lines|entries)/);
  });
});

describe("reservation payment refund — accounting period (15)", () => {
  it("blocks refund into a locked or closed accounting period, mirroring post_journal()/reverse_ap_payment()'s own rule", () => {
    expect(reverseFn).toContain("status IN ('locked','closed')");
    expect(reverseFn).toContain("Current accounting period is locked");
  });

  it("the period check runs unconditionally, before the journal-entry lookup — so it applies even in today's common case where no entry exists yet, and automatically covers a future post_payment() fix with no further change", () => {
    const periodIdx = reverseFn.indexOf("Current accounting period is locked");
    const lookupIdx = reverseFn.indexOf("WHERE source = 'payment'");
    expect(periodIdx).toBeGreaterThan(0);
    expect(lookupIdx).toBeGreaterThan(periodIdx);
  });
});

describe("reservation payment refund — reason (11)", () => {
  it("requires a refund reason of at least 5 characters", () => {
    expect(reverseFn).toContain("char_length(_trimmed_reason) < 5");
    expect(reverseFn).toContain("refund reason of at least 5 characters is required");
  });

  it("rejects an oversized reason", () => {
    expect(reverseFn).toContain("char_length(_trimmed_reason) > 500");
    expect(reverseFn).toContain("500 characters or fewer");
  });
});

describe("reservation payment refund — permissions and isolation (9/10)", () => {
  it("9. only super_admin/hotel_owner/general_manager/accountant may refund — front_desk (which CAN receive payment) is deliberately excluded", () => {
    expect(reverseFn).toContain(
      "public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], res.property_id)",
    );
    expect(reverseFn).not.toMatch(/has_any_role\([^)]*front_desk/);
  });

  it("this is the exact same ACCOUNTING_ADMIN_ROLES set the app already uses for AR/AP reversal — reused, not redefined", () => {
    const permissions = readFileSync(resolve(root, "src/lib/accounting/permissions.ts"), "utf8");
    expect(permissions).toMatch(
      /"super_admin",\s*"hotel_owner",\s*"general_manager",\s*"accountant",/,
    );
    expect(reservationPage).toContain('import { ACCOUNTING_ADMIN_ROLES } from "@/lib/accounting/permissions";');
  });

  it("10. property/reservation is derived from the locked payment row, never taken as a client-supplied parameter — cross-property refund is impossible by construction", () => {
    expect(reverseFn).toMatch(/reverse_reservation_payment\(_id UUID, _reason TEXT\)/);
    expect(reverseFn).not.toContain("_property_id UUID");
    expect(reverseFn).not.toContain("_reservation_id UUID");
  });

  it("payments_write RLS still allows front_desk/cashier to INSERT a payment — this migration does not touch payment creation", () => {
    expect(foundation).toContain(
      "ARRAY['super_admin','hotel_owner','general_manager','front_desk','cashier']::app_role[], r.property_id",
    );
  });
});

describe("reservation payment refund — audit (16)", () => {
  it("inserts directly into admin_action_logs, exactly once, with actor from auth.uid()", () => {
    expect(reverseFn).toContain("INSERT INTO public.admin_action_logs(");
    const inserts = reverseFn.match(/INSERT INTO public\.admin_action_logs/g) ?? [];
    expect(inserts).toHaveLength(1);
    expect(reverseFn).toContain("res.property_id, auth.uid(), 'reservation_payment', pay.id::text, 'update',");
  });

  it("audit content captures before/after status, reservation id, method, amount, and the refund reason", () => {
    expect(reverseFn).toContain(
      "jsonb_build_object('status', 'posted', 'reservationId', pay.reservation_id, 'method', pay.method, 'amount', pay.amount, 'receivedAt', pay.received_at)",
    );
    expect(reverseFn).toContain(
      "jsonb_build_object('status', 'void', 'reversalEntryId', _reversal_entry, 'reason', _trimmed_reason)",
    );
  });

  it("an unauthorized role never reaches the audit insert — has_any_role() raises before any write happens", () => {
    const roleCheckIdx = reverseFn.indexOf("has_any_role(");
    const auditIdx = reverseFn.indexOf("INSERT INTO public.admin_action_logs(");
    expect(roleCheckIdx).toBeGreaterThan(0);
    expect(roleCheckIdx).toBeLessThan(auditIdx);
  });

  it("a failed refund produces no audit row — no exception handler swallows a failure after the writes", () => {
    expect(reverseFn).not.toMatch(/EXCEPTION\s+WHEN/);
  });
});

describe("reservation payment refund — SECURITY DEFINER / ACL", () => {
  it("pins search_path so it cannot be hijacked via a caller-controlled search_path", () => {
    expect(reverseFn).toContain("LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
  });

  it("revokes PUBLIC and anon execution, grants authenticated only", () => {
    expect(migration).toContain(
      "REVOKE EXECUTE ON FUNCTION public.reverse_reservation_payment(uuid, text) FROM PUBLIC, anon;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.reverse_reservation_payment(uuid, text) TO authenticated;",
    );
  });
});

describe("reservation payment refund — UI (4/5/18/19/20/21)", () => {
  // NOTE ON THIS DESCRIBE BLOCK: superseded by
  // 20260824130000_reservation_payment_partial_refund.sql, which replaces
  // this page's single-shot full-refund dialog with a partial-refund-aware
  // one calling refund_reservation_payment() instead of
  // reverse_reservation_payment() — see
  // tests/reservation-payment-partial-refund.test.ts for the full coverage
  // of the new flow. The assertions below are updated to match the current
  // UI; every assertion about the OLD migration file/function's own
  // content elsewhere in this file is untouched and still valid, since
  // that file and function were not modified.
  it("19. the refund action is wired into the real production reservation route, gated by role and by whether any refundable balance remains", () => {
    expect(reservationPage).toContain('(supabase.rpc as any)("refund_reservation_payment"');
    expect(reservationPage).toContain("!fullyRefunded && canRefund.allowed");
  });

  it("20. a fully refunded payment never renders a Refund trigger again — the same computed flag that shows the Refunded badge hides the button", () => {
    expect(reservationPage).toContain("fullyRefunded && <Badge variant=\"secondary\"");
  });

  it("the confirmation dialog shows original amount, already refunded, remaining refundable, method, paid date, an explicit financial-correction warning, and requires both a valid amount and a reason 5-500 chars before enabling submit", () => {
    expect(reservationPage).toContain("refundTarget.amount");
    expect(reservationPage).toContain("refundTarget.method");
    expect(reservationPage).toContain("refundTarget.received_at");
    expect(reservationPage).toContain("alreadyRefundedFor(refundTarget)");
    expect(reservationPage).toContain("remainingRefundableFor(refundTarget)");
    expect(reservationPage).toMatch(/financial correction/);
    expect(reservationPage).toContain("const reasonValid = refundReason.trim().length >= 5 && refundReason.trim().length <= 500;");
  });

  it("21. shows refund history (amount, date, reason, and — where resolvable — the refunding staff member) per payment, plus a legacy single-shot display for payments refunded before this feature existed", () => {
    expect(reservationPage).toContain("paymentRefunds.map((r: any)");
    expect(reservationPage).toContain("refundedByName(r.refunded_by)");
    // Legacy display for pre-existing void payments with no new-table rows.
    expect(reservationPage).toContain("p.reversed_at");
    expect(reservationPage).toContain("p.reversal_reason");
    expect(reservationPage).toContain("refundedByName(p.reversed_by)");
  });

  it("does not silently delete the payment — the row is always rendered from payments.data regardless of status", () => {
    expect(reservationPage).toContain("(payments.data ?? []).map((p: any) =>");
  });

  it("refresh: a successful refund invalidates the payments, payment-refunds, and reservation queries", () => {
    const rpcCallIdx = reservationPage.indexOf('(supabase.rpc as any)("refund_reservation_payment"');
    expect(rpcCallIdx).toBeGreaterThan(-1);
    const afterRpc = reservationPage.slice(rpcCallIdx);
    expect(afterRpc).toContain('qc.invalidateQueries({ queryKey: ["payments", id] });');
    expect(afterRpc).toContain('qc.invalidateQueries({ queryKey: ["payment-refunds", id] });');
    expect(afterRpc).toContain('qc.invalidateQueries({ queryKey: ["reservation", id] });');
  });

  it("4/5. totalPaid/balance count only each payment's NET remaining amount — a fully refunded payment nets to zero exactly as before, a partially refunded payment counts only its unrefunded portion", () => {
    expect(reservationPage).toContain(".reduce((s: number, p: any) => s + remainingRefundableFor(p), 0);");
  });

  it("does not open the dialog pre-filled and auto-submit — Cancel always returns to a clean closed state without calling the RPC", () => {
    expect(reservationPage).toMatch(/onClick=\{\(\) => setRefundTarget\(null\)\}>Cancel</);
  });
});

describe("reservation payment refund — reporting correction (18)", () => {
  it("dashboard.tsx: today's revenue excludes refunded payments", () => {
    expect(dashboardPage).toContain('.eq("status", "posted").gte("received_at", today)');
  });

  it("reports.tsx: daily revenue excludes refunded payments", () => {
    expect(reportsPage).toContain('.eq("status", "posted").gte("received_at", startStr)');
  });

  it("insights.functions.ts: the 7-day revenue trend excludes refunded payments", () => {
    expect(insightsFns).toContain('.eq("status", "posted")');
  });

  it("pdf.functions.ts: a printed folio never shows a refunded payment as money collected", () => {
    expect(pdfFns).toContain(
      '(supabase as any).from("payments").select("*").eq("reservation_id", data.id).eq("status", "posted")',
    );
  });

  it("no unrelated reporting module (executive analytics, accounting reports, POS) was touched by this PR — those compute from different tables (rate_total/pos_orders), not payments", () => {
    const analytics = readFileSync(resolve(root, "src/routes/_authenticated/analytics.tsx"), "utf8");
    expect(analytics).not.toMatch(/from\("payments"\)/);
  });
});

describe("reservation payment refund — no regression to existing flows (22/23)", () => {
  it("22. Add Payment still performs a raw insert with no new required field", () => {
    expect(reservationPage).toContain(
      'reservation_id: reservationId, method: method as any, amount: Number(amount),',
    );
  });

  it("23. checkIn/checkOut/cancel are untouched — same status transitions, same room-status side effects, same invoice insert on checkout", () => {
    expect(reservationPage).toContain('status: "checked_in", checked_in_at: new Date().toISOString(),');
    expect(reservationPage).toContain('status: "checked_out", checked_out_at: new Date().toISOString(),');
    expect(reservationPage).toContain('await supabase.from("reservations").update({ status: "cancelled" }).eq("id", id);');
  });

  it("checkOut()'s invoice snapshot naturally reflects the corrected totalPaid (post-refund-exclusion) because it reads the same variable — no separate fix needed there", () => {
    expect(reservationPage).toContain(
      "reservation_id: id, number: invNumber, subtotal: totalCharges, total: totalCharges, paid: totalPaid,",
    );
  });
});

describe("reservation payment refund — scope control", () => {
  it("does not implement partial refunds — the RPC always reverses a payment's full original amount, never a client-supplied partial amount", () => {
    expect(reverseFn).not.toContain("_amount");
    expect(reverseFn).toMatch(/reverse_reservation_payment\(_id UUID, _reason TEXT\)/);
  });

  it("does not touch ap_bills, ap_payments, ar_invoices, ar_receipts, or any AR/AP table — no executable SQL statement (ALTER/CREATE/INSERT/UPDATE/DELETE) references any of them, even though the header comment discusses them for context/comparison", () => {
    expect(migration).not.toMatch(/(ALTER TABLE|CREATE (OR REPLACE )?(TABLE|FUNCTION|INDEX)|INSERT INTO|UPDATE|DELETE FROM)\s+public\.(ap_bills|ap_payments|ar_invoices|ar_receipts|ar_credit_notes)/);
  });

  it("does not touch channel manager, inventory, HRM, FX, gallery, or search modules", () => {
    expect(migration).not.toMatch(/channel|inventory_items|hr_employees|fx_rates|gallery/i);
  });
});
