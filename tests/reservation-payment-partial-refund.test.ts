import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Reservation Refund PR1 — partial/repeated-partial refund of a reservation
// payment, extending the existing full-refund-only
// reverse_reservation_payment() (20260822130000) with a new,
// partial-refund-aware refund_reservation_payment(). See
// 20260824130000_reservation_payment_partial_refund.sql's own header for
// the full Phase 1 audit and design rationale.
//
// This suite follows the same structural (source-text) convention as
// tests/reservation-payment-refund.test.ts and
// tests/reservation-item-distribution-ui.test.ts — vitest runs in a `node`
// environment (see vitest.config.ts), with no live database wired into the
// automated suite. The fully behavioral claims below (idempotent replay,
// genuine concurrent double-submit serialization, cannot exceed remaining
// balance under concurrency, balanced accounting entries, audit event
// created exactly once, original payment immutability, multiple partial
// refunds summing correctly, wrong-property/unauthorized rejection) were
// additionally verified live against a real local disposable Postgres
// replaying this repo's full migration history end to end — see the
// incident/implementation report for the exact commands and results. That
// live pass is a manual authoring-time verification (matching this repo's
// established convention), not re-run by `vitest run`.
//
// Replay authorization / validation ordering fix (findings 16-18) — also
// live-verified against a real local disposable Postgres: an unauthorized
// actor's exact replay is rejected with no refund id returned and no
// mutation; a same-property actor holding a role on a DIFFERENT property is
// rejected identically; a replay with a fractional-cent amount is rejected
// by amount validation before ever reaching the idempotency comparison
// (never rounds into apparent equality with a prior valid request); a
// negative-amount replay and a too-short-reason replay are each rejected by
// their own validation for the same reason; an exact valid replay and a
// replay differing only by incidental reason whitespace both return the
// same refund id with no second financial effect; and an exact, authorized
// replay of the refund call that itself completed a payment's full refund
// still returns the same id despite payments.status already being 'void'.

const root = resolve(__dirname, "..");
function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const migration = read(
  resolve(root, "supabase/migrations/20260824130000_reservation_payment_partial_refund.sql"),
);
const oldMigration = read(
  resolve(root, "supabase/migrations/20260822130000_reservation_payment_refund.sql"),
);
const reservationPage = read(resolve(root, "src/routes/_authenticated/reservations.$id.tsx"));
const dashboardPage = read(resolve(root, "src/routes/_authenticated/dashboard.tsx"));
const reportsPage = read(resolve(root, "src/routes/_authenticated/reports.tsx"));
const insightsFns = read(resolve(root, "src/lib/insights.functions.ts"));
const pdfFns = read(resolve(root, "src/lib/admin/pdf.functions.ts"));

