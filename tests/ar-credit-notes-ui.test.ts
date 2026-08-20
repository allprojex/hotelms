import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const panel = read(resolve(root, "src/components/accounting/ar-credit-notes-panel.tsx"));
const serverFn = read(resolve(root, "src/lib/accounting/ar-credit-notes.functions.ts"));
const permissions = read(resolve(root, "src/lib/accounting/permissions.ts"));
const arPage = read(resolve(root, "src/routes/_authenticated/accounting.ar.tsx"));
const migration = read(resolve(root, "supabase/migrations/20260819120000_ar_credit_notes_pr1.sql"));

describe("AR Credit Note UI — contract review against the real migration signatures", () => {
  it("create_ar_credit_note()'s exact signature in the migration matches what the server function sends", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION public.create_ar_credit_note(\n  _property_id UUID,\n  _invoice_id UUID,\n  _issue_date DATE,\n  _reason TEXT,\n  _lines JSONB\n) RETURNS UUID",
    );
    expect(serverFn).toContain('.rpc("create_ar_credit_note", {');
    expect(serverFn).toContain("_property_id: data.propertyId,");
    expect(serverFn).toContain("_invoice_id: data.invoiceId,");
    expect(serverFn).toContain("_issue_date: data.issueDate,");
    expect(serverFn).toContain("_reason: data.reason,");
    expect(serverFn).toContain("_lines: data.lines.map(");
  });

  it("_lines shape sent by the server function matches the migration's documented shape exactly (source_invoice_line_id, quantity)", () => {
    expect(migration).toContain(
      '-- _lines shape: [{"source_invoice_line_id": "<uuid>", "quantity": <number>}, ...]',
    );
    expect(serverFn).toContain("source_invoice_line_id: line.sourceInvoiceLineId,");
    expect(serverFn).toContain("quantity: line.quantity,");
  });

  it("post_ar_credit_note()'s exact signature matches the client's RPC call (_id only)", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION public.post_ar_credit_note(_id UUID) RETURNS UUID",
    );
    expect(panel).toContain('(supabase.rpc as any)("post_ar_credit_note", { _id: id })');
  });

  it("neither the panel nor the server function ever writes directly to ar_credit_notes/ar_credit_note_lines", () => {
    expect(panel).not.toMatch(/\.from\("ar_credit_notes"\)\.(insert|update|upsert|delete)/);
    expect(panel).not.toMatch(/\.from\("ar_credit_note_lines"\)\.(insert|update|upsert|delete)/);
    expect(serverFn).not.toMatch(/\.from\("ar_credit_notes"\)/);
    expect(serverFn).not.toMatch(/\.from\("ar_credit_note_lines"\)/);
  });

  it("the RPC's own authorization role array is reflected by the UI's default-hidden role set (ACCOUNTING_ADMIN_ROLES)", () => {
    expect(migration).toContain(
      "ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id) THEN\n    RAISE EXCEPTION 'Not permitted to create AR credit notes';",
    );
    expect(permissions).toContain(
      'export const ACCOUNTING_ADMIN_ROLES: readonly AppRole[] = [\n  "super_admin",\n  "hotel_owner",\n  "general_manager",\n  "accountant",\n];',
    );
    expect(panel).toContain("useHasAnyRole([...ACCOUNTING_ADMIN_ROLES], propertyId)");
  });

  it("credit-note permissions use a distinct module from invoicesCreate, so a Permission Matrix override for one never silently affects the other", () => {
    expect(permissions).toContain(
      'creditNotesCreate: { module: "ar_credit_notes", capability: "create" }',
    );
    expect(permissions).toContain(
      'creditNotesPost: { module: "ar_credit_notes", capability: "approve" }',
    );
    expect(permissions).toContain(
      'invoicesCreate: { module: "accounts_receivable", capability: "create" }',
    );
  });
});

