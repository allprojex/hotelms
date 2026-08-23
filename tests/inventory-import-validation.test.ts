import { describe, expect, it } from "vitest";
import {
  validateInventoryRow,
  validateInventoryImportBatch,
  normalizeHeaderKey,
  isBlankRow,
  isExampleRow,
  EXAMPLE_ROW,
  EXAMPLE_ROW_SKU,
  INVENTORY_TEMPLATE_COLUMNS,
  type ValidateInventoryRowContext,
} from "../src/lib/inventory/import-validation";

const emptyCtx: ValidateInventoryRowContext = {
  existingSkusLower: new Set(),
  validLocationNamesLower: new Set(["main store", "bar store"]),
};

describe("normalizeHeaderKey -- header alias resolution", () => {
  it("maps common natural-language headers to canonical column names", () => {
    expect(normalizeHeaderKey("Selling Price")).toBe("sale_price");
    expect(normalizeHeaderKey("selling-price")).toBe("sale_price");
    expect(normalizeHeaderKey("Reorder Point")).toBe("reorder_level");
    expect(normalizeHeaderKey("Qty")).toBe("opening_quantity");
    expect(normalizeHeaderKey("Expiration")).toBe("expiry_date");
    expect(normalizeHeaderKey("Stock Location")).toBe("location");
  });

  it("passes through the canonical name unchanged", () => {
    for (const c of INVENTORY_TEMPLATE_COLUMNS) {
      expect(normalizeHeaderKey(c)).toBe(c);
    }
  });
});

describe("isBlankRow / isExampleRow", () => {
  it("a row with every field empty is blank", () => {
    expect(isBlankRow({ name: "", sku: "  ", cost: null })).toBe(true);
  });

  it("a row with any non-empty field is not blank", () => {
    expect(isBlankRow({ name: "Soap", sku: "" })).toBe(false);
  });

  it("the shipped template EXAMPLE_ROW is detected as an example row", () => {
    expect(isExampleRow(EXAMPLE_ROW)).toBe(true);
  });

  it("is case-insensitive on the sentinel SKU", () => {
    expect(isExampleRow({ sku: "example-delete-me" })).toBe(true);
  });

  it("a real row is never misdetected as the example row", () => {
    expect(isExampleRow({ sku: "REAL-SKU-1", name: "Real item" })).toBe(false);
  });
});

describe("validateInventoryRow -- test 1: valid catalog-only row", () => {
  it("an item with only name+sku is valid, with no stock/batch fields set", () => {
    const r = validateInventoryRow({ name: "Bath Soap", sku: "SKU-1" }, 0, emptyCtx);
    expect(r.errors).toEqual([]);
    expect(r.parsed).toEqual({
      name: "Bath Soap", sku: "SKU-1", category: null, unit: null,
      cost: 0, salePrice: 0, reorderLevel: 0, location: null, openingQuantity: null, expiryDate: null,
    });
  });
});

describe("validateInventoryRow -- test 2: valid item + opening quantity", () => {
  it("quantity + a real location parses cleanly, expiry stays null", () => {
    const r = validateInventoryRow(
      { name: "Milk", sku: "SKU-2", opening_quantity: "50", location: "Main Store" },
      0, emptyCtx,
    );
    expect(r.errors).toEqual([]);
    expect(r.parsed?.openingQuantity).toBe(50);
    expect(r.parsed?.location).toBe("Main Store");
    expect(r.parsed?.expiryDate).toBeNull();
  });
});

describe("validateInventoryRow -- test 3: item + quantity + expiry", () => {
  it("a full row with all three parses cleanly", () => {
    const r = validateInventoryRow(
      { name: "Yogurt", sku: "SKU-3", opening_quantity: 10, location: "Bar Store", expiry_date: "2026-09-01" },
      0, emptyCtx,
    );
    expect(r.errors).toEqual([]);
    expect(r.parsed?.expiryDate).toBe("2026-09-01");
  });
});

describe("validateInventoryRow -- test 5: blank expiry is allowed", () => {
  it("quantity + location with no expiry_date value parses with expiryDate null, no error", () => {
    const r = validateInventoryRow(
      { name: "Coffee", sku: "SKU-5", opening_quantity: 20, location: "Main Store", expiry_date: "" },
      0, emptyCtx,
    );
    expect(r.errors).toEqual([]);
    expect(r.parsed?.expiryDate).toBeNull();
  });
});

