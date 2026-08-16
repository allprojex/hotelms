import { safeCurrencyCode } from "@/lib/accounting/domain";

/**
 * Statuses that represent an actual, posted receivable. 'draft' is
 * deliberately excluded — post_ar_invoice() is the only thing that computes
 * real totals and sets posted_entry_id; a draft invoice's total may still be
 * the unposted default (0) and was never sent to the customer. 'void' is
 * excluded per the existing ar_aging view's own convention (status <>
 * 'void'). No code path in this application currently sets 'void' at all —
 * there is no void/cancel action anywhere in the AR UI or a dedicated RPC —
 * but the calculation excludes it defensively regardless, since a voided
 * invoice must never contribute to a balance if that capability is ever
 * added.
 */
export const AR_STATEMENT_INCLUDED_STATUSES = ["sent", "paid"] as const;

export type ArStatementInvoiceRow = {
  id: string;
  code: string;
  /** ISO date (YYYY-MM-DD) — post_ar_invoice's own posting date. */
  issueDate: string;
  status: string;
  total: number;
  currency: string;
};

/**
 * One row per ar_receipt_allocations entry (not one per ar_receipts row) —
 * a single receipt can be allocated across multiple invoices, potentially
 * belonging to different customers (post_ar_receipt only enforces a shared
 * property and currency across a receipt's allocations, never a shared
 * customer), so the allocation is the only unit that can be safely
 * attributed to one customer. ar_receipts itself has no customer_id column.
 */
export type ArStatementAllocationRow = {
  invoiceId: string;
  amount: number;
  receiptCode: string;
  /** ISO date (YYYY-MM-DD) — the receipt's own receipt_date, not the invoice's. */
  receiptDate: string;
  /** The allocation's currency — always equal to its invoice's currency (enforced by post_ar_receipt). */
  currency: string;
};

export type ArStatementTransaction = {
  date: string;
  type: "invoice" | "receipt";
  reference: string;
  description: string;
  debit: number;
  credit: number;
  runningBalance: number;
};

export type ArStatementCurrencySection = {
  currency: string;
  openingBalance: number;
  transactions: ArStatementTransaction[];
  totalDebits: number;
  totalCredits: number;
  closingBalance: number;
};

/** Matches ar_invoices/ar_receipts' own NUMERIC(18,4) precision, applied at
 * every accumulation step so repeated floating-point addition across many
 * transactions can't drift the running/closing balance. */
function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

/**
 * Computes a customer's AR statement — opening balance, period transactions
 * with a running balance, and closing balance — grouped by currency, since
 * no base-currency/FX conversion mechanism is actively used anywhere in
 * this application's AR module (fx_rates/fx.functions.ts exist but are
 * never referenced by any accounting code). Combining different currencies
 * into one balance would be mathematically invalid, so each currency gets
 * its own independent opening/period/closing calculation.
 *
 * Pure function: takes already-fetched rows (already scoped to one
 * property + one customer by the caller) and returns the computed
 * statement. Contains no data access, so it's fully unit-testable without a
 * database.
 */
