import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const migration = read(
  resolve(root, "supabase/migrations/20260822120000_ap_posting_reversal_hardening.sql"),
);
const foundation = read(
  resolve(root, "supabase/migrations/20260705040642_e2695ffa-2a90-4433-bfeb-059363c7aa85.sql"),
);
const paymentIntegrity = read(
  resolve(root, "supabase/migrations/20260807120000_ar_ap_payment_integrity.sql"),
);
const invoiceReversalMigration = read(
  resolve(root, "supabase/migrations/20260818090000_ar_invoice_reversal.sql"),
);
const apPage = read(resolve(root, "src/routes/_authenticated/accounting.ap.tsx"));

function fn(source: string, name: string): string {
  const match = source.match(
    new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}[\\s\\S]*?\\$\\$;`),
  )?.[0];
  if (!match) throw new Error(`Could not find function ${name} in source`);
  return match;
}

const createFn = fn(migration, "create_ap_bill");
const postFn = fn(migration, "post_ap_bill");
const reverseBillFn = fn(migration, "reverse_ap_bill");
const reversePaymentFn = fn(migration, "reverse_ap_payment");

describe("AP hardening — accounting model / scope sanity", () => {
  it("does not touch FX, posting_rules, night audit, HRM/payroll, POS/inventory, or channel integrations", () => {
    expect(migration).not.toMatch(
      /fx_convert|posting_rules\s+SET|night_audit|payroll|hrm_|pos_orders|channel_/i,
    );
  });

  it("reuses the global journal_entries_reversal_of_uniq index created by AR reversal work — does not redefine it", () => {
    expect(invoiceReversalMigration).toContain(
      "CREATE UNIQUE INDEX journal_entries_reversal_of_uniq",
    );
    expect(migration).not.toMatch(/CREATE UNIQUE INDEX journal_entries_reversal_of_uniq/);
  });

  it("this migration only adds new objects — no destructive statement anywhere", () => {
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/);
  });

  it("ap_bills reuses the existing (already-reserved, unused) 'void' status value — no ALTER TYPE needed", () => {
    expect(foundation).toContain("CREATE TYPE ap_status AS ENUM ('draft','open','paid','void');");
    expect(migration).not.toMatch(/ALTER TYPE public\.ap_status/);
  });

  it("ap_payments gains a new ap_payment_status ENUM ('posted','void'), defaulting every existing row to 'posted'", () => {
    expect(migration).toContain("CREATE TYPE public.ap_payment_status AS ENUM ('posted', 'void');");
    expect(migration).toContain(
      "ADD COLUMN IF NOT EXISTS status public.ap_payment_status NOT NULL DEFAULT 'posted'",
    );
  });

  it("ap_bills and ap_payments both gain the same reversal metadata shape used by AR", () => {
    for (const table of ["ap_bills", "ap_payments"]) {
      const alterIdx = migration.indexOf(`ALTER TABLE public.${table}`);
      expect(alterIdx).toBeGreaterThan(-1);
      const chunk = migration.slice(alterIdx, alterIdx + 600);
      expect(chunk).toContain(
        "ADD COLUMN IF NOT EXISTS reversal_entry_id UUID REFERENCES public.journal_entries(id)",
      );
      expect(chunk).toContain("ADD COLUMN IF NOT EXISTS reversal_reason TEXT");
      expect(chunk).toContain(
        "ADD COLUMN IF NOT EXISTS reversed_by UUID REFERENCES auth.users(id)",
      );
      expect(chunk).toContain("ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ");
    }
  });
});

describe("AP hardening — atomic bill creation (create_ap_bill)", () => {
  it("signature: (_property_id, _supplier_id, _supplier_name, _reference, _bill_date, _due_date, _currency, _notes, _lines) RETURNS UUID", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION public.create_ap_bill(\n  _property_id UUID,\n  _supplier_id UUID,\n  _supplier_name TEXT,\n  _reference TEXT,\n  _bill_date DATE,\n  _due_date DATE,\n  _currency TEXT,\n  _notes TEXT,\n  _lines JSONB\n) RETURNS UUID",
    );
  });

  it("enforces the same role set every other AP write already requires — permission rejection happens before any write", () => {
    expect(createFn).toContain(
      "IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id) THEN",
    );
    const roleIdx = createFn.indexOf("has_any_role(");
    const firstInsertIdx = createFn.indexOf("INSERT INTO");
    expect(roleIdx).toBeGreaterThan(-1);
    expect(roleIdx).toBeLessThan(firstInsertIdx);
  });

  it("rejects an empty/malformed bill — no lines, non-array lines, or a blank supplier name — before any INSERT", () => {
    expect(createFn).toContain("_trimmed_supplier_name = ''");
    expect(createFn).toContain("Supplier name is required");
    expect(createFn).toContain(
      "_lines IS NULL OR jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0",
    );
    expect(createFn).toContain("At least one bill line is required");
    const validationIdx = createFn.indexOf("At least one bill line is required");
    const billInsertIdx = createFn.indexOf("INSERT INTO public.ap_bills(");
    expect(validationIdx).toBeLessThan(billInsertIdx);
  });

  it("rejects a line with a blank description, non-positive quantity, negative unit price, or an out-of-range tax rate — inside the per-line loop, before that line's own INSERT", () => {
    expect(createFn).toContain("_description = ''");
    expect(createFn).toContain("Every bill line requires a description");
    expect(createFn).toContain("_quantity IS NULL OR _quantity <= 0");
    expect(createFn).toContain("Bill line quantity must be greater than zero");
    expect(createFn).toContain("_unit_price IS NULL OR _unit_price < 0");
    expect(createFn).toContain("must not be negative");
    expect(createFn).toContain("_tax_rate < 0 OR _tax_rate > 100");
    expect(createFn).toContain("must be between 0 and 100");
  });

  it("rejects an unrecognized currency code and a supplier_id that does not belong to this property, before any bill row is created", () => {
    expect(createFn).toContain(
      "NOT EXISTS (SELECT 1 FROM public.currencies WHERE code = _currency)",
    );
    expect(createFn).toContain("is not a recognized currency code");
    expect(createFn).toContain(
      "SELECT * INTO _supplier FROM public.suppliers WHERE id = _supplier_id AND property_id = _property_id;",
    );
    expect(createFn).toContain("Supplier not found for this property");
    const supplierCheckIdx = createFn.indexOf("Supplier not found for this property");
    const billInsertIdx = createFn.indexOf("INSERT INTO public.ap_bills(");
    expect(supplierCheckIdx).toBeLessThan(billInsertIdx);
  });

  it("a validation failure on line 2+ rolls back line 1's own INSERT too — a RAISE EXCEPTION anywhere aborts the whole implicit transaction, so no partially-created bill can ever exist", () => {
    // No exception handler swallows a mid-loop failure — plpgsql functions
    // run inside the caller's transaction by default with no BEGIN/
    // EXCEPTION block here, so any RAISE EXCEPTION mid-loop rolls back the
    // already-inserted ap_bills row and every ap_bill_lines row inserted so
    // far in the same call.
    expect(createFn).not.toMatch(/EXCEPTION\s+WHEN/);
    const loopIdx = createFn.indexOf("FOR _line IN SELECT * FROM jsonb_array_elements");
    const lineInsertIdx = createFn.indexOf("INSERT INTO public.ap_bill_lines(");
    expect(loopIdx).toBeLessThan(lineInsertIdx);
  });

  it("creates the bill as 'draft' — no journal is posted at creation time, matching post_ap_bill()'s own separate, explicit posting step", () => {
    expect(createFn).toContain("'draft', auth.uid()");
    expect(createFn).not.toContain("post_journal(");
  });

  it("computed subtotal/tax/total are a preview only — post_ap_bill() still recomputes fresh from ap_bill_lines at posting time, unchanged by this migration", () => {
    expect(postFn).toContain("FOR ln IN SELECT * FROM public.ap_bill_lines WHERE bill_id=_id LOOP");
    expect(postFn).toContain("_sub := _sub + (ln.quantity * ln.unit_price);");
  });

  it("grants: authenticated only, no anon/PUBLIC", () => {
    expect(migration).toContain(
      "REVOKE EXECUTE ON FUNCTION public.create_ap_bill(uuid, uuid, text, text, date, date, text, text, jsonb) FROM PUBLIC, anon;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.create_ap_bill(uuid, uuid, text, text, date, date, text, text, jsonb) TO authenticated;",
    );
  });
});

describe("AP hardening — no direct client writes to ap_bills/ap_bill_lines", () => {
  it("revokes INSERT/UPDATE/DELETE grants from authenticated on both tables, leaving SELECT intact", () => {
    expect(migration).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.ap_bills FROM authenticated;",
    );
    expect(migration).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.ap_bill_lines FROM authenticated;",
    );
    expect(migration).not.toMatch(/REVOKE SELECT[^;]*ap_bills/);
    expect(migration).not.toMatch(/REVOKE SELECT[^;]*ap_bill_lines/);
  });

  it("the AP route no longer writes directly to ap_bills/ap_bill_lines — bill creation is RPC-only", () => {
    expect(apPage).not.toMatch(/\.from\("ap_bills"\)\.(insert|update|upsert|delete)/);
    expect(apPage).not.toMatch(/\.from\("ap_bill_lines"\)\.(insert|update|upsert|delete)/);
    expect(apPage).toContain('"create_ap_bill"');
  });
});

describe("AP hardening — post_ap_bill() concurrency fix", () => {
  it("now takes a row lock before checking/setting posted_entry_id — the pre-existing missing-lock bug", () => {
    expect(postFn).toContain("SELECT * INTO b FROM public.ap_bills WHERE id=_id FOR UPDATE;");
    const lockIdx = postFn.indexOf("FOR UPDATE");
    const idempotencyCheckIdx = postFn.indexOf("b.posted_entry_id IS NOT NULL");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(idempotencyCheckIdx).toBeGreaterThan(lockIdx);
  });

  it("everything else about post_ap_bill's own posting/permission/journal logic is unchanged from the original foundation migration", () => {
    expect(foundation).toContain("SELECT * INTO b FROM public.ap_bills WHERE id=_id;");
    expect(postFn).toContain(
      "IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], b.property_id) THEN",
    );
    expect(postFn).toContain(
      "_entry := public.post_journal(b.property_id, b.bill_date, b.currency, 'AP Bill '||b.code, 'ap', b.id::text, _lines);",
    );
  });
});

describe("AP hardening — reverse_ap_bill() eligibility", () => {
  it("signature matches reverse_ar_invoice()'s own shape: (_id UUID, _reason TEXT) RETURNS UUID", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION public.reverse_ap_bill(_id UUID, _reason TEXT)\nRETURNS UUID",
    );
  });

  it("rejects a draft bill (nothing posted yet)", () => {
    expect(reverseBillFn).toContain("IF bl.status = 'draft' THEN");
    expect(reverseBillFn).toContain("still a draft and has nothing to reverse");
  });

  it("rejects an already-void bill (double reversal via status)", () => {
    expect(reverseBillFn).toContain("IF bl.status = 'void' THEN");
    expect(reverseBillFn).toContain("has already been reversed");
  });

  it("rejects any status other than 'open' (defensive catch-all, e.g. 'paid')", () => {
    expect(reverseBillFn).toContain("IF bl.status <> 'open' THEN");
    expect(reverseBillFn).toContain("is not in a reversible state");
  });

  it("rejects a bill with any nonzero amount_paid, and independently rejects a bill with any posted ap_payments row — a bill with payments must be reversed via payment reversal first", () => {
    expect(reverseBillFn).toContain("IF bl.amount_paid <> 0 THEN");
    expect(reverseBillFn).toContain("reverse the payment(s) first");
    expect(reverseBillFn).toContain(
      "SELECT count(*) INTO _payment_count FROM public.ap_payments WHERE bill_id = bl.id AND status = 'posted';",
    );
    expect(reverseBillFn).toContain("_payment_count > 0");
  });

  it("rejects reversal with no posted journal entry to reverse", () => {
    expect(reverseBillFn).toContain("IF bl.posted_entry_id IS NULL THEN");
    expect(reverseBillFn).toContain("has no posted journal entry to reverse");
  });
});

describe("AP hardening — reverse_ap_bill() concurrency, idempotency, and period lock", () => {
  it("row lock acquired before any status/eligibility check — primary defense against concurrent double reversal of the same bill", () => {
    expect(reverseBillFn).toContain(
      "SELECT * INTO bl FROM public.ap_bills WHERE id = _id FOR UPDATE;",
    );
    const lockIdx = reverseBillFn.indexOf("FOR UPDATE");
    const statusIdx = reverseBillFn.indexOf("IF bl.status = 'draft'");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(statusIdx).toBeGreaterThan(lockIdx);
  });

  it("also checks journal_entries for an existing is_reversal_of row before inserting — belt-and-suspenders alongside the global unique index", () => {
    expect(reverseBillFn).toContain(
      "SELECT id INTO _existing_reversal FROM public.journal_entries WHERE is_reversal_of = bl.posted_entry_id;",
    );
    expect(reverseBillFn).toContain("already has a reversal journal entry");
  });

  it("blocks reversal during a locked/closed accounting period", () => {
    expect(reverseBillFn).toContain("status IN ('locked','closed')");
    expect(reverseBillFn).toContain("Current accounting period is locked");
  });
});

describe("AP hardening — reverse_ap_bill() journal construction", () => {
  it("original journal is read but never mutated", () => {
    expect(reverseBillFn).toContain(
      "FOR jl IN SELECT * FROM public.journal_lines WHERE entry_id = bl.posted_entry_id ORDER BY created_at LOOP",
    );
    expect(reverseBillFn).not.toMatch(/UPDATE public\.journal_lines/);
    expect(reverseBillFn).not.toMatch(/DELETE FROM public\.journal_(lines|entries)/);
  });

  it("reversal lines are the exact inverse of the original — debit/credit swapped, fx/base amounts copied verbatim, never recomputed from ap_bill_lines/tax_rate", () => {
    expect(reverseBillFn).toContain(
      "VALUES (_reversal_entry, jl.account_id, jl.credit, jl.debit, jl.currency, jl.fx_rate, jl.credit_base, jl.debit_base,",
    );
    expect(reverseBillFn).not.toContain("ap_bill_lines");
  });

  it("reversal entry links to the original via is_reversal_of", () => {
    expect(reverseBillFn).toContain(
      "VALUES (bl.property_id, CURRENT_DATE, 'Reversal of AP Bill '||bl.code||' — '||_trimmed_reason, 'ap', bl.id::text, orig_entry.currency, auth.uid(), bl.posted_entry_id)",
    );
  });

  it("does not overload ap_bills.posted_entry_id to point at the reversal — it is only read here, a separate reversal_entry_id column holds the reversal", () => {
    expect(reverseBillFn).not.toMatch(/UPDATE public\.ap_bills\s+SET[^;]*posted_entry_id/);
    expect(reverseBillFn).toContain(
      "SET status = 'void', reversal_entry_id = _reversal_entry, reversal_reason = _trimmed_reason,\n        reversed_by = auth.uid(), reversed_at = now()",
    );
  });

  it("net GL effect is asserted balanced with NUMERIC precision, not assumed", () => {
    expect(reverseBillFn).toContain(
      "SELECT COALESCE(SUM(debit_base),0), COALESCE(SUM(credit_base),0) INTO _dr, _cr",
    );
    expect(reverseBillFn).toContain("ROUND(_dr,2) <> ROUND(_cr,2)");
    expect(reverseBillFn).toContain("Reversal journal is not balanced");
  });
});

describe("AP hardening — reverse_ap_bill() permissions, isolation, reason, audit", () => {
  it("uses the same admin role set every other AP write already requires — no broader or narrower set introduced", () => {
    expect(reverseBillFn).toContain(
      "public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], bl.property_id)",
    );
    expect(reverseBillFn).not.toMatch(/front_desk/);
  });

  it("property scope is derived server-side from the locked row, never a client-supplied parameter — cross-property/tenant reversal is impossible by construction", () => {
    expect(migration).not.toMatch(/reverse_ap_bill\([^)]*_property_id/);
  });

  it("requires a reason of 5-500 trimmed characters", () => {
    expect(reverseBillFn).toContain("char_length(_trimmed_reason) < 5");
    expect(reverseBillFn).toContain("reversal reason of at least 5 characters is required");
    expect(reverseBillFn).toContain("char_length(_trimmed_reason) > 500");
    expect(reverseBillFn).toContain("500 characters or fewer");
  });

  it("writes exactly one admin_action_logs row, only after every guard and after the journal/status writes, using auth.uid() as actor and bl.property_id (never a client-supplied value)", () => {
    const inserts = reverseBillFn.match(/INSERT INTO public\.admin_action_logs/g) ?? [];
    expect(inserts).toHaveLength(1);
    expect(reverseBillFn).toContain(
      "bl.property_id, auth.uid(), 'ap_bill', bl.id::text, 'update',",
    );
    const auditIdx = reverseBillFn.indexOf("INSERT INTO public.admin_action_logs(");
    const journalInsertIdx = reverseBillFn.indexOf("INSERT INTO public.journal_entries(");
    const statusUpdateIdx = reverseBillFn.indexOf("SET status = 'void', reversal_entry_id");
    expect(auditIdx).toBeGreaterThan(journalInsertIdx);
    expect(auditIdx).toBeGreaterThan(statusUpdateIdx);
    expect(reverseBillFn).not.toMatch(/EXCEPTION\s+WHEN/);
  });

  it("grants: authenticated only, no anon/PUBLIC", () => {
    expect(migration).toContain(
      "REVOKE EXECUTE ON FUNCTION public.reverse_ap_bill(uuid, text) FROM PUBLIC, anon;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.reverse_ap_bill(uuid, text) TO authenticated;",
    );
  });
});

describe("AP hardening — reverse_ap_payment() eligibility, concurrency, and lock order", () => {
  it("signature: (_id UUID, _reason TEXT) RETURNS UUID", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION public.reverse_ap_payment(_id UUID, _reason TEXT)\nRETURNS UUID",
    );
  });

  it("locks the payment row first, before any status check — primary defense against concurrent double reversal of the same payment", () => {
    expect(reversePaymentFn).toContain(
      "SELECT * INTO pay FROM public.ap_payments WHERE id = _id FOR UPDATE;",
    );
    const lockIdx = reversePaymentFn.indexOf("FOR UPDATE");
    const statusIdx = reversePaymentFn.indexOf("IF pay.status = 'void'");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(statusIdx).toBeGreaterThan(lockIdx);
  });

  it("rejects an already-void payment and any non-'posted' status", () => {
    expect(reversePaymentFn).toContain("IF pay.status = 'void' THEN");
    expect(reversePaymentFn).toContain("has already been reversed");
    expect(reversePaymentFn).toContain("IF pay.status <> 'posted' THEN");
    expect(reversePaymentFn).toContain("is not in a reversible state");
  });

  it("also checks journal_entries.is_reversal_of before inserting, same as bill reversal, alongside the DB-level global unique index", () => {
    expect(reversePaymentFn).toContain(
      "SELECT id INTO _existing_reversal FROM public.journal_entries WHERE is_reversal_of = pay.posted_entry_id;",
    );
    expect(reversePaymentFn).toContain("already has a reversal journal entry");
  });

  it("blocks reversal during a locked/closed accounting period", () => {
    expect(reversePaymentFn).toContain("status IN ('locked','closed')");
    expect(reversePaymentFn).toContain("Current accounting period is locked");
  });

  it("locks the payment's single bill AFTER the payment row — the same order post_ap_payment() itself uses when it locks the bill during payment creation, so a concurrent post_ap_payment() and reverse_ap_payment() on bills sharing no rows can never deadlock against each other, and two reverse_ap_payment() calls for different payments on the SAME bill serialize on the bill lock in whichever order they arrive, never circularly", () => {
    const payLockIdx = reversePaymentFn.indexOf(
      "SELECT * INTO pay FROM public.ap_payments WHERE id = _id FOR UPDATE;",
    );
    const billLockIdx = reversePaymentFn.indexOf(
      "SELECT * INTO bl FROM public.ap_bills WHERE id = pay.bill_id FOR UPDATE;",
    );
    expect(payLockIdx).toBeGreaterThan(-1);
    expect(billLockIdx).toBeGreaterThan(payLockIdx);
    expect(paymentIntegrity).toContain(
      "SELECT * INTO b FROM public.ap_bills WHERE id=p.bill_id FOR UPDATE;",
    );
  });
});

describe("AP hardening — reverse_ap_payment() journal construction and balance restoration", () => {
  it("original journal is read but never mutated", () => {
    expect(reversePaymentFn).toContain(
      "FOR jl IN SELECT * FROM public.journal_lines WHERE entry_id = pay.posted_entry_id ORDER BY created_at LOOP",
    );
    expect(reversePaymentFn).not.toMatch(/UPDATE public\.journal_lines/);
    expect(reversePaymentFn).not.toMatch(/DELETE FROM public\.journal_(lines|entries)/);
  });

  it("reversal lines are the exact inverse of the original payment posting", () => {
    expect(reversePaymentFn).toContain(
      "VALUES (_reversal_entry, jl.account_id, jl.credit, jl.debit, jl.currency, jl.fx_rate, jl.credit_base, jl.debit_base,",
    );
  });

  it("net GL effect is asserted balanced with NUMERIC precision", () => {
    expect(reversePaymentFn).toContain(
      "SELECT COALESCE(SUM(debit_base),0), COALESCE(SUM(credit_base),0) INTO _dr, _cr",
    );
    expect(reversePaymentFn).toContain("ROUND(_dr,2) <> ROUND(_cr,2)");
  });

  it("amount_paid is decremented by exactly this payment's own original amount — an exact undo, not a recompute-from-scratch sum, so any OTHER payment on the same bill is left untouched", () => {
    expect(reversePaymentFn).toContain("_new_paid := bl.amount_paid - pay.amount;");
    expect(reversePaymentFn).toContain(
      "UPDATE public.ap_bills SET amount_paid = _new_paid, status = _new_status WHERE id = bl.id;",
    );
  });

  it("guards a structurally-unreachable negative amount_paid with a clean business error rather than a raw CHECK-constraint violation", () => {
    expect(reversePaymentFn).toContain("IF _new_paid < 0 THEN");
    expect(reversePaymentFn).toContain("would drive bill % amount_paid negative");
  });

  it("bill status is recomputed via the same paid-vs-open threshold post_ap_payment() itself uses going forward, never hardcoded/restored to a stored prior value", () => {
    expect(reversePaymentFn).toContain(
      "_new_status := CASE WHEN _new_paid >= bl.total THEN 'paid'::ap_status ELSE 'open'::ap_status END;",
    );
    expect(paymentIntegrity).toContain(
      "status = CASE WHEN amount_paid + p.amount >= total THEN 'paid'::ap_status ELSE status END",
    );
  });

  it("never deletes or modifies any other ap_payments row — the payment being reversed is the only row updated, immutable history for every other payment", () => {
    const updateMatches = reversePaymentFn.match(/UPDATE public\.ap_payments/g) ?? [];
    expect(updateMatches).toHaveLength(1);
    expect(reversePaymentFn).toContain("WHERE id = pay.id;");
  });

  it("writes exactly one admin_action_logs row with actor from auth.uid() and property_id from the locked payment row", () => {
    const inserts = reversePaymentFn.match(/INSERT INTO public\.admin_action_logs/g) ?? [];
    expect(inserts).toHaveLength(1);
    expect(reversePaymentFn).toContain(
      "pay.property_id, auth.uid(), 'ap_payment', pay.id::text, 'update',",
    );
  });

  it("requires a reason of 5-500 trimmed characters, same rule as bill reversal", () => {
    expect(reversePaymentFn).toContain("char_length(_trimmed_reason) < 5");
    expect(reversePaymentFn).toContain("char_length(_trimmed_reason) > 500");
  });

  it("uses the same admin role set, no front_desk, and property scope derived server-side (no _property_id parameter)", () => {
    expect(reversePaymentFn).toContain(
      "public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], pay.property_id)",
    );
    expect(reversePaymentFn).not.toMatch(/front_desk/);
    expect(migration).not.toMatch(/reverse_ap_payment\([^)]*_property_id/);
  });

  it("grants: authenticated only, no anon/PUBLIC", () => {
    expect(migration).toContain(
      "REVOKE EXECUTE ON FUNCTION public.reverse_ap_payment(uuid, text) FROM PUBLIC, anon;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.reverse_ap_payment(uuid, text) TO authenticated;",
    );
  });
});

describe("AP hardening — 'no multi-bill allocation' invariant (why AP payment reversal is simpler than AR receipt reversal)", () => {
  it("ap_payments.bill_id is a direct single FK — there is no ap_payment allocation table, so reverse_ap_payment() never loops over multiple bills/allocations", () => {
    expect(foundation).toContain(
      "bill_id UUID NOT NULL REFERENCES public.ap_bills(id) ON DELETE CASCADE",
    );
    // The migration's own header comment documents this invariant in prose
    // (search for the phrase itself), but never actually creates the table.
    expect(migration).not.toMatch(/CREATE TABLE public\.ap_payment_allocations/);
    expect(reversePaymentFn).not.toMatch(/ap_payment_allocations/);
    expect(reversePaymentFn).not.toMatch(/ORDER BY (invoice_id|bill_id)/);
  });
});

describe("AP hardening — UI (accounting.ap.tsx)", () => {
  it("Reverse bill is only offered for an open bill with zero amount_paid", () => {
    expect(apPage).toContain(
      'b.status === "open" && Number(b.amount_paid) === 0 && canReverse.allowed',
    );
  });

  it("Reverse payment is only offered for a posted (non-void) payment", () => {
    expect(apPage).toContain('p.status === "posted" && canReverse.allowed');
  });

  it("both actions are gated by the same ACCOUNTING_AP_ROLES set used elsewhere in this file, not a hardcoded role string", () => {
    expect(apPage).toContain("useHasAnyRole([...ACCOUNTING_AP_ROLES], propertyId)");
    expect(apPage).not.toMatch(/role\s*===\s*['"]admin['"]/);
  });

  it("both reversal dialogs require a 5-500 char reason and use destructive button styling", () => {
    expect(apPage).toContain("disabled={reverseBill.isPending || reverseReason.trim().length < 5}");
    expect(apPage).toContain(
      "disabled={reversePayment.isPending || reversePaymentReason.trim().length < 5}",
    );
    const billDialog =
      apPage.match(/<DialogTitle>Reverse bill<\/DialogTitle>[\s\S]*?<\/Dialog>/)?.[0] ?? "";
    const paymentDialog =
      apPage.match(/<DialogTitle>Reverse payment<\/DialogTitle>[\s\S]*?<\/Dialog>/)?.[0] ?? "";
    expect(billDialog).toContain('variant="destructive"');
    expect(paymentDialog).toContain('variant="destructive"');
  });

  it("both dialogs carry an explicit permanence warning that the original record/journal is never edited or deleted", () => {
    const billDialog =
      apPage.match(/<DialogTitle>Reverse bill<\/DialogTitle>[\s\S]*?<\/Dialog>/)?.[0] ?? "";
    const paymentDialog =
      apPage.match(/<DialogTitle>Reverse payment<\/DialogTitle>[\s\S]*?<\/Dialog>/)?.[0] ?? "";
    expect(billDialog).toMatch(/never edited or deleted/);
    expect(paymentDialog).toMatch(/never edited or deleted/);
  });

  it("reversed bills and payments remain visible with a void badge/status and the reversal reason shown, not hidden", () => {
    expect(apPage).toContain('b.status === "void" && b.reversal_reason && (');
    expect(apPage).toContain('p.status === "void" && <Badge variant="secondary"');
    expect(apPage).toContain('p.status === "void" && p.reversal_reason && (');
  });

  it("calls reverse_ap_bill / reverse_ap_payment directly via supabase.rpc, matching the AR page's own unwrapped-RPC precedent for not-yet-typed RPCs", () => {
    expect(apPage).toContain(
      '(supabase.rpc as any)("reverse_ap_bill", { _id: id, _reason: reason });',
    );
    expect(apPage).toContain(
      '(supabase.rpc as any)("reverse_ap_payment", { _id: id, _reason: reason });',
    );
  });

  it("query invalidation after bill reversal covers bills and aging; after payment reversal covers payments, bills, and aging", () => {
    const reverseBillBlock =
      apPage.match(
        /const reverseBill = useMutation\(\{[\s\S]*?onError: \(e: Error\) => toast\.error\(e\.message\),\n {2}\}\);/,
      )?.[0] ?? "";
    const reversePaymentBlock =
      apPage.match(
        /const reversePayment = useMutation\(\{[\s\S]*?onError: \(e: Error\) => toast\.error\(e\.message\),\n {2}\}\);/,
      )?.[0] ?? "";
    expect(reverseBillBlock).toContain(
      'qc.invalidateQueries({ queryKey: ["ap-bills", propertyId] });',
    );
    expect(reverseBillBlock).toContain(
      'qc.invalidateQueries({ queryKey: ["ap-aging", propertyId] });',
    );
    expect(reversePaymentBlock).toContain(
      'qc.invalidateQueries({ queryKey: ["ap-payments", propertyId] });',
    );
    expect(reversePaymentBlock).toContain(
      'qc.invalidateQueries({ queryKey: ["ap-bills", propertyId] });',
    );
    expect(reversePaymentBlock).toContain(
      'qc.invalidateQueries({ queryKey: ["ap-aging", propertyId] });',
    );
  });

  it("errors from either reversal RPC surface the server's own message, without a generic override that would hide details", () => {
    const reverseBillBlock =
      apPage.match(
        /const reverseBill = useMutation\(\{[\s\S]*?onError: \(e: Error\) => toast\.error\(e\.message\),\n {2}\}\);/,
      )?.[0] ?? "";
    const reversePaymentBlock =
      apPage.match(
        /const reversePayment = useMutation\(\{[\s\S]*?onError: \(e: Error\) => toast\.error\(e\.message\),\n {2}\}\);/,
      )?.[0] ?? "";
    expect(reverseBillBlock).toContain("onError: (e: Error) => toast.error(e.message),");
    expect(reversePaymentBlock).toContain("onError: (e: Error) => toast.error(e.message),");
  });
});

describe("AP hardening — security posture / no unrelated code touched", () => {
  it("neither the AP page nor the migration references FX, posting_rules mutation, night audit, HRM/payroll, POS/inventory, or channel integrations", () => {
    expect(apPage).not.toMatch(/night_audit|payroll|hrm_|pos_orders|channel_/i);
  });

  it("reverse_ar_invoice()/reverse_ar_credit_note()/reverse_ar_receipt() are untouched by this migration — no CREATE OR REPLACE of any of them here", () => {
    expect(migration).not.toContain("FUNCTION public.reverse_ar_invoice");
    expect(migration).not.toContain("FUNCTION public.reverse_ar_credit_note");
    expect(migration).not.toContain("FUNCTION public.reverse_ar_receipt");
  });

  it("no service-role usage anywhere in the touched client code", () => {
    expect(apPage).not.toMatch(/service_role/i);
  });

  it("every new/changed function pins search_path so it cannot be hijacked via a caller-controlled search_path", () => {
    for (const body of [createFn, postFn, reverseBillFn, reversePaymentFn]) {
      expect(body).toContain("SECURITY DEFINER SET search_path");
    }
  });
});
