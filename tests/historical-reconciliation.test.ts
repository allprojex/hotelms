import { describe, expect, it } from "vitest";
import {
  FIX_FORWARD_BOUNDARY,
  EXCLUSION,
  CATEGORY,
  money,
  money4,
  deriveFolioSplit,
  buildProposal,
  exclude,
  decodeNumeric,
  decodeUuid,
  classifyFolio,
  classifyPayment,
  classifyFx,
  summarize,
} from "../scripts/prod/reconcile-historical-journals.mjs";

const PROP = {
  id: "9a101d34-b724-4e57-b0eb-71ec5ecac162",
  name: "Theskwoff hotel ",
  base_currency: "GHS",
  currency: "GHS",
};
const ACCOUNTS = {
  ar: "acc-ar",
  room_revenue: "acc-rev",
  tax_payable: "acc-tax",
  cash: "acc-cash",
};

/** A stay that should repair cleanly. */
function stay(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    code: "RES-0001",
    property_id: PROP.id,
    check_out: "2026-08-20T00:00:00Z",
    rate_total: 550,
    existing_entry_id: null,
    other_linkage_entry_id: null,
    period_locked: false,
    ...over,
  };
}

function payment(over: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    reservation_id: "11111111-1111-1111-1111-111111111111",
    property_id: PROP.id,
    received_at: "2026-08-10T09:00:00Z",
    amount: 400,
    method: "cash",
    existing_entry_id: null,
    reversal_entry_id: null,
    period_locked: false,
    ...over,
  };
}

function fxEntry(over: Record<string, unknown> = {}) {
  return {
    entry_id: "33333333-3333-3333-3333-333333333333",
    property_id: PROP.id,
    source: "folio",
    source_ref: "11111111-1111-1111-1111-111111111111",
    currency: "USD",
    entry_date: "2026-08-12",
    already_reversed_by: null,
    period_locked: false,
    lines: [
      { account_id: "acc-ar", system_key: "ar", debit: 1000, credit: 0, debit_base: 100, credit_base: 0, memo: "AR" },
      { account_id: "acc-rev", system_key: "room_revenue", debit: 0, credit: 909.0909, debit_base: 0, credit_base: 90.9091, memo: "Room revenue" },
      { account_id: "acc-tax", system_key: "tax_payable", debit: 0, credit: 90.9091, debit_base: 0, credit_base: 9.0909, memo: "Tax" },
    ],
    ...over,
  };
}

describe("the cutoff is locked, not configurable", () => {
  it("is exactly the fix-forward boundary", () => {
    expect(FIX_FORWARD_BOUNDARY).toBe("2026-09-09T21:55:03.790Z");
  });

  it("excludes a stay whose check-out is at or after the boundary", () => {
    const [r] = classifyFolio([stay({ check_out: "2026-09-11T00:00:00Z" })], PROP, ACCOUNTS, 10);
    expect(r.eligible).toBe(false);
    expect(r.exclusion_reason).toBe(EXCLUSION.AFTER_BOUNDARY);
  });

  it("excludes a payment received after the boundary", () => {
    const [r] = classifyPayment([payment({ received_at: "2026-09-10T00:00:00Z" })], PROP, ACCOUNTS);
    expect(r.exclusion_reason).toBe(EXCLUSION.AFTER_BOUNDARY);
  });

  it("keeps a stay from before the boundary", () => {
    const [r] = classifyFolio([stay()], PROP, ACCOUNTS, 10);
    expect(r.eligible).toBe(true);
  });
});

