import { describe, expect, it } from "vitest";
import {
  computeApSupplierStatement,
  type ApStatementBillRow,
  type ApStatementPaymentRow,
} from "@/lib/accounting/ap-statement-calc";

function bill(overrides: Partial<ApStatementBillRow> & { id: string }): ApStatementBillRow {
  return {
    code: `BILL-${overrides.id}`,
    billDate: "2026-06-15",
    status: "open",
    total: 100,
    currency: "GHS",
    ...overrides,
  };
}

function payment(
  overrides: Partial<ApStatementPaymentRow> & { billId: string },
): ApStatementPaymentRow {
  return {
    amount: 50,
    method: "cash",
    reference: null,
    paidDate: "2026-06-16",
    currency: "GHS",
    ...overrides,
  };
}

const PERIOD = { from: "2026-06-01", to: "2026-06-30" };

describe("computeApSupplierStatement", () => {
  it("A. a supplier with one bill produces one credit transaction and a matching closing balance", () => {
    const [section] = computeApSupplierStatement({
      ...PERIOD,
      bills: [bill({ id: "1", billDate: "2026-06-10", total: 250 })],
      payments: [],
    });
    expect(section.currency).toBe("GHS");
    expect(section.transactions).toHaveLength(1);
    expect(section.transactions[0]).toMatchObject({
      type: "bill",
      debit: 0,
      credit: 250,
      runningBalance: 250,
    });
    expect(section.closingBalance).toBe(250);
  });

  it("B. a supplier with multiple bills lists each as a separate credit", () => {
    const [section] = computeApSupplierStatement({
      ...PERIOD,
      bills: [
        bill({ id: "1", billDate: "2026-06-05", total: 100 }),
        bill({ id: "2", billDate: "2026-06-20", total: 75 }),
      ],
      payments: [],
    });
    expect(section.transactions).toHaveLength(2);
    expect(section.totalCredits).toBe(175);
    expect(section.closingBalance).toBe(175);
  });

  it("C. a bill dated before From contributes to the opening balance, not the period", () => {
    const [section] = computeApSupplierStatement({
      ...PERIOD,
      bills: [bill({ id: "1", billDate: "2026-05-15", total: 300 })],
      payments: [],
    });
    expect(section.openingBalance).toBe(300);
    expect(section.transactions).toHaveLength(0);
    expect(section.closingBalance).toBe(300);
  });

  it("D. a bill dated exactly on From appears in the period (inclusive lower bound)", () => {
    const [section] = computeApSupplierStatement({
      ...PERIOD,
      bills: [bill({ id: "1", billDate: PERIOD.from, total: 40 })],
      payments: [],
    });
    expect(section.openingBalance).toBe(0);
    expect(section.transactions).toHaveLength(1);
    expect(section.transactions[0].date).toBe(PERIOD.from);
  });

  it("E. a bill dated exactly on To appears in the period (inclusive upper bound)", () => {
    const [section] = computeApSupplierStatement({
      ...PERIOD,
      bills: [bill({ id: "1", billDate: PERIOD.to, total: 60 })],
      payments: [],
    });
    expect(section.transactions).toHaveLength(1);
    expect(section.transactions[0].date).toBe(PERIOD.to);
  });

  it("F. a bill dated after To is excluded entirely", () => {
    const sections = computeApSupplierStatement({
      ...PERIOD,
      bills: [bill({ id: "1", billDate: "2026-07-01", total: 999 })],
      payments: [],
    });
    expect(sections).toEqual([]);
  });

  it("G. a payment before From reduces the opening balance", () => {
    const [section] = computeApSupplierStatement({
      ...PERIOD,
      bills: [bill({ id: "1", billDate: "2026-05-01", total: 200 })],
      payments: [payment({ billId: "1", amount: 80, paidDate: "2026-05-20" })],
    });
    expect(section.openingBalance).toBe(120);
    expect(section.transactions).toHaveLength(0);
  });

  it("H. a payment dated exactly on From appears in the period", () => {
    const [section] = computeApSupplierStatement({
      ...PERIOD,
      bills: [bill({ id: "1", billDate: "2026-05-01", total: 200 })],
      payments: [payment({ billId: "1", amount: 80, paidDate: PERIOD.from })],
    });
    expect(section.transactions).toHaveLength(1);
    expect(section.transactions[0]).toMatchObject({ type: "payment", debit: 80 });
  });

  it("I. a payment dated exactly on To appears in the period", () => {
    const [section] = computeApSupplierStatement({
      ...PERIOD,
      bills: [bill({ id: "1", billDate: "2026-05-01", total: 200 })],
      payments: [payment({ billId: "1", amount: 80, paidDate: PERIOD.to })],
    });
    expect(section.transactions).toHaveLength(1);
    expect(section.transactions[0].date).toBe(PERIOD.to);
  });

  it("J. a payment dated after To is excluded entirely", () => {
    const [section] = computeApSupplierStatement({
      ...PERIOD,
      bills: [bill({ id: "1", billDate: "2026-06-05", total: 200 })],
      payments: [payment({ billId: "1", amount: 80, paidDate: "2026-07-15" })],
    });
    expect(section.transactions).toHaveLength(1); // only the bill
    expect(section.transactions[0].type).toBe("bill");
    expect(section.closingBalance).toBe(200);
  });

  it("K. a partial payment shows the actual paid amount, leaving the remainder in the balance", () => {
    const [section] = computeApSupplierStatement({
      ...PERIOD,
      bills: [bill({ id: "1", billDate: "2026-06-05", total: 200, status: "open" })],
      payments: [payment({ billId: "1", amount: 75, paidDate: "2026-06-10" })],
    });
    expect(section.transactions).toHaveLength(2);
    expect(section.closingBalance).toBe(125);
  });

  it("L. multiple payments against the same bill each appear as their own transaction", () => {
    const [section] = computeApSupplierStatement({
      ...PERIOD,
      bills: [bill({ id: "1", billDate: "2026-06-01", total: 300, status: "paid" })],
      payments: [
        payment({ billId: "1", amount: 100, paidDate: "2026-06-05" }),
        payment({ billId: "1", amount: 200, paidDate: "2026-06-12" }),
      ],
    });
    expect(section.transactions).toHaveLength(3);
    expect(section.closingBalance).toBe(0);
  });

  it("M. the running balance accumulates in date order across mixed debits and credits", () => {
    const [section] = computeApSupplierStatement({
      from: "2026-06-01",
      to: "2026-06-30",
      bills: [
        bill({ id: "1", billDate: "2026-06-02", total: 100 }),
        bill({ id: "2", billDate: "2026-06-20", total: 50 }),
      ],
      payments: [payment({ billId: "1", amount: 60, paidDate: "2026-06-10" })],
    });
    expect(section.transactions.map((t) => t.runningBalance)).toEqual([100, 40, 90]);
  });

  it("N. the closing balance equals opening + period credits - period debits", () => {
    const [section] = computeApSupplierStatement({
      ...PERIOD,
      bills: [
        bill({ id: "1", billDate: "2026-05-01", total: 500 }), // opening
        bill({ id: "2", billDate: "2026-06-10", total: 100 }), // period credit
      ],
      payments: [payment({ billId: "1", amount: 200, paidDate: "2026-06-15" })], // period debit
    });
    expect(section.openingBalance).toBe(500);
    expect(section.totalCredits).toBe(100);
    expect(section.totalDebits).toBe(200);
    expect(section.closingBalance).toBe(400);
  });

  it("O. a supplier whose bills are exactly offset by payments has a zero opening balance", () => {
    const [section] = computeApSupplierStatement({
      ...PERIOD,
      bills: [bill({ id: "1", billDate: "2026-05-01", total: 100, status: "paid" })],
      payments: [payment({ billId: "1", amount: 100, paidDate: "2026-05-10" })],
    });
    expect(section.openingBalance).toBe(0);
  });

  it("P. a nonzero opening balance with no period transactions still produces a valid section", () => {
    const [section] = computeApSupplierStatement({
      ...PERIOD,
      bills: [bill({ id: "1", billDate: "2026-04-01", total: 175 })],
      payments: [],
    });
    expect(section.openingBalance).toBe(175);
    expect(section.transactions).toEqual([]);
    expect(section.closingBalance).toBe(175);
  });

  it("Q. a bill mapped via historical supplier mapping is included identically to any other bill — the function has no concept of mapping origin", () => {
    // The caller (server function) is what filters by supplier_id; once a
    // bill row reaches this pure function it's treated exactly like any
    // other eligible bill, regardless of whether supplier_id was set at
    // creation time or later via assign_ap_bill_supplier().
    const [section] = computeApSupplierStatement({
      ...PERIOD,
      bills: [bill({ id: "1", billDate: "2026-06-11", total: 90 })],
      payments: [],
    });
    expect(section.transactions[0].credit).toBe(90);
  });

  it("fully settled supplier: bill and payment net to a zero closing balance", () => {
    const [section] = computeApSupplierStatement({
      ...PERIOD,
      bills: [bill({ id: "1", billDate: "2026-06-05", total: 500, status: "paid" })],
      payments: [payment({ billId: "1", amount: 500, paidDate: "2026-06-06" })],
    });
    expect(section.closingBalance).toBe(0);
  });

  it("AA(void). a void bill contributes nothing to opening balance, period, or closing balance", () => {
    const sections = computeApSupplierStatement({
      ...PERIOD,
      bills: [
        bill({ id: "1", billDate: "2026-05-01", status: "void", total: 999 }),
        bill({ id: "2", billDate: "2026-06-05", status: "void", total: 999 }),
      ],
      payments: [],
    });
    expect(sections).toEqual([]);
  });

  it("a payment against a (hypothetically) void bill is excluded along with it", () => {
    const sections = computeApSupplierStatement({
      ...PERIOD,
      bills: [bill({ id: "1", billDate: "2026-05-01", status: "void", total: 500 })],
      payments: [payment({ billId: "1", amount: 100, paidDate: "2026-06-10" })],
    });
    expect(sections).toEqual([]);
  });

  it("Z(draft). a draft bill contributes nothing — never posted, no committed total", () => {
    const sections = computeApSupplierStatement({
      ...PERIOD,
      bills: [bill({ id: "1", billDate: "2026-06-05", status: "draft", total: 0 })],
      payments: [],
    });
    expect(sections).toEqual([]);
  });

  it("AB. bills in different currencies never combine into one balance — each currency gets its own section", () => {
    const sections = computeApSupplierStatement({
      ...PERIOD,
      bills: [
        bill({ id: "1", billDate: "2026-06-05", total: 100, currency: "GHS" }),
        bill({ id: "2", billDate: "2026-06-06", total: 50, currency: "USD" }),
      ],
      payments: [],
    });
    expect(sections).toHaveLength(2);
    const ghs = sections.find((s) => s.currency === "GHS")!;
    const usd = sections.find((s) => s.currency === "USD")!;
    expect(ghs.closingBalance).toBe(100);
    expect(usd.closingBalance).toBe(50);
    // no section anywhere sums the two currencies together
    expect(sections.every((s) => s.closingBalance !== 150)).toBe(true);
  });

  it("AC. a malformed/unsupported currency code is normalized rather than crashing or silently dropped", () => {
    const sections = computeApSupplierStatement({
      ...PERIOD,
      bills: [bill({ id: "1", billDate: "2026-06-05", total: 40, currency: "not-a-currency" })],
      payments: [],
    });
    expect(sections).toHaveLength(1);
    expect(sections[0].currency).toBe("GHS"); // safeCurrencyCode's established fallback
    expect(sections[0].closingBalance).toBe(40);
  });

  it("groups a supplier's own multi-currency bills and payments correctly at the same time", () => {
    const sections = computeApSupplierStatement({
      ...PERIOD,
      bills: [
        bill({ id: "1", billDate: "2026-06-01", total: 100, currency: "GHS" }),
        bill({ id: "2", billDate: "2026-06-02", total: 200, currency: "USD" }),
      ],
      payments: [
        payment({ billId: "1", amount: 30, paidDate: "2026-06-10", currency: "GHS" }),
        payment({ billId: "2", amount: 50, paidDate: "2026-06-11", currency: "USD" }),
      ],
    });
    const ghs = sections.find((s) => s.currency === "GHS")!;
    const usd = sections.find((s) => s.currency === "USD")!;
    expect(ghs.closingBalance).toBe(70);
    expect(usd.closingBalance).toBe(150);
  });

  it("returns no sections at all for a supplier with zero eligible activity", () => {
    expect(computeApSupplierStatement({ ...PERIOD, bills: [], payments: [] })).toEqual([]);
  });

  it("does not accumulate floating-point drift across many small transactions", () => {
    const bills = Array.from({ length: 20 }, (_, i) =>
      bill({ id: `${i}`, billDate: "2026-06-01", total: 0.1 }),
    );
    const [section] = computeApSupplierStatement({ ...PERIOD, bills, payments: [] });
    expect(section.closingBalance).toBe(2);
  });

  it("reference falls back to the bill code when the payment has no free-text reference", () => {
    const [section] = computeApSupplierStatement({
      ...PERIOD,
      bills: [bill({ id: "1", code: "BILL-XYZ", billDate: "2026-06-01", total: 100 })],
      payments: [payment({ billId: "1", amount: 40, paidDate: "2026-06-05", reference: null })],
    });
    const paymentRow = section.transactions.find((t) => t.type === "payment")!;
    expect(paymentRow.reference).toBe("BILL-XYZ");
  });

  it("reference prefers the payment's own free-text reference when present", () => {
    const [section] = computeApSupplierStatement({
      ...PERIOD,
      bills: [bill({ id: "1", code: "BILL-XYZ", billDate: "2026-06-01", total: 100 })],
      payments: [
        payment({ billId: "1", amount: 40, paidDate: "2026-06-05", reference: "CHQ-9911" }),
      ],
    });
    const paymentRow = section.transactions.find((t) => t.type === "payment")!;
    expect(paymentRow.reference).toBe("CHQ-9911");
  });
});
