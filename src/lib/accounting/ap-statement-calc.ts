import { safeCurrencyCode } from "@/lib/accounting/domain";

/**
 * Statuses that represent an actual, posted payable. 'draft' is deliberately
 * excluded — post_ap_bill() is the only thing that computes real totals and
 * sets posted_entry_id; a draft bill's total may still be the unposted
 * default (0). 'void' is excluded per the existing ap_aging view's own
 * convention (status <> 'void'). No code path in this application currently
 * sets 'void' on an ap_bill — there is no void/cancel action anywhere in the
 * AP UI or a dedicated RPC — but the calculation excludes it defensively
 * regardless, mirroring AR_STATEMENT_INCLUDED_STATUSES's identical
 * reasoning, since a voided bill must never contribute to a balance if that
 * capability is ever added.
 */
export const AP_STATEMENT_INCLUDED_STATUSES = ["open", "paid"] as const;

export type ApStatementBillRow = {
  id: string;
  code: string;
  /** ISO date (YYYY-MM-DD) — ap_bills.bill_date, post_ap_bill's own posting date. */
  billDate: string;
  status: string;
  total: number;
  currency: string;
};

/**
 * One row per ap_payments entry. Unlike AR (where one receipt can be
 * allocated across many invoices via a separate ar_receipt_allocations
 * table), ap_payments.bill_id is NOT NULL and every payment already belongs
 * to exactly one bill — there is no AP allocation table and no code path
 * that lets one payment span multiple bills or multiple suppliers. So the
 * payment row itself is the unit attributable to one supplier (via its
 * bill's supplier_id), with no join table involved.
 */
export type ApStatementPaymentRow = {
  billId: string;
  amount: number;
  method: string;
  /** ap_payments.reference — free-text, user-entered, often a cheque/transfer number. */
  reference: string | null;
  /** ISO date (YYYY-MM-DD) — derived from ap_payments.paid_at's UTC calendar date (see ap-statements.functions.ts). */
  paidDate: string;
  /** The payment's own currency — always its bill's currency (post_ap_payment derives it that way; ap_payments has no currency column of its own). */
  currency: string;
};

export type ApStatementTransaction = {
  date: string;
  type: "bill" | "payment";
  reference: string;
  description: string;
  debit: number;
  credit: number;
  runningBalance: number;
};

export type ApStatementCurrencySection = {
  currency: string;
  openingBalance: number;
  transactions: ApStatementTransaction[];
  totalDebits: number;
  totalCredits: number;
  closingBalance: number;
};

/** Matches ap_bills/ap_payments' own NUMERIC(18,4) precision, applied at
 * every accumulation step so repeated floating-point addition across many
 * transactions can't drift the running/closing balance. */
function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

/**
 * Computes a supplier's AP statement — opening balance, period transactions
 * with a running balance, and closing balance — grouped by currency, since
 * no base-currency/FX conversion mechanism is actively used anywhere in
 * this application's AP module. Combining different currencies into one
 * balance would be mathematically invalid, so each currency gets its own
 * independent opening/period/closing calculation.
 *
 * Sign convention (amount owed TO the supplier, a liability balance — the
 * mirror image of AR's receivable balance): a bill CREDITS the supplier
 * balance (increases what's owed), a payment DEBITS it (reduces what's
 * owed). Running/closing balance = opening + credits - debits. This is
 * intentionally the opposite polarity from computeArCustomerStatement's
 * debit=invoice/credit=receipt, because AP is a credit-normal liability
 * account while AR is a debit-normal asset account.
 *
 * Pure function: takes already-fetched rows (already scoped to one
 * property + one supplier by the caller) and returns the computed
 * statement. Contains no data access, so it's fully unit-testable without a
 * database.
 */
