import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
// Normalized to LF immediately on read — a Windows checkout with
// core.autocrlf can re-materialize tracked (LF-in-git) files as CRLF on
// disk depending on when/how they were last checked out, independent of
// this file's own content. Normalizing once here keeps every assertion
// below independent of that checkout-time state. See
// tests/reservation-payment-refund.test.ts for the concrete case this was
// discovered from.
const readNormalized = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const migration = readNormalized(
  resolve(root, "supabase/migrations/20260823090000_reservation_payment_ledger_posting_fix.sql"),
);
const foundation = readNormalized(
  resolve(root, "supabase/migrations/20260705035515_24d4b7b8-9714-4a00-adf2-ad1321d22092.sql"),
);
const paymentsFoundation = readNormalized(
  resolve(root, "supabase/migrations/20260705025821_92278fdb-63f6-4a91-922f-a7cb4005b441.sql"),
);
const refundMigration = readNormalized(
  resolve(root, "supabase/migrations/20260822130000_reservation_payment_refund.sql"),
);
const auditDiagnostic = readNormalized(
  resolve(root, "supabase/diagnostics/20260823_reservation_payment_ledger_audit.sql"),
);
const backfillProposal = readNormalized(
  resolve(root, "supabase/diagnostics/20260823_reservation_payment_backfill_PROPOSAL.sql"),
);

