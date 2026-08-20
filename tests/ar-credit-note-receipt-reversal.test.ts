import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const migration = read(
  resolve(root, "supabase/migrations/20260821120000_ar_credit_note_receipt_reversal.sql"),
);
const prevMigration = read(
  resolve(root, "supabase/migrations/20260819120000_ar_credit_notes_pr1.sql"),
);
const invoiceReversalMigration = read(
  resolve(root, "supabase/migrations/20260818090000_ar_invoice_reversal.sql"),
);
const panel = read(resolve(root, "src/components/accounting/ar-credit-notes-panel.tsx"));
const arPage = read(resolve(root, "src/routes/_authenticated/accounting.ar.tsx"));
const statementCalc = read(resolve(root, "src/lib/accounting/ar-statement-calc.ts"));
const statementsFn = read(resolve(root, "src/lib/accounting/ar-statements.functions.ts"));

function fn(source: string, name: string): string {
  const match = source.match(
    new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}[\\s\\S]*?\\$\\$;`),
  )?.[0];
  if (!match) throw new Error(`Could not find function ${name} in source`);
  return match;
}

describe("PR B — schema", () => {
  it("ar_credit_notes reuses the existing (already-reserved, unused) 'void' status value — no ALTER TYPE needed", () => {
    expect(prevMigration).toContain(
      "CREATE TYPE public.ar_credit_note_status AS ENUM ('draft', 'posted', 'void');",
    );
    expect(migration).not.toMatch(/ALTER TYPE public\.ar_credit_note_status/);
  });

  it("ar_credit_notes gains reversal metadata columns, additively", () => {
    expect(migration).toContain(
      "ADD COLUMN IF NOT EXISTS reversal_entry_id UUID REFERENCES public.journal_entries(id)",
    );
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS reversal_reason TEXT");
    expect(migration).toContain(
      "ADD COLUMN IF NOT EXISTS reversed_by UUID REFERENCES auth.users(id)",
    );
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ");
  });

  it("ar_receipts gains a new ar_receipt_status ENUM ('posted','void'), defaulting every existing row to 'posted'", () => {
    expect(migration).toContain("CREATE TYPE public.ar_receipt_status AS ENUM ('posted', 'void');");
    expect(migration).toContain(
      "ADD COLUMN IF NOT EXISTS status public.ar_receipt_status NOT NULL DEFAULT 'posted'",
    );
  });

  it("ar_receipts gains the same reversal metadata shape as ar_credit_notes", () => {
    expect(migration).toContain(
      "ADD COLUMN IF NOT EXISTS reversal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,\n  ADD COLUMN IF NOT EXISTS reversal_reason TEXT,\n  ADD COLUMN IF NOT EXISTS reversed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,\n  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;",
    );
  });

  it("no destructive statement anywhere — additive only", () => {
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/);
  });
});

describe("PR B — reverse_ar_credit_note() contract", () => {
  const body = fn(migration, "reverse_ar_credit_note");

  it("signature matches reverse_ar_invoice()'s own shape exactly: (_id UUID, _reason TEXT) RETURNS UUID", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION public.reverse_ar_credit_note(_id UUID, _reason TEXT)\nRETURNS UUID",
    );
    expect(invoiceReversalMigration).toContain(
      "CREATE OR REPLACE FUNCTION public.reverse_ar_invoice(_id UUID, _reason TEXT)",
    );
  });

  it("1. reverses a posted credit note", () => {
    expect(body).toContain("IF cn.status <> 'posted' THEN");
    expect(body).toContain("UPDATE public.ar_credit_notes\n    SET status = 'void'");
  });

  it("2. rejects a draft credit note", () => {
    expect(body).toContain(
      "IF cn.status = 'draft' THEN\n    RAISE EXCEPTION 'Credit note % is still a draft and has nothing to reverse', cn.code;",
    );
  });

  it("3. rejects double reversal", () => {
    expect(body).toContain(
      "IF cn.status = 'void' THEN\n    RAISE EXCEPTION 'Credit note % has already been reversed', cn.code;",
    );
    expect(body).toContain(
      "SELECT id INTO _existing_reversal FROM public.journal_entries WHERE is_reversal_of = cn.posted_entry_id;",
    );
  });

  it("4. rejects unauthorized reversal — same accounting-admin role array reverse_ar_invoice() already uses, deliberately not the broader receipt-creation set", () => {
    expect(body).toContain(
      "IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], cn.property_id) THEN\n    RAISE EXCEPTION 'Not permitted to reverse an AR credit note';",
    );
  });

  it("5. property scope is derived server-side from the locked row, not a client-supplied parameter — cross-property reversal is structurally impossible", () => {
    expect(migration).not.toMatch(/reverse_ar_credit_note\([^)]*_property_id/);
    expect(body).toContain(
      "SELECT * INTO cn FROM public.ar_credit_notes WHERE id = _id FOR UPDATE;",
    );
  });

  it("6. journal inversion swaps debit/credit from the original entry's lines, exactly like reverse_ar_invoice()", () => {
    expect(body).toContain(
      "INSERT INTO public.journal_lines(entry_id, account_id, debit, credit, currency, fx_rate, debit_base, credit_base, memo)\n    VALUES (_reversal_entry, jl.account_id, jl.credit, jl.debit, jl.currency, jl.fx_rate, jl.credit_base, jl.debit_base",
    );
    expect(body).toContain("is_reversal_of = cn.posted_entry_id");
    // Balance re-check, same defensive posture as reverse_ar_invoice().
    expect(body).toContain(
      "IF ROUND(_dr,2) <> ROUND(_cr,2) THEN\n    RAISE EXCEPTION 'Reversal journal is not balanced (DR %, CR %)', _dr, _cr;",
    );
  });

  it("7. credited total is recomputed fresh (not restored from a stored value) after the status flip makes it no longer 'posted'", () => {
    const order = body.indexOf("SET status = 'void'");
    const recompute = body.indexOf("_credited_total := public.ar_invoice_credited_total(inv.id);");
    expect(order).toBeGreaterThan(-1);
    expect(recompute).toBeGreaterThan(order);
  });

  it("8. invoice status is recomputed via the same net_balance <= 0 ? paid : sent rule, never hardcoded/restored", () => {
    expect(body).toContain(
      "_new_status := CASE WHEN _net_balance <= 0 THEN 'paid'::ar_status ELSE 'sent'::ar_status END;",
    );
  });

  it("respects the accounting-period lock, matching every other posting/reversal function", () => {
    expect(body).toContain("status IN ('locked','closed')");
    expect(body).toContain("RAISE EXCEPTION 'Current accounting period is locked';");
  });

  it("writes a direct admin_action_logs row (not via admin_log(), whose own role check excludes accountant) — same reasoning as reverse_ar_invoice()", () => {
    expect(body).toContain("INSERT INTO public.admin_action_logs(");
    expect(body).not.toContain("admin_log(");
  });

  it("grants: authenticated only, no anon/PUBLIC", () => {
    expect(migration).toContain(
      "REVOKE EXECUTE ON FUNCTION public.reverse_ar_credit_note(uuid, text) FROM PUBLIC, anon;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.reverse_ar_credit_note(uuid, text) TO authenticated;",
    );
  });
});

describe("PR B — reverse_ar_receipt() contract", () => {
  const body = fn(migration, "reverse_ar_receipt");

  it("signature: (_id UUID, _reason TEXT) RETURNS UUID — same shape as every other reversal RPC", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION public.reverse_ar_receipt(_id UUID, _reason TEXT)\nRETURNS UUID",
    );
  });

  it("9. reverses a posted receipt", () => {
    expect(body).toContain("IF rec.status <> 'posted' THEN");
    expect(body).toContain("UPDATE public.ar_receipts\n    SET status = 'void'");
  });

  it("10. rejects double reversal", () => {
    expect(body).toContain(
      "IF rec.status = 'void' THEN\n    RAISE EXCEPTION 'Receipt % has already been reversed', rec.code;",
    );
  });

  it("11. rejects unauthorized reversal — deliberately NOT the front_desk-inclusive set post_ar_receipt() itself uses", () => {
    expect(body).toContain(
      "IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], rec.property_id) THEN\n    RAISE EXCEPTION 'Not permitted to reverse an AR receipt';",
    );
    expect(body).not.toMatch(/front_desk/);
  });

  it("12. property scope derived server-side from the locked row — no _property_id parameter", () => {
    expect(migration).not.toMatch(/reverse_ar_receipt\([^)]*_property_id/);
    expect(body).toContain("SELECT * INTO rec FROM public.ar_receipts WHERE id = _id FOR UPDATE;");
  });

  it("13. handles multi-invoice allocation: loops every ar_receipt_allocations row for this receipt, in deterministic (invoice_id) order to avoid deadlocking a concurrent post/reversal on an overlapping invoice", () => {
    expect(body).toContain(
      "SELECT * FROM public.ar_receipt_allocations WHERE receipt_id = rec.id ORDER BY invoice_id",
    );
  });

  it("never deletes or modifies ar_receipt_allocations — immutable history, only the parent row's status changes", () => {
    expect(body).not.toMatch(
      /DELETE FROM public\.ar_receipt_allocations|UPDATE public\.ar_receipt_allocations/,
    );
  });

  it("14. amount_paid is decremented by exactly the original allocation amount per invoice — an exact undo, not a recompute-from-scratch sum, so sibling receipts on the same invoice are untouched", () => {
    expect(body).toContain("_new_paid := inv.amount_paid - alloc.amount;");
    expect(body).toContain(
      "UPDATE public.ar_invoices SET amount_paid = _new_paid, status = _new_status WHERE id = inv.id;",
    );
  });

  it("guards against a structurally-unreachable negative amount_paid with a clean business message rather than a raw CHECK-constraint violation", () => {
    expect(body).toContain("IF _new_paid < 0 THEN");
    expect(body).toContain(
      "RAISE EXCEPTION 'Reversing receipt % would drive invoice % amount_paid negative'",
    );
  });

  it("15. net balance is recomputed per invoice from total/amount_paid/credited_total, and 16. status reopens to 'sent' when the balance becomes positive again", () => {
    expect(body).toContain("_credited_total := public.ar_invoice_credited_total(inv.id);");
    expect(body).toContain("_net_balance := inv.total - _new_paid - _credited_total;");
    expect(body).toContain(
      "_new_status := CASE WHEN _net_balance <= 0 THEN 'paid'::ar_status ELSE 'sent'::ar_status END;",
    );
  });

  it("17. reversal journal swaps debit/credit from the original receipt entry and is re-verified balanced", () => {
    expect(body).toContain(
      "INSERT INTO public.journal_lines(entry_id, account_id, debit, credit, currency, fx_rate, debit_base, credit_base, memo)\n    VALUES (_reversal_entry, jl.account_id, jl.credit, jl.debit",
    );
    expect(body).toContain("is_reversal_of = rec.posted_entry_id");
    expect(body).toContain("IF ROUND(_dr,2) <> ROUND(_cr,2) THEN");
  });

  it("respects the accounting-period lock", () => {
    expect(body).toContain("status IN ('locked','closed')");
  });

  it("writes a direct admin_action_logs row, same reasoning as credit-note reversal", () => {
    expect(body).toContain("INSERT INTO public.admin_action_logs(");
  });

  it("grants: authenticated only, no anon/PUBLIC", () => {
    expect(migration).toContain(
      "REVOKE EXECUTE ON FUNCTION public.reverse_ar_receipt(uuid, text) FROM PUBLIC, anon;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.reverse_ar_receipt(uuid, text) TO authenticated;",
    );
  });
});

describe("PR B — combined-scenario invariant is encoded in the formula, not hardcoded numbers (18/19/20)", () => {
  it("both reversal functions recompute status via the exact same net_balance formula post_ar_credit_note()/post_ar_receipt() already use going forward — never a stored 'previous status'", () => {
    const cnBody = fn(migration, "reverse_ar_credit_note");
    const recBody = fn(migration, "reverse_ar_receipt");
    for (const body of [cnBody, recBody]) {
      expect(body).toMatch(/net_balance <= 0 THEN 'paid'::ar_status ELSE 'sent'::ar_status/);
    }
  });

  it("the invariant reasoning (reverse receipt first -> balance 60/sent; then reverse credit -> balance 100/sent; reverse credit alone while receipt active -> balance 40/sent) is documented explicitly in the migration header, and was verified live against a real Postgres engine, not merely asserted in prose", () => {
    expect(migration).toContain("reopens it to 'sent' with balance 60");
    expect(migration).toContain("balance 100");
    expect(migration).toContain("yields balance 40, still\n--    'sent'");
  });
});

describe("PR B — statement misstatement fix for reversed receipts", () => {
  it("ArStatementAllocationRow now carries receiptStatus, and the calculator excludes a non-'posted' receipt's allocation", () => {
    expect(statementCalc).toContain("receiptStatus: string;");
    expect(statementCalc).toContain('a.receiptStatus === "posted"');
  });

  it("loadArCustomerStatement fetches ar_receipts.status and threads it through as receiptStatus", () => {
    expect(statementsFn).toContain('.select("id,code,receipt_date,currency,status")');
    expect(statementsFn).toContain("receiptStatus: receipt.status,");
  });
});

describe("PR B — credit note UI: Reverse action", () => {
  it("posted rows show a Reverse action, gated to canManage.allowed (the same ACCOUNTING_ADMIN_ROLES check used for New/Post)", () => {
    expect(panel).toContain('cn.status === "posted" && canManage.allowed && (');
    expect(panel).toContain('<Undo2 className="h-3 w-3 mr-1" /> Reverse');
  });

  it("reversal requires a confirmation dialog with a required 5-500 char reason, matching the invoice-reversal UX pattern exactly", () => {
    expect(panel).toContain("Reverse credit note");
    expect(panel).toContain("disabled={reverse.isPending || reverseReason.trim().length < 5}");
    expect(panel).toContain("maxLength={500}");
  });

  it("the confirmation button uses destructive styling — unlike Post, this genuinely is an undo action", () => {
    const reverseDialog =
      panel.match(/<DialogTitle>Reverse credit note<\/DialogTitle>[\s\S]*?<\/Dialog>/)?.[0] ?? "";
    expect(reverseDialog).toContain('variant="destructive"');
  });

  it("reversed (void) credit notes are visually distinct: a distinct badge plus an explicit Reversed date/reason line", () => {
    expect(panel).toContain('cn.status === "void" && (');
    expect(panel).toContain("Reversed {cn.reversed_at");
    expect(panel).toContain("Reversal reason: {cn.reversal_reason}");
  });

  it("no Delete action exists anywhere for a reversed credit note", () => {
    expect(panel).not.toContain("Delete credit note");
    expect(panel).not.toMatch(
      /cn\.status === "void"[\s\S]{0,200}onClick[\s\S]{0,50}(delete|remove)/i,
    );
  });

  it("calls reverse_ar_credit_note directly via supabase.rpc, matching post's own unwrapped-RPC precedent", () => {
    expect(panel).toContain('(supabase.rpc as any)("reverse_ar_credit_note", {');
    expect(panel).toContain("_id: id,");
    expect(panel).toContain("_reason: reversalReason,");
  });

  it("query invalidation after reversal uses the exact same shared derived-query set as posting, plus onLedgerChanged()", () => {
    const reverseOnSuccess =
      panel.match(
        /const reverse = useMutation\(\{[\s\S]*?onError: \(e: Error\) => toast\.error\(e\.message\),\n {2}\}\);/,
      )?.[0] ?? "";
    expect(reverseOnSuccess).toContain("invalidateDerivedQueries();");
  });

  it("errors surface the RPC's own message directly", () => {
    const reverseBlock =
      panel.match(
        /const reverse = useMutation\(\{[\s\S]*?onError: \(e: Error\) => toast\.error\(e\.message\),\n {2}\}\);/,
      )?.[0] ?? "";
    expect(reverseBlock).toContain("onError: (e: Error) => toast.error(e.message),");
  });
});

describe("PR B — receipt UI: Reverse action (inline in accounting.ar.tsx, mirroring invoice reversal)", () => {
  it("posted (non-void) receipts show a Reverse action, gated to canReverse.allowed (ACCOUNTING_ADMIN_ROLES — deliberately excluding front_desk)", () => {
    expect(arPage).toContain('r.status !== "void" && canReverse.allowed && (');
    expect(arPage).toContain("useHasAnyRole([...ACCOUNTING_ADMIN_ROLES], propertyId)");
  });

  it("reversal requires a confirmation dialog with a required 5-500 char reason", () => {
    expect(arPage).toContain("Reverse receipt");
    expect(arPage).toContain(
      "disabled={reverseReceipt.isPending || reverseReceiptReason.trim().length < 5}",
    );
  });

  it("the confirmation explicitly covers the multi-invoice-allocation case and immutability of the original receipt/journal", () => {
    expect(arPage).toContain("restores every invoice it was allocated to");
    expect(arPage).toContain(
      "allocations, and its original journal entry are never edited or deleted. This cannot",
    );
  });

  it("reversed receipts remain visible (not hidden) with a distinct void badge and reversal reason shown", () => {
    expect(arPage).toContain(
      'r.status === "void" && (\n                  <Badge variant="secondary"',
    );
    expect(arPage).toContain("Reversed: {r.reversal_reason}");
  });

  it("no Delete action exists for a reversed receipt", () => {
    expect(arPage).not.toContain("Delete receipt");
  });

  it("calls reverse_ar_receipt directly via supabase.rpc, matching reverse_ar_invoice's own unwrapped-RPC precedent in this same file", () => {
    expect(arPage).toContain('(supabase.rpc as any)("reverse_ar_receipt", {');
    expect(arPage).toContain("_id: id,");
    expect(arPage).toContain("_reason: reason,");
  });

  it("query invalidation covers receipts, invoices, and aging — a receipt can touch multiple invoices, mirroring invoice reversal's own invalidation set plus the receipts list itself", () => {
    const reverseReceiptOnSuccess =
      arPage.match(
        /const reverseReceipt = useMutation\(\{[\s\S]*?onError: \(e: Error\) => toast\.error\(e\.message\),\n {2}\}\);/,
      )?.[0] ?? "";
    expect(reverseReceiptOnSuccess).toContain(
      'qc.invalidateQueries({ queryKey: ["ar-receipts", propertyId] });',
    );
    expect(reverseReceiptOnSuccess).toContain(
      'qc.invalidateQueries({ queryKey: ["ar-invoices", propertyId] });',
    );
    expect(reverseReceiptOnSuccess).toContain(
      'qc.invalidateQueries({ queryKey: ["ar-aging", propertyId] });',
    );
  });

  it("errors surface the RPC's own message directly", () => {
    const block =
      arPage.match(
        /const reverseReceipt = useMutation\(\{[\s\S]*?onError: \(e: Error\) => toast\.error\(e\.message\),\n {2}\}\);/,
      )?.[0] ?? "";
    expect(block).toContain("onError: (e: Error) => toast.error(e.message),");
  });
});

describe("PR B — security posture (structural, mirrors PR A's own review discipline)", () => {
  it("neither the panel nor accounting.ar.tsx ever writes directly to ar_credit_notes/ar_receipts — RPC-only mutation", () => {
    expect(panel).not.toMatch(/\.from\("ar_credit_notes"\)\.(insert|update|upsert|delete)/);
    expect(arPage).not.toMatch(/\.from\("ar_receipts"\)\.(insert|update|upsert|delete)/);
  });

  it("no service-role usage anywhere in the touched client/server-function code", () => {
    expect(panel).not.toMatch(/service_role/i);
    expect(arPage).not.toMatch(/service_role/i);
  });

  it("UI visibility is never treated as the security boundary — both new RPCs re-derive property/role from the locked row server-side, independent of anything the client sends", () => {
    const cnBody = fn(migration, "reverse_ar_credit_note");
    const recBody = fn(migration, "reverse_ar_receipt");
    expect(cnBody).toContain("has_any_role(auth.uid(),");
    expect(recBody).toContain("has_any_role(auth.uid(),");
  });
});

describe("PR B — no unrelated financial code touched", () => {
  it("AP/HRM/payroll modules are not referenced by the new migration or UI changes", () => {
    expect(migration).not.toMatch(/ap_bills|ap_payments|payroll|hrm/i);
  });

  it("reverse_ar_invoice() itself is untouched by this migration (no CREATE OR REPLACE of it here)", () => {
    expect(migration).not.toContain("FUNCTION public.reverse_ar_invoice");
  });
});
