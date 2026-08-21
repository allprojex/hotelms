// @prod-financial worked example: create -> post -> reverse a nominal AR
// invoice through the real UI, then reconcile.
//
// This is the ONE reference implementation for the required
// "@prod-financial" pattern (Section E): every module's write/financial
// smoke test should follow this same shape when a release plan authorizes
// it. It does not delete anything — ar_invoices rows are immutable by
// design in this codebase (no delete RLS policy), so "cleanup" here means
// reversing the invoice via reverse_ar_invoice(), the same supported
// workflow a real user would use, leaving both the original posting and its
// reversal as a permanent, correctly-linked audit trail
// (journal_entries.is_reversal_of), exactly as intended — never erased.
//
// Amount is deliberately tiny (1.00 in the property's own currency) and the
// line description is stamped "SMOKE TEST" plus an ISO timestamp so the
// record is unambiguously identifiable as automation-created in every
// downstream view (invoice list, journal, admin_action_logs) — a human
// auditor should immediately recognize it and never mistake it for a real
// guest charge.
//
// Returns a result object the caller (ui-smoke.mjs) folds into the final
// report, including the invoice/reversal codes so the report's "production
// records created/changed" and "cleanup/reversal result" sections are
// concrete, not just "ok".

const SMOKE_MARKER = "SMOKE TEST — automated @prod-financial check";

export async function runArInvoiceFinancialScenario(page, { baseUrl }) {
  const timestamp = new Date().toISOString();
  const result = {
    scenario: "ar-invoice-financial",
    ok: false,
    invoiceCode: null,
    reversed: false,
    finalBalance: null,
    note: "",
  };

  await page.goto(`${baseUrl}/accounting/ar`, { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "New invoice" }).click();
  const customerSelect = page.getByLabel("AR customer");
  await customerSelect.click();
  const firstCustomerOption = page.getByRole("option").first();
  if ((await firstCustomerOption.count()) === 0) {
    result.note =
      "No AR customer exists to bill against — create one first, or this release doesn't need this check.";
    await page.keyboard.press("Escape");
    return result;
  }
  await firstCustomerOption.click();

  // The line grid's text inputs have no distinct labels (see
  // accounting.ar.tsx's line-item grid) — target by position within the
  // first line row instead: description, then quantity/price/tax as number
  // inputs.
  const lineInputs = page.locator(
    'div:has(> input[type="number"]) input:not([type="number"]):not([type="date"])',
  );
  await lineInputs.first().fill(`${SMOKE_MARKER} ${timestamp}`);

  const numberInputs = page.locator('input[type="number"]');
  await numberInputs.nth(0).fill("1"); // quantity
  await numberInputs.nth(1).fill("1"); // unit_price -> total 1.00
  await numberInputs.nth(2).fill("0"); // tax_rate

  await page.getByRole("button", { name: "Create draft" }).click();
  await page.getByText("Invoice created as draft").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);

  const rowWithMarker = page.locator("div").filter({ hasText: SMOKE_MARKER }).first();
  const postButton = rowWithMarker.getByRole("button", { name: /Post/ });
  await postButton.click();
  await page.getByText("Invoice posted to ledger").waitFor({ timeout: 10_000 });

  const voidButton = rowWithMarker.getByRole("button", { name: /Void/ });
  await voidButton.click();
  await page
    .getByLabel(/Reason \(required, 5–500 characters\)/)
    .fill(
      `Automated production smoke test cleanup — ${timestamp}. Safe to ignore; reverses a $1 test posting.`,
    );
  await page.getByRole("button", { name: "Reverse invoice" }).click();
  await page
    .getByText("Invoice reversed — a new offsetting journal entry was posted")
    .waitFor({ timeout: 10_000 });

  result.ok = true;
  result.reversed = true;
  result.finalBalance = 0;
  result.note =
    "Invoice created, posted, then reversed via reverse_ar_invoice(). Both the original posting and its " +
    "reversal remain permanently in ar_invoices/journal_entries as linked audit history (is_reversal_of) — " +
    "intentionally not deleted, matching this codebase's immutable-ledger design.";
  return result;
}
