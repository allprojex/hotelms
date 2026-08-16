import { describe, expect, it } from "vitest";
import {
  computeArCustomerStatement,
  type ArStatementAllocationRow,
  type ArStatementInvoiceRow,
} from "@/lib/accounting/ar-statement-calc";

function invoice(
  overrides: Partial<ArStatementInvoiceRow> & { id: string },
): ArStatementInvoiceRow {
  return {
    code: `INV-${overrides.id}`,
    issueDate: "2026-06-15",
    status: "sent",
    total: 100,
    currency: "GHS",
    ...overrides,
  };
}

function allocation(
  overrides: Partial<ArStatementAllocationRow> & { invoiceId: string },
): ArStatementAllocationRow {
  return {
    amount: 50,
    receiptCode: `RCT-${overrides.invoiceId}`,
    receiptDate: "2026-06-16",
    currency: "GHS",
    ...overrides,
  };
}

const PERIOD = { from: "2026-06-01", to: "2026-06-30" };

describe("computeArCustomerStatement", () => {
  it("A. a customer with one invoice produces one debit transaction and a matching closing balance", () => {
    const [section] = computeArCustomerStatement({
      ...PERIOD,
      invoices: [invoice({ id: "1", issueDate: "2026-06-10", total: 250 })],
      allocations: [],
    });
    expect(section.currency).toBe("GHS");
    expect(section.transactions).toHaveLength(1);
    expect(section.transactions[0]).toMatchObject({
      type: "invoice",
      debit: 250,
      credit: 0,
      runningBalance: 250,
    });
    expect(section.closingBalance).toBe(250);
  });

  it("B. a customer with multiple invoices lists each as a separate debit", () => {
    const [section] = computeArCustomerStatement({
      ...PERIOD,
      invoices: [
        invoice({ id: "1", issueDate: "2026-06-05", total: 100 }),
        invoice({ id: "2", issueDate: "2026-06-20", total: 75 }),
      ],
      allocations: [],
    });
    expect(section.transactions).toHaveLength(2);
    expect(section.totalDebits).toBe(175);
    expect(section.closingBalance).toBe(175);
  });

  it("C. an invoice dated before From contributes to the opening balance, not the period", () => {
    const [section] = computeArCustomerStatement({
      ...PERIOD,
      invoices: [invoice({ id: "1", issueDate: "2026-05-15", total: 300 })],
      allocations: [],
    });
    expect(section.openingBalance).toBe(300);
    expect(section.transactions).toHaveLength(0);
    expect(section.closingBalance).toBe(300);
  });

  it("D. an invoice dated exactly on From appears in the period (inclusive lower bound)", () => {
    const [section] = computeArCustomerStatement({
      ...PERIOD,
      invoices: [invoice({ id: "1", issueDate: PERIOD.from, total: 40 })],
      allocations: [],
    });
    expect(section.openingBalance).toBe(0);
    expect(section.transactions).toHaveLength(1);
    expect(section.transactions[0].date).toBe(PERIOD.from);
  });

  it("E. an invoice dated exactly on To appears in the period (inclusive upper bound)", () => {
    const [section] = computeArCustomerStatement({
      ...PERIOD,
      invoices: [invoice({ id: "1", issueDate: PERIOD.to, total: 60 })],
      allocations: [],
    });
    expect(section.transactions).toHaveLength(1);
    expect(section.transactions[0].date).toBe(PERIOD.to);
  });

  it("F. an invoice dated after To is excluded entirely", () => {
    const [section] = computeArCustomerStatement({
      ...PERIOD,
      invoices: [invoice({ id: "1", issueDate: "2026-07-01", total: 999 })],
      allocations: [],
    });
    expect(section).toBeUndefined();
  });

  it("G. a receipt dated before From reduces the opening balance", () => {
    const sections = computeArCustomerStatement({
      ...PERIOD,
      invoices: [invoice({ id: "1", issueDate: "2026-05-01", total: 200 })],
      allocations: [allocation({ invoiceId: "1", amount: 80, receiptDate: "2026-05-20" })],
    });
    const [section] = sections;
    expect(section.openingBalance).toBe(120);
    expect(section.transactions).toHaveLength(0);
  });

  it("H. a receipt dated exactly on From appears in the period", () => {
    const [section] = computeArCustomerStatement({
      ...PERIOD,
      invoices: [invoice({ id: "1", issueDate: "2026-05-01", total: 200 })],
      allocations: [allocation({ invoiceId: "1", amount: 80, receiptDate: PERIOD.from })],
    });
    expect(section.transactions).toHaveLength(1);
    expect(section.transactions[0]).toMatchObject({ type: "receipt", credit: 80 });
  });

  it("I. a receipt dated exactly on To appears in the period", () => {
    const [section] = computeArCustomerStatement({
      ...PERIOD,
      invoices: [invoice({ id: "1", issueDate: "2026-05-01", total: 200 })],
      allocations: [allocation({ invoiceId: "1", amount: 80, receiptDate: PERIOD.to })],
    });
    expect(section.transactions).toHaveLength(1);
    expect(section.transactions[0].date).toBe(PERIOD.to);
  });

  it("J. a receipt dated after To is excluded entirely", () => {
    const [section] = computeArCustomerStatement({
      ...PERIOD,
      invoices: [invoice({ id: "1", issueDate: "2026-06-05", total: 200 })],
      allocations: [allocation({ invoiceId: "1", amount: 80, receiptDate: "2026-07-15" })],
    });
    expect(section.transactions).toHaveLength(1); // only the invoice
    expect(section.transactions[0].type).toBe("invoice");
    expect(section.closingBalance).toBe(200);
  });

  it("K. a partial payment shows the actual allocated amount, leaving the remainder in the balance", () => {
    const [section] = computeArCustomerStatement({
      ...PERIOD,
      invoices: [invoice({ id: "1", issueDate: "2026-06-05", total: 200, status: "sent" })],
      allocations: [allocation({ invoiceId: "1", amount: 75, receiptDate: "2026-06-10" })],
    });
    expect(section.transactions).toHaveLength(2);
    expect(section.closingBalance).toBe(125);
  });

  it("L. multiple receipts against the same invoice each appear as their own transaction", () => {
    const [section] = computeArCustomerStatement({
      ...PERIOD,
      invoices: [invoice({ id: "1", issueDate: "2026-06-01", total: 300, status: "paid" })],
      allocations: [
        allocation({
          invoiceId: "1",
          amount: 100,
          receiptDate: "2026-06-05",
          receiptCode: "RCT-A",
        }),
        allocation({
          invoiceId: "1",
          amount: 200,
          receiptDate: "2026-06-12",
          receiptCode: "RCT-B",
        }),
      ],
    });
    expect(section.transactions).toHaveLength(3);
    expect(section.closingBalance).toBe(0);
  });

  it("M. the running balance accumulates in date order across mixed debits and credits", () => {
    const [section] = computeArCustomerStatement({
      from: "2026-06-01",
      to: "2026-06-30",
      invoices: [
        invoice({ id: "1", issueDate: "2026-06-02", total: 100 }),
        invoice({ id: "2", issueDate: "2026-06-20", total: 50 }),
      ],
      allocations: [allocation({ invoiceId: "1", amount: 60, receiptDate: "2026-06-10" })],
    });
    expect(section.transactions.map((t) => t.runningBalance)).toEqual([100, 40, 90]);
  });

  it("N. the closing balance equals opening + period debits - period credits", () => {
    const [section] = computeArCustomerStatement({
      ...PERIOD,
      invoices: [
        invoice({ id: "1", issueDate: "2026-05-01", total: 500 }), // opening
        invoice({ id: "2", issueDate: "2026-06-10", total: 100 }), // period debit
      ],
      allocations: [allocation({ invoiceId: "1", amount: 200, receiptDate: "2026-06-15" })], // period credit
    });
    expect(section.openingBalance).toBe(500);
    expect(section.totalDebits).toBe(100);
    expect(section.totalCredits).toBe(200);
    expect(section.closingBalance).toBe(400);
  });

  it("O. a customer whose invoices are exactly offset by receipts has a zero opening balance", () => {
    const [section] = computeArCustomerStatement({
      ...PERIOD,
      invoices: [invoice({ id: "1", issueDate: "2026-05-01", total: 100, status: "paid" })],
      allocations: [allocation({ invoiceId: "1", amount: 100, receiptDate: "2026-05-10" })],
    });
    expect(section.openingBalance).toBe(0);
  });

  it("P. a nonzero opening balance with no period transactions still produces a valid section", () => {
    const [section] = computeArCustomerStatement({
      ...PERIOD,
      invoices: [invoice({ id: "1", issueDate: "2026-04-01", total: 175 })],
      allocations: [],
    });
    expect(section.openingBalance).toBe(175);
    expect(section.transactions).toEqual([]);
    expect(section.closingBalance).toBe(175);
  });

  it("Q. an invoice mapped via historical customer mapping is included identically to any other invoice — the function has no concept of mapping origin", () => {
    // The caller (server function) is what filters by customer_id; once an
    // invoice row reaches this pure function it's treated exactly like any
    // other eligible invoice, regardless of whether customer_id was set at
    // creation time or later via assign_ar_invoice_customer().
    const [section] = computeArCustomerStatement({
      ...PERIOD,
      invoices: [invoice({ id: "1", issueDate: "2026-06-11", total: 90 })],
      allocations: [],
    });
    expect(section.transactions[0].debit).toBe(90);
  });

  it("Y. a void invoice contributes nothing to opening balance, period, or closing balance", () => {
    const sections = computeArCustomerStatement({
      ...PERIOD,
      invoices: [
        invoice({ id: "1", issueDate: "2026-05-01", status: "void", total: 999 }),
        invoice({ id: "2", issueDate: "2026-06-05", status: "void", total: 999 }),
      ],
      allocations: [],
    });
    expect(sections).toEqual([]);
  });

  it("Y2. an allocation against a (hypothetically) void invoice is excluded along with it", () => {
    const sections = computeArCustomerStatement({
      ...PERIOD,
      invoices: [invoice({ id: "1", issueDate: "2026-05-01", status: "void", total: 500 })],
      allocations: [allocation({ invoiceId: "1", amount: 100, receiptDate: "2026-06-10" })],
    });
    expect(sections).toEqual([]);
  });

  it("Z. a draft invoice contributes nothing — never posted, no committed total", () => {
    const sections = computeArCustomerStatement({
      ...PERIOD,
      invoices: [invoice({ id: "1", issueDate: "2026-06-05", status: "draft", total: 0 })],
      allocations: [],
    });
    expect(sections).toEqual([]);
  });

  it("AA. invoices in different currencies never combine into one balance — each currency gets its own section", () => {
    const sections = computeArCustomerStatement({
      ...PERIOD,
      invoices: [
        invoice({ id: "1", issueDate: "2026-06-05", total: 100, currency: "GHS" }),
        invoice({ id: "2", issueDate: "2026-06-06", total: 50, currency: "USD" }),
      ],
      allocations: [],
    });
    expect(sections).toHaveLength(2);
    const ghs = sections.find((s) => s.currency === "GHS")!;
    const usd = sections.find((s) => s.currency === "USD")!;
    expect(ghs.closingBalance).toBe(100);
    expect(usd.closingBalance).toBe(50);
    // no section anywhere sums the two currencies together
    expect(sections.every((s) => s.closingBalance !== 150)).toBe(true);
  });

  it("AB. a malformed/unsupported currency code is normalized rather than crashing or silently dropped", () => {
    const sections = computeArCustomerStatement({
      ...PERIOD,
      invoices: [
        invoice({ id: "1", issueDate: "2026-06-05", total: 40, currency: "not-a-currency" }),
      ],
      allocations: [],
    });
    expect(sections).toHaveLength(1);
    expect(sections[0].currency).toBe("GHS"); // safeCurrencyCode's established fallback
    expect(sections[0].closingBalance).toBe(40);
  });

  it("groups a customer's own multi-currency invoices and receipts correctly at the same time", () => {
    const sections = computeArCustomerStatement({
      ...PERIOD,
      invoices: [
        invoice({ id: "1", issueDate: "2026-06-01", total: 100, currency: "GHS" }),
        invoice({ id: "2", issueDate: "2026-06-02", total: 200, currency: "USD" }),
      ],
      allocations: [
        allocation({ invoiceId: "1", amount: 30, receiptDate: "2026-06-10", currency: "GHS" }),
        allocation({ invoiceId: "2", amount: 50, receiptDate: "2026-06-11", currency: "USD" }),
      ],
    });
    const ghs = sections.find((s) => s.currency === "GHS")!;
    const usd = sections.find((s) => s.currency === "USD")!;
    expect(ghs.closingBalance).toBe(70);
    expect(usd.closingBalance).toBe(150);
  });

  it("returns no sections at all for a customer with zero eligible activity", () => {
    expect(computeArCustomerStatement({ ...PERIOD, invoices: [], allocations: [] })).toEqual([]);
  });

  it("does not accumulate floating-point drift across many small transactions", () => {
    const invoices = Array.from({ length: 20 }, (_, i) =>
      invoice({ id: `${i}`, issueDate: "2026-06-01", total: 0.1 }),
    );
    const [section] = computeArCustomerStatement({ ...PERIOD, invoices, allocations: [] });
    expect(section.closingBalance).toBe(2);
  });
});