export function computeApSupplierStatement(input: {
  from: string;
  to: string;
  bills: ApStatementBillRow[];
  payments: ApStatementPaymentRow[];
}): ApStatementCurrencySection[] {
  const includedStatuses: readonly string[] = AP_STATEMENT_INCLUDED_STATUSES;
  const eligibleBills = input.bills.filter((bill) => includedStatuses.includes(bill.status));
  const eligibleBillIds = new Set(eligibleBills.map((bill) => bill.id));
  const billsById = new Map(eligibleBills.map((bill) => [bill.id, bill]));
  // A payment against a draft/void bill never happens in practice
  // (post_ap_payment only allows paying a bill with status='open'), but this
  // filter keeps the guarantee explicit and correct even if that invariant
  // ever changes.
  const eligiblePayments = input.payments.filter((p) => eligibleBillIds.has(p.billId));

  const currencies = new Set<string>();
  for (const bill of eligibleBills) currencies.add(safeCurrencyCode(bill.currency));
  for (const p of eligiblePayments) currencies.add(safeCurrencyCode(p.currency));

  const sections: ApStatementCurrencySection[] = [];
  for (const currency of [...currencies].sort()) {
    const currencyBills = eligibleBills.filter(
      (bill) => safeCurrencyCode(bill.currency) === currency,
    );
    const currencyPayments = eligiblePayments.filter(
      (p) => safeCurrencyCode(p.currency) === currency,
    );

    // Skip a currency entirely if none of its activity is on or before `to`
    // — i.e. it has nothing that could contribute to either the opening
    // balance or the period, only transactions strictly in the future
    // relative to this statement's window. A currency whose prior activity
    // nets to exactly zero (fully settled before `from`) is still included,
    // since that's a real, meaningful opening balance of $0 — distinct from
    // a currency with no relevant history at all.
    const hasRelevantActivity =
      currencyBills.some((bill) => bill.billDate <= input.to) ||
      currencyPayments.some((p) => p.paidDate <= input.to);
    if (!hasRelevantActivity) continue;

    // Opening balance nets every qualifying credit and debit strictly
    // before `from`, each on its own authoritative date — the bill's own
    // bill_date for credits, the payment's own paid_at (UTC calendar date)
    // for debits — independent of which bill a given payment happened to
    // be applied to. This is a snapshot of the account's net position at a
    // point in time, not a per-bill reconciliation.
    const openingCredits = currencyBills
      .filter((bill) => bill.billDate < input.from)
      .reduce((sum, bill) => round4(sum + bill.total), 0);
    const openingDebits = currencyPayments
      .filter((p) => p.paidDate < input.from)
      .reduce((sum, p) => round4(sum + p.amount), 0);
    const openingBalance = round4(openingCredits - openingDebits);

    type Draft = {
      date: string;
      type: "bill" | "payment";
      reference: string;
      description: string;
      debit: number;
      credit: number;
      sortKey: string;
    };
    const draftRows: Draft[] = [];

    for (const bill of currencyBills) {
      if (bill.billDate >= input.from && bill.billDate <= input.to) {
        draftRows.push({
          date: bill.billDate,
          type: "bill",
          reference: bill.code,
          description: `Bill ${bill.code}`,
          debit: 0,
          credit: bill.total,
          // Credits (bills) before debits (payments) on the same day: the
          // charge that created the balance reads before a same-day
          // payment against it — same ordering rule AR uses, just against
          // the swapped debit/credit columns.
          sortKey: `${bill.billDate}|0|${bill.code}`,
        });
      }
    }
    for (const p of currencyPayments) {
      if (p.paidDate >= input.from && p.paidDate <= input.to) {
        const bill = billsById.get(p.billId);
        const billCode = bill?.code ?? "bill";
        draftRows.push({
          date: p.paidDate,
          type: "payment",
          reference: p.reference ?? billCode,
          description: `Payment — ${p.method}${p.reference ? ` (${p.reference})` : ""} against ${billCode}`,
          debit: p.amount,
          credit: 0,
          sortKey: `${p.paidDate}|1|${billCode}`,
        });
      }
    }
    draftRows.sort((x, y) => x.sortKey.localeCompare(y.sortKey));

    let running = openingBalance;
    const transactions: ApStatementTransaction[] = draftRows.map((row) => {
      running = round4(running + row.credit - row.debit);
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
    const closingBalance = round4(openingBalance + totalCredits - totalDebits);

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