describe("AR Credit Note UI — list rendering", () => {
  it("renders code, date, customer, related invoice, reason, subtotal, tax, total, and status — never a raw UUID", () => {
    expect(panel).toContain("{cn.code}");
    expect(panel).toContain("{cn.issue_date}");
    expect(panel).toContain("{cn.invoice?.bill_to_name ?? ");
    expect(panel).toContain("against invoice {cn.invoice?.code ?? ");
    expect(panel).toContain("{cn.reason}");
    expect(panel).toContain("Subtotal {formatMoney(Number(cn.subtotal), cn.currency)}");
    expect(panel).toContain("Tax {formatMoney(Number(cn.tax), cn.currency)}");
    expect(panel).toContain("{formatMoney(Number(cn.total), cn.currency)}");
    expect(panel).toContain("{cn.status}");
    // cn.id appears only as a React `key` prop and as an argument passed to
    // setPostTarget(cn) — never rendered as visible text.
    expect(panel).not.toMatch(/>\{cn\.id\}</);
  });

  it("shows a posted date derived from updated_at only when the note is actually posted", () => {
    expect(panel).toContain('{cn.status === "posted" && (');
    expect(panel).toContain('Posted {format(new Date(cn.updated_at), "yyyy-MM-dd")}');
  });

  it("credit notes are fetched via a single unambiguous embed (ar_credit_notes_invoice_fkey is the only FK to ar_invoices)", () => {
    expect(panel).toContain("invoice:ar_invoices(code,bill_to_name)");
    expect(panel).toContain("ar_credit_notes_invoice_fkey is the only FK from ar_credit_notes to");
  });

  it("empty state is shown when there are no credit notes", () => {
    expect(panel).toContain("No credit notes yet.");
  });
});

describe("AR Credit Note UI — create dialog", () => {
  it("has a New credit note action that opens the create dialog", () => {
    expect(panel).toContain("New credit note");
    expect(panel).toContain("onClick={openCreate}");
  });

  it("invoice selector is restricted to eligible (sent) invoices, matching create_ar_credit_note()'s own eligibility check exactly", () => {
    expect(migration).toContain(
      "IF _inv.status <> 'sent' THEN\n    RAISE EXCEPTION 'Credit notes can only be created against a sent invoice (status: %)', _inv.status;",
    );
    expect(panel).toContain('invoices.filter((i) => i.status === "sent")');
  });

  it("shows the selected invoice's code and customer, never a raw UUID, in the picker", () => {
    expect(panel).toContain("{inv.code} · {inv.bill_to_name ?? ");
  });

  it("shows original invoice lines with description, price, and tax rate", () => {
    expect(panel).toContain("<div>Description</div>");
    expect(panel).toContain("<div>Price</div>");
    expect(panel).toContain("<div>Tax %</div>");
    expect(panel).toContain("{line.description}");
    expect(panel).toContain("formatMoney(Number(line.unit_price), selectedInvoice.currency)");
    expect(panel).toContain("{line.tax_rate}%");
  });

  it("never writes to ar_invoice_lines — invoice lines are read-only in this dialog", () => {
    const linesQueryBlock =
      panel.match(/const invoiceLines = useQuery\(\{[\s\S]*?\}\);/)?.[0] ?? "";
    expect(linesQueryBlock).toContain('.from("ar_invoice_lines")');
    expect(linesQueryBlock).toContain(".select(");
    expect(linesQueryBlock).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });
});

describe("AR Credit Note UI — line selection and quantity validation", () => {
  it("supports selecting one or multiple lines by entering a quantity per line", () => {
    expect(panel).toContain(
      "onChange={(e) => setLineQuantity(line.id, e.target.value, remaining)}",
    );
    expect(panel).toContain("const selectedLines = useMemo(() => {");
    expect(panel).toContain(".filter((x): x is NonNullable<typeof x> => x !== null);");
  });

  it("supports a partial quantity (less than the line's remaining quantity)", () => {
    expect(panel).toContain("if (!(qty > 0)) return null;");
    // Any 0 < qty <= remaining is accepted — not just qty === remaining.
    expect(panel).not.toContain("qty !== remaining");
  });

  it("rejects zero and negative quantities client-side before they ever reach the input state", () => {
    expect(panel).toContain('if (raw !== "" && (!Number.isFinite(parsed) || parsed < 0)) return;');
    expect(panel).toContain("if (!(qty > 0)) return null;");
  });

  it("clamps an excessive quantity to the remaining creditable quantity on that line — client-side UX only, server re-enforces authoritatively", () => {
    expect(panel).toContain("Math.min(parsed, Math.max(0, remaining))");
    expect(panel).toContain("this clamp is\n    // UX only.");
    expect(panel).toContain("max={Math.max(0, remaining)}");
  });

  it("a fully-credited line (remaining <= 0) is shown disabled with a clear label, not silently hidden", () => {
    expect(panel).toContain("const fullyCredited = remaining <= 0;");
    expect(panel).toContain(
      '{fullyCredited ? "Fully credited" : `${remaining} of ${line.quantity}`}',
    );
    expect(panel).toContain("disabled={fullyCredited}");
  });

  it("remaining quantity only subtracts POSTED credit-note lines, mirroring post_ar_credit_note()'s own _cum_qty computation (draft/void never consumed capacity)", () => {
    expect(migration).toContain("AND xc.status = 'posted';");
    expect(panel).toContain("if (!postedIds.has(row.credit_note_id)) continue;");
    expect(panel).toContain("draft/void lines never consumed it");
  });
});

