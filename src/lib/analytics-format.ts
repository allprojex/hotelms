// Shared formatting for the executive dashboard / executive report surface.
// Screen, print/PDF and scheduled-email exports all render through these helpers
// so a property's base currency is applied identically everywhere.
import { formatMoney, safeCurrencyCode } from "@/lib/accounting/domain";

export const EXEC_EMPTY = "—";

/** Resolve the report currency from a property's base_currency (falls back safely). */
export function execCurrency(baseCurrency: unknown): string {
  return safeCurrencyCode(baseCurrency);
}

/** Monetary KPI/table/tooltip value rendered in the property's base currency. */
export function execMoney(value: unknown, currency: unknown): string {
  const n = value == null || value === "" ? NaN : Number(value);
  if (!Number.isFinite(n)) return EXEC_EMPTY;
  return formatMoney(n, currency);
}

/** Non-monetary value (percentages, counts, nights) — never gets a currency symbol. */
export function execNumber(value: unknown, suffix = ""): string {
  const n = value == null || value === "" ? NaN : Number(value);
  if (!Number.isFinite(n)) return EXEC_EMPTY;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 }) + suffix;
}
