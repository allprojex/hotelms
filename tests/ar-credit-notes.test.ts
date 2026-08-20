import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const migration = readFileSync(
  resolve(root, "supabase/migrations/20260819120000_ar_credit_notes_pr1.sql"),
  "utf8",
);
const receiptFoundation = readFileSync(
  resolve(root, "supabase/migrations/20260807120000_ar_ap_payment_integrity.sql"),
  "utf8",
);
const reversalFoundation = readFileSync(
  resolve(root, "supabase/migrations/20260818090000_ar_invoice_reversal.sql"),
  "utf8",
);

function fn(source: string, name: string): string {
  const match = source.match(
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\$\\$;`),
  )?.[0];
  if (!match) throw new Error(`Could not find function ${name} in source`);
  return match;
}

const createFn = fn(migration, "create_ar_credit_note");
const postFn = fn(migration, "post_ar_credit_note");
const receiptFn = fn(migration, "post_ar_receipt");
const creditedTotalFn = fn(migration, "ar_invoice_credited_total");
const reverseFn = fn(migration, "reverse_ar_invoice");
const originalReverseFn = fn(reversalFoundation, "reverse_ar_invoice");

describe("AR credit notes — schema", () => {
  it("defines a credit-note-specific status enum: draft, posted, void", () => {
    expect(migration).toContain(
      "CREATE TYPE public.ar_credit_note_status AS ENUM ('draft', 'posted', 'void');",
    );
  });

  it("ar_credit_notes carries the required core fields", () => {
    const table =
      migration.match(/CREATE TABLE public\.ar_credit_notes \([\s\S]*?\n\);/)?.[0] ?? "";
    for (const field of [
      "id UUID PRIMARY KEY",
      "property_id UUID NOT NULL",
      "code TEXT NOT NULL",
      "invoice_id UUID NOT NULL",
      "customer_id UUID",
      "issue_date DATE NOT NULL",
      "currency TEXT NOT NULL",
      "reason TEXT NOT NULL",
      "subtotal NUMERIC(18,4)",
      "tax NUMERIC(18,4)",
      "total NUMERIC(18,4)",
      "status public.ar_credit_note_status",
      "posted_entry_id UUID REFERENCES public.journal_entries",
      "created_by UUID REFERENCES auth.users",
    ]) {
      expect(table).toContain(field);
    }
  });

  it("invoice_id is mandatory in V1 — no standalone credit notes", () => {
    expect(migration).toContain("invoice_id UUID NOT NULL,");
    expect(migration).toContain(
      "FOREIGN KEY (property_id, invoice_id) REFERENCES public.ar_invoices(property_id, id)",
    );
  });

  it("enforces composite property isolation and code/id uniqueness", () => {
    expect(migration).toContain(
      "CONSTRAINT ar_credit_notes_property_id_uniq UNIQUE (property_id, id)",
    );
    expect(migration).toContain(
      "CONSTRAINT ar_credit_notes_property_code_uniq UNIQUE (property_id, code)",
    );
  });

  it("enforces non-negative financial fields and total = subtotal + tax", () => {
    expect(migration).toContain("subtotal NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0)");
    expect(migration).toContain("tax NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (tax >= 0)");
    expect(migration).toContain("total NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (total >= 0)");
    expect(migration).toContain(
      "CONSTRAINT ar_credit_notes_total_eq_lines CHECK (total = subtotal + tax)",
    );
  });

  it("requires a non-blank reason at the row level, consistent with reverse_ar_invoice's reason validation", () => {
    expect(migration).toContain(
      "CONSTRAINT ar_credit_notes_reason_not_blank CHECK (btrim(reason) <> '')",
    );
  });

  it("ar_credit_note_lines carries the required core fields including the denormalized invoice_id needed for structural linkage", () => {
    const table =
      migration.match(/CREATE TABLE public\.ar_credit_note_lines \([\s\S]*?\n\);/)?.[0] ?? "";
    for (const field of [
      "credit_note_id UUID NOT NULL",
      "invoice_id UUID NOT NULL",
      "source_invoice_line_id UUID NOT NULL",
      "quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0)",
      "unit_price NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (unit_price >= 0)",
      "tax_rate NUMERIC(6,3) NOT NULL DEFAULT 0",
      "revenue_account_id UUID REFERENCES public.accounts",
    ]) {
      expect(table).toContain(field);
    }
  });
});

describe("AR credit notes — structural (not app-only) source-line linkage", () => {
  it("exposes ar_invoice_lines(id, invoice_id) as a valid composite FK target", () => {
    expect(migration).toContain(
      "ADD CONSTRAINT ar_invoice_lines_id_invoice_uniq UNIQUE (id, invoice_id);",
    );
  });

  it("exposes ar_credit_notes(id, invoice_id) as a valid composite FK target", () => {
    expect(migration).toContain(
      "CONSTRAINT ar_credit_notes_id_invoice_uniq UNIQUE (id, invoice_id)",
    );
  });

  it("constrains a credit-note line's own invoice_id to match its parent credit note's invoice_id — structurally, via FK, not an app check", () => {
    expect(migration).toContain(
      "FOREIGN KEY (credit_note_id, invoice_id) REFERENCES public.ar_credit_notes(id, invoice_id)",
    );
  });

  it("constrains the source invoice line to literally belong to that same invoice_id — cross-invoice linkage is structurally impossible", () => {
    expect(migration).toContain(
      "FOREIGN KEY (source_invoice_line_id, invoice_id) REFERENCES public.ar_invoice_lines(id, invoice_id)",
    );
  });

  it("every property-scoped composite foreign key has its unique constraint declared before the foreign key that references it", () => {
    const pairs = [
      {
        unique: "CONSTRAINT ar_credit_notes_property_id_uniq UNIQUE (property_id, id)",
        fk: "FOREIGN KEY (property_id, credit_note_id) REFERENCES public.ar_credit_notes(property_id, id)",
      },
      {
        unique: "ADD CONSTRAINT ar_invoice_lines_id_invoice_uniq UNIQUE (id, invoice_id);",
        fk: "FOREIGN KEY (source_invoice_line_id, invoice_id) REFERENCES public.ar_invoice_lines(id, invoice_id)",
      },
      {
        unique: "CONSTRAINT ar_credit_notes_id_invoice_uniq UNIQUE (id, invoice_id)",
        fk: "FOREIGN KEY (credit_note_id, invoice_id) REFERENCES public.ar_credit_notes(id, invoice_id)",
      },
    ];
    for (const { unique, fk } of pairs) {
      const uniquePos = migration.indexOf(unique);
      const fkPos = migration.indexOf(fk);
      expect(uniquePos).toBeGreaterThanOrEqual(0);
      expect(fkPos).toBeGreaterThan(uniquePos);
    }
  });

  it("property isolation on lines is also declarative via a composite FK to the parent credit note", () => {
    expect(migration).toContain(
      "FOREIGN KEY (property_id, credit_note_id) REFERENCES public.ar_credit_notes(property_id, id)",
    );
  });
});

describe("AR credit notes — ACL", () => {
  it("locks down direct table writes — only SELECT is granted to authenticated on both new tables", () => {
    expect(migration).toContain("GRANT SELECT ON public.ar_credit_notes TO authenticated;");
    expect(migration).toContain("GRANT SELECT ON public.ar_credit_note_lines TO authenticated;");
    expect(migration).not.toMatch(
      /GRANT (SELECT, )?INSERT.*ON public\.ar_credit_notes TO authenticated/,
    );
    expect(migration).not.toMatch(
      /GRANT (SELECT, )?INSERT.*ON public\.ar_credit_note_lines TO authenticated/,
    );
  });

  it("scopes RLS read access to property membership on both new tables", () => {
    expect(migration).toContain(
      'CREATE POLICY "ar_credit_notes read" ON public.ar_credit_notes FOR SELECT TO authenticated',
    );
    expect(migration).toContain(
      'CREATE POLICY "ar_credit_note_lines read" ON public.ar_credit_note_lines FOR SELECT TO authenticated',
    );
    expect(
      migration.match(/public\.can_access_property\(auth\.uid\(\), property_id\)/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
  });

  it("pins search_path on every new SECURITY DEFINER function so it cannot be hijacked via caller-controlled search_path", () => {
    expect(createFn).toMatch(/SECURITY DEFINER SET search_path\s*=\s*public/);
    expect(postFn).toMatch(/SECURITY DEFINER SET search_path\s*=\s*public/);
    expect(receiptFn).toMatch(/SECURITY DEFINER SET search_path\s*=\s*public/);
  });

  it("revokes PUBLIC and anon execution and grants only authenticated for create_ar_credit_note", () => {
    expect(migration).toContain(
      "REVOKE EXECUTE ON FUNCTION public.create_ar_credit_note(uuid, uuid, date, text, jsonb) FROM PUBLIC, anon;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.create_ar_credit_note(uuid, uuid, date, text, jsonb) TO authenticated;",
    );
  });

  it("revokes PUBLIC and anon execution and grants only authenticated for post_ar_credit_note", () => {
    expect(migration).toContain(
      "REVOKE EXECUTE ON FUNCTION public.post_ar_credit_note(uuid) FROM PUBLIC, anon;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.post_ar_credit_note(uuid) TO authenticated;",
    );
  });

  it("re-hardens post_ar_receipt's ACL in the same migration it is modified in", () => {
    expect(migration).toContain(
      "REVOKE EXECUTE ON FUNCTION public.post_ar_receipt(uuid, date, payment_method, text, text, text, jsonb) FROM PUBLIC, anon;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.post_ar_receipt(uuid, date, payment_method, text, text, text, jsonb) TO authenticated;",
    );
  });

  it("every role check routes through has_any_role() restricted to admin-tier roles for creation and posting — front_desk is excluded from both", () => {
    expect(createFn).toContain(
      "public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id)",
    );
    expect(postFn).toContain(
      "public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], cn.property_id)",
    );
  });

  it("property access is enforced server-side (RPC role check), not left to RLS alone", () => {
    expect(createFn).toContain("Not permitted to create AR credit notes");
    expect(postFn).toContain("Not permitted to post an AR credit note");
  });
});

describe("AR credit notes — create_ar_credit_note (draft, no financial effect)", () => {
  it("validates the linked invoice belongs to the given property and is sent — matching post_ar_credit_note()'s own eligibility exactly, so a draft can never be created against a 'paid' invoice it could never post against (PR #36 fix)", () => {
    expect(createFn).toContain("WHERE id = _invoice_id AND property_id = _property_id");
    expect(createFn).toContain("IF _inv.status <> 'sent' THEN");
    expect(createFn).not.toContain("_inv.status NOT IN ('sent','paid')");
  });

  it("derives customer_id and currency from the invoice — never independently supplied", () => {
    expect(createFn).toContain(
      "_property_id, _code, _inv.id, _inv.customer_id, COALESCE(_issue_date, CURRENT_DATE), _inv.currency",
    );
    expect(migration).not.toMatch(/create_ar_credit_note\([^)]*_customer_id/);
    expect(migration).not.toMatch(/create_ar_credit_note\([^)]*_currency/);
  });

  it("validates every line's source invoice line against the linked invoice, not just any line in the system", () => {
    expect(createFn).toContain(
      "WHERE id = (_line->>'source_invoice_line_id')::UUID AND invoice_id = _inv.id",
    );
    expect(createFn).toContain("Source invoice line not found on invoice");
  });

  it("copies unit_price, tax_rate, and revenue_account_id from the source line — never accepts them from the caller", () => {
    expect(createFn).toContain(
      "_source_line.description, _quantity, _source_line.unit_price, _source_line.tax_rate,\n      _source_line.revenue_account_id",
    );
    expect(migration).not.toMatch(/create_ar_credit_note\([^)]*_unit_price/);
    expect(migration).not.toMatch(/create_ar_credit_note\([^)]*_tax_rate/);
    expect(migration).not.toMatch(/create_ar_credit_note\([^)]*_revenue_account_id/);
  });

  it("requires a reason of at least 5 and at most 500 characters, consistent with reverse_ar_invoice", () => {
    expect(createFn).toContain("char_length(_trimmed_reason) < 5");
    expect(createFn).toContain("char_length(_trimmed_reason) > 500");
  });

  it("requires at least one line", () => {
    expect(createFn).toContain("At least one credit note line is required");
  });

  it("draft creation performs no journal posting and no invoice mutation — no financial effect", () => {
    expect(createFn).not.toContain("post_journal");
    expect(createFn).not.toMatch(/UPDATE public\.ar_invoices/);
    // The INSERT never sets status explicitly — it relies on the table's
    // DEFAULT 'draft', and nothing in this function transitions it further.
    expect(createFn).not.toMatch(/status\s*=\s*'posted'/);
    expect(createFn).not.toContain(
      "INSERT INTO public.ar_credit_notes(\n    property_id, code, invoice_id, customer_id, issue_date, currency, reason, created_by, status",
    );
  });

  it("draft credit notes do not consume source-line capacity — only an original-quantity sanity check runs at create time, not the remaining-capacity cap", () => {
    expect(createFn).toContain("_quantity > _source_line.quantity");
    expect(createFn).not.toContain("_remaining_qty");
  });
});

describe("AR credit notes — post_ar_credit_note eligibility", () => {
  it("rejects posting a draft invoice — nothing to credit yet", () => {
    expect(postFn).toContain("IF inv.status = 'draft' THEN");
    expect(postFn).toContain("has nothing to credit");
  });

  it("rejects posting against a void invoice", () => {
    expect(postFn).toContain("IF inv.status = 'void' THEN");
    expect(postFn).toContain("has been voided");
  });

  it("rejects posting against an already fully-paid invoice in this version", () => {
    expect(postFn).toContain("IF inv.status = 'paid' THEN");
    expect(postFn).toContain("cannot be credited in this version");
  });

  it("allows posting against a sent invoice, unpaid or partially paid — 'sent' is the only accepted status", () => {
    expect(postFn).toContain("IF inv.status <> 'sent' THEN");
  });

  it("rejects posting an already-void credit note, and re-posting an already-posted one is a safe idempotent no-op", () => {
    expect(postFn).toContain("IF cn.status = 'void' THEN");
    expect(postFn).toContain("has been voided and cannot be posted");
    expect(postFn).toContain("IF cn.status = 'posted' THEN");
    expect(postFn).toContain("RETURN cn.posted_entry_id;");
  });

  it("rejects posting a credit note with no lines", () => {
    expect(postFn).toContain("Credit note % has no lines to post");
  });

  it("blocks posting into a locked or closed accounting period, the same rule post_journal()/reverse_ar_invoice() enforce", () => {
    expect(postFn).toContain("status IN ('locked','closed')");
    expect(postFn).toContain("Current accounting period is locked");
  });
});

describe("AR credit notes — locking order and concurrency safety", () => {
  it("locks the credit note row itself first, before any status decision — primary defense against double-posting the same row", () => {
    const cnLockIdx = postFn.indexOf("FROM public.ar_credit_notes WHERE id = _id FOR UPDATE");
    const statusIdx = postFn.indexOf("IF cn.status = 'posted' THEN");
    expect(cnLockIdx).toBeGreaterThan(0);
    expect(statusIdx).toBeGreaterThan(cnLockIdx);
  });

  it("locks the invoice row after the credit note row, in a fixed order — defense against concurrent over-credit across different credit notes on the same invoice", () => {
    const cnLockIdx = postFn.indexOf("FROM public.ar_credit_notes WHERE id = _id FOR UPDATE");
    const invLockIdx = postFn.indexOf(
      "FROM public.ar_invoices WHERE id = cn.invoice_id FOR UPDATE",
    );
    expect(invLockIdx).toBeGreaterThan(cnLockIdx);
  });

  it("recomputes credited_total fresh under the invoice lock rather than trusting a cached/view value", () => {
    expect(postFn).toContain("_posted_credit_total := public.ar_invoice_credited_total(inv.id);");
    expect(postFn).toContain("_net_balance := inv.total - inv.amount_paid - _posted_credit_total;");
  });

  it("post_ar_receipt locks each allocated invoice FOR UPDATE in a deterministic order, the same lock post_ar_credit_note takes, so the two paths serialize safely against each other", () => {
    expect(receiptFn).toContain("ORDER BY (value->>'invoice_id')");
    expect(receiptFn).toContain("WHERE id=_invoice_id AND property_id=_property_id FOR UPDATE");
  });
});

describe("AR credit notes — line cap and repeated partial credits", () => {
  it("recomputes remaining quantity from POSTED credit-note lines only — draft/void lines never count toward consumed capacity", () => {
    expect(postFn).toContain("AND xc.status = 'posted';");
    expect(postFn).toContain("_remaining_qty := ln.source_quantity - _cum_qty;");
  });

  it("rejects posting when requested quantity exceeds remaining quantity on the source line", () => {
    expect(postFn).toContain("IF ln.quantity > _remaining_qty THEN");
    expect(postFn).toContain("exceeds remaining quantity");
  });

  it("supports the documented repeated-partial-credit example (line qty 10, credit A=6, credit B=4 passes, any further credit is rejected) via the same remaining-quantity formula applied per posting call", () => {
    // The formula is stateless per call: each post recomputes _cum_qty from
    // whatever is already 'posted' at that moment, so A=6 then B=4 (total
    // consumed 10) leaves _remaining_qty=0 for a third attempt, which the
    // same IF ln.quantity > _remaining_qty guard above rejects.
    expect(postFn).toContain(
      "FROM public.ar_credit_note_lines x\n      JOIN public.ar_credit_notes xc ON xc.id = x.credit_note_id\n      WHERE x.source_invoice_line_id = ln.source_invoice_line_id",
    );
  });

  it("because unit_price and tax_rate are copied and immutable, the quantity cap alone also enforces the monetary cap — no separate amount-based guard is needed at the line level", () => {
    expect(postFn).toContain("Because unit_price and");
  });
});

describe("AR credit notes — tax and terminal residual rounding", () => {
  it("uses ROUND(qty * unit_price, 4) and ROUND(subtotal * tax_rate / 100, 4) for a non-terminal partial credit", () => {
    expect(postFn).toContain("_line_subtotal := ROUND(ln.quantity * ln.source_unit_price, 4);");
    expect(postFn).toContain("_line_tax := ROUND(_line_subtotal * ln.source_tax_rate / 100, 4);");
  });

  it("uses the exact remaining original subtotal/tax (not a recomputed ROUND) when a credit exhausts the source line's remaining quantity", () => {
    expect(postFn).toContain("_is_terminal := (ln.quantity = _remaining_qty);");
    expect(postFn).toContain("_line_subtotal := _remaining_subtotal;");
    expect(postFn).toContain("_line_tax := _remaining_tax;");
  });

  it("computes the remaining residual as original subtotal/tax minus the sum already recorded on previously posted credit lines for that source line — guaranteeing cumulative posted credits can never exceed the original and leave zero drift on full credit", () => {
    expect(postFn).toContain("_remaining_subtotal := _orig_subtotal - _cum_subtotal;");
    expect(postFn).toContain("_remaining_tax := _orig_tax - _cum_tax;");
    expect(postFn).toContain(
      "_orig_subtotal := ROUND(ln.source_quantity * ln.source_unit_price, 4);",
    );
    expect(postFn).toContain("_orig_tax := ROUND(_orig_subtotal * ln.source_tax_rate / 100, 4);");
  });

  it("persists the authoritative recomputed subtotal/tax back onto the credit note line at posting time, not the draft-time estimate", () => {
    expect(postFn).toContain(
      "UPDATE public.ar_credit_note_lines SET subtotal = _line_subtotal, tax = _line_tax WHERE id = ln.id;",
    );
  });
});

describe("AR credit notes — net balance invariant", () => {
  it("rejects posting when the recomputed total exceeds the invoice's fresh net balance — a credit note must never reduce net_balance below zero", () => {
    expect(postFn).toContain("IF _total > _net_balance THEN");
    expect(postFn).toContain("exceeds invoice % remaining net balance");
  });

  it("net balance formula matches the authoritative invariant: total - amount_paid - posted credited total", () => {
    expect(postFn).toContain("_net_balance := inv.total - inv.amount_paid - _posted_credit_total;");
    expect(creditedTotalFn).toContain(
      "SELECT COALESCE(SUM(total), 0) FROM public.ar_credit_notes\n    WHERE invoice_id = _invoice_id AND status = 'posted';",
    );
  });

  it("does not store net_balance as a mutable column on ar_invoices — it is computed, not persisted, on that table", () => {
    expect(migration).not.toMatch(/ALTER TABLE public\.ar_invoices\s+ADD COLUMN\s+net_balance/);
  });

  it("exposes the read model with the required fields for consistent consumption", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE VIEW public.ar_invoice_balances\nWITH (security_invoker = true) AS",
    );
    for (const field of [
      "i.property_id",
      "i.id AS invoice_id",
      "i.total",
      "i.amount_paid",
      "AS credited_total",
      "AS net_balance",
    ]) {
      expect(migration).toContain(field);
    }
  });

  it("the view is read convenience only — posting functions never query it to make a posting decision (only mention it in an explanatory comment, never in a FROM/JOIN)", () => {
    expect(postFn).not.toMatch(/FROM\s+public\.ar_invoice_balances/i);
    expect(postFn).not.toMatch(/JOIN\s+public\.ar_invoice_balances/i);
    expect(receiptFn).not.toMatch(/FROM\s+public\.ar_invoice_balances/i);
    expect(receiptFn).not.toMatch(/JOIN\s+public\.ar_invoice_balances/i);
  });
});

describe("AR credit notes — journal", () => {
  it("posts DR revenue per line, DR tax (if any), CR accounts receivable — the reverse GL direction of post_ar_invoice", () => {
    expect(postFn).toContain(
      "jsonb_build_object('account_id',_rev,'debit',_line_subtotal,'credit',0,'memo','Credit note '",
    );
    expect(postFn).toContain(
      "jsonb_build_object('account_id',_tax_acc,'debit',_tax,'credit',0,'memo','Tax on credit note '",
    );
    expect(postFn).toContain(
      "jsonb_build_object('account_id',_ar,'debit',0,'credit',_total,'memo','Credit note '",
    );
  });

  it("resolves GL accounts via posting_rules/resolve_account, reusing the exact same rule keys as post_ar_invoice — no new account mapping invented", () => {
    expect(postFn).toContain("public.resolve_account(cn.property_id,'ar_revenue','other_revenue')");
    expect(postFn).toContain("public.resolve_account(cn.property_id,'ar_receivable','ar')");
    expect(postFn).toContain("public.resolve_account(cn.property_id,'ar_tax','tax_payable')");
  });

  it("posts through post_journal (not a raw journal_entries insert), so the double-entry balance check still applies", () => {
    expect(postFn).toContain(
      "public.post_journal(cn.property_id, cn.issue_date, cn.currency, 'AR Credit Note '||cn.code, 'ar', cn.id::text, _lines)",
    );
  });

  it("does not copy the original invoice's historical journal lines — unlike reverse_ar_invoice, this is a new economic event using today's posting-date FX", () => {
    expect(postFn).not.toContain("jl.fx_rate");
    expect(postFn).not.toContain("jl.debit_base");
    expect(postFn).not.toContain("is_reversal_of");
  });

  it("links the credit note to its journal via posted_entry_id", () => {
    expect(postFn).toContain(
      "SET subtotal = _sub, tax = _tax, total = _total, status = 'posted', posted_entry_id = _entry",
    );
  });

  it("skips the tax line entirely when there is no tax, matching post_ar_invoice's own convention", () => {
    expect(postFn).toContain("IF _tax > 0 THEN");
  });
});

describe("AR credit notes — invoice status transition", () => {
  it("advances to 'paid' only when the new net balance reaches zero — no new invoice status is introduced", () => {
    expect(postFn).toContain(
      "_new_balance := inv.total - inv.amount_paid - (_posted_credit_total + _total);",
    );
    expect(postFn).toContain(
      "_new_status := CASE WHEN _new_balance <= 0 THEN 'paid'::ar_status ELSE inv.status END;",
    );
    expect(migration).not.toMatch(/CREATE TYPE public\.ar_status/);
  });

  it("remains 'sent' when net balance is still positive after posting (the CASE ELSE branch preserves inv.status)", () => {
    expect(postFn).toContain("ELSE inv.status END;");
  });

  it("never mutates amount_paid — a credit note's only invoice-side write is the status column", () => {
    const invoiceUpdateStatements = postFn.match(/UPDATE public\.ar_invoices SET[^;]*;/g) ?? [];
    expect(invoiceUpdateStatements).toHaveLength(1);
    expect(invoiceUpdateStatements[0]).not.toContain("amount_paid");
    expect(invoiceUpdateStatements[0]).toContain("status = _new_status");
  });
});

describe("AR credit notes — audit", () => {
  it("does not route through admin_log() — its own role check excludes accountant, mirroring reverse_ar_invoice's documented reasoning", () => {
    expect(postFn).not.toMatch(/PERFORM public\.admin_log\(/);
    expect(postFn).not.toMatch(/\.rpc\(["']admin_log["']\)/);
  });

  it("inserts directly into admin_action_logs exactly once, in the same transaction as the journal/invoice/credit-note writes", () => {
    const inserts = postFn.match(/INSERT INTO public\.admin_action_logs/g) ?? [];
    expect(inserts).toHaveLength(1);
  });

  it("the audit insert happens after every eligibility guard and after the financial writes — a failed post produces no audit row, and there is no catch-all handler that could swallow a failure silently", () => {
    const auditIdx = postFn.indexOf("INSERT INTO public.admin_action_logs(");
    const journalIdx = postFn.indexOf("_entry := public.post_journal(");
    const creditNoteUpdateIdx = postFn.indexOf(
      "SET subtotal = _sub, tax = _tax, total = _total, status = 'posted'",
    );
    const invoiceUpdateIdx = postFn.indexOf("UPDATE public.ar_invoices SET status = _new_status");
    expect(auditIdx).toBeGreaterThan(journalIdx);
    expect(auditIdx).toBeGreaterThan(creditNoteUpdateIdx);
    expect(auditIdx).toBeGreaterThan(invoiceUpdateIdx);
    expect(postFn).not.toMatch(/EXCEPTION\s+WHEN\s+OTHERS/);
  });

  it("captures property, actor, invoice id/code, reason, total, and both entry ids", () => {
    expect(postFn).toContain(
      "jsonb_build_object('status', 'posted', 'code', cn.code, 'invoiceId', cn.invoice_id, 'postedEntryId', _entry, 'total', _total, 'reason', cn.reason)",
    );
    expect(postFn).toContain(
      "cn.property_id, auth.uid(), 'ar_credit_note', cn.id::text, 'update',",
    );
  });

  it("duplicate/idempotent re-posting cannot produce a duplicate audit row — the early idempotent return happens before the audit insert is ever reached", () => {
    const idempotentReturnIdx = postFn.indexOf("RETURN cn.posted_entry_id;");
    const auditIdx = postFn.indexOf("INSERT INTO public.admin_action_logs(");
    expect(idempotentReturnIdx).toBeGreaterThan(0);
    expect(idempotentReturnIdx).toBeLessThan(auditIdx);
  });
});

describe("AR credit notes — receipt safety (post_ar_receipt net-balance fix)", () => {
  it("computes remaining balance from net balance (total - amount_paid - credited), not merely total - amount_paid", () => {
    expect(receiptFn).toContain("_credited := public.ar_invoice_credited_total(_inv.id);");
    expect(receiptFn).toContain("_remaining := _inv.total - _inv.amount_paid - _credited;");
  });

  it("computes the credited amount while the invoice FOR UPDATE lock from pass 2 is already held", () => {
    const lockIdx = receiptFn.indexOf("FOR UPDATE;\n    IF _inv IS NULL THEN");
    const creditedIdx = receiptFn.indexOf(
      "_credited := public.ar_invoice_credited_total(_inv.id);\n    _remaining",
    );
    expect(lockIdx).toBeGreaterThan(0);
    expect(creditedIdx).toBeGreaterThan(lockIdx);
  });

  it("rejects an allocation that would push amount_paid + posted_credit_total above invoice.total", () => {
    expect(receiptFn).toContain("IF _alloc_amount > _remaining THEN");
    expect(receiptFn).toContain("exceeds its remaining net balance");
  });

  it("flips status to 'paid' once the net balance (not just amount_paid vs total) reaches zero", () => {
    expect(receiptFn).toContain(
      "_new_status := CASE WHEN (_inv.total - _new_paid - _credited) <= 0 THEN 'paid'::ar_status ELSE _inv.status END;",
    );
  });

  it("this is the SAME migration that adds post_ar_credit_note — the two are not split across PRs", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.post_ar_credit_note(_id UUID)");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.post_ar_receipt(");
  });

  it("no longer contains the old uncorrected remaining-balance formula", () => {
    expect(receiptFn).not.toContain("_remaining := _inv.total - _inv.amount_paid;");
  });

  it("preserves every other pre-existing safety property of post_ar_receipt untouched: idempotency key handling, empty/duplicate allocation rejection, deterministic lock ordering, GL posting shape", () => {
    expect(receiptFn).toContain("IF _idempotency_key IS NOT NULL THEN");
    expect(receiptFn).toContain("At least one allocation is required");
    expect(receiptFn).toContain("Each invoice may only appear once per receipt");
    expect(receiptFn).toContain("ORDER BY (value->>'invoice_id')");
    expect(receiptFn).toContain(
      "jsonb_build_object('account_id',_cash,'debit',_total_allocated,'credit',0",
    );
    expect(receiptFn).toContain(
      "jsonb_build_object('account_id',_ar,'debit',0,'credit',_total_allocated",
    );
  });

  it("still exists as the exact same function signature — no breaking change to callers of post_ar_receipt", () => {
    expect(receiptFoundation).toContain(
      "CREATE OR REPLACE FUNCTION public.post_ar_receipt(\n  _property_id UUID,\n  _receipt_date DATE,\n  _method payment_method,\n  _reference TEXT,\n  _notes TEXT,\n  _idempotency_key TEXT,\n  _allocations JSONB\n) RETURNS UUID",
    );
    expect(receiptFn).toContain(
      "_property_id UUID,\n  _receipt_date DATE,\n  _method payment_method,\n  _reference TEXT,\n  _notes TEXT,\n  _idempotency_key TEXT,\n  _allocations JSONB\n) RETURNS UUID",
    );
  });
});

describe("AR credit notes — ageing release safety", () => {
  it("redefines ar_aging to use net balance (subtracting posted credit notes), not the old total - amount_paid", () => {
    const view =
      migration.match(
        /CREATE OR REPLACE VIEW public\.ar_aging[\s\S]*?FROM public\.ar_invoices i WHERE i\.status <> 'void';/,
      )?.[0] ?? "";
    expect(view).toContain("public.ar_invoice_credited_total(i.id)) AS balance");
    expect(view).not.toMatch(/\(i\.total - i\.amount_paid\) AS balance/);
  });

  it("keeps the same output column list/order/types as the prior ar_aging definition, so no dependent object breaks", () => {
    const view =
      migration.match(/CREATE OR REPLACE VIEW public\.ar_aging[\s\S]*?bucket\n/)?.[0] ?? "";
    expect(view).toMatch(
      /SELECT i\.property_id, i\.id, i\.code, i\.bill_to_name, i\.due_date, i\.total, i\.amount_paid,/,
    );
  });

  it("PR #36 fix: ar-statement-calc.ts / ar-statements.functions.ts ARE changed in this PR to also treat posted credit notes as a customer-statement credit — the original 'display gap, not a misstatement' reasoning is corrected in the migration header", () => {
    expect(migration).toContain("ar-statement-calc.ts");
    expect(migration).toContain("that reasoning was wrong");
    expect(migration).toContain("It is fixed here, not deferred.");
  });
});

describe("AR credit notes — cross-property and cross-invoice isolation", () => {
  it("create_ar_credit_note looks up the invoice scoped to the caller-supplied property_id, and the row-level FK independently pins invoice.property_id to the credit note's own property_id", () => {
    expect(createFn).toContain("WHERE id = _invoice_id AND property_id = _property_id");
    expect(migration).toContain(
      "FOREIGN KEY (property_id, invoice_id) REFERENCES public.ar_invoices(property_id, id)",
    );
  });

  it("post_ar_credit_note derives property_id from the locked credit note row itself, never from a client-supplied parameter — cross-property posting is impossible by construction", () => {
    expect(postFn).toMatch(/post_ar_credit_note\(_id UUID\)/);
    expect(postFn).not.toContain("_property_id UUID");
  });

  it("customer_id FK is property-scoped, so a credit note can never reference a customer belonging to a different property", () => {
    expect(migration).toContain(
      "FOREIGN KEY (property_id, customer_id) REFERENCES public.ar_customers(property_id, id)",
    );
  });
});

describe("AR credit notes — this migration only adds new objects", () => {
  it("never drops or destructively alters a historical migration's tables/functions — post_ar_receipt() and reverse_ar_invoice() are both redeclared via CREATE OR REPLACE FUNCTION, never DROP+recreate", () => {
    expect(migration).not.toMatch(/DROP FUNCTION|DROP TABLE|DROP TYPE/);
    expect(migration).not.toMatch(/ALTER TABLE public\.ar_invoices\s+DROP/);
    expect(migration).not.toMatch(/ALTER TABLE public\.ar_invoice_lines\s+DROP/);
  });
});

describe("PR #36 fix 1 — reverse_ar_invoice() posted-credit-note guard", () => {
  it("adds exactly one new guard: an EXISTS check against posted ar_credit_notes, under the same invoice row lock as every other eligibility check", () => {
    expect(reverseFn).toContain(
      "SELECT 1 FROM public.ar_credit_notes WHERE invoice_id = inv.id AND status = 'posted'",
    );
    expect(reverseFn).toContain("has posted credit notes and cannot be reversed");
  });

  it("the guard runs after the invoice row lock (FOR UPDATE), same as every other eligibility check in this function", () => {
    const lockIdx = reverseFn.indexOf("FROM public.ar_invoices WHERE id=_id FOR UPDATE");
    const guardIdx = reverseFn.indexOf("has posted credit notes and cannot be reversed");
    expect(lockIdx).toBeGreaterThan(0);
    expect(guardIdx).toBeGreaterThan(lockIdx);
  });

  it("the guard runs alongside (after) the existing amount_paid and ar_receipt_allocations guards, not instead of them — no existing guard was removed or weakened", () => {
    const amountPaidIdx = reverseFn.indexOf("IF inv.amount_paid <> 0 THEN");
    const allocIdx = reverseFn.indexOf("_alloc_count > 0");
    const creditGuardIdx = reverseFn.indexOf("has posted credit notes and cannot be reversed");
    expect(amountPaidIdx).toBeGreaterThan(0);
    expect(allocIdx).toBeGreaterThan(amountPaidIdx);
    expect(creditGuardIdx).toBeGreaterThan(allocIdx);
    // Every other guard from the original function is preserved verbatim.
    for (const guard of [
      "IF inv.status = 'void' THEN",
      "IF inv.status = 'draft' THEN",
      "IF inv.status = 'paid' THEN",
      "IF inv.status <> 'sent' THEN",
      "IF inv.posted_entry_id IS NULL THEN",
      "IF inv.amount_paid <> 0 THEN",
      "SELECT count(*) INTO _alloc_count FROM public.ar_receipt_allocations WHERE invoice_id = _id;",
    ]) {
      expect(reverseFn).toContain(guard);
      expect(originalReverseFn).toContain(guard);
    }
  });

  it("a sent, unpaid invoice with no credit notes at all remains eligible — the new EXISTS check is false, so reversal proceeds exactly as before", () => {
    // No new unconditional exception between the credit-note guard and the
    // existing-reversal check; the EXISTS is the only new gate.
    const creditGuardBlock = reverseFn.match(
      /IF EXISTS \(\s*SELECT 1 FROM public\.ar_credit_notes[\s\S]*?END IF;/,
    )?.[0];
    expect(creditGuardBlock).toBeDefined();
    expect(creditGuardBlock).toContain("status = 'posted'");
  });

  it("a DRAFT credit note against the invoice does not block reversal — the guard filters to status = 'posted' only", () => {
    expect(reverseFn).toContain("AND status = 'posted'");
    expect(reverseFn).not.toMatch(
      /ar_credit_notes WHERE invoice_id = inv\.id AND status IN \('draft'/,
    );
  });

  it("a VOID credit note against the invoice does not block reversal — the ar_credit_notes clause filters to status = 'posted' only, with no OR branch for 'void'", () => {
    // A single EXISTS clause filtered to 'posted' inherently excludes both
    // 'draft' and 'void' — there is no separate OR branch that would catch
    // a void credit note.
    const creditNoteClause =
      reverseFn.match(/SELECT 1 FROM public\.ar_credit_notes WHERE[^\n]*/)?.[0] ?? "";
    expect(creditNoteClause).toBe(
      "SELECT 1 FROM public.ar_credit_notes WHERE invoice_id = inv.id AND status = 'posted'",
    );
    expect(creditNoteClause).not.toMatch(/OR|void/);
  });

  it("a fully credited invoice (net balance reduced to zero by posted credit notes, still status='sent' per point 11 of the migration header) is blocked by the same guard — no separate 'fully credited' branch is needed since ANY posted credit note blocks reversal, not just a partial one", () => {
    expect(reverseFn).toContain("AND status = 'posted'");
  });

  it("does not weaken or remove the existing double-reversal / concurrency protections (row lock ordering, is_reversal_of uniqueness, balance re-check)", () => {
    expect(reverseFn).toContain(
      "SELECT * INTO inv FROM public.ar_invoices WHERE id=_id FOR UPDATE;",
    );
    expect(reverseFn).toContain(
      "SELECT id INTO _existing_reversal FROM public.journal_entries WHERE is_reversal_of = inv.posted_entry_id;",
    );
    expect(reverseFn).toContain("ROUND(_dr,2) <> ROUND(_cr,2)");
    expect(migration).not.toMatch(/CREATE UNIQUE INDEX journal_entries_reversal_of_uniq/); // unique index already exists from 20260818090000, not redeclared here
  });

  it("preserves the exact same audit insert shape and permission role set as the original function", () => {
    expect(reverseFn).toContain(
      "public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], inv.property_id)",
    );
    expect(reverseFn).toContain("INSERT INTO public.admin_action_logs(");
    const inserts = reverseFn.match(/INSERT INTO public\.admin_action_logs/g) ?? [];
    expect(inserts).toHaveLength(1);
  });

  it("is redeclared via CREATE OR REPLACE FUNCTION under the identical signature — the historical migration file itself is never edited", () => {
    expect(reverseFn).toMatch(/reverse_ar_invoice\(_id UUID, _reason TEXT\)/);
    expect(reversalFoundation).toContain(
      "CREATE OR REPLACE FUNCTION public.reverse_ar_invoice(_id UUID, _reason TEXT)",
    );
  });

  it("ACL is re-declared for defense-in-depth, matching this migration's own post_ar_receipt() precedent", () => {
    expect(migration).toContain(
      "REVOKE EXECUTE ON FUNCTION public.reverse_ar_invoice(uuid, text) FROM PUBLIC, anon;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.reverse_ar_invoice(uuid, text) TO authenticated;",
    );
  });

  it("the original migration file's own regression test suite is untouched and still describes true, unchanged behavior for every guard other than the new one", () => {
    expect(reversalFoundation).not.toContain("ar_credit_notes");
  });
});

describe("PR #36 fix 2 — duplicate source line within one credit note", () => {
  it("adds a structural UNIQUE (credit_note_id, source_invoice_line_id) constraint — not an aggregation workaround in the function", () => {
    expect(migration).toContain(
      "CONSTRAINT ar_credit_note_lines_note_source_uniq UNIQUE (credit_note_id, source_invoice_line_id)",
    );
  });

  it("the constraint is declared on the table itself (structural), and the function-level per-line loop is unchanged — the fix is not a new _cum_qty aggregation branch inside post_ar_credit_note()", () => {
    expect(postFn).not.toContain("credit_note_id = cn.id AND"); // no same-note aggregation hack was added to the remaining-quantity query
    expect(postFn).toContain(
      "FROM public.ar_credit_note_lines x\n      JOIN public.ar_credit_notes xc ON xc.id = x.credit_note_id\n      WHERE x.source_invoice_line_id = ln.source_invoice_line_id\n        AND xc.status = 'posted';",
    );
  });

  it("create_ar_credit_note() also rejects a duplicate source_invoice_line_id early, with a clear error, before ever reaching the structural constraint", () => {
    expect(createFn).toContain(
      "SELECT COUNT(DISTINCT value->>'source_invoice_line_id') FROM jsonb_array_elements(_lines)",
    );
    expect(createFn).toContain("Each source invoice line may only appear once per credit note");
  });

  it("the early application-level check runs before any line INSERT, so a duplicate submission never partially writes lines before being rejected", () => {
    const checkIdx = createFn.indexOf(
      "Each source invoice line may only appear once per credit note",
    );
    const firstInsertIdx = createFn.indexOf("INSERT INTO public.ar_credit_note_lines(");
    expect(checkIdx).toBeGreaterThan(0);
    expect(checkIdx).toBeLessThan(firstInsertIdx);
  });
});

describe("PR #36 fix 3 — ar_invoice_balances / ar_aging view security (security_invoker)", () => {
  it("declares security_invoker = true directly in the CREATE OR REPLACE VIEW statement for ar_invoice_balances — not left to default (false)", () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE VIEW public\.ar_invoice_balances\s*\nWITH \(security_invoker = true\) AS/,
    );
  });

  it("declares security_invoker = true directly in the CREATE OR REPLACE VIEW statement for ar_aging — this PR's own redefinition would otherwise silently reset it to the default (false), reintroducing the exact cross-property leak this repo already fixed twice before", () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE VIEW public\.ar_aging\s*\nWITH \(security_invoker = true\) AS/,
    );
  });

  it("also applies a defensive ALTER VIEW ... SET (security_invoker = true) immediately after each CREATE OR REPLACE VIEW, for both views", () => {
    expect(migration).toContain(
      "ALTER VIEW public.ar_invoice_balances SET (security_invoker = true);",
    );
    expect(migration).toContain("ALTER VIEW public.ar_aging SET (security_invoker = true);");
  });

  it("the ALTER VIEW for each view appears after that view's own CREATE OR REPLACE VIEW", () => {
    const balancesCreateIdx = migration.indexOf(
      "CREATE OR REPLACE VIEW public.ar_invoice_balances",
    );
    const balancesAlterIdx = migration.indexOf(
      "ALTER VIEW public.ar_invoice_balances SET (security_invoker = true);",
    );
    const agingCreateIdx = migration.indexOf("CREATE OR REPLACE VIEW public.ar_aging");
    const agingAlterIdx = migration.indexOf(
      "ALTER VIEW public.ar_aging SET (security_invoker = true);",
    );
    expect(balancesAlterIdx).toBeGreaterThan(balancesCreateIdx);
    expect(agingAlterIdx).toBeGreaterThan(agingCreateIdx);
  });

  it("documents the established project precedent for this exact bug class (ar_aging security_invoker fixed twice before) rather than asserting it from scratch", () => {
    expect(migration).toContain("20260705040652_ca91242d-63f8-4436-aa72-3c3d68f10a95.sql");
    expect(migration).toContain("20260706002151_e5d271a3-0dc5-464a-bd70-f020a231e8ae.sql");
  });

  it("the referenced historical migrations really do contain the security_invoker fix this migration's comment describes — the citation is not fabricated", () => {
    const fix1 = readFileSync(
      resolve(root, "supabase/migrations/20260705040652_ca91242d-63f8-4436-aa72-3c3d68f10a95.sql"),
      "utf8",
    );
    const fix2 = readFileSync(
      resolve(root, "supabase/migrations/20260706002151_e5d271a3-0dc5-464a-bd70-f020a231e8ae.sql"),
      "utf8",
    );
    expect(fix1).toContain("ALTER VIEW public.ar_aging SET (security_invoker = true);");
    expect(fix2).toContain("ALTER VIEW public.ar_aging SET (security_invoker = true);");
  });

  it("both views still GRANT SELECT to authenticated only (no broader grant introduced while fixing security_invoker)", () => {
    expect(migration).toContain("GRANT SELECT ON public.ar_invoice_balances TO authenticated;");
    expect(migration).toContain("GRANT SELECT ON public.ar_aging TO authenticated;");
    expect(migration).not.toMatch(/GRANT SELECT ON public\.ar_invoice_balances TO (PUBLIC|anon)/);
    expect(migration).not.toMatch(/GRANT SELECT ON public\.ar_aging TO (PUBLIC|anon)/);
  });
});

describe("PR #36 fix 4 — create_ar_credit_note() rejects a paid invoice at create time", () => {
  it("requires status = 'sent' exactly, matching post_ar_credit_note()'s own eligibility — 'paid' is no longer accepted at create time", () => {
    expect(createFn).toContain("IF _inv.status <> 'sent' THEN");
    expect(createFn).not.toContain("NOT IN ('sent','paid')");
  });

  it("the V1 rule that a fully paid invoice cannot be credited at all is unchanged — post_ar_credit_note() still rejects 'paid' independently, under its own invoice lock", () => {
    expect(postFn).toContain("IF inv.status = 'paid' THEN");
    expect(postFn).toContain("cannot be credited in this version");
  });
});