describe("validateInventoryRow -- test 6: already-expired date is allowed (allow+warn policy)", () => {
  it("a past expiry_date does not produce a validation error", () => {
    const r = validateInventoryRow(
      { name: "Old Stock", sku: "SKU-6", opening_quantity: 5, location: "Main Store", expiry_date: "2020-01-01" },
      0, emptyCtx,
    );
    expect(r.errors).toEqual([]);
    expect(r.parsed?.expiryDate).toBe("2020-01-01");
  });

  it("accepts a real JS Date instance the same way (as XLSX date-formatted cells produce)", () => {
    const r = validateInventoryRow(
      { name: "Old Stock 2", sku: "SKU-6b", opening_quantity: 5, location: "Main Store", expiry_date: new Date(Date.UTC(2020, 0, 1)) },
      0, emptyCtx,
    );
    expect(r.errors).toEqual([]);
    expect(r.parsed?.expiryDate).toBe("2020-01-01");
  });
});

describe("validateInventoryRow -- test 7: invalid date formats are rejected, not guessed", () => {
  it.each(["01/09/2026", "09-01-2026", "next tuesday", "2026/09/01", "2026-13-40"])(
    "rejects %s rather than silently reinterpreting it",
    (bad) => {
      const r = validateInventoryRow(
        { name: "X", sku: "SKU-BADDATE", opening_quantity: 1, location: "Main Store", expiry_date: bad },
        0, emptyCtx,
      );
      expect(r.errors.some((e) => /expiry date/i.test(e))).toBe(true);
      expect(r.parsed).toBeNull();
    },
  );
});

describe("validateInventoryRow -- test 8: negative quantity rejected", () => {
  it("a negative opening_quantity is a hard error, not silently clamped to 0", () => {
    const r = validateInventoryRow({ name: "X", sku: "SKU-NEGQ", opening_quantity: -3, location: "Main Store" }, 0, emptyCtx);
    expect(r.errors.some((e) => /cannot be negative/i.test(e))).toBe(true);
    expect(r.parsed).toBeNull();
  });
});

describe("validateInventoryRow -- test 9: invalid/negative prices rejected", () => {
  it("negative cost is rejected", () => {
    const r = validateInventoryRow({ name: "X", sku: "SKU-NEGCOST", cost: -1 }, 0, emptyCtx);
    expect(r.errors.some((e) => /cost cannot be negative/i.test(e))).toBe(true);
  });
  it("negative sale_price is rejected", () => {
    const r = validateInventoryRow({ name: "X", sku: "SKU-NEGPRICE", sale_price: -1 }, 0, emptyCtx);
    expect(r.errors.some((e) => /selling price cannot be negative/i.test(e))).toBe(true);
  });
  it("a malformed (non-numeric) cost is rejected, not coerced to 0", () => {
    const r = validateInventoryRow({ name: "X", sku: "SKU-BADCOST", cost: "abc" }, 0, emptyCtx);
    expect(r.errors.some((e) => /not a valid number/i.test(e))).toBe(true);
  });
});

describe("validateInventoryRow -- test 10: missing required fields", () => {
  it("blank name is rejected", () => {
    const r = validateInventoryRow({ name: "", sku: "SKU-NONAME" }, 0, emptyCtx);
    expect(r.errors.some((e) => /item name is required/i.test(e))).toBe(true);
  });
  it("blank sku is rejected (and never silently defaulted from the name)", () => {
    const r = validateInventoryRow({ name: "Has A Name", sku: "" }, 0, emptyCtx);
    expect(r.errors.some((e) => /sku is required/i.test(e))).toBe(true);
    expect(r.parsed).toBeNull();
  });
});

describe("validateInventoryRow -- test 14: invalid location rejected", () => {
  it("a location name that does not exist for this property is a hard error", () => {
    const r = validateInventoryRow({ name: "X", sku: "SKU-BADLOC", location: "Nowhere" }, 0, emptyCtx);
    expect(r.errors.some((e) => /unknown stock location/i.test(e))).toBe(true);
  });
});

describe("validateInventoryRow -- expiry-without-quantity/location and quantity-without-location", () => {
  it("expiry supplied without an opening quantity is rejected", () => {
    const r = validateInventoryRow({ name: "X", sku: "SKU-EXPNOQTY", expiry_date: "2026-09-01" }, 0, emptyCtx);
    expect(r.errors.some((e) => /expiry date supplied without/i.test(e))).toBe(true);
  });
  it("opening quantity supplied without a location is rejected", () => {
    const r = validateInventoryRow({ name: "X", sku: "SKU-QTYNOLOC", opening_quantity: 5 }, 0, emptyCtx);
    expect(r.errors.some((e) => /opening quantity supplied without/i.test(e))).toBe(true);
  });
});

