// Pure, DOM-free validation/normalization for the Inventory CSV/XLSX
// importer (src/routes/_authenticated/admin_.uploads.tsx). Kept separate
// from the route so it can be unit-tested directly and reused by both the
// live Preview (client-side, read-only) and — if ever needed — a
// server-side re-check, without duplicating the rules in two places.
//
// This module never talks to the network or Supabase; it only knows about
// plain JS values and the two lookup sets (existing SKUs, valid location
// names) the caller must supply after its own read-only queries.

export const INVENTORY_TEMPLATE_COLUMNS = [
  "name",
  "sku",
  "category",
  "unit",
  "cost",
  "sale_price",
  "reorder_level",
  "location",
  "opening_quantity",
  "expiry_date",
] as const;

// A template example/instruction row. Its SKU is the sentinel isExampleRow()
// checks for, so even if a user forgets to delete this row before
// uploading, it can never be imported as real stock.
export const EXAMPLE_ROW_SKU = "EXAMPLE-DELETE-ME";
export const EXAMPLE_ROW: Record<string, string | number> = {
  name: "DELETE THIS ROW — EXAMPLE ONLY",
  sku: EXAMPLE_ROW_SKU,
  category: "Beverages",
  unit: "each",
  cost: 1.5,
  sale_price: 3,
  reorder_level: 10,
  location: "Main Store",
  opening_quantity: 24,
  expiry_date: "2026-12-31",
};

const MAX_MONEY = 1e10; // comfortably below NUMERIC(12,2)'s ~1e10 limit
const MAX_QUANTITY = 1e11; // comfortably below NUMERIC(14,3)'s ~1e11 limit
const MAX_TEXT_LENGTH = 200;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Known header aliases -> canonical column name. Headers are matched after
// trimming, lowercasing, and collapsing whitespace/dashes to underscores,
// so "Selling Price", "selling-price", and "sale_price" all resolve the
// same way.
const HEADER_ALIASES: Record<string, string> = {
  name: "name",
  item: "name",
  item_name: "name",
  sku: "sku",
  code: "sku",
  category: "category",
  unit: "unit",
  uom: "unit",
  cost: "cost",
  cost_price: "cost",
  price: "sale_price",
  sale_price: "sale_price",
  selling_price: "sale_price",
  reorder_level: "reorder_level",
  reorder_point: "reorder_level",
  reorder: "reorder_level",
  location: "location",
  stock_location: "location",
  opening_quantity: "opening_quantity",
  opening_qty: "opening_quantity",
  quantity: "opening_quantity",
  qty: "opening_quantity",
  expiry_date: "expiry_date",
  expiry: "expiry_date",
  expiration: "expiry_date",
  expiration_date: "expiry_date",
};

export function normalizeHeaderKey(key: string): string {
  const cleaned = String(key ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return HEADER_ALIASES[cleaned] ?? cleaned;
}

// Re-keys a raw parsed row (whatever headers the sheet actually had) onto
// canonical column names, so downstream validation never has to guess at
// header spelling variants.
export function normalizeRowKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[normalizeHeaderKey(k)] = v;
  }
  return out;
}

export function isBlankRow(raw: Record<string, unknown>): boolean {
  return Object.values(raw).every((v) => v === null || v === undefined || String(v).trim() === "");
}

export function isExampleRow(raw: Record<string, unknown>): boolean {
  const normalized = normalizeRowKeys(raw);
  const sku = String(normalized.sku ?? "")
    .trim()
    .toUpperCase();
  return sku === EXAMPLE_ROW_SKU;
}

type NumberResult = { ok: true; value: number } | { ok: false; error: string };

function parseRequiredText(
  raw: unknown,
  label: string,
  maxLen = MAX_TEXT_LENGTH,
): { ok: true; value: string } | { ok: false; error: string } {
  const s = raw === null || raw === undefined ? "" : String(raw).trim();
  if (!s) return { ok: false, error: `${label} is required` };
  if (s.length > maxLen)
    return { ok: false, error: `${label} is too long (max ${maxLen} characters)` };
  return { ok: true, value: s };
}

function parseOptionalText(
  raw: unknown,
  label: string,
  maxLen = MAX_TEXT_LENGTH,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const s = raw === null || raw === undefined ? "" : String(raw).trim();
  if (!s) return { ok: true, value: null };
  if (s.length > maxLen)
    return { ok: false, error: `${label} is too long (max ${maxLen} characters)` };
  return { ok: true, value: s };
}