describe("idempotency and duplicate prevention", () => {
  it("refuses a stay that already has its folio journal", () => {
    const [r] = classifyFolio([stay({ existing_entry_id: "aaaa" })], PROP, ACCOUNTS, 10);
    expect(r.eligible).toBe(false);
    expect(r.exclusion_reason).toBe(EXCLUSION.ALREADY_POSTED);
  });

  it("refuses a stay already posted under another source linkage", () => {
    const [r] = classifyFolio([stay({ other_linkage_entry_id: "bbbb" })], PROP, ACCOUNTS, 10);
    expect(r.exclusion_reason).toBe(EXCLUSION.POSTED_UNDER_OTHER_LINKAGE);
  });

  it("refuses a payment that already has its journal", () => {
    const [r] = classifyPayment([payment({ existing_entry_id: "cccc" })], PROP, ACCOUNTS);
    expect(r.exclusion_reason).toBe(EXCLUSION.ALREADY_POSTED);
  });

  it("refuses a payment already represented by a reversal entry", () => {
    const [r] = classifyPayment([payment({ reversal_entry_id: "dddd" })], PROP, ACCOUNTS);
    expect(r.exclusion_reason).toBe(EXCLUSION.POSTED_UNDER_OTHER_LINKAGE);
  });

  it("refuses an FX entry that has already been reversed", () => {
    const out = classifyFx([fxEntry({ already_reversed_by: "eeee" })], PROP);
    expect(out).toHaveLength(1);
    expect(out[0].exclusion_reason).toBe(EXCLUSION.ALREADY_POSTED);
  });

  it("is stable across reruns: classifying twice yields identical proposals", () => {
    const a = classifyFolio([stay()], PROP, ACCOUNTS, 10);
    const b = classifyFolio([stay()], PROP, ACCOUNTS, 10);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("carries the application's own idempotency key as source_ref", () => {
    const [r] = classifyFolio([stay()], PROP, ACCOUNTS, 10);
    expect(r.source_ref).toBe("11111111-1111-1111-1111-111111111111");
    const [p] = classifyPayment([payment()], PROP, ACCOUNTS);
    expect(p.source_ref).toBe("22222222-2222-2222-2222-222222222222");
  });
});

describe("fail closed on unexpected input", () => {
  it("refuses a reservation belonging to another property", () => {
    const [r] = classifyFolio([stay({ property_id: "99999999-9999-9999-9999-999999999999" })], PROP, ACCOUNTS, 10);
    expect(r.exclusion_reason).toBe(EXCLUSION.WRONG_PROPERTY);
  });

  it("refuses a payment whose reservation belongs to another property", () => {
    const [r] = classifyPayment([payment({ property_id: "99999999-9999-9999-9999-999999999999" })], PROP, ACCOUNTS);
    expect(r.exclusion_reason).toBe(EXCLUSION.WRONG_PROPERTY);
  });

  it("refuses an FX entry from another property", () => {
    const out = classifyFx([fxEntry({ property_id: "99999999-9999-9999-9999-999999999999" })], PROP);
    expect(out[0].exclusion_reason).toBe(EXCLUSION.WRONG_PROPERTY);
  });

  it("refuses when an account mapping is missing", () => {
    const [r] = classifyFolio([stay()], PROP, { ar: "acc-ar", tax_payable: "acc-tax" }, 10);
    expect(r.exclusion_reason).toBe(EXCLUSION.MISSING_ACCOUNT_MAPPING);
    expect(r.exclusion_detail).toContain("room_revenue");
  });

  it("refuses when the payment cash account is missing", () => {
    const [r] = classifyPayment([payment()], PROP, { ar: "acc-ar" });
    expect(r.exclusion_reason).toBe(EXCLUSION.MISSING_ACCOUNT_MAPPING);
  });

  it("refuses when the property has no STD tax code", () => {
    const [r] = classifyFolio([stay()], PROP, ACCOUNTS, null);
    expect(r.exclusion_reason).toBe(EXCLUSION.MISSING_TAX_CODE);
  });

  it("refuses a malformed source: no check-out date", () => {
    const [r] = classifyFolio([stay({ check_out: null })], PROP, ACCOUNTS, 10);
    expect(r.exclusion_reason).toBe(EXCLUSION.MISSING_BUSINESS_DATE);
  });

  it("refuses a malformed source: null amount", () => {
    const [r] = classifyFolio([stay({ rate_total: null })], PROP, ACCOUNTS, 10);
    expect(r.exclusion_reason).toBe(EXCLUSION.MISSING_AMOUNT);
  });

  it("refuses a zero-amount record rather than posting an empty journal", () => {
    const [r] = classifyFolio([stay({ rate_total: 0 })], PROP, ACCOUNTS, 10);
    expect(r.exclusion_reason).toBe(EXCLUSION.ZERO_OR_NEGATIVE_AMOUNT);
    const [p] = classifyPayment([payment({ amount: 0 })], PROP, ACCOUNTS);
    expect(p.exclusion_reason).toBe(EXCLUSION.ZERO_OR_NEGATIVE_AMOUNT);
  });

  it("refuses a negative amount", () => {
    const [r] = classifyFolio([stay({ rate_total: -100 })], PROP, ACCOUNTS, 10);
    expect(r.exclusion_reason).toBe(EXCLUSION.ZERO_OR_NEGATIVE_AMOUNT);
  });

  it("refuses a payment with no reservation linkage as ambiguous", () => {
    const [r] = classifyPayment([payment({ reservation_id: null })], PROP, ACCOUNTS);
    expect(r.exclusion_reason).toBe(EXCLUSION.AMBIGUOUS_SOURCE);
  });

  it("refuses an FX entry with no lines as ambiguous", () => {
    const out = classifyFx([fxEntry({ lines: [] })], PROP);
    expect(out[0].exclusion_reason).toBe(EXCLUSION.AMBIGUOUS_SOURCE);
  });

  it("refuses anything whose accounting period is locked or closed", () => {
    expect(classifyFolio([stay({ period_locked: true })], PROP, ACCOUNTS, 10)[0].exclusion_reason).toBe(EXCLUSION.PERIOD_LOCKED);
    expect(classifyPayment([payment({ period_locked: true })], PROP, ACCOUNTS)[0].exclusion_reason).toBe(EXCLUSION.PERIOD_LOCKED);
    expect(classifyFx([fxEntry({ period_locked: true })], PROP)[0].exclusion_reason).toBe(EXCLUSION.PERIOD_LOCKED);
  });
});

describe("currency is always the property's own, never a literal", () => {
  it("uses base_currency on every proposal", () => {
    const f = classifyFolio([stay()], PROP, ACCOUNTS, 10)[0];
    const p = classifyPayment([payment()], PROP, ACCOUNTS)[0];
    const x = classifyFx([fxEntry()], PROP);
    expect(f.currency).toBe("GHS");
    expect(p.currency).toBe("GHS");
    expect(x[0].currency).toBe("GHS");
    expect(x[1].currency).toBe("GHS");
  });

  it("re-posts an FX entry in the property's currency, not its original USD label", () => {
    const [, replacement] = classifyFx([fxEntry()], PROP);
    expect(replacement.currency).toBe("GHS");
    expect(replacement.original_source ?? replacement.category).toBeDefined();
  });

  it("contains no hardcoded USD or GHS literal in the source", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/prod/reconcile-historical-journals.mjs", "utf8");
    const body = src.split(/\r?\n/).filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    expect(body).not.toMatch(/["']USD["']/);
    expect(body).not.toMatch(/["']GHS["']/);
  });
});

describe("balance enforcement", () => {
  it("derives the folio split exactly as the posting function does", () => {
    const { gross, net, tax } = deriveFolioSplit(550, 10);
    expect(gross).toBe(550);
    expect(net).toBe(500);
    expect(tax).toBe(50);
    expect(money4(net + tax)).toBe(gross);
  });

  it("rounds to 4dp, matching NUMERIC(18,4) and the function's ROUND(...,4)", () => {
    const { net } = deriveFolioSplit(333, 10);
    expect(net).toBe(302.7273);
  });

  it("every eligible folio proposal balances", () => {
    const rows = [stay({ rate_total: 333 }), stay({ id: "44444444-4444-4444-4444-444444444444", rate_total: 777 })];
    for (const r of classifyFolio(rows, PROP, ACCOUNTS, 10)) {
      expect(r.eligible).toBe(true);
      expect(r.total_debit).toBe(r.total_credit);
    }
  });

  it("every payment proposal balances", () => {
    const [p] = classifyPayment([payment({ amount: 123.45 })], PROP, ACCOUNTS);
    expect(p.total_debit).toBe(p.total_credit);
    expect(p.total_debit).toBe(123.45);
  });

  it("marks an unbalanced proposal ineligible rather than posting it", () => {
    const p = buildProposal({
      category: CATEGORY.FOLIO_OMISSION, sourceType: "reservation", sourceId: "x", sourceRef: "x",
      propertyId: PROP.id, propertyName: PROP.name, currency: "GHS", entryDate: "2026-08-01", memo: "m",
      lines: [{ account_id: "a", debit: 100, credit: 0 }, { account_id: "b", debit: 0, credit: 90 }],
    });
    expect(p.balanced).toBe(false);
    expect(p.eligible).toBe(false);
    expect(p.exclusion_reason).toBe(EXCLUSION.UNBALANCED);
  });

  it("refuses a zero-total proposal even if technically balanced", () => {
    const p = buildProposal({
      category: CATEGORY.FOLIO_OMISSION, sourceType: "reservation", sourceId: "x", sourceRef: "x",
      propertyId: PROP.id, propertyName: PROP.name, currency: "GHS", entryDate: "2026-08-01", memo: "m",
      lines: [{ account_id: "a", debit: 0, credit: 0 }],
    });
    expect(p.eligible).toBe(false);
  });
});

describe("FX correction is a reversal plus a replacement, never a rewrite", () => {
  it("emits exactly two proposals per affected entry", () => {
    const out = classifyFx([fxEntry()], PROP);
    expect(out).toHaveLength(2);
    expect(out[0].category).toBe(CATEGORY.FX_REVERSAL);
    expect(out[1].category).toBe(CATEGORY.FX_REPLACEMENT);
  });

  it("links the reversal to the original through is_reversal_of", () => {
    const [rev] = classifyFx([fxEntry()], PROP);
    expect(rev.is_reversal_of).toBe("33333333-3333-3333-3333-333333333333");
  });

  it("the reversal mirrors the ORIGINAL posted base amounts, so the pair nets to zero", () => {
    const [rev] = classifyFx([fxEntry()], PROP);
    expect(rev.total_debit).toBe(100);
    const arLine = rev.lines.find((l: any) => l.system_key === "ar");
    expect(arLine.credit).toBe(100);
    expect(arLine.debit).toBe(0);
  });

  it("the replacement posts the transaction amounts at rate 1", () => {
    const [, rep] = classifyFx([fxEntry()], PROP);
    expect(rep.total_debit).toBe(1000);
    const arLine = rep.lines.find((l: any) => l.system_key === "ar");
    expect(arLine.debit).toBe(1000);
  });

  it("records the understatement it corrects", () => {
    const [rev, rep] = classifyFx([fxEntry()], PROP);
    expect(rev.amount_actually_posted).toBe(100);
    expect(rev.amount_that_should_have_posted).toBe(1000);
    expect(rev.difference).toBe(900);
    expect(rep.difference).toBe(900);
  });

  it("refuses an entry whose ORIGINAL base amounts do not tie, rather than absorbing the residue", () => {
    // The ledger's own invariant is ROUND(sum_dr,2) <> ROUND(sum_cr,2) on the
    // TRANSACTION amounts, so an entry whose base side is off by a fraction
    // of a pesewa was accepted when it was written. A faithful reversal would
    // inherit that; where the difference lands is an accounting decision.
    const residue = fxEntry({
      lines: [
        { account_id: "acc-ar", system_key: "ar", debit: 500, credit: 0, debit_base: 0, credit_base: 50 },
        { account_id: "acc-rev", system_key: "room_revenue", debit: 0, credit: 454.5455, debit_base: 45.4546, credit_base: 0 },
        { account_id: "acc-tax", system_key: "tax_payable", debit: 0, credit: 45.4545, debit_base: 4.5455, credit_base: 0 },
      ],
    });
    const out = classifyFx([residue], PROP);
    expect(out).toHaveLength(1);
    expect(out[0].exclusion_reason).toBe(EXCLUSION.BASE_ROUNDING_RESIDUE);
    expect(out[0].exclusion_detail).toContain("0.0001");
  });

  it("excludes the replacement too when the reversal is refused", () => {
    const residue = fxEntry({
      lines: [
        { account_id: "acc-ar", system_key: "ar", debit: 500, credit: 0, debit_base: 0, credit_base: 50 },
        { account_id: "acc-rev", system_key: "room_revenue", debit: 0, credit: 500, debit_base: 50.0001, credit_base: 0 },
      ],
    });
    const out = classifyFx([residue], PROP);
    expect(out.every((p: any) => !p.eligible)).toBe(true);
    expect(out.some((p: any) => p.category === CATEGORY.FX_REPLACEMENT && p.eligible)).toBe(false);
  });

  it("preserves the original business date on both halves", () => {
    const out = classifyFx([fxEntry()], PROP);
    expect(out[0].entry_date).toBe("2026-08-12");
    expect(out[1].entry_date).toBe("2026-08-12");
  });

  it("preserves the original business source identifier", () => {
    const out = classifyFx([fxEntry()], PROP);
    expect(out[0].source_ref).toBe("11111111-1111-1111-1111-111111111111");
    expect(out[0].original_entry_id ?? out[0].is_reversal_of).toBe("33333333-3333-3333-3333-333333333333");
  });
});

describe("the tool cannot mutate anything", () => {
  it("contains no INSERT, UPDATE or DELETE statement", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/prod/reconcile-historical-journals.mjs", "utf8");
    const body = src.split(/\r?\n/).filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    expect(body).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(body).not.toMatch(/\bUPDATE\s+public\./i);
    expect(body).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("every SQL query it issues is a SELECT", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/prod/reconcile-historical-journals.mjs", "utf8");
    for (const m of src.matchAll(/query\(url, `([\s\S]*?)`\)/g)) {
      expect(m[1].trim().toUpperCase().startsWith("SELECT")).toBe(true);
    }
  });
});

describe("reporting hides nothing", () => {
  it("counts excluded records and groups them by reason", () => {
    const proposals = [
      ...classifyFolio([stay(), stay({ id: "55555555-5555-5555-5555-555555555555", rate_total: 0 })], PROP, ACCOUNTS, 10),
      ...classifyPayment([payment(), payment({ id: "66666666-6666-6666-6666-666666666666", existing_entry_id: "z" })], PROP, ACCOUNTS),
    ];
    const s = summarize(proposals);
    expect(s.total).toBe(4);
    expect(s.eligible).toBe(2);
    expect(s.excluded).toBe(2);
    expect(s.excluded_by_reason[EXCLUSION.ZERO_OR_NEGATIVE_AMOUNT]).toBe(1);
    expect(s.excluded_by_reason[EXCLUSION.ALREADY_POSTED]).toBe(1);
  });

  it("the summary balances across every category", () => {
    const proposals = [
      ...classifyFolio([stay()], PROP, ACCOUNTS, 10),
      ...classifyPayment([payment()], PROP, ACCOUNTS),
      ...classifyFx([fxEntry()], PROP),
    ];
    const s = summarize(proposals);
    expect(s.total_debit).toBe(s.total_credit);
  });
});

describe("value decoding", () => {
  it("decodes Supabase numeric objects", () => {
    expect(decodeNumeric({ Int: 13565000, Exp: -2 })).toBe(135650);
    expect(decodeNumeric(null)).toBeNull();
  });

  it("decodes Supabase uuid byte arrays", () => {
    const bytes = [0x9a, 0x10, 0x1d, 0x34, 0xb7, 0x24, 0x4e, 0x57, 0xb0, 0xeb, 0x71, 0xec, 0x5e, 0xca, 0xc1, 0x62];
    expect(decodeUuid(bytes)).toBe("9a101d34-b724-4e57-b0eb-71ec5ecac162");
  });

  it("money() and money4() round without binary drift", () => {
    expect(money(0.1 + 0.2)).toBe(0.3);
    expect(money4(1.00005)).toBe(1.0001);
  });

  it("exclude() preserves the record and records a reason", () => {
    const r = exclude({ source_id: "x" }, EXCLUSION.WRONG_PROPERTY, "detail");
    expect(r.eligible).toBe(false);
    expect(r.exclusion_reason).toBe(EXCLUSION.WRONG_PROPERTY);
    expect(r.exclusion_detail).toBe("detail");
    expect(r.source_id).toBe("x");
  });
});