describe("AR Credit Note UI — tax calculation and preview", () => {
  it("previews subtotal/tax/total using the same ROUND(x,4)-equivalent formula create_ar_credit_note() itself uses at draft-create time", () => {
    expect(migration).toContain("_line_subtotal := ROUND(_quantity * _source_line.unit_price, 4);");
    expect(migration).toContain(
      "_line_tax := ROUND(_line_subtotal * _source_line.tax_rate / 100, 4);",
    );
    expect(panel).toContain("function round4(n: number): number {");
    expect(panel).toContain("const subtotal = round4(qty * Number(line.unit_price));");
    expect(panel).toContain("const tax = round4(subtotal * (Number(line.tax_rate) / 100));");
  });

  it("displays subtotal, tax, and total distinctly in the preview footer", () => {
    expect(panel).toContain(
      "Preview: subtotal {formatMoney(previewSubtotal, selectedInvoice.currency)} + tax",
    );
    expect(panel).toContain("{formatMoney(previewTotal, selectedInvoice.currency)}");
  });

  it("honestly discloses that the terminal-residual amount is only finalized at posting time, not claimed as exact here", () => {
    expect(panel).toContain("does not attempt to\n// predict that residual.");
    expect(panel).toContain("is finalized only\n                  when the credit note is posted.");
  });
});

describe("AR Credit Note UI — reason validation", () => {
  it("requires 5-500 characters, matching create_ar_credit_note()'s own trimmed-length check exactly", () => {
    expect(migration).toContain(
      "IF char_length(_trimmed_reason) < 5 THEN\n    RAISE EXCEPTION 'A credit note reason of at least 5 characters is required';",
    );
    expect(migration).toContain("IF char_length(_trimmed_reason) > 500 THEN");
    expect(panel).toContain(
      "const reasonValid = reason.trim().length >= 5 && reason.trim().length <= 500;",
    );
    expect(panel).toContain("maxLength={500}");
  });

  it("disables Create draft when the reason is invalid", () => {
    const footerBlock = panel.match(/Create draft\s*<\/Button>/)?.[0] ?? "";
    // Locate the disabled expression preceding the Create draft button.
    const createButtonBlock =
      panel.match(/disabled=\{[\s\S]*?\}\s*\n\s*onClick=\{\(\) => create\.mutate\(\)\}/)?.[0] ?? "";
    expect(createButtonBlock).toContain("!reasonValid");
    expect(footerBlock).toBeDefined();
  });
});

describe("AR Credit Note UI — excessive value UX (net balance)", () => {
  it("computes exceedsNetBalance from the same ar_invoice_balances read model the backend itself exposes, and disables Create draft when exceeded", () => {
    expect(panel).toContain('.from("ar_invoice_balances")');
    expect(panel).toContain("const exceedsNetBalance =");
    expect(panel).toContain("previewTotal > Number(balance.data.net_balance)");
    expect(panel).toContain("exceedsNetBalance\n              }");
  });

  it("shows a clear inline warning explaining why, rather than a silent disable", () => {
    expect(panel).toContain(
      "exceeds the invoice&apos;s remaining net balance and will be rejected",
    );
  });
});