function parseMoney(
  raw: unknown,
  label: string,
  { allowBlank }: { allowBlank: boolean },
): NumberResult {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    if (allowBlank) return { ok: true, value: 0 };
    return { ok: false, error: `${label} is required` };
  }
  const s = String(raw).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s))
    return { ok: false, error: `${label} is not a valid number: "${s}"` };
  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, error: `${label} is not a valid number: "${s}"` };
  if (Math.abs(n) >= MAX_MONEY) return { ok: false, error: `${label} is too large: "${s}"` };
  if (n < 0) return { ok: false, error: `${label} cannot be negative` };
  return { ok: true, value: n };
}

function parseOpeningQuantity(
  raw: unknown,
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined || String(raw).trim() === "")
    return { ok: true, value: null };
  const s = String(raw).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s))
    return { ok: false, error: `Opening quantity is not a valid number: "${s}"` };
  const n = Number(s);
  if (!Number.isFinite(n))
    return { ok: false, error: `Opening quantity is not a valid number: "${s}"` };
  if (Math.abs(n) >= MAX_QUANTITY)
    return { ok: false, error: `Opening quantity is too large: "${s}"` };
  if (n < 0) return { ok: false, error: `Opening quantity cannot be negative` };
  return { ok: true, value: n };
}

// Deliberately strict: only a real JS Date (from an XLSX date-formatted
// cell) or an unambiguous ISO yyyy-mm-dd string is accepted. Anything else
// (MM/DD/YYYY, DD/MM/YYYY, "next Tuesday", ...) is rejected rather than
// guessed — a wrong guess here would silently corrupt an expiry date.
function parseExpiryDate(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined || String(raw).trim() === "")
    return { ok: true, value: null };
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return { ok: false, error: "Expiry date is invalid" };
    const y = raw.getFullYear();
    const m = String(raw.getMonth() + 1).padStart(2, "0");
    const d = String(raw.getDate()).padStart(2, "0");
    return { ok: true, value: `${y}-${m}-${d}` };
  }
  const s = String(raw).trim();
  if (!ISO_DATE_RE.test(s)) {
    return { ok: false, error: `Expiry date must be in YYYY-MM-DD format: "${s}"` };
  }
  const d = new Date(`${s}T00:00:00Z`);
  const [y, m, day] = s.split("-").map(Number);
  if (
    Number.isNaN(d.getTime()) ||
    d.getUTCFullYear() !== y ||
    d.getUTCMonth() + 1 !== m ||
    d.getUTCDate() !== day
  ) {
    return { ok: false, error: `Expiry date is not a real calendar date: "${s}"` };
  }
  return { ok: true, value: s };
}

export interface ParsedInventoryRow {
  name: string;
  sku: string;
  category: string | null;
  unit: string | null;
  cost: number;
  salePrice: number;
  reorderLevel: number;
  location: string | null;
  openingQuantity: number | null;
  expiryDate: string | null;
}

export interface InventoryRowValidation {
  index: number;
  raw: Record<string, unknown>;
  parsed: ParsedInventoryRow | null;
  errors: string[];
  isBlank: boolean;
  isExample: boolean;
  isDuplicateInFile: boolean;
  isDuplicateInProperty: boolean;
}

export interface ValidateInventoryRowContext {
  existingSkusLower: Set<string>;
  validLocationNamesLower: Set<string>;
}