function fn(source: string, name: string): string {
  const matches = source.match(
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\$\\$;`, "g"),
  );
  if (!matches || matches.length === 0)
    throw new Error(`Could not find function ${name} in source`);
  return matches[matches.length - 1];
}

const postPaymentFn = fn(migration, "post_payment");
const reverseFn = fn(migration, "reverse_reservation_payment");

describe("post_payment() — root cause (finding 1)", () => {
  it("the original foundation migration's post_payment() reads a column that has never existed on payments", () => {
    expect(foundation).toContain("COALESCE(p.paid_at::date, CURRENT_DATE)");
    expect(paymentsFoundation).toContain("received_at TIMESTAMPTZ NOT NULL DEFAULT now()");
    expect(paymentsFoundation).not.toMatch(/CREATE TABLE public\.payments[\s\S]*?paid_at/);
  });

  it("the fixed post_payment() uses received_at, not paid_at, and needs no COALESCE since the column is NOT NULL", () => {
    expect(postPaymentFn).toContain("p.received_at::date");
    // p.paid_at may appear only inside an explanatory comment, never in an
    // executable statement.
    const withoutComments = postPaymentFn.replace(/--[^\n]*/g, "");
    expect(withoutComments).not.toContain("paid_at");
    expect(postPaymentFn).not.toContain("COALESCE(p.received_at");
  });

  it("the swallowing EXCEPTION handler is removed — no EXCEPTION WHEN OTHERS anywhere in the fixed function", () => {
    expect(postPaymentFn).not.toMatch(/EXCEPTION\s+WHEN\s+OTHERS/);
  });
});

describe("post_payment() — atomicity (payment + journal succeed or fail together)", () => {
  it("the AFTER INSERT trigger still only PERFORMs post_payment() with no exception handling of its own — an uncaught exception aborts the whole INSERT", () => {
    const triggerFn = fn(foundation, "tg_autopost_payment");
    expect(triggerFn).toContain("PERFORM public.post_payment(NEW.id);");
    expect(triggerFn).not.toMatch(/EXCEPTION/);
    expect(foundation).toContain("CREATE TRIGGER autopost_payment AFTER INSERT ON public.payments");
  });

  it("a missing cash or AR account raises a clear, specific error instead of a raw NOT NULL constraint violation", () => {
    expect(postPaymentFn).toContain(
      "RAISE EXCEPTION 'No cash account configured for this property (system_key=cash) — accounting setup is incomplete';",
    );
    expect(postPaymentFn).toContain(
      "RAISE EXCEPTION 'No AR account configured for this property (system_key=ar) — accounting setup is incomplete';",
    );
  });

  it("a locked/closed accounting period is rejected, replicating post_journal()'s own rule since post_payment() no longer calls it", () => {
    expect(postPaymentFn).toContain("status IN ('locked','closed')");
    expect(postPaymentFn).toContain("RAISE EXCEPTION 'Accounting period is locked'; END IF;");
  });
});

describe("post_payment() — idempotency and duplicate-posting prevention", () => {
  it("locks the payment row before checking for an existing journal entry", () => {
    expect(postPaymentFn).toContain(
      "SELECT * INTO p FROM public.payments WHERE id=_pay_id FOR UPDATE;",
    );
    const lockIdx = postPaymentFn.indexOf("FOR UPDATE");
    const checkIdx = postPaymentFn.indexOf("SELECT id INTO _existing");
    expect(lockIdx).toBeGreaterThan(0);
    expect(checkIdx).toBeGreaterThan(lockIdx);
  });

  it("returns the existing entry id early rather than re-posting", () => {
    expect(postPaymentFn).toContain(
      "SELECT id INTO _existing FROM public.journal_entries WHERE source='payment' AND source_ref=_pay_id::text AND is_reversal_of IS NULL LIMIT 1;",
    );
    expect(postPaymentFn).toContain("IF _existing IS NOT NULL THEN RETURN _existing; END IF;");
  });

  it("a DB-level unique index backs the same invariant, not just application-level locking", () => {
    expect(migration).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_payment_source_ref_uniq",
    );
    expect(migration).toContain("WHERE source = 'payment' AND is_reversal_of IS NULL;");
  });

  it("the new unique index is scoped to is_reversal_of IS NULL, so a refund's reversal entry (which shares source_ref with its original) never violates it", () => {
    expect(refundMigration).toContain(
      "VALUES (res.property_id, CURRENT_DATE, 'Refund of reservation payment — '||_trimmed_reason, 'payment', pay.id::text, orig_entry.currency, auth.uid(), orig_entry.id)",
    );
    // The reversal's own is_reversal_of is non-null (orig_entry.id), so it
    // falls outside the partial index's WHERE clause entirely.
    expect(migration).toContain("WHERE source = 'payment' AND is_reversal_of IS NULL;");
  });

  it("journal_entries_reversal_of_uniq (pre-existing, AR migration) is reused as-is, not redefined here", () => {
    expect(migration).not.toMatch(/CREATE UNIQUE INDEX journal_entries_reversal_of_uniq/);
  });
});

describe("post_payment() — authorization boundary (finding 2)", () => {
  it("no longer calls the shared, stricter post_journal() at all", () => {
    expect(postPaymentFn).not.toContain("public.post_journal(");
  });

  it("post_journal() itself is completely untouched by this migration — its own accountant-only role check is preserved for every other caller", () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.post_journal/);
  });

  it("authorizes the same role set payments_write's own RLS policy requires to insert a payment — not post_journal()'s stricter accountant-only set", () => {
    expect(postPaymentFn).toContain(
      "public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','front_desk','cashier','accountant']::app_role[], _prop_id)",
    );
    expect(paymentsFoundation).toContain(
      "ARRAY['super_admin','hotel_owner','general_manager','front_desk','cashier']::app_role[], r.property_id",
    );
  });

  it("front_desk and cashier — who can record a payment but were previously rejected by post_journal()'s stricter set — are explicitly included", () => {
    const roleArrayMatch = postPaymentFn.match(/ARRAY\[([^\]]+)\]::app_role\[\]/)?.[1] ?? "";
    expect(roleArrayMatch).toContain("'front_desk'");
    expect(roleArrayMatch).toContain("'cashier'");
  });

  it("post_payment()'s ACL is hardened to match every other financial RPC — EXECUTE revoked from PUBLIC/anon, granted to authenticated only", () => {
    expect(migration).toContain(
      "REVOKE EXECUTE ON FUNCTION public.post_payment(uuid) FROM PUBLIC, anon;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.post_payment(uuid) TO authenticated;",
    );
  });
});

describe("post_payment() — accounting correctness", () => {
  it("still debits cash and credits AR for the full payment amount, unchanged from the original design intent", () => {
    expect(postPaymentFn).toContain(
      "VALUES (_entry_id, _cash, p.amount, 0, 'USD', _rate, ROUND(p.amount * _rate, 4), 0, 'Payment received');",
    );
    expect(postPaymentFn).toContain(
      "VALUES (_entry_id, _ar, 0, p.amount, 'USD', _rate, 0, ROUND(p.amount * _rate, 4), 'Apply to AR');",
    );
  });

  it("property is derived from the payment's own reservation, never a client-supplied parameter", () => {
    expect(postPaymentFn).toMatch(/post_payment\(_pay_id UUID\) RETURNS UUID/);
    expect(postPaymentFn).not.toContain("_property_id UUID");
  });

  it("the currency hardcode ('USD') is a documented, deliberate non-fix — shared by post_reservation_checkout/post_pos_order_close, out of scope here", () => {
    expect(postPaymentFn).toContain("'USD'");
    expect(migration).toMatch(/still hardcodes 'USD'/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.post_reservation_checkout/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.post_pos_order_close/);
  });
});

describe("reverse_reservation_payment() — PR #46 bug fix (finding 3)", () => {
  it("tests orig_entry.id IS NOT NULL, not the bare record — the only line changed from PR #46", () => {
    expect(reverseFn).toContain("IF orig_entry.id IS NOT NULL THEN");
    expect(reverseFn).not.toMatch(/IF orig_entry IS NOT NULL THEN/);
  });

  it("the not-found checks on pay/res remain the safe pattern (bare record IS NULL) — unaffected by the mixed-null asymmetry", () => {
    expect(reverseFn).toContain("IF pay IS NULL THEN RAISE EXCEPTION 'Payment not found'; END IF;");
    expect(reverseFn).toContain(
      "IF res IS NULL THEN RAISE EXCEPTION 'Reservation for this payment was not found'; END IF;",
    );
  });

  it("every executable line in reverse_reservation_payment() is reproduced verbatim from PR #46 — only the one IF condition differs (comment-only lines excluded from this comparison)", () => {
    const original = refundMigration.match(
      /CREATE OR REPLACE FUNCTION public\.reverse_reservation_payment[\s\S]*?\$\$;/,
    )?.[0];
    expect(original).toBeTruthy();
    const codeLines = (s: string) =>
      s
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("--"))
        .map((line) =>
          line.replace(/IF orig_entry(\.id)? IS NOT NULL THEN/, "IF orig_entry IS NOT NULL THEN"),
        );
    expect(codeLines(reverseFn)).toEqual(codeLines(original!));
  });

  it("this fix is scoped to reverse_reservation_payment() only — no other AR/AP reversal function is touched", () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.reverse_ar_invoice/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.reverse_ap_payment/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.reverse_ap_bill/);
  });
});

describe("scope control", () => {
  it("does not touch reservations, reservation_charges, invoices, or the UI layer — this is a backend ledger-posting fix only", () => {
    expect(migration).not.toMatch(/ALTER TABLE public\.reservations/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.post_reservation_checkout/);
  });

  it("does not add a payment-gateway concept, partial refunds, or touch AR/AP tables — no executable statement references any of them, even though the header discusses ap_payments/ar_receipts for comparison", () => {
    expect(migration).not.toMatch(
      /(ALTER TABLE|CREATE (OR REPLACE )?(TABLE|FUNCTION|INDEX)|INSERT INTO|UPDATE|DELETE FROM)\s+public\.(ap_bills|ap_payments|ar_invoices|ar_receipts|ar_credit_notes)/,
    );
    expect(migration).not.toMatch(/gateway|stripe|paystack/i);
  });

  it("only adds/redefines objects — never drops anything", () => {
    expect(migration).not.toMatch(/DROP (FUNCTION|TABLE|INDEX|TRIGGER)/);
  });
});

describe("Phase 3 — read-only historical audit diagnostic", () => {
  it("classifies payments as no_journal / has_journal / ambiguous_multiple_journals", () => {
    expect(auditDiagnostic).toContain("'no_journal'");
    expect(auditDiagnostic).toContain("'has_journal'");
    expect(auditDiagnostic).toContain("'ambiguous_multiple_journals'");
  });

  it("is purely read-only — every statement is a SELECT, no write/DDL keyword outside comments", () => {
    const withoutComments = auditDiagnostic.replace(/--[^\n]*/g, "");
    expect(withoutComments).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/i);
  });

  it("checks for backfill blockers: properties missing cash/AR accounts, and payments blocked by a locked accounting period", () => {
    expect(auditDiagnostic).toMatch(/has_cash_account/);
    expect(auditDiagnostic).toMatch(/has_ar_account/);
    expect(auditDiagnostic).toMatch(/status IN \('locked', 'closed'\)/);
  });
});

describe("Phase 3 — historical backfill proposal (not executed)", () => {
  it("is explicitly marked as a proposal, not a migration, requiring separate approval", () => {
    expect(backfillProposal).toMatch(/PROPOSAL ONLY — NOT A MIGRATION/);
    expect(backfillProposal).toMatch(/DO NOT APPLY WITHOUT SEPARATE, EXPLICIT[\s\S]*APPROVAL/);
  });

  it("lives outside supabase/migrations/ so it can never be picked up by `supabase db push`", () => {
    const path = resolve(
      root,
      "supabase/diagnostics/20260823_reservation_payment_backfill_PROPOSAL.sql",
    );
    expect(path).not.toContain(`${resolve(root, "supabase/migrations")}`);
  });

  it("only considers posted payments with no existing journal — never re-posts an already-posted or refunded payment", () => {
    expect(backfillProposal).toContain("WHERE p.status = 'posted'");
    expect(backfillProposal).toMatch(/NOT EXISTS[\s\S]*?journal_entries je/);
  });

  it("delegates the actual posting to post_payment() itself — no duplicated posting logic, so every guard in PART B applies identically", () => {
    expect(backfillProposal).toContain("_entry_id := public.post_payment(r.id);");
    expect(backfillProposal).not.toMatch(/INSERT INTO public\.journal_entries/);
  });

  it("isolates each row's failure in its own EXCEPTION block so one bad row does not block the rest — a deliberately different tolerance model from the live single-payment path", () => {
    expect(backfillProposal).toMatch(/EXCEPTION WHEN OTHERS THEN/);
    const exceptionIdx = backfillProposal.indexOf("EXCEPTION WHEN OTHERS THEN");
    const loopIdx = backfillProposal.indexOf("FOR r IN");
    expect(exceptionIdx).toBeGreaterThan(loopIdx);
  });

  it("never modifies received_at, received_by, method, reference, or amount — read-only against the original payment fields", () => {
    const doBlock = backfillProposal.match(/DO \$\$[\s\S]*?\$\$;/)?.[0] ?? "";
    expect(doBlock).not.toMatch(/UPDATE public\.payments/);
  });

  it("requires the operator to establish an authorized identity before running — documented, not silently assumed", () => {
    expect(backfillProposal).toMatch(/SET LOCAL ROLE authenticated;/);
    expect(backfillProposal).toMatch(/SET LOCAL request\.jwt\.claim\.sub/);
  });
});
