import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
// Normalized to LF immediately on read — a Windows checkout with
// core.autocrlf can re-materialize tracked (LF-in-git) files as CRLF on
// disk depending on when/how they were last checked out, independent of
// this file's own content. See tests/reservation-payment-refund.test.ts for
// the concrete case this was discovered from.
const readNormalized = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const migration = readNormalized(
  resolve(root, "supabase/migrations/20260823100000_reservation_payment_journal_currency_fix.sql"),
);
const postingFixMigration = readNormalized(
  resolve(root, "supabase/migrations/20260823090000_reservation_payment_ledger_posting_fix.sql"),
);
const refundMigration = readNormalized(
  resolve(root, "supabase/migrations/20260822130000_reservation_payment_refund.sql"),
);
const foundation = readNormalized(
  resolve(root, "supabase/migrations/20260705025821_92278fdb-63f6-4a91-922f-a7cb4005b441.sql"),
);
const accountingFoundation = readNormalized(
  resolve(root, "supabase/migrations/20260705035515_24d4b7b8-9714-4a00-adf2-ad1321d22092.sql"),
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

const withoutComments = (s: string) => s.replace(/--[^\n]*/g, "");

describe("post_payment() — authoritative currency source (13)", () => {
  it("no hardcoded 'USD' remains in any executable statement (explanatory comments may still reference the old behavior in past tense)", () => {
    expect(withoutComments(postPaymentFn)).not.toContain("'USD'");
  });

  it("uses properties.base_currency, not properties.currency (the UI-display-only field)", () => {
    expect(postPaymentFn).toContain("_currency := prop.base_currency;");
    expect(postPaymentFn).not.toMatch(/prop\.currency\b/);
  });

  it("base_currency is confirmed NOT NULL at the schema level, and FK-constrained to an existing currency code", () => {
    expect(accountingFoundation).toContain(
      "ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS base_currency TEXT REFERENCES public.currencies(code) NOT NULL DEFAULT 'USD';",
    );
  });

  it("fails clearly if base_currency is somehow null/blank, rather than silently posting a bad entry", () => {
    expect(postPaymentFn).toContain("IF _currency IS NULL OR btrim(_currency) = '' THEN");
    expect(postPaymentFn).toContain("has no valid base currency configured");
  });
});

describe("post_payment() — no unnecessary FX conversion (1/2/3)", () => {
  it("1. a GHS property's payment posts a journal entry with currency = 'GHS' (generic — not a special case)", () => {
    // The function is fully generic: it reads whatever prop.base_currency
    // is and uses it verbatim. This is asserted structurally, not via a
    // GHS-specific branch (there is none) — see the live-validation
    // section of the PR description for a real GHS-property proof.
    expect(postPaymentFn).toContain(
      "VALUES (_prop_id, p.received_at::date, 'Payment '||_pay_id::text, 'payment', _pay_id::text, _currency, auth.uid())",
    );
  });

  it("2. no fx_convert() call exists — no FX conversion path exists at all, not merely skipped when currencies match", () => {
    const code = withoutComments(postPaymentFn);
    expect(code).not.toContain("fx_convert");
    expect(code).not.toMatch(/\bCASE\b/);
  });

  it("3. fx_rate is hardcoded to exactly 1 for both journal lines — works identically for any base_currency value, not just GHS/USD", () => {
    expect(postPaymentFn).toContain(
      "VALUES (_entry_id, _cash, p.amount, 0, _currency, 1, p.amount, 0, 'Payment received');",
    );
    expect(postPaymentFn).toContain(
      "VALUES (_entry_id, _ar, 0, p.amount, _currency, 1, 0, p.amount, 'Apply to AR');",
    );
  });
});

describe("post_payment() — amount exactness and balance (5/6)", () => {
  it("5. debit_base/credit_base equal debit/credit exactly (p.amount, not p.amount * rate) — no rounding introduced by a now-always-1 rate", () => {
    expect(postPaymentFn).not.toContain("ROUND(p.amount * _rate");
    expect(postPaymentFn).not.toContain("ROUND(p.amount *");
  });

  it("6. cash line debits p.amount, AR line credits p.amount — same balanced pair as before this fix, currency aside", () => {
    const cashLine = postPaymentFn.match(/VALUES \(_entry_id, _cash,[^;]+;/)?.[0] ?? "";
    const arLine = postPaymentFn.match(/VALUES \(_entry_id, _ar,[^;]+;/)?.[0] ?? "";
    expect(cashLine).toContain("p.amount, 0");
    expect(arLine).toContain("0, p.amount");
  });
});

describe("post_payment() — preserved from 20260823090000 (9/10/11/12)", () => {
  it("9. idempotency: row lock before the existing-journal check, early return on an existing entry", () => {
    expect(postPaymentFn).toContain(
      "SELECT * INTO p FROM public.payments WHERE id=_pay_id FOR UPDATE;",
    );
    expect(postPaymentFn).toContain(
      "SELECT id INTO _existing FROM public.journal_entries WHERE source='payment' AND source_ref=_pay_id::text AND is_reversal_of IS NULL LIMIT 1;",
    );
    expect(postPaymentFn).toContain("IF _existing IS NOT NULL THEN RETURN _existing; END IF;");
  });

  it("10. atomicity: still no EXCEPTION WHEN OTHERS swallow anywhere — a failure still aborts payment + journal together", () => {
    expect(postPaymentFn).not.toMatch(/EXCEPTION\s+WHEN\s+OTHERS/);
  });

  it("11. front_desk/cashier remain in the authorization role set, not just accountant-family roles", () => {
    const roleArrayMatch = postPaymentFn.match(/ARRAY\[([^\]]+)\]::app_role\[\]/)?.[1] ?? "";
    expect(roleArrayMatch).toContain("'front_desk'");
    expect(roleArrayMatch).toContain("'cashier'");
    expect(postPaymentFn).not.toContain("public.post_journal(");
  });

  it("12. locked/closed accounting-period check is preserved verbatim", () => {
    expect(postPaymentFn).toContain("status IN ('locked','closed')");
    expect(postPaymentFn).toContain("RAISE EXCEPTION 'Accounting period is locked'; END IF;");
  });

  it("the missing cash/AR account guards are preserved verbatim", () => {
    expect(postPaymentFn).toContain(
      "RAISE EXCEPTION 'No cash account configured for this property (system_key=cash) — accounting setup is incomplete';",
    );
    expect(postPaymentFn).toContain(
      "RAISE EXCEPTION 'No AR account configured for this property (system_key=ar) — accounting setup is incomplete';",
    );
  });

  it("the DB-level unique index from 20260823090000 is untouched, not redefined here", () => {
    expect(migration).not.toMatch(/CREATE UNIQUE INDEX/);
  });

  it("does not re-grant EXECUTE — CREATE OR REPLACE preserves existing grants on an unchanged signature", () => {
    expect(migration).not.toMatch(/REVOKE EXECUTE|GRANT EXECUTE/);
  });
});

describe("reverse_reservation_payment() — refund compatibility (7/8)", () => {
  it("7. is NOT redefined by this migration — already currency-agnostic by construction (copies orig_entry.currency verbatim)", () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.reverse_reservation_payment/);
    const reverseFn = fn(refundMigration, "reverse_reservation_payment");
    expect(reverseFn).toContain(
      "VALUES (res.property_id, CURRENT_DATE, 'Refund of reservation payment — '||_trimmed_reason, 'payment', pay.id::text, orig_entry.currency, auth.uid(), orig_entry.id)",
    );
  });

  it("7. reversal journal_lines copy currency/fx_rate verbatim from the original — a payment posted in any currency reverses in that exact currency", () => {
    const reverseFn = fn(refundMigration, "reverse_reservation_payment");
    expect(reverseFn).toContain(
      "VALUES (_reversal_entry, jl.account_id, jl.credit, jl.debit, jl.currency, jl.fx_rate, jl.credit_base, jl.debit_base,",
    );
  });

  it("8. the historical no-journal defensive path (orig_entry.id IS NOT NULL check, fixed by PR #47) is untouched by this migration", () => {
    // The .id fix lives in 20260823090000 (PR #47), which CREATE OR
    // REPLACEd the function after PR #46 — that redefinition is the live
    // one. This migration does not redefine reverse_reservation_payment()
    // at all (asserted above), so PR #47's fixed version remains in effect.
    const fixedReverseFn = fn(postingFixMigration, "reverse_reservation_payment");
    expect(fixedReverseFn).toContain("IF orig_entry.id IS NOT NULL THEN");
  });
});