export function validateInventoryRow(
  rawInput: Record<string, unknown>,
  index: number,
  ctx: ValidateInventoryRowContext,
): InventoryRowValidation {
  const raw = normalizeRowKeys(rawInput);
  const base: InventoryRowValidation = {
    index,
    raw: rawInput,
    parsed: null,
    errors: [],
    isBlank: isBlankRow(rawInput),
    isExample: isExampleRow(rawInput),
    isDuplicateInFile: false,
    isDuplicateInProperty: false,
  };
  if (base.isBlank || base.isExample) return base;

  const errors: string[] = [];

  const name = parseRequiredText(raw.name, "Item name");
  if (!name.ok) errors.push(name.error);

  const sku = parseRequiredText(raw.sku, "SKU", 64);
  if (!sku.ok) errors.push(sku.error);

  const category = parseOptionalText(raw.category, "Category", 100);
  if (!category.ok) errors.push(category.error);

  const unit = parseOptionalText(raw.unit, "Unit", 32);
  if (!unit.ok) errors.push(unit.error);

  const cost = parseMoney(raw.cost, "Cost", { allowBlank: true });
  if (!cost.ok) errors.push(cost.error);

  const salePrice = parseMoney(raw.sale_price, "Selling price", { allowBlank: true });
  if (!salePrice.ok) errors.push(salePrice.error);

  const reorderLevel = parseMoney(raw.reorder_level, "Reorder level", { allowBlank: true });
  if (!reorderLevel.ok) errors.push(reorderLevel.error);

  const location = parseOptionalText(raw.location, "Location", 100);
  if (!location.ok) errors.push(location.error);
  else if (location.value && !ctx.validLocationNamesLower.has(location.value.toLowerCase())) {
    errors.push(`Unknown stock location: "${location.value}"`);
  }

  const openingQuantity = parseOpeningQuantity(raw.opening_quantity);
  if (!openingQuantity.ok) errors.push(openingQuantity.error);

  const expiryDate = parseExpiryDate(raw.expiry_date);
  if (!expiryDate.ok) errors.push(expiryDate.error);

  // Cross-field rules (only meaningful once the individual fields parsed).
  if (openingQuantity.ok && location.ok) {
    const qty = openingQuantity.value;
    if (qty !== null && qty > 0 && !location.value) {
      errors.push("Opening quantity supplied without a stock location");
    }
  }
  if (expiryDate.ok && openingQuantity.ok && location.ok) {
    const qty = openingQuantity.value;
    if (expiryDate.value && (!qty || qty <= 0 || !location.value)) {
      errors.push("Expiry date supplied without an opening quantity and stock location");
    }
  }

  if (sku.ok && ctx.existingSkusLower.has(sku.value.toLowerCase())) {
    base.isDuplicateInProperty = true;
  }

  base.errors = errors;
  if (
    errors.length === 0 &&
    name.ok &&
    sku.ok &&
    category.ok &&
    unit.ok &&
    cost.ok &&
    salePrice.ok &&
    reorderLevel.ok &&
    location.ok &&
    openingQuantity.ok &&
    expiryDate.ok
  ) {
    base.parsed = {
      name: name.value,
      sku: sku.value,
      category: category.value,
      unit: unit.value,
      cost: cost.value,
      salePrice: salePrice.value,
      reorderLevel: reorderLevel.value,
      location: location.value,
      openingQuantity: openingQuantity.value,
      expiryDate: expiryDate.value,
    };
  }
  return base;
}

export interface InventoryImportBatchResult {
  rows: InventoryRowValidation[];
  totals: {
    total: number;
    blank: number;
    example: number;
    valid: number;
    invalid: number;
    duplicateInFile: number;
    duplicateInProperty: number;
  };
}

// Runs validateInventoryRow over every row, then a second pass to flag
// in-file duplicate SKUs: the FIRST occurrence of a SKU is left as
// otherwise-valid, every later occurrence is flagged as a duplicate (never
// imported), mirroring the existing within-file dedup convention already
// used for the other upload targets in this same admin page.
export function validateInventoryImportBatch(
  rawRows: Record<string, unknown>[],
  ctx: ValidateInventoryRowContext,
): InventoryImportBatchResult {
  const rows = rawRows.map((r, i) => validateInventoryRow(r, i, ctx));
  const seenSkus = new Set<string>();
  for (const row of rows) {
    if (row.isBlank || row.isExample || !row.parsed) continue;
    const key = row.parsed.sku.toLowerCase();
    if (seenSkus.has(key)) {
      row.isDuplicateInFile = true;
    } else {
      seenSkus.add(key);
    }
  }

  const totals = {
    total: rows.length,
    blank: rows.filter((r) => r.isBlank).length,
    example: rows.filter((r) => r.isExample).length,
    duplicateInFile: rows.filter((r) => r.isDuplicateInFile).length,
    duplicateInProperty: rows.filter((r) => !r.isDuplicateInFile && r.isDuplicateInProperty).length,
    valid: 0,
    invalid: 0,
  };
  totals.valid = rows.filter(
    (r) =>
      !r.isBlank &&
      !r.isExample &&
      !r.isDuplicateInFile &&
      !r.isDuplicateInProperty &&
      r.parsed &&
      r.errors.length === 0,
  ).length;
  totals.invalid = rows.filter(
    (r) => !r.isBlank && !r.isExample && (r.errors.length > 0 || !r.parsed),
  ).length;

  return { rows, totals };
}