describe("AR Credit Note UI — eligibility / balance display (Original / Paid / Credited / Net balance)", () => {
  it("shows all four figures, sourced from the ar_invoice_balances view — the same source of truth the backend uses", () => {
    expect(panel).toContain("Original total");
    expect(panel).toContain("Paid");
    expect(panel).toContain("Already credited");
    expect(panel).toContain("Remaining net balance");
    expect(panel).toContain("balance.data.total");
    expect(panel).toContain("balance.data.amount_paid");
    expect(panel).toContain("balance.data.credited_total");
    expect(panel).toContain("balance.data.net_balance");
  });

  it("net_balance query matches the view's exact column set (property_id, invoice_id, total, amount_paid, credited_total, net_balance)", () => {
    expect(migration).toContain(
      "SELECT\n  i.property_id,\n  i.id AS invoice_id,\n  i.total,\n  i.amount_paid,\n  public.ar_invoice_credited_total(i.id) AS credited_total,\n  i.total - i.amount_paid - public.ar_invoice_credited_total(i.id) AS net_balance",
    );
    expect(panel).toContain('.select("total,amount_paid,credited_total,net_balance")');
  });
});

describe("AR Credit Note UI — draft state and posting confirmation", () => {
  it("a draft never auto-posts on create — Post is a distinct, separate action shown only for draft status", () => {
    expect(panel).toContain('cn.status === "draft" && canManage.allowed && (');
    expect(panel).not.toContain("post.mutate(result.id)");
    expect(panel).not.toContain("post.mutate(data.id)");
  });

  it("posting requires opening a dedicated confirmation dialog, not a single unconfirmed click", () => {
    expect(panel).toContain("onClick={() => setPostTarget(cn)}");
    expect(panel).toContain("<Dialog open={!!postTarget}");
    expect(panel).toContain("Post credit note");
  });

  it("the confirmation dialog explains that posting creates real accounting entries and describes the only path to undo it afterward", () => {
    expect(panel).toContain(
      "Posting creates a new accounting entry (debiting revenue and tax, crediting accounts",
    );
    expect(panel).toContain("can only be undone afterward by reversing it");
  });

  it("PR B: reversal now exists — the post dialog no longer claims no reversal exists", () => {
    expect(panel).not.toContain("no reversal for a posted credit note");
  });
});

describe("AR Credit Note UI — posted / read-only state (immutability)", () => {
  it("a posted or void credit note offers no Post/Edit/Delete action — only draft rows get the Post button", () => {
    expect(panel).not.toMatch(
      /status === "posted"[^)]*&&[^)]*<Button[^>]*onClick=\{[^}]*(edit|delete|update)/i,
    );
    expect(panel).not.toContain("Edit credit note");
    expect(panel).not.toContain("Delete credit note");
    expect(panel).not.toContain("Void credit note");
  });

  it("no DELETE/UPDATE grant exists on ar_credit_notes for the client to even attempt — the backend has no mutation surface beyond the two RPCs", () => {
    expect(migration).toContain("GRANT SELECT ON public.ar_credit_notes TO authenticated;");
    expect(migration).not.toMatch(
      /GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*ON public\.ar_credit_notes TO authenticated/,
    );
  });
});

describe("AR Credit Note UI — role visibility", () => {
  it("New credit note and Post are both hidden (not merely disabled) unless canManage.allowed", () => {
    expect(panel).toContain("{canManage.allowed && (");
    expect(panel).toContain('cn.status === "draft" && canManage.allowed && (');
  });

  it("the list itself has no role gate — read access matches the RLS SELECT policy (any authenticated user with property access)", () => {
    expect(migration).toContain(
      'CREATE POLICY "ar_credit_notes read" ON public.ar_credit_notes FOR SELECT TO authenticated\n  USING (public.can_access_property(auth.uid(), property_id));',
    );
    const creditNotesQueryBlock =
      panel.match(/const creditNotes = useQuery\(\{[\s\S]*?\}\);/)?.[0] ?? "";
    expect(creditNotesQueryBlock).not.toContain("canManage");
  });

  it("backend remains authoritative — hiding the button is UX only, the RPC still enforces has_any_role() itself", () => {
    expect(migration).toContain(
      "public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], cn.property_id) THEN\n    RAISE EXCEPTION 'Not permitted to post an AR credit note';",
    );
  });
});

describe("AR Credit Note UI — server error display", () => {
  it("create and post both surface the RPC's own error message directly, matching every other AR mutation's onError pattern in this file — never a generic replacement", () => {
    expect(panel).toContain("onError: (e: Error) => toast.error(e.message),");
    expect(arPage).toContain("onError: (e: Error) => toast.error(e.message),");
  });

  it("permission-denied errors from the server function surface PermissionDeniedError's own safe message, not a stack trace", () => {
    expect(serverFn).toContain("assertServerPermission(context, {");
  });
});