function fn(source: string, name: string): string {
  const match = source.match(
    new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}[\\s\\S]*?\\$\\$;`),
  )?.[0];
  if (!match) throw new Error(`Could not find function ${name} in source`);
  return match;
}

const refundFn = fn(migration, "refund_reservation_payment");

describe("partial refund — schema (additive only)", () => {
  it("adds reservation_payment_refunds as an event-ledger table, never a mutable running total on payments", () => {
    expect(migration).toContain("CREATE TABLE public.reservation_payment_refunds (");
    expect(migration).toContain(
      "payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT",
    );
    expect(migration).toContain("amount NUMERIC NOT NULL CHECK (amount > 0)");
    expect(migration).toContain("reason TEXT NOT NULL");
    expect(migration).toContain("reversal_entry_id UUID REFERENCES public.journal_entries(id)");
    expect(migration).toContain("refunded_by UUID NOT NULL REFERENCES auth.users(id)");
    expect(migration).toContain("request_id UUID NOT NULL");
    expect(migration).not.toMatch(/ALTER TABLE public\.payments\s+ADD COLUMN/);
  });

  it("does not drop or alter any historical object, and does not touch the old migration file at all", () => {
    expect(migration).not.toMatch(/DROP FUNCTION|DROP TABLE|ALTER TABLE public\.reservations/);
    // Byte-for-byte untouched — this migration never redefines it.
    expect(migration).not.toMatch(
      /CREATE (OR REPLACE )?FUNCTION public\.reverse_reservation_payment/,
    );
  });

  it("idempotency key is unique per property, mirroring reservation_item_distributions' exact pattern", () => {
    expect(migration).toContain("UNIQUE (property_id, request_id)");
  });
});

describe("partial refund — retiring the old entrypoint without touching it (finding 9)", () => {
  it("revokes authenticated EXECUTE on the OLD full-refund RPC — grants-only, no body/signature change", () => {
    expect(migration).toContain(
      "REVOKE EXECUTE ON FUNCTION public.reverse_reservation_payment(uuid, text) FROM authenticated;",
    );
  });

  it("the old migration's own function body is completely unrepresented in the new migration — confirms no accidental redefinition", () => {
    const oldFnBody = fn(oldMigration, "reverse_reservation_payment");
    expect(migration).not.toContain(oldFnBody);
  });

  it("the old RPC keeps its original PUBLIC/anon revoke and authenticated grant in ITS OWN file, unmodified — only a later, separate REVOKE narrows it further", () => {
    expect(oldMigration).toContain(
      "REVOKE EXECUTE ON FUNCTION public.reverse_reservation_payment(uuid, text) FROM PUBLIC, anon;",
    );
    expect(oldMigration).toContain(
      "GRANT EXECUTE ON FUNCTION public.reverse_reservation_payment(uuid, text) TO authenticated;",
    );
  });
});

describe("partial refund — the journal_entries_reversal_of_uniq constraint conflict, and its resolution (finding 3)", () => {
  it("never sets is_reversal_of for a partial-refund journal entry — uses a new source tag + source_ref instead", () => {
    expect(refundFn).toContain("'payment_refund', _refund_id::text");
    expect(refundFn).not.toMatch(/is_reversal_of\)\s*\n?\s*VALUES/);
    // No is_reversal_of column is ever populated by an INSERT in this function.
    const insertEntryStmt =
      refundFn.match(/INSERT INTO public\.journal_entries\([\s\S]*?\);/)?.[0] ?? "";
    expect(insertEntryStmt).not.toMatch(/is_reversal_of/);
  });

  it("does not touch journal_entries_reversal_of_uniq or any AR/AP reversal object in an actual SQL statement (the header comment discusses them for context/comparison, which is fine — only executable statements matter here)", () => {
    const withoutComments = migration.replace(/--[^\n]*/g, "");
    expect(withoutComments).not.toMatch(/journal_entries_reversal_of_uniq/);
    expect(withoutComments).not.toMatch(
      /reverse_ar_invoice|reverse_ap_payment|reverse_ap_bill|ar_credit_notes/,
    );
  });
});

describe("partial refund — eligibility, amount validation, and remaining-balance authority", () => {
  it("rejects a nonexistent payment", () => {
    expect(refundFn).toContain("IF pay IS NULL THEN RAISE EXCEPTION 'Payment not found'; END IF;");
  });

  it("rejects a payment already fully refunded via EITHER path (defensive pay.status check, independent of this table's own SUM)", () => {
    const statusCheckIdx = refundFn.indexOf("IF pay.status = 'void' THEN");
    expect(statusCheckIdx).toBeGreaterThan(-1);
    expect(refundFn).toContain("already been fully refunded");
  });

  it("computes remaining refundable balance as payment.amount minus the SUM of this payment's own refund rows — never a client-supplied or stored total", () => {
    expect(refundFn).toContain(
      "SELECT COALESCE(SUM(amount), 0) INTO _already_refunded\n    FROM public.reservation_payment_refunds WHERE payment_id = pay.id;",
    );
    expect(refundFn).toContain("_remaining := ROUND(pay.amount - _already_refunded, 2);");
  });

  it("rejects zero and negative amounts", () => {
    expect(refundFn).toContain("IF _amount IS NULL OR _amount <= 0 THEN");
    expect(refundFn).toContain("Refund amount must be greater than zero");
  });

  it("rejects a fractional-cent amount at the RPC layer, and again at the database layer via a hard CHECK constraint — not just a courtesy check", () => {
    expect(refundFn).toContain("IF ROUND(_amount, 2) <> _amount THEN");
    expect(refundFn).toContain("Refund amount cannot have fractional cents");
    expect(migration).toContain(
      "CONSTRAINT reservation_payment_refunds_amount_no_fractional_cents CHECK (amount = ROUND(amount, 2))",
    );
  });

  it("rejects an amount exceeding the remaining refundable balance using an exact-cent comparison, with no 0.005 tolerance band — NUMERIC is exact decimal arithmetic, not float", () => {
    expect(refundFn).toContain("IF _amount > _remaining THEN");
    expect(refundFn).toContain("Refund amount exceeds remaining refundable balance");
    expect(refundFn).not.toMatch(/_remaining\s*\+\s*0\.005/);
    expect(refundFn).not.toMatch(/_remaining\s*<=\s*0\.005/);
  });

  it("the remaining-balance check happens strictly after locking the payment row and computing the fresh SUM — never before", () => {
    const lockIdx = refundFn.indexOf("FOR UPDATE");
    const sumIdx = refundFn.indexOf("INTO _already_refunded");
    const checkIdx = refundFn.indexOf("IF _amount > _remaining THEN");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(sumIdx).toBeGreaterThan(lockIdx);
    expect(checkIdx).toBeGreaterThan(sumIdx);
  });

  it("requires a refund reason of 5-500 characters, identical thresholds/messages to the original full-refund RPC", () => {
    expect(refundFn).toContain("char_length(_trimmed_reason) < 5");
    expect(refundFn).toContain("char_length(_trimmed_reason) > 500");
  });
});

describe("partial refund — concurrency and idempotency", () => {
  it("locks the payment row before computing the refundable balance — the database, not the client, is authoritative against two concurrent refunds over-spending the balance", () => {
    expect(refundFn).toContain(
      "SELECT * INTO pay FROM public.payments WHERE id = _payment_id FOR UPDATE;",
    );
  });

  it("requires a caller-supplied request id and takes an advisory transaction lock keyed on it, mirroring issue_reservation_item()'s exact pattern — serializes even two truly concurrent identical calls", () => {
    expect(refundFn).toContain("IF _request_id IS NULL THEN");
    expect(refundFn).toContain(
      "PERFORM pg_advisory_xact_lock(hashtextextended(_request_id::text, 0));",
    );
  });

  it("authorization runs BEFORE the idempotent-replay lookup, and therefore before any possible early RETURN of an existing refund id — a replay is still a call to a protected financial operation", () => {
    const lockCallIdx = refundFn.indexOf("pg_advisory_xact_lock");
    const roleCheckIdx = refundFn.indexOf("has_any_role(");
    const existingCheckIdx = refundFn.indexOf(
      "SELECT * INTO existing FROM public.reservation_payment_refunds",
    );
    expect(lockCallIdx).toBeGreaterThan(-1);
    expect(roleCheckIdx).toBeGreaterThan(lockCallIdx);
    expect(existingCheckIdx).toBeGreaterThan(roleCheckIdx);
    expect(refundFn).toContain("IF existing.id IS NOT NULL THEN");
    expect(refundFn).toContain("existing.payment_id = _payment_id");
    expect(refundFn).toContain("existing.amount = _amount");
    expect(refundFn).not.toMatch(/ROUND\(existing\.amount,\s*2\)\s*=\s*ROUND\(_amount,\s*2\)/);
    expect(refundFn).toContain("existing.reason = _trimmed_reason");
    expect(refundFn).toContain("RETURN existing.id;");
  });

  it("reason and amount are fully normalized and validated (length, positivity, fractional cents) BEFORE the payload is compared against an existing row — a malformed retry cannot round or truncate into apparent equality with a prior valid request", () => {
    const roleCheckIdx = refundFn.indexOf("has_any_role(");
    const normalizeIdx = refundFn.indexOf(
      "_trimmed_reason := regexp_replace(btrim(COALESCE(_reason, '')), '\\s+', ' ', 'g');",
    );
    const reasonLenIdx = refundFn.indexOf("char_length(_trimmed_reason) < 5");
    const amountPositiveIdx = refundFn.indexOf("IF _amount IS NULL OR _amount <= 0 THEN");
    const fractionalCentIdx = refundFn.indexOf("IF ROUND(_amount, 2) <> _amount THEN");
    const idempotencyIdx = refundFn.indexOf(
      "SELECT * INTO existing FROM public.reservation_payment_refunds",
    );
    expect(roleCheckIdx).toBeGreaterThan(-1);
    expect(normalizeIdx).toBeGreaterThan(roleCheckIdx);
    expect(reasonLenIdx).toBeGreaterThan(normalizeIdx);
    expect(amountPositiveIdx).toBeGreaterThan(reasonLenIdx);
    expect(fractionalCentIdx).toBeGreaterThan(amountPositiveIdx);
    expect(idempotencyIdx).toBeGreaterThan(fractionalCentIdx);
  });

  it("a request id reused with a different payment/amount/reason raises an explicit, named conflict — never silently returns an unrelated refund's id or silently creates a second refund", () => {
    expect(refundFn).toContain("was already used for a different refund");
    expect(refundFn).toContain("reuse a request id only to retry the exact same refund");
  });

  it("the payment-status void check runs AFTER the idempotent-replay lookup, applying only to a genuinely new refund event — an exact replay of the refund that itself fully refunded the payment must still return the same id, not be blocked by this guard", () => {
    const idempotencyIdx = refundFn.indexOf(
      "SELECT * INTO existing FROM public.reservation_payment_refunds",
    );
    const voidCheckIdx = refundFn.indexOf("IF pay.status = 'void' THEN");
    expect(idempotencyIdx).toBeGreaterThan(-1);
    expect(voidCheckIdx).toBeGreaterThan(idempotencyIdx);
  });

  it("the idempotency key is scoped by property, backed by a real UNIQUE(property_id, request_id) constraint at the DB level, not just the advisory lock", () => {
    expect(migration).toContain("UNIQUE (property_id, request_id)");
  });
});

describe("partial refund — property isolation and permissions", () => {
  it("property/reservation is derived from the locked payment row, never a client-supplied parameter — cross-property refund is impossible by construction", () => {
    expect(refundFn).toMatch(
      /refund_reservation_payment\(\s*_payment_id UUID, _amount NUMERIC, _reason TEXT, _request_id UUID\s*\)/,
    );
    expect(refundFn).not.toContain("_property_id UUID");
    expect(refundFn).not.toContain("_reservation_id UUID");
  });

  it("reuses the exact ACCOUNTING_ADMIN_ROLES set (super_admin/hotel_owner/general_manager/accountant) — front_desk deliberately excluded, not redesigned", () => {
    expect(refundFn).toContain(
      "public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], res.property_id)",
    );
    expect(refundFn).not.toMatch(/has_any_role\([^)]*front_desk/);
  });

  it("is SECURITY DEFINER with search_path pinned, revoked from PUBLIC/anon, granted to authenticated only", () => {
    expect(refundFn).toContain("LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(migration).toContain(
      "REVOKE EXECUTE ON FUNCTION public.refund_reservation_payment(uuid, numeric, text, uuid) FROM PUBLIC, anon;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.refund_reservation_payment(uuid, numeric, text, uuid) TO authenticated;",
    );
  });

  it("the new refunds table is read-only to authenticated — every write goes through the guarded RPC, never a raw client insert", () => {
    expect(migration).toContain(
      "GRANT SELECT ON public.reservation_payment_refunds TO authenticated;",
    );
    expect(migration).not.toMatch(
      /GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*ON public\.reservation_payment_refunds TO authenticated/,
    );
  });

  it("row-level security scopes read access by property, matching can_access_property's established convention", () => {
    expect(migration).toContain(
      "CREATE POLICY reservation_payment_refunds_read ON public.reservation_payment_refunds FOR SELECT TO authenticated\n  USING (public.can_access_property(auth.uid(), property_id));",
    );
  });
});

describe("partial refund — original-payment immutability", () => {
  it("never UPDATEs amount, method, reference, received_by, or received_at on payments — only status, and only via a CASE that may leave it unchanged", () => {
    const updateStmt =
      refundFn.match(/UPDATE public\.payments\s+SET[\s\S]*?WHERE id = pay\.id;/)?.[0] ?? "";
    expect(updateStmt).not.toMatch(/\bamount\s*=/);
    expect(updateStmt).not.toMatch(/\bmethod\s*=/);
    expect(updateStmt).not.toMatch(/\breceived_at\s*=/);
    expect(updateStmt).not.toMatch(/\breceived_by\s*=/);
    expect(updateStmt).toContain("SET status = CASE WHEN");
  });

  it("never DELETEs the payment row, and updates it at most once", () => {
    expect(refundFn).not.toMatch(/DELETE FROM public\.payments/);
    const updates = refundFn.match(/UPDATE public\.payments/g) ?? [];
    expect(updates).toHaveLength(1);
  });

  it("status only flips to 'void' once the running total reaches the full original amount at the exact cent — no tolerance band — otherwise it is left exactly as it was (still 'posted' for a genuine partial)", () => {
    expect(refundFn).toContain(
      "ROUND(_already_refunded + _amount, 2) >= ROUND(pay.amount, 2) THEN 'void'::public.reservation_payment_status ELSE pay.status END",
    );
    expect(refundFn).not.toMatch(/pay\.amount\s*-\s*0\.005/);
  });

  it("never mutates or deletes original journal_lines — only reads them to build new, separate reversal lines", () => {
    expect(refundFn).not.toMatch(/UPDATE public\.journal_lines/);
    expect(refundFn).not.toMatch(/DELETE FROM public\.journal_(lines|entries)/);
  });
});

describe("partial refund — accounting treatment: exact partial reversal, guarded shape assumption, balance assertion", () => {
  it("verifies the original entry has exactly two lines each equal to the full payment amount before computing an exact (non-prorated) partial reversal", () => {
    expect(refundFn).toContain("SELECT count(*), COALESCE(SUM(debit),0), COALESCE(SUM(credit),0)");
    expect(refundFn).toContain("_orig_line_count <> 2");
    expect(refundFn).toContain("does not have the expected two-line, full-amount shape");
  });

  it("each reversal line is valued at the requested _amount directly, not a ratio/division of the original line's own value — avoids any NUMERIC-division rounding residue", () => {
    expect(refundFn).not.toMatch(/_amount\s*\/\s*pay\.amount/);
    expect(refundFn).not.toMatch(/jl\.(debit|credit)\s*\*\s*\(/);
    expect(refundFn).toContain("CASE WHEN jl.credit > 0 THEN _amount ELSE 0 END");
    expect(refundFn).toContain("CASE WHEN jl.debit > 0 THEN _amount ELSE 0 END");
  });

  it("asserts the new reversal entry is balanced (DR = CR) using ROUND(...,2) NUMERIC comparison before returning", () => {
    expect(refundFn).toContain(
      "SELECT COALESCE(SUM(debit_base),0), COALESCE(SUM(credit_base),0) INTO _dr, _cr",
    );
    expect(refundFn).toContain("ROUND(_dr,2) <> ROUND(_cr,2)");
    expect(refundFn).toContain("Reversal journal is not balanced");
  });

  it("skips journal creation entirely (reversal_entry_id stays NULL) when no original entry exists — matches the original refund RPC's own documented, still-current finding 6", () => {
    expect(refundFn).toContain("IF orig_entry.id IS NOT NULL THEN");
    expect(refundFn).not.toMatch(/no posted journal entry/);
  });

  it("accounting period lock check runs unconditionally, before the journal-entry lookup", () => {
    const periodIdx = refundFn.indexOf("Current accounting period is locked");
    const lookupIdx = refundFn.indexOf("WHERE source = 'payment'");
    expect(periodIdx).toBeGreaterThan(-1);
    expect(lookupIdx).toBeGreaterThan(periodIdx);
  });
});

describe("partial refund — audit", () => {
  it("inserts into admin_action_logs exactly once, with actor from auth.uid(), after the permission check", () => {
    const inserts = refundFn.match(/INSERT INTO public\.admin_action_logs/g) ?? [];
    expect(inserts).toHaveLength(1);
    const roleCheckIdx = refundFn.indexOf("has_any_role(");
    const auditIdx = refundFn.indexOf("INSERT INTO public.admin_action_logs(");
    expect(roleCheckIdx).toBeGreaterThan(-1);
    expect(roleCheckIdx).toBeLessThan(auditIdx);
  });

  it("audit content captures the payment, reservation, amount already refunded before this event, the new refund amount, its reversal entry (if any), reason, and request id", () => {
    expect(refundFn).toContain(
      "jsonb_build_object('paymentId', pay.id, 'reservationId', pay.reservation_id, 'paymentAmount', pay.amount, 'alreadyRefundedBefore', _already_refunded)",
    );
    expect(refundFn).toContain(
      "jsonb_build_object('refundId', _refund_id, 'amount', _amount, 'reversalEntryId', _entry_id, 'reason', _trimmed_reason, 'requestId', _request_id)",
    );
  });

  it("a failed refund produces no audit row — no exception handler swallows a failure after the writes (an uncaught RAISE aborts the whole transaction, refund row and audit row included)", () => {
    expect(refundFn).not.toMatch(/EXCEPTION\s+WHEN/);
  });
});

describe("partial refund — UI: identifying the payment, amounts, mandatory reason, confirmation, history", () => {
  it("the operator can see original amount, already-refunded amount, and remaining refundable amount in the refund dialog", () => {
    expect(reservationPage).toContain("Original amount");
    expect(reservationPage).toContain("Already refunded");
    expect(reservationPage).toContain("Remaining refundable");
  });

  it("the amount input is bounded to the remaining refundable amount using an exact-cents comparison — no 0.005 tolerance, matching the RPC's exact-cent semantics", () => {
    expect(reservationPage).toContain("max={remaining}");
    expect(reservationPage).toContain(
      "Math.round(parsedAmount * 100) <= Math.round(remaining * 100)",
    );
    expect(reservationPage).not.toMatch(/parsedAmount\s*<=\s*remaining\s*\+\s*0\.005/);
  });

  it("rejects fractional-cent input in the refund amount field before it can be submitted", () => {
    const occurrences = reservationPage.match(/hasExactCents = \/\^\\d\+\(\\\.\\d\{1,2\}\)\?\$\/\.test\(refundAmount\.trim\(\)\)/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
    expect(reservationPage).toContain("hasExactCents &&");
  });

  it("reason remains mandatory (5-500 chars) alongside the new amount validation — submit requires BOTH", () => {
    expect(reservationPage).toContain("return !amountValid || !reasonValid;");
  });

  it("double-submit protection: a fresh idempotency key is generated only when the dialog opens for a given payment, reused across any repeated click while it stays open, and the confirm button is disabled while busy", () => {
    expect(reservationPage).toContain("setRefundRequestId(crypto.randomUUID());");
    expect(reservationPage).toContain("_request_id: refundRequestId");
    expect(reservationPage).toContain("if (!refundTarget || refundBusy) return true;");
  });

  it("refund history is rendered per payment from the new table, plus a legacy fallback for pre-existing void payments with no such rows", () => {
    expect(reservationPage).toContain("refundsFor(p.id)");
    expect(reservationPage).toContain("paymentRefunds.length === 0 && p.reversal_reason");
  });

  it("shows a distinct 'Partially refunded' indicator separate from the fully-refunded 'Refunded' badge", () => {
    expect(reservationPage).toContain('partiallyRefunded && <Badge variant="outline"');
    expect(reservationPage).toMatch(/Partially refunded/);
  });
});

describe("partial refund — reporting correction: partially refunded payments count only their net remaining amount", () => {
  it("dashboard.tsx nets today's revenue against reservation_payment_refunds for the same payment ids", () => {
    expect(dashboardPage).toContain('.eq("status", "posted").gte("received_at", today)');
    expect(dashboardPage).toContain('(supabase.from as any)("reservation_payment_refunds")');
    expect(dashboardPage).toContain(
      "Math.max(0, Number(r.amount || 0) - (refundedByPayment.get(r.id) ?? 0))",
    );
  });

  it("reports.tsx nets daily revenue the same way", () => {
    expect(reportsPage).toContain('.eq("status", "posted").gte("received_at", startStr)');
    expect(reportsPage).toContain('(supabase.from as any)("reservation_payment_refunds")');
    expect(reportsPage).toContain(
      "netAmount: Math.max(0, Number(p.amount) - (refundedByPayment.get(p.id) ?? 0))",
    );
  });

  it("insights.functions.ts nets the 7-day revenue trend the same way", () => {
    expect(insightsFns).toContain('.eq("status", "posted")');
    expect(insightsFns).toContain('(supabase.from as any)("reservation_payment_refunds")');
  });

  it("pdf.functions.ts nets a printed folio's payment lines and total the same way — a partial refund is never shown as full money collected", () => {
    expect(pdfFns).toContain(
      '(supabase as any).from("payments").select("*").eq("reservation_id", data.id).eq("status", "posted")',
    );
    expect(pdfFns).toContain('(supabase.from as any)("reservation_payment_refunds")');
    expect(pdfFns).toContain(
      "netAmount: Math.max(0, Number(x.amount) - (refundedByPayment.get(x.id) ?? 0))",
    );
  });

  it("no unrelated reporting module (executive analytics, accounting reports, POS) was touched", () => {
    const analytics = readFileSync(
      resolve(root, "src/routes/_authenticated/analytics.tsx"),
      "utf8",
    );
    expect(analytics).not.toMatch(/reservation_payment_refunds/);
  });
});

describe("partial refund — scope control", () => {
  it("does not touch ap_bills, ap_payments, ar_invoices, ar_receipts, ar_credit_notes, or any AR/AP table", () => {
    expect(migration).not.toMatch(
      /(ALTER TABLE|CREATE (OR REPLACE )?(TABLE|FUNCTION|INDEX)|INSERT INTO|UPDATE|DELETE FROM)\s+public\.(ap_bills|ap_payments|ar_invoices|ar_receipts|ar_credit_notes)/,
    );
  });

  it("does not touch channel manager, inventory, HRM, FX, gallery, or search modules", () => {
    expect(migration).not.toMatch(/channel|inventory_items|hr_employees|fx_rates|gallery/i);
  });

  it("does not touch reservation_charges, checkIn/checkOut/cancel logic, or Add Payment", () => {
    expect(reservationPage).toContain(
      "reservation_id: reservationId, method: method as any, amount: Number(amount),",
    );
    expect(reservationPage).toContain(
      'status: "checked_in", checked_in_at: new Date().toISOString(),',
    );
    expect(reservationPage).toContain(
      'status: "checked_out", checked_out_at: new Date().toISOString(),',
    );
    expect(reservationPage).toContain(
      'await supabase.from("reservations").update({ status: "cancelled" }).eq("id", id);',
    );
  });
});
