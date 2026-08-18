import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const migration = readFileSync(
  resolve(root, "supabase/migrations/20260818090000_ar_invoice_reversal.sql"),
  "utf8",
);
const arPage = readFileSync(
  resolve(root, "src/routes/_authenticated/accounting.ar.tsx"),
  "utf8",
);
const arStatementCalc = readFileSync(
  resolve(root, "src/lib/accounting/ar-statement-calc.ts"),
  "utf8",
);
const arStatementsFns = readFileSync(
  resolve(root, "src/lib/accounting/ar-statements.functions.ts"),
  "utf8",
);
const arInvoiceFoundation = readFileSync(
  resolve(root, "supabase/migrations/20260705040642_e2695ffa-2a90-4433-bfeb-059363c7aa85.sql"),
  "utf8",
);

function fn(source: string, name: string): string {
  const match = source.match(
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\$\\$;`),
  )?.[0];
  if (!match) throw new Error(`Could not find function ${name} in source`);
  return match;
}

const reverseFn = fn(migration, "reverse_ar_invoice");

describe("AR invoice reversal — eligibility", () => {
  it("1/9/10. requires status='sent' — draft, paid, and already-void invoices are all explicitly rejected", () => {
    expect(reverseFn).toContain("IF inv.status = 'void' THEN");
    expect(reverseFn).toContain("already been reversed");
    expect(reverseFn).toContain("IF inv.status = 'draft' THEN");
    expect(reverseFn).toContain("has no posting to reverse");
    expect(reverseFn).toContain("IF inv.status = 'paid' THEN");
    expect(reverseFn).toContain("fully paid and cannot be reversed");
    expect(reverseFn).toContain("IF inv.status <> 'sent' THEN");
  });

  it("6. missing posted_entry_id is rejected", () => {
    expect(reverseFn).toContain("IF inv.posted_entry_id IS NULL THEN");
    expect(reverseFn).toContain("has no posted journal entry to reverse");
  });

  it("4/5. partially paid invoice (status still 'sent', amount_paid > 0) is rejected", () => {
    expect(reverseFn).toContain("IF inv.amount_paid <> 0 THEN");
    expect(reverseFn).toContain("has payments applied");
  });

  it("5. an invoice with receipt allocations is rejected even independent of amount_paid", () => {
    expect(reverseFn).toContain(
      "SELECT count(*) INTO _alloc_count FROM public.ar_receipt_allocations WHERE invoice_id = _id;",
    );
    expect(reverseFn).toContain("_alloc_count > 0");
    expect(reverseFn).toContain("has receipt allocations");
  });
});

describe("AR invoice reversal — idempotency and concurrency", () => {
  it("7/17. already-reversed invoice cannot be reversed twice — checked via is_reversal_of before insert", () => {
    expect(reverseFn).toContain(
      "SELECT id INTO _existing_reversal FROM public.journal_entries WHERE is_reversal_of = inv.posted_entry_id;",
    );
    expect(reverseFn).toContain("already has a reversal journal entry");
  });

  it("8. concurrent second reversal is rejected — the invoice row is locked before any status read", () => {
    expect(reverseFn).toContain("SELECT * INTO inv FROM public.ar_invoices WHERE id=_id FOR UPDATE;");
    // The lock is acquired before the status checks that decide eligibility.
    const lockIdx = reverseFn.indexOf("FOR UPDATE");
    const statusIdx = reverseFn.indexOf("IF inv.status = 'void'");
    expect(lockIdx).toBeGreaterThan(0);
    expect(statusIdx).toBeGreaterThan(lockIdx);
  });

  it("never creates two reversal journals for the same original entry — backed by a DB-level unique index, not just an application check", () => {
    expect(migration).toContain(
      "CREATE UNIQUE INDEX journal_entries_reversal_of_uniq",
    );
    expect(migration).toContain("WHERE is_reversal_of IS NOT NULL");
  });
});

describe("AR invoice reversal — journal construction", () => {
  it("9/10/11. original journal is read but never mutated — only journal_lines WHERE entry_id = inv.posted_entry_id is SELECTed, never UPDATEd/DELETEd", () => {
    expect(reverseFn).toContain(
      "FOR jl IN SELECT * FROM public.journal_lines WHERE entry_id = inv.posted_entry_id ORDER BY created_at LOOP",
    );
    expect(reverseFn).not.toMatch(/UPDATE public\.journal_lines/);
    expect(reverseFn).not.toMatch(/DELETE FROM public\.journal_(lines|entries)/);
    expect(reverseFn).not.toMatch(/UPDATE public\.journal_entries\s+SET[\s\S]*?WHERE id\s*=\s*inv\.posted_entry_id/);
  });

  it("11. reversal lines are the exact inverse of the original — debit becomes credit and vice versa, including fx_rate/base amounts copied verbatim, not recomputed", () => {
    expect(reverseFn).toContain(
      "VALUES (_reversal_entry, jl.account_id, jl.credit, jl.debit, jl.currency, jl.fx_rate, jl.credit_base, jl.debit_base,",
    );
  });

  it("20. tax is reversed exactly as originally posted — the loop copies every original line including any tax line, never recomputes from ar_invoice_lines/tax_rate", () => {
    expect(reverseFn).not.toContain("ar_invoice_lines");
    expect(reverseFn).not.toContain("tax_rate");
  });

  it("12. reversal entry links to the original via journal_entries.is_reversal_of", () => {
    expect(reverseFn).toContain(
      "VALUES (inv.property_id, CURRENT_DATE, 'Reversal of AR Invoice '||inv.code||' — '||_trimmed_reason, 'ar', inv.id::text, orig_entry.currency, auth.uid(), inv.posted_entry_id)",
    );
  });

  it("does not overload ar_invoices.posted_entry_id to point at the reversal — it is only ever read, never written, by this function", () => {
    expect(reverseFn).not.toMatch(/UPDATE public\.ar_invoices\s+SET[^;]*posted_entry_id/);
  });

  it("13. net GL effect is asserted to be exactly zero (balanced) using NUMERIC precision, not a floating approximation", () => {
    expect(reverseFn).toContain(
      "SELECT COALESCE(SUM(debit_base),0), COALESCE(SUM(credit_base),0) INTO _dr, _cr",
    );
    expect(reverseFn).toContain("ROUND(_dr,2) <> ROUND(_cr,2)");
    expect(reverseFn).toContain("Reversal journal is not balanced");
  });

  it("21. only invoice status changes — invoice lines, snapshot fields, issue date, and code are never written", () => {
    expect(reverseFn).not.toMatch(/UPDATE public\.ar_invoice_lines/);
    expect(reverseFn).toContain("UPDATE public.ar_invoices SET status = 'void' WHERE id = _id;");
    expect(reverseFn).not.toMatch(/UPDATE public\.ar_invoices SET[^;]*issue_date/);
    expect(reverseFn).not.toMatch(/UPDATE public\.ar_invoices SET[^;]*code\s*=/);
  });

  it("15/16. invoice becomes 'void', and post_ar_invoice's own pre-existing idempotency guard (posted_entry_id IS NOT NULL -> return early, no re-post) means a void invoice can never be re-posted, since posted_entry_id is never cleared by this migration", () => {
    expect(reverseFn).toContain("UPDATE public.ar_invoices SET status = 'void' WHERE id = _id;");
    expect(reverseFn).not.toMatch(/posted_entry_id\s*=\s*NULL/);
    const postFn = fn(arInvoiceFoundation, "post_ar_invoice");
    expect(postFn).toContain("IF inv.posted_entry_id IS NOT NULL THEN RETURN inv.posted_entry_id; END IF;");
  });
});

describe("AR invoice reversal — accounting period", () => {
  it("blocks reversal into a locked or closed accounting period, same rule post_journal() enforces for every other posting", () => {
    expect(reverseFn).toContain("status IN ('locked','closed')");
    expect(reverseFn).toContain("Current accounting period is locked");
  });
});

describe("AR invoice reversal — reason", () => {
  it("25. requires a reversal reason", () => {
    expect(reverseFn).toContain("char_length(_trimmed_reason) < 5");
    expect(reverseFn).toContain("reversal reason of at least 5 characters is required");
  });

  it("26. rejects an oversized reason", () => {
    expect(reverseFn).toContain("char_length(_trimmed_reason) > 500");
    expect(reverseFn).toContain("500 characters or fewer");
  });

  it("stores the reason in the reversal journal's memo, not as a new ar_invoice_lines field", () => {
    expect(reverseFn).toContain("_trimmed_reason");
    expect(reverseFn).not.toMatch(/ALTER TABLE public\.ar_invoice_lines/);
  });
});

describe("AR invoice reversal — permissions and isolation", () => {
  it("22/23/24. reuses post_ar_invoice's own admin role set (super_admin, hotel_owner, general_manager, accountant) — same roles allowed to post are allowed to reverse; front_desk is excluded from both", () => {
    expect(reverseFn).toContain(
      "public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], inv.property_id)",
    );
    expect(reverseFn).not.toMatch(/has_any_role\([^)]*front_desk/);
  });

  it("does not hardcode role === 'admin' anywhere — authorization is always routed through has_any_role()", () => {
    expect(reverseFn).not.toMatch(/role\s*===\s*['"]admin['"]/);
    expect(reverseFn).not.toMatch(/=\s*'admin'/);
  });

  it("21/property isolation. property_id is derived server-side from the locked invoice row, never taken as a client-supplied parameter — cross-property reversal is impossible by construction", () => {
    expect(reverseFn).toMatch(/reverse_ar_invoice\(_id UUID, _reason TEXT\)/);
    expect(reverseFn).not.toContain("_property_id UUID");
  });
});

describe("AR invoice reversal — audit", () => {
  it("27. a successful reversal calls the established admin_log() convention with property, invoice id/code (via before/after + memo), original and new status, and both journal entry ids", () => {
    expect(reverseFn).toContain("PERFORM public.admin_log(");
    expect(reverseFn).toContain("inv.property_id, 'ar_invoice', inv.id::text, 'update',");
    expect(reverseFn).toContain("jsonb_build_object('status', inv.status, 'postedEntryId', inv.posted_entry_id)");
    expect(reverseFn).toContain(
      "jsonb_build_object('status', 'void', 'postedEntryId', inv.posted_entry_id, 'reversalEntryId', _reversal_entry)",
    );
  });

  it("28. a failed reversal produces no audit event — admin_log() is only called after every guard clause and after the invoice UPDATE, so any earlier RAISE EXCEPTION rolls back the whole transaction including the audit insert", () => {
    const auditIdx = reverseFn.indexOf("PERFORM public.admin_log(");
    const lastGuardIdx = reverseFn.lastIndexOf("RAISE EXCEPTION");
    expect(auditIdx).toBeGreaterThan(lastGuardIdx);
  });

  it("does not log unnecessary personal data — only ids, statuses, and the operator-entered reason are captured, not customer PII", () => {
    expect(reverseFn).not.toMatch(/bill_to_email|bill_to_address/);
  });
});

describe("AR invoice reversal — SECURITY DEFINER / ACL", () => {
  it("pins search_path so it cannot be hijacked via a caller-controlled search_path", () => {
    expect(reverseFn).toContain("LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$");
  });

  it("revokes PUBLIC and anon execution", () => {
    expect(migration).toContain(
      "REVOKE EXECUTE ON FUNCTION public.reverse_ar_invoice(uuid, text) FROM PUBLIC, anon;",
    );
  });

  it("grants execution to authenticated only", () => {
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.reverse_ar_invoice(uuid, text) TO authenticated;",
    );
  });

  it("this migration only adds new objects — it never edits, drops, or alters any historical migration file", () => {
    expect(migration).not.toMatch(/DROP FUNCTION|DROP TABLE|ALTER TABLE public\.ar_invoices\s+DROP/);
  });
});

describe("AR invoice reversal — ageing and statement regression (18/19)", () => {
  it("a reversed (void) invoice is excluded from ar_aging by the existing view's own WHERE status <> 'void' clause — no view change needed or made", () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE VIEW public\.ar_aging/);
  });

  it("a reversed (void) invoice is excluded from customer statements by the existing AR_STATEMENT_INCLUDED_STATUSES = ['sent','paid'] filter — no calc-file change needed or made", () => {
    expect(arStatementCalc).toContain('AR_STATEMENT_INCLUDED_STATUSES = ["sent", "paid"] as const');
  });

  it("the statement's own DB query also excludes non-sent/paid invoices, not just the pure calculator", () => {
    expect(arStatementsFns).toMatch(/status.*['"]sent['"].*['"]paid['"]|in\(["']status["'],\s*\[?["']sent["']/i);
  });

  it("historical mapped customer relationship is untouched — this migration never writes to ar_customers or an invoice's customer_id", () => {
    expect(reverseFn).not.toMatch(/customer_id/);
  });
});

describe("AR invoice reversal — UI (14/30)", () => {
  it("30. the reversal action is wired into the real production AR route (accounting.ar.tsx), not a separate page", () => {
    expect(arPage).toContain('supabase.rpc("reverse_ar_invoice"');
  });

  it("14. the Void action is only shown for sent, unpaid invoices — not draft, not paid/partially-paid, not already-void", () => {
    expect(arPage).toContain('i.status === "sent" && Number(i.amount_paid) === 0');
  });

  it("14. the confirmation dialog shows invoice code, customer, total, currency, an explicit warning, and requires a reason", () => {
    expect(arPage).toContain("reverseTarget.code");
    expect(arPage).toContain("reverseTarget.bill_to_name");
    expect(arPage).toContain("formatMoney(Number(reverseTarget.total), reverseTarget.currency)");
    expect(arPage).toMatch(/offsetting journal entry/);
    expect(arPage).toContain('disabled={reverse.isPending || reverseReason.trim().length < 5}');
  });
});