describe("validateInventoryImportBatch -- test 11: duplicate SKU inside file", () => {
  it("the first occurrence stays valid, later occurrences are flagged as in-file duplicates and never re-imported as a second batch", () => {
    const result = validateInventoryImportBatch(
      [
        { name: "A", sku: "SKU-DUP", opening_quantity: 5, location: "Main Store" },
        { name: "A again", sku: "SKU-DUP", opening_quantity: 7, location: "Main Store" },
      ],
      emptyCtx,
    );
    expect(result.rows[0].isDuplicateInFile).toBe(false);
    expect(result.rows[1].isDuplicateInFile).toBe(true);
    expect(result.totals.duplicateInFile).toBe(1);
    expect(result.totals.valid).toBe(1);
  });

  it("SKU matching is case-insensitive", () => {
    const result = validateInventoryImportBatch(
      [{ name: "A", sku: "sku-x" }, { name: "B", sku: "SKU-X" }],
      emptyCtx,
    );
    expect(result.totals.duplicateInFile).toBe(1);
  });
});

describe("validateInventoryImportBatch -- test 12/13: existing-property vs cross-property duplicates", () => {
  it("a SKU that already exists in this property is flagged duplicateInProperty", () => {
    const ctx: ValidateInventoryRowContext = { existingSkusLower: new Set(["sku-existing"]), validLocationNamesLower: new Set() };
    const result = validateInventoryImportBatch([{ name: "X", sku: "SKU-EXISTING" }], ctx);
    expect(result.rows[0].isDuplicateInProperty).toBe(true);
    expect(result.totals.duplicateInProperty).toBe(1);
    expect(result.totals.valid).toBe(0);
  });

  it("the same SKU is NOT flagged when the existing-SKU set belongs to a different property (caller passes a property-scoped set)", () => {
    // existingSkusLower here represents "Property B"'s SKUs -- Property A's
    // import context would pass an empty/disjoint set for the same SKU.
    const propertyAContext: ValidateInventoryRowContext = { existingSkusLower: new Set(), validLocationNamesLower: new Set() };
    const result = validateInventoryImportBatch([{ name: "X", sku: "SKU-EXISTING" }], propertyAContext);
    expect(result.rows[0].isDuplicateInProperty).toBe(false);
    expect(result.totals.valid).toBe(1);
  });
});

describe("validateInventoryImportBatch -- test 15: cross-property location attempt", () => {
  it("a location that exists only in another property is invalid here (caller passes only this property's location set)", () => {
    const ctx: ValidateInventoryRowContext = { existingSkusLower: new Set(), validLocationNamesLower: new Set(["hotel store"]) };
    const result = validateInventoryImportBatch([{ name: "X", sku: "SKU-Y", location: "Bar Store" }], ctx);
    expect(result.rows[0].errors.some((e) => /unknown stock location/i.test(e))).toBe(true);
  });
});

describe("validateInventoryImportBatch -- example and blank rows are excluded from all counts", () => {
  it("an example row and a blank row are neither valid nor invalid", () => {
    const result = validateInventoryImportBatch(
      [EXAMPLE_ROW, {}, { name: "Real", sku: "SKU-REAL" }],
      emptyCtx,
    );
    expect(result.totals.example).toBe(1);
    expect(result.totals.blank).toBe(1);
    expect(result.totals.valid).toBe(1);
    expect(result.totals.invalid).toBe(0);
    expect(result.totals.total).toBe(3);
  });
});

describe("validateInventoryRow -- numeric overflow / oversized input safety", () => {
  it("an absurdly large opening_quantity is rejected client-side rather than reaching the DB as a numeric-overflow error", () => {
    const r = validateInventoryRow({ name: "X", sku: "SKU-HUGE", opening_quantity: "99999999999999", location: "Main Store" }, 0, emptyCtx);
    expect(r.errors.some((e) => /too large/i.test(e))).toBe(true);
  });

  it("an overly long item name is rejected rather than silently truncated", () => {
    const r = validateInventoryRow({ name: "x".repeat(500), sku: "SKU-LONGNAME" }, 0, emptyCtx);
    expect(r.errors.some((e) => /too long/i.test(e))).toBe(true);
  });
});

describe("validateInventoryRow -- HTML/script-like text is treated as plain text, never specially interpreted", () => {
  it("a name containing script-like content is accepted as ordinary text (rendering safety is the UI's job via React's default escaping, not this validator's)", () => {
    const r = validateInventoryRow({ name: "<script>alert(1)</script>", sku: "SKU-XSS" }, 0, emptyCtx);
    expect(r.errors).toEqual([]);
    expect(r.parsed?.name).toBe("<script>alert(1)</script>");
  });
});