describe("14. historical backfill proposal still delegates to the fixed post_payment()", () => {
  it("delegates all posting logic to post_payment() — inherits the currency fix automatically, no change needed in the proposal itself", () => {
    expect(backfillProposal).toContain("_entry_id := public.post_payment(r.id);");
    expect(backfillProposal).not.toMatch(/'USD'/);
    expect(backfillProposal).not.toMatch(/INSERT INTO public\.journal_entries/);
  });

  it("this migration does not touch the backfill proposal file at all", () => {
    // Sanity: the proposal lives outside supabase/migrations/ and nothing
    // in this new migration references it.
    expect(migration).not.toMatch(/backfill/i);
  });
});

describe("Phase 3 — ThesKwoff Bar currency inconsistency (documented, not fixed)", () => {
  it("is documented in this migration's header as a separate data-quality issue, not corrected here", () => {
    expect(migration).toMatch(/ThesKwoff Bar/);
    expect(migration).toMatch(/currency='GHS', base_currency='AUD'/);
  });

  it("does not touch any specific property row — no UPDATE public.properties anywhere in this migration", () => {
    expect(migration).not.toMatch(/UPDATE public\.properties/);
  });
});

describe("scope control", () => {
  it("does not touch post_reservation_checkout() or post_pos_order_close() — documented as deliberately out of scope", () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.post_reservation_checkout/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.post_pos_order_close/);
  });

  it("does not touch fx_rates, fx_convert(), or any FX admin UI/table", () => {
    expect(migration).not.toMatch(/CREATE (OR REPLACE )?(TABLE|FUNCTION) public\.fx_/);
    expect(migration).not.toMatch(/ALTER TABLE public\.fx_rates/);
  });

  it("performs no historical/retroactive data write — no UPDATE or DELETE against payments/journal_entries/journal_lines anywhere (the INSERTs present are post_payment()'s own normal, per-new-payment posting logic, unchanged in kind from 20260823090000)", () => {
    expect(migration).not.toMatch(
      /(UPDATE|DELETE FROM)\s+public\.(payments|journal_entries|journal_lines)/,
    );
  });

  it("only redefines post_payment() — no other function, table, or index is created/altered/dropped", () => {
    const createOrReplace = migration.match(/CREATE OR REPLACE FUNCTION public\.\w+/g) ?? [];
    expect(createOrReplace).toEqual(["CREATE OR REPLACE FUNCTION public.post_payment"]);
    expect(migration).not.toMatch(/DROP (FUNCTION|TABLE|INDEX|TRIGGER)/);
    expect(migration).not.toMatch(/ALTER TABLE/);
  });
});
