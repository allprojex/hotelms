import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatMoney,
  requireValidCurrencyCode,
  safeCurrencyCode,
} from "../src/lib/accounting/domain";

const root = resolve(__dirname, "..");
const arPage = readFileSync(resolve(root, "src/routes/_authenticated/accounting.ar.tsx"), "utf8");
const receiptFunctions = readFileSync(
  resolve(root, "src/lib/accounting/ar-receipts.functions.ts"),
  "utf8",
);
const customerFunctions = readFileSync(
  resolve(root, "src/lib/accounting/ar-customers.functions.ts"),
  "utf8",
);

describe("AR currency safety", () => {
  it.each(["GHS", "USD", "EUR", "GBP"])("formats valid currency %s", (currency) => {
    expect(() => formatMoney(12.5, currency)).not.toThrow();
    expect(safeCurrencyCode(currency)).toBe(currency);
  });

  it.each(["GHS4554", "", null, undefined, "arbitrary text"])(
    "falls back without throwing for invalid currency %s",
    (currency) => {
      expect(() => formatMoney(12.5, currency)).not.toThrow();
      expect(safeCurrencyCode(currency)).toBe("GHS");
    },
  );

  it("rejects malformed currency before invoice insertion", () => {
    expect(() => requireValidCurrencyCode("GHS4554")).toThrow(
      "Currency must be a valid 3-letter code",
    );
    expect(arPage).toContain("currency: requireValidCurrencyCode(form.currency)");
    expect(customerFunctions).toContain("currency: requireValidCurrencyCode(d.currency)");
    expect(customerFunctions.indexOf("requireValidCurrencyCode(d.currency)")).toBeLessThan(
      customerFunctions.indexOf('.rpc("create_ar_invoice"'),
    );
  });

  it("renders loaded invoices and receipts with the safe formatter", () => {
    expect(arPage).toContain("formatMoney(Number(i.total), i.currency)");
    expect(arPage).toContain("formatMoney(Number(r.amount), r.currency)");
    expect(arPage).not.toContain("new Intl.NumberFormat");
  });

  it("rejects malformed invoice currency before receipt posting", () => {
    expect(receiptFunctions).toContain('.select("id,currency")');
    expect(receiptFunctions).toContain("requireValidCurrencyCode(invoice.currency)");
    expect(receiptFunctions.indexOf("requireValidCurrencyCode(invoice.currency)")).toBeLessThan(
      receiptFunctions.indexOf('supabase.rpc("post_ar_receipt"'),
    );
  });
});
