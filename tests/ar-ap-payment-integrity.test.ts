import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const migration = readFileSync(
  resolve(root, "supabase/migrations/20260807120000_ar_ap_payment_integrity.sql"),
  "utf8",
);
const arReceiptsFns = readFileSync(
  resolve(root, "src/lib/accounting/ar-receipts.functions.ts"),
  "utf8",
);
const apPaymentsFns = readFileSync(
  resolve(root, "src/lib/accounting/ap-payments.functions.ts"),
  "utf8",
);
const pdfFns = readFileSync(resolve(root, "src/lib/admin/pdf.functions.ts"), "utf8");
const accountingModule = readFileSync(
  resolve(root, "src/components/admin/modules/accounting-module.tsx"),
  "utf8",
);
const arPage = readFileSync(
  resolve(root, "src/routes/_authenticated/accounting.ar.tsx"),
  "utf8",
);
const apPage = readFileSync(
  resolve(root, "src/routes/_authenticated/accounting.ap.tsx"),
  "utf8",
);
const preflight = readFileSync(
  resolve(root, "supabase/preflight/20260807_ar_ap_payment_integrity_preflight.sql"),
  "utf8",
);

function fn(source: string, name: string): string {
  const match = source.match(
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\$\\$;`),
  )?.[0];
  if (!match) throw new Error(`Could not find function ${name} in source`);
  return match;
}

describe("Phase AR/AP-1: baseline bug confirmation", () => {
  it("fixes the invalid journal_source that silently broke every historical AP payment", () => {
    // 'ap_payment' was never a member of journal_source ('manual','folio','pos','ap','ar','payment','night_audit','fx','external_sync').
    const post = fn(migration, "post_ap_payment");
    // The only remaining 'ap_payment' occurrence in this function should be
    // the explanatory comment about the historical bug, not the actual
    // post_journal() call — assert the call itself passes 'ap' as source.
    expect(post).toContain(
      "public.post_journal(p.property_id, p.paid_at::date, _cur, 'AP Payment '||b.code, 'ap', p.id::text, _lines)",
    );
  });
});

describe("Phase AR/AP-1: SECURITY DEFINER search_path pinning", () => {
  it("pins post_ap_payment()'s search_path so it cannot be hijacked via a caller-controlled search_path", () => {
    const post = fn(migration, "post_ap_payment");
    expect(post).toContain("LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$");
  });

  it("pins post_ar_receipt()'s search_path so it cannot be hijacked via a caller-controlled search_path", () => {
    const post = fn(migration, "post_ar_receipt");
    expect(post).toContain("LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$");
  });
});

describe("Phase AR/AP-1: AP payment safety", () => {
  it("rejects zero or negative payment amounts", () => {
    const post = fn(migration, "post_ap_payment");
    expect(post).toContain("p.amount IS NULL OR p.amount <= 0");
    expect(post).toContain("Payment amount must be greater than zero");
  });

  it("rejects payment beyond the bill's remaining balance (overpayment)", () => {
    const post = fn(migration, "post_ap_payment");
    expect(post).toContain("_remaining := b.total - b.amount_paid");
    expect(post).toContain("p.amount > _remaining");
    expect(post).toContain("exceeds remaining balance");
  });

  it("allows a partial payment and only flips the bill to paid once fully covered", () => {
    const post = fn(migration, "post_ap_payment");
    expect(post).toContain(
      "status = CASE WHEN amount_paid + p.amount >= total THEN 'paid'::ap_status ELSE status END",
    );
  });

  it("rejects payment against a bill that is not open — draft, void, and already-paid bills are all excluded", () => {
    const post = fn(migration, "post_ap_payment");
    expect(post).toContain("b.status <> 'open'");
    expect(post).toContain("Bill is not open for payment");
  });

  it("enforces payment.property_id matches bill.property_id before any state changes", () => {
    const post = fn(migration, "post_ap_payment");
    expect(post).toContain("p.property_id IS DISTINCT FROM b.property_id");
    expect(post).toContain("Payment property does not match bill property");
  });

  it("also enforces property isolation declaratively via a composite foreign key", () => {
    expect(migration).toContain("ap_bills_property_id_uniq UNIQUE (property_id, id)");
    expect(migration).toContain(
      "FOREIGN KEY (property_id, bill_id) REFERENCES public.ap_bills(property_id, id)",
    );
  });

  it("locks the bill row before reading its remaining balance, so two concurrent payments cannot both approve against a stale balance", () => {
    const post = fn(migration, "post_ap_payment");
    expect(post).toContain("FOR UPDATE");
    expect(post).toContain("concurrent payments");
  });

  it("adds table-level guards so amount_paid can never drift out of [0, total] even from another write path", () => {
    expect(migration).toContain(
      "ap_bills_amount_paid_bounds CHECK (amount_paid >= 0 AND amount_paid <= total)",
    );
    expect(migration).toContain("ap_payments_amount_positive CHECK (amount > 0)");
  });

  it("does not swallow a failed journal post — no catch-all exception handler, so a post_journal failure rolls back the whole payment", () => {
    const post = fn(migration, "post_ap_payment");
    expect(post).not.toMatch(/WHEN\s+OTHERS/);
  });

  it("stays idempotent for an already-posted payment", () => {
    const post = fn(migration, "post_ap_payment");
    expect(post).toContain("IF p.posted_entry_id IS NOT NULL THEN RETURN p.posted_entry_id; END IF;");
  });
});

describe("Phase AR/AP-1: AR receipt schema", () => {
  it("creates ar_receipts and ar_receipt_allocations scoped by property-scoped composite foreign keys", () => {
    expect(migration).toContain("CREATE TABLE public.ar_receipts");
    expect(migration).toContain("CREATE TABLE public.ar_receipt_allocations");
    expect(migration).toContain("CONSTRAINT ar_receipts_property_id_uniq UNIQUE (property_id, id)");
    expect(migration).toContain(
      "FOREIGN KEY (property_id, receipt_id) REFERENCES public.ar_receipts(property_id, id)",
    );
    expect(migration).toContain(
      "FOREIGN KEY (property_id, invoice_id) REFERENCES public.ar_invoices(property_id, id)",
    );
  });

  it("provides an exact unique key for every property-scoped composite foreign key before that foreign key is created", () => {
    const compositeForeignKeys = [
      {
        unique: "ap_bills_property_id_uniq UNIQUE (property_id, id)",
        foreignKey:
          "FOREIGN KEY (property_id, bill_id) REFERENCES public.ap_bills(property_id, id)",
      },
      {
        unique: "ar_receipts_property_id_uniq UNIQUE (property_id, id)",
        foreignKey:
          "FOREIGN KEY (property_id, receipt_id) REFERENCES public.ar_receipts(property_id, id)",
      },
      {
        unique: "ar_invoices_property_id_uniq UNIQUE (property_id, id)",
        foreignKey:
          "FOREIGN KEY (property_id, invoice_id) REFERENCES public.ar_invoices(property_id, id)",
      },
    ];

    for (const { unique, foreignKey } of compositeForeignKeys) {
      const uniquePosition = migration.indexOf(unique);
      const foreignKeyPosition = migration.indexOf(foreignKey);
      expect(uniquePosition).toBeGreaterThanOrEqual(0);
      expect(foreignKeyPosition).toBeGreaterThan(uniquePosition);
    }
  });

  it("requires every write to route through post_ar_receipt — only SELECT is granted to authenticated", () => {
    expect(migration).toContain("GRANT SELECT ON public.ar_receipts TO authenticated;");
    expect(migration).toContain("GRANT SELECT ON public.ar_receipt_allocations TO authenticated;");
    expect(migration).not.toMatch(
      /GRANT (SELECT, )?INSERT.*ON public\.ar_receipts TO authenticated/,
    );
    expect(migration).not.toMatch(
      /GRANT (SELECT, )?INSERT.*ON public\.ar_receipt_allocations TO authenticated/,
    );
  });

  it("scopes RLS read access to property membership on both new tables", () => {
    expect(migration).toContain('CREATE POLICY "ar_receipts read" ON public.ar_receipts FOR SELECT TO authenticated');
    expect(migration).toContain(
      'CREATE POLICY "ar_receipt_allocations read" ON public.ar_receipt_allocations FOR SELECT TO authenticated',
    );
    expect(migration).toContain("public.can_access_property(auth.uid(), property_id)");
  });

  it("prevents duplicate allocation rows for the same invoice within a single receipt", () => {
    expect(migration).toContain("UNIQUE (receipt_id, invoice_id)");
  });

  it("enforces a positive amount at the row level on both the receipt and each allocation", () => {
    expect(migration).toMatch(/ar_receipts[\s\S]*?amount NUMERIC\(18,4\) NOT NULL CHECK \(amount > 0\)/);
    expect(migration).toMatch(
      /ar_receipt_allocations[\s\S]*?amount NUMERIC\(18,4\) NOT NULL CHECK \(amount > 0\)/,
    );
  });

  it("bounds ar_invoices.amount_paid between 0 and total", () => {
    expect(migration).toContain(
      "ar_invoices_amount_paid_bounds CHECK (amount_paid >= 0 AND amount_paid <= total)",
    );
  });

  it("adds supporting indexes for eligible-invoice and status-scoped lookups", () => {
    expect(migration).toContain("CREATE INDEX ar_receipt_allocations_invoice ON public.ar_receipt_allocations(invoice_id)");
    expect(migration).toContain("CREATE INDEX ar_invoices_property_status ON public.ar_invoices(property_id, status)");
    expect(migration).toContain("CREATE INDEX ap_bills_property_status ON public.ap_bills(property_id, status)");
  });
});

describe("Phase AR/AP-1: post_ar_receipt — atomic AR receipt posting", () => {
  it("requires an AR-eligible role before posting anything", () => {
    const post = fn(migration, "post_ar_receipt");
    expect(post).toContain(
      "public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant','front_desk']::app_role[], _property_id)",
    );
    expect(post).toContain("Not permitted to record an AR receipt");
  });

  it("is idempotent for a repeated call with the same idempotency_key", () => {
    const post = fn(migration, "post_ar_receipt");
    expect(post).toContain("IF _idempotency_key IS NOT NULL THEN");
    expect(post).toContain("WHERE property_id=_property_id AND idempotency_key=_idempotency_key");
  });

  it("stays idempotent under a concurrent double-submit race, not only a sequential retry", () => {
    const post = fn(migration, "post_ar_receipt");
    expect(post).toMatch(/BEGIN[\s\S]*INSERT INTO public\.ar_receipts[\s\S]*EXCEPTION WHEN unique_violation/);
    expect(migration).toContain("UNIQUE (property_id, idempotency_key)");
  });

  it("rejects an empty allocation set", () => {
    const post = fn(migration, "post_ar_receipt");
    expect(post).toContain("_allocations IS NULL OR jsonb_array_length(_allocations) = 0");
    expect(post).toContain("At least one allocation is required");
  });

  it("rejects a zero or negative allocation amount", () => {
    const post = fn(migration, "post_ar_receipt");
    expect(post).toContain("_alloc_amount IS NULL OR _alloc_amount <= 0");
    expect(post).toContain("Allocation amount must be greater than zero");
  });

  it("rejects a duplicate invoice_id within the same submission", () => {
    const post = fn(migration, "post_ar_receipt");
    expect(post).toContain("Each invoice may only appear once per receipt");
  });

  it("only allows allocating against invoices with status 'sent' — draft, void, and already-paid invoices are all rejected", () => {
    const post = fn(migration, "post_ar_receipt");
    expect(post).toContain("_inv.status <> 'sent'");
    expect(post).toContain("is not eligible to receive payment");
  });

  it("prevents over-allocation beyond an invoice's remaining balance", () => {
    const post = fn(migration, "post_ar_receipt");
    expect(post).toContain("_remaining := _inv.total - _inv.amount_paid");
    expect(post).toContain("_alloc_amount > _remaining");
    expect(post).toContain("exceeds its remaining balance");
  });

  it("locks every allocated invoice in a deterministic order to protect against concurrent over-allocation without deadlocking", () => {
    const post = fn(migration, "post_ar_receipt");
    expect(post).toContain("ORDER BY (value->>'invoice_id')");
    expect(post).toContain("FOR UPDATE");
    expect(post).toContain("concurrent receipts");
  });

  it("also enforces property isolation on invoice lookup, not just RLS", () => {
    const post = fn(migration, "post_ar_receipt");
    expect(post).toContain("WHERE id=_invoice_id AND property_id=_property_id FOR UPDATE");
  });

  it("derives the receipt amount as the exact sum of allocations — the fully-allocated model, no unapplied credit bucket", () => {
    const post = fn(migration, "post_ar_receipt");
    expect(post).toContain("_total_allocated := _total_allocated + _alloc_amount");
    expect(post).toContain("VALUES (_property_id, _receipt_code, COALESCE(_receipt_date, CURRENT_DATE), _total_allocated");
  });

  it("advances amount_paid per invoice and only flips status to paid once fully covered", () => {
    const post = fn(migration, "post_ar_receipt");
    expect(post).toContain("_new_paid := _inv.amount_paid + _alloc_amount");
    expect(post).toContain("_new_status := CASE WHEN _new_paid >= _inv.total THEN 'paid'::ar_status ELSE _inv.status END");
  });

  it("posts a single balanced GL entry: debit cash/bank, credit Accounts Receivable", () => {
    const post = fn(migration, "post_ar_receipt");
    expect(post).toContain("jsonb_build_object('account_id',_cash,'debit',_total_allocated,'credit',0");
    expect(post).toContain("jsonb_build_object('account_id',_ar,'debit',0,'credit',_total_allocated");
  });

  it("resolves GL accounts via posting_rules/resolve_account — never hardcodes an account id", () => {
    const post = fn(migration, "post_ar_receipt");
    expect(post).toContain("public.resolve_account(_property_id, CASE WHEN _method='cash' THEN 'payment_cash' ELSE 'payment_bank' END");
    expect(post).toContain("public.resolve_account(_property_id,'ar_receivable','ar')");
  });

  it("posts through post_journal (not a raw journal_entries insert) so the double-entry balance check still applies", () => {
    const post = fn(migration, "post_ar_receipt");
    expect(post).toContain("public.post_journal(_property_id, COALESCE(_receipt_date, CURRENT_DATE), _currency, 'AR Receipt '||_receipt_code, 'ar', _receipt_id::text, _lines)");
  });

  it("does not swallow posting failures with a catch-all handler — only the specific unique_violation case is caught", () => {
    const post = fn(migration, "post_ar_receipt");
    expect(post).not.toMatch(/WHEN\s+OTHERS/);
  });

  it("is exposed to authenticated users only via EXECUTE on the RPC, matching the direct-write lockdown on the tables", () => {
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.post_ar_receipt(uuid, date, payment_method, text, text, text, jsonb) TO authenticated;",
    );
  });
});

describe("Phase AR/AP-1: audit logging", () => {
  it("wires AR receipt posting through a server function that captures an audit event", () => {
    expect(arReceiptsFns).toContain("export const createArReceipt");
    expect(arReceiptsFns).toContain("captureAuditEvent");
    expect(arReceiptsFns).toContain("ar_receipt.posted");
  });

  it("calls post_ar_receipt with argument names matching the migration's function signature", () => {
    for (const arg of [
      "_property_id",
      "_receipt_date",
      "_method",
      "_reference",
      "_notes",
      "_idempotency_key",
      "_allocations",
    ]) {
      expect(arReceiptsFns).toContain(arg);
    }
  });

  it("wires AP payment recording through a server function that captures an audit event", () => {
    expect(apPaymentsFns).toContain("export const recordApPayment");
    expect(apPaymentsFns).toContain("captureAuditEvent");
    expect(apPaymentsFns).toContain("ap_payment.recorded");
  });

  it("does not restructure the existing AP bill create/post flows — only the payment insert moved behind a server function", () => {
    expect(apPage).toContain('supabase.rpc("post_ap_bill"');
    expect(apPage).toContain('supabase.from("ap_bills").insert(');
  });
});

describe("Phase AR/AP-1: AR invoice PDF regression", () => {
  it("invokes the PDF server function through TanStack's client binding", () => {
    expect(accountingModule).toContain("useServerFn(renderAdminPdf)");
    expect(accountingModule).toContain('downloadServerPdf(renderPdf, "invoice"');
  });

  it("uses the real ar_invoices schema fields instead of the stale customer_name/customer_email/invoice_date", () => {
    expect(pdfFns).toContain("anyI.bill_to_name");
    expect(pdfFns).toContain("anyI.bill_to_email");
    expect(pdfFns).toContain("anyI.issue_date");
    expect(pdfFns).not.toMatch(/anyI\.customer_name|anyI\.customer_email|anyI\.invoice_date/);
  });

  it("fixes the same stale field names in the admin AR Invoices table, where ordering by the nonexistent column would have broken the query outright", () => {
    expect(accountingModule).toContain('order: { column: "issue_date"');
    expect(accountingModule).toContain("r.bill_to_name");
    expect(accountingModule).not.toMatch(/invoice_date|customer_name/);
  });

  it("logs the print only after PDF generation succeeds", () => {
    expect(pdfFns.indexOf("await buildDocPdf(doc)")).toBeLessThan(
      pdfFns.indexOf("await logPrint(context"),
    );
  });
});

describe("Phase AR/AP-1: AR receive-payment UI", () => {
  it("adds a Receive Payment workflow wired to the new server function", () => {
    expect(arPage).toContain("createArReceipt");
    expect(arPage).toContain("Receive payment");
  });

  it("only offers invoices that are eligible — status 'sent' with a positive remaining balance", () => {
    expect(arPage).toMatch(/i\.status === ["']sent["'][\s\S]{0,80}amount_paid/);
  });

  it("supports allocating a single receipt across multiple invoices", () => {
    expect(arPage).toContain("payAllocations");
    expect(arPage).toContain("toggleInvoice");
  });

  it("generates a fresh client-side idempotency key per receipt attempt", () => {
    expect(arPage).toContain("crypto.randomUUID()");
    expect(arPage).toContain("payIdempotencyKey");
  });

  it("blocks submission client-side when an allocation exceeds its invoice's remaining balance", () => {
    expect(arPage).toContain("receiveOverAllocated");
  });
});

describe("Phase AR/AP-1: production preflight", () => {
  it("is read-only — contains no INSERT/UPDATE/DELETE/DDL statements", () => {
    const withoutComments = preflight.replace(/--.*$/gm, "");
    expect(withoutComments).not.toMatch(/\b(INSERT INTO|UPDATE\s+public\.|DELETE FROM|DROP\s|ALTER\s|TRUNCATE)\b/i);
  });

  it("checks for AP amount_paid bound violations, zero/negative payments, and status inconsistencies", () => {
    expect(preflight).toContain("FROM public.ap_bills");
    expect(preflight).toContain("amount_paid < 0 OR amount_paid > total");
    expect(preflight).toContain("FROM public.ap_payments");
    expect(preflight).toContain("amount IS NULL OR amount <= 0");
  });

  it("checks that every property has the accounts resolve_account() depends on, to avoid a NULL account_id at posting time", () => {
    expect(preflight).toContain("('cash'), ('bank'), ('ap'), ('ar')");
  });

  it("checks all nine named migration constraint names for collisions", () => {
    const constraintCollisionCheck = preflight.match(
      /SELECT conname FROM pg_constraint[\s\S]*?\);/,
    )?.[0];
    expect(constraintCollisionCheck).toBeDefined();

    const expectedConstraints = [
      "ap_bills_property_id_uniq",
      "ap_payments_property_bill_fkey",
      "ap_payments_amount_positive",
      "ap_bills_amount_paid_bounds",
      "ar_invoices_property_id_uniq",
      "ar_invoices_amount_paid_bounds",
      "ar_receipts_property_id_uniq",
      "ar_receipt_allocations_receipt_fkey",
      "ar_receipt_allocations_invoice_fkey",
    ];

    for (const name of expectedConstraints) {
      expect(constraintCollisionCheck).toContain(`'${name}'`);
    }
    expect(constraintCollisionCheck?.match(/'[^']+'/g)).toHaveLength(9);
  });
});