export function computeArCustomerStatement(input: {
  from: string;
  to: string;
  invoices: ArStatementInvoiceRow[];
  allocations: ArStatementAllocationRow[];
}): ArStatementCurrencySection[] {
  const includedStatuses: readonly string[] = AR_STATEMENT_INCLUDED_STATUSES;
  const eligibleInvoices = input.invoices.filter((inv) => includedStatuses.includes(inv.status));
  const eligibleInvoiceIds = new Set(eligibleInvoices.map((inv) => inv.id));
  const invoicesById = new Map(eligibleInvoices.map((inv) => [inv.id, inv]));
  // An allocation against a draft/void invoice never happens in practice
  // (post_ar_receipt only allows allocating against status='sent'), but
  // this filter keeps the guarantee explicit and correct even if that
  // invariant ever changes.
  const eligibleAllocations = input.allocations.filter((a) => eligibleInvoiceIds.has(a.invoiceId));

  const currencies = new Set<string>();
  for (const inv of eligibleInvoices) currencies.add(safeCurrencyCode(inv.currency));
  for (const a of eligibleAllocations) currencies.add(safeCurrencyCode(a.currency));

  const sections: ArStatementCurrencySection[] = [];
  for (const currency of [...currencies].sort()) {
    const currencyInvoices = eligibleInvoices.filter(
      (inv) => safeCurrencyCode(inv.currency) === currency,
    );
    const currencyAllocations = eligibleAllocations.filter(
      (a) => safeCurrencyCode(a.currency) === currency,
    );

    // Skip a currency entirely if none of its activity is on or before
    // `to` — i.e. it has nothing that could contribute to either the
    // opening balance or the period, only transactions strictly in the
    // future relative to this statement's window. A currency whose prior
    // activity nets to exactly zero (fully settled before `from`) is still
    // included, since that's a real, meaningful opening balance of $0 —
    // distinct from a currency with no relevant history at all.
    const hasRelevantActivity =
      currencyInvoices.some((inv) => inv.issueDate <= input.to) ||
      currencyAllocations.some((a) => a.receiptDate <= input.to);
    if (!hasRelevantActivity) continue;

    // Opening balance nets every qualifying debit and credit strictly
    // before `from`, each on its own authoritative date — the invoice's
    // issue_date for debits, the receipt's receipt_date for credits —
    // independent of which invoice a given receipt happened to be applied
    // to. This is a snapshot of the account's net position at a point in
    // time, not a per-invoice reconciliation.
    const openingDebits = currencyInvoices
      .filter((inv) => inv.issueDate < input.from)
      .reduce((sum, inv) => round4(sum + inv.total), 0);
    const openingCredits = currencyAllocations
      .filter((a) => a.receiptDate < input.from)
      .reduce((sum, a) => round4(sum + a.amount), 0);
    const openingBalance = round4(openingDebits - openingCredits);

    type Draft = {
      date: string;
      type: "invoice" | "receipt";
      reference: string;
      description: string;
      debit: number;
      credit: number;
      sortKey: string;
    };
    const draftRows: Draft[] = [];

    for (const inv of currencyInvoices) {
      if (inv.issueDate >= input.from && inv.issueDate <= input.to) {
        draftRows.push({
          date: inv.issueDate,
          type: "invoice",
          reference: inv.code,
          description: `Invoice ${inv.code}`,
          debit: inv.total,
          credit: 0,
          // Debits before credits on the same day: the charge that created
          // the balance reads before a same-day payment against it.
          sortKey: `${inv.issueDate}|0|${inv.code}`,
        });
      }
    }
    for (const a of currencyAllocations) {
      if (a.receiptDate >= input.from && a.receiptDate <= input.to) {
        const inv = invoicesById.get(a.invoiceId);
        draftRows.push({
          date: a.receiptDate,
          type: "receipt",
          reference: a.receiptCode,
          description: `Payment — applied to ${inv?.code ?? "invoice"}`,
          debit: 0,
          credit: a.amount,
          sortKey: `${a.receiptDate}|1|${a.receiptCode}`,
        });
      }
    }
    draftRows.sort((x, y) => x.sortKey.localeCompare(y.sortKey));

    let running = openingBalance;
    const transactions: ArStatementTransaction[] = draftRows.map((row) => {
      running = round4(running + row.debit - row.credit);
      return {
        date: row.date,
        type: row.type,
        reference: row.reference,
        description: row.description,
        debit: round4(row.debit),
        credit: round4(row.credit),
        runningBalance: running,
      };
    });

    const totalDebits = round4(draftRows.reduce((sum, row) => round4(sum + row.debit), 0));
    const totalCredits = round4(draftRows.reduce((sum, row) => round4(sum + row.credit), 0));
    const closingBalance = round4(openingBalance + totalDebits - totalCredits);

    sections.push({
      currency,
      openingBalance,
      transactions,
      totalDebits,
      totalCredits,
      closingBalance,
    });
  }
  return sections;
}