describe("AR Credit Note UI — query invalidation / refresh after create and post", () => {
  it("create invalidates only ar-credit-notes (a draft has no journal entry yet, so invoices/aging are unaffected)", () => {
    const createOnSuccess =
      panel.match(
        /mutationFn: async \(\) => \{[\s\S]*?onError: \(e: Error\) => toast\.error\(e\.message\),\n {2}\}\);\n\n {2}\/\/ Shared by post and reverse/,
      )?.[0] ?? "";
    expect(createOnSuccess).toContain(
      'qc.invalidateQueries({ queryKey: ["ar-credit-notes", propertyId] });',
    );
    expect(createOnSuccess).not.toContain('"ar-invoices"');
    expect(createOnSuccess).not.toContain('"ar-aging"');
  });

  it("post and reverse both delegate to the same shared invalidateDerivedQueries() helper — every derived per-invoice query (credit notes, balance, remaining-capacity lines, posted-ids) explicitly, not relying only on the create dialog's enabled/staleTime transition to refetch them", () => {
    const helperBody =
      panel.match(/function invalidateDerivedQueries\(\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(helperBody).toContain(
      'qc.invalidateQueries({ queryKey: ["ar-credit-notes", propertyId] });',
    );
    expect(helperBody).toContain('qc.invalidateQueries({ queryKey: ["ar-invoice-balance"] });');
    expect(helperBody).toContain('qc.invalidateQueries({ queryKey: ["ar-credit-note-lines"] });');
    expect(helperBody).toContain(
      'qc.invalidateQueries({ queryKey: ["ar-credit-notes-posted-ids"] });',
    );
    expect(helperBody).toContain("onLedgerChanged();");

    const postOnSuccess =
      panel.match(
        /const post = useMutation\(\{[\s\S]*?onError: \(e: Error\) => toast\.error\(e\.message\),\n {2}\}\);/,
      )?.[0] ?? "";
    expect(postOnSuccess).toContain("invalidateDerivedQueries();");

    const reverseOnSuccess =
      panel.match(
        /const reverse = useMutation\(\{[\s\S]*?onError: \(e: Error\) => toast\.error\(e\.message\),\n {2}\}\);/,
      )?.[0] ?? "";
    expect(reverseOnSuccess).toContain("invalidateDerivedQueries();");
  });

  it("post/reverse delegate ar-invoices/ar-aging invalidation to the parent via onLedgerChanged() — posting/reversing changes invoice status/balance, matching how reverse_ar_invoice's own onSuccess behaves in this file", () => {
    expect(arPage).toContain(
      'qc.invalidateQueries({ queryKey: ["ar-invoices", propertyId] });\n          qc.invalidateQueries({ queryKey: ["ar-aging", propertyId] });',
    );
    expect(arPage).toContain("onLedgerChanged={() => {");
  });

  it("the panel is mounted with the parent's already-fetched invoice list rather than re-querying ar_invoices a second time", () => {
    expect(arPage).toContain("<ArCreditNotesPanel");
    expect(arPage).toContain("invoices={invoices.data ?? []}");
    expect(panel).not.toMatch(/\.from\("ar_invoices"\)\.select\(\s*"\*"/);
  });
});

describe("AR Credit Note UI — no unrelated financial code touched", () => {
  it("receipt posting/reversal RPC names are absent from this PR's new files — no reverse_ar_receipt anywhere", () => {
    expect(panel).not.toMatch(/reverse_ar_receipt|void_ar_receipt/);
    expect(serverFn).not.toMatch(/reverse_ar_receipt|void_ar_receipt/);
  });

  it("PR B superseded the original PR A constraint of 'no credit-note reversal exists yet' — reverse_ar_credit_note is now called, covered in depth by tests/ar-credit-note-receipt-reversal.test.ts", () => {
    expect(panel).toContain('"reverse_ar_credit_note"');
    expect(panel).not.toMatch(/void_ar_credit_note/);
  });

  it("imports nothing from the HRM, payroll, or AP modules — every import is scoped to AR/shared UI primitives", () => {
    const importLines = [
      ...panel.matchAll(/^import .*$/gm),
      ...serverFn.matchAll(/^import .*$/gm),
    ].map((m) => m[0]);
    for (const line of importLines) {
      expect(line).not.toMatch(/\/hrm\/|\/payroll\/|ap-bills|ap-payments|ap-statements/);
    }
  });
});
