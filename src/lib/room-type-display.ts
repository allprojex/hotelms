import { formatMoney } from "@/lib/accounting/domain";

/**
 * Display helpers for the Room Types card.
 *
 * These exist as pure functions because the card's whole job is to render
 * values that may be absent or malformed, and the previous implementation got
 * that wrong in two visible ways: `Number(base_rate).toFixed(2)` printed
 * "NaN/night", and `{base_occupancy}/{max_occupancy}` printed a bare
 * "Occupancy /". Both are impossible here -- every entry point returns a
 * deliberate "not set" string instead.
 *
 * Note that formatMoney() coerces a non-finite amount to 0, so calling it
 * with a bad value would silently invent a price of zero. Every amount is
 * therefore validated by parseRateValue() BEFORE it reaches formatMoney, and
 * a value that fails validation never gets formatted at all.
 */

export const RATE_NOT_SET = "Rate not set";
export const OCCUPANCY_NOT_SET = "Occupancy not set";

/**
 * Narrows an untrusted rate to a finite, non-negative number.
 *
 * PostgREST returns NUMERIC as a JSON number, but a numeric string is also
 * accepted because that is a legitimate wire shape and callers should not
 * have to care. A negative rate is treated as missing rather than displayed:
 * it cannot be a real nightly price, and showing it would present bad data as
 * fact.
 */
export function parseRateValue(raw: unknown): number | null {
  if (raw === null || raw === undefined || typeof raw === "boolean") return null;
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/**
 * "GH₵300.00 / night" for a GHS property, "$300.00 / night" for an AUD one.
 * The currency always comes from the caller (the active property's
 * base_currency) -- nothing here has a default or a fallback symbol.
 */
export function formatRatePerNight(raw: unknown, currency: unknown): string {
  const value = parseRateValue(raw);
  if (value === null) return RATE_NOT_SET;
  return `${formatMoney(value, currency)} / night`;
}

/** Narrows an untrusted occupancy to a positive whole number of guests. */
export function parseOccupancyValue(raw: unknown): number | null {
  if (raw === null || raw === undefined || typeof raw === "boolean") return null;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * "Sleeps 2", or "Sleeps 2–4" when the base and maximum differ.
 *
 * The two values are ordered low-to-high rather than printed positionally.
 * Production genuinely contains a room type with base_occupancy 3 and
 * max_occupancy 2, which the old card rendered as "Occupancy 3/2" -- a
 * backwards range. Ordering them keeps the display truthful about the two
 * numbers stored without ever showing an inverted range; correcting the
 * underlying record is a data task, not a rendering one.
 */
export function formatOccupancy(base: unknown, max: unknown): string {
  const b = parseOccupancyValue(base);
  const m = parseOccupancyValue(max);
  if (b === null && m === null) return OCCUPANCY_NOT_SET;
  if (b === null || m === null) return `Sleeps ${b ?? m}`;
  const lo = Math.min(b, m);
  const hi = Math.max(b, m);
  return lo === hi ? `Sleeps ${hi}` : `Sleeps ${lo}–${hi}`;
}

/** "No photos" / "1 photo" / "4 photos". */
export function formatPhotoCount(count: unknown): string {
  const n = typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 0;
  if (n === 0) return "No photos";
  return n === 1 ? "1 photo" : `${n} photos`;
}
