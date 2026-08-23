import { describe, expect, it } from "vitest";
import {
  computeBatchStatus,
  BATCH_STATUS_LABEL,
  BATCH_STATUS_BADGE_VARIANT,
} from "../src/lib/inventory/batch-status";

const TODAY = new Date("2026-08-23T12:00:00Z");

describe("computeBatchStatus", () => {
  it("returns 'no_expiry' when expiryDate is null (blank expiry is a valid, permanent state)", () => {
    expect(computeBatchStatus(null, 30, TODAY)).toBe("no_expiry");
  });

  it("returns 'expired' for a date strictly in the past", () => {
    expect(computeBatchStatus("2026-08-22", 30, TODAY)).toBe("expired");
    expect(computeBatchStatus("2020-01-01", 30, TODAY)).toBe("expired");
  });

  it("returns 'expiring_soon' (not 'expired') for a date that is exactly today -- expiring today is urgent, not silently fine", () => {
    expect(computeBatchStatus("2026-08-23", 30, TODAY)).toBe("expiring_soon");
  });

  it("returns 'expiring_soon' when within the configurable warning window (inclusive, including day zero)", () => {
    expect(computeBatchStatus("2026-09-22", 30, TODAY)).toBe("expiring_soon"); // exactly 30 days out
    expect(computeBatchStatus("2026-08-24", 30, TODAY)).toBe("expiring_soon"); // 1 day out
    expect(computeBatchStatus("2026-08-23", 30, TODAY)).toBe("expiring_soon"); // 0 days out (expires today)
  });

  it("returns 'valid' just beyond the warning window", () => {
    expect(computeBatchStatus("2026-09-23", 30, TODAY)).toBe("valid"); // 31 days out
  });

  it("respects a different configured threshold (no hardcoded 30-day assumption)", () => {
    // Same date (10 days out), two different thresholds -> two different results.
    expect(computeBatchStatus("2026-09-02", 7, TODAY)).toBe("valid");
    expect(computeBatchStatus("2026-09-02", 14, TODAY)).toBe("expiring_soon");
  });

  it("has a distinct label and badge variant for all four statuses", () => {
    const statuses = ["expired", "expiring_soon", "valid", "no_expiry"] as const;
    for (const s of statuses) {
      expect(BATCH_STATUS_LABEL[s]).toBeTruthy();
      expect(BATCH_STATUS_BADGE_VARIANT[s]).toBeTruthy();
    }
    // Expired is visually the most severe -- destructive variant specifically.
    expect(BATCH_STATUS_BADGE_VARIANT.expired).toBe("destructive");
  });
});
