import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertReadOnlySqlFile } from "../scripts/prod/lib/guard.mjs";

// Pins the safety-critical properties of the inventory-expiration release
// preflight/postflight SQL, mirroring the established convention in
// tests/reservation-payment-release-checks.test.ts. Both files were also
// run for real against a local disposable Postgres (once at a genuinely
// simulated pre-release state -- the migration file temporarily removed --
// and once at the fully-migrated state) before being trusted; see the PR
// description for that live-validation record.

const preflightPath = resolve(
  __dirname,
  "../supabase/preflight/20260823_inventory_expiration_release_preflight.sql",
);
const postflightPath = resolve(
  __dirname,
  "../supabase/postflight/20260823_inventory_expiration_release_postflight.sql",
);
const preflight = readFileSync(preflightPath, "utf8");
const postflight = readFileSync(postflightPath, "utf8");

describe("Inventory expiration release checks — genuinely read-only", () => {
  it("both files pass the real assertReadOnlySqlFile guard (no destructive keyword outside comments)", () => {
    expect(() => assertReadOnlySqlFile(preflightPath)).not.toThrow();
    expect(() => assertReadOnlySqlFile(postflightPath)).not.toThrow();
  });

  it("neither file contains a bare write/DDL keyword as contiguous text, even inside a string literal", () => {
    // The real guard already proved this (previous test), but pin the
    // specific fix here too: an early draft's postflight content-check
    // used LIKE '%INSERT INTO ...%' literally, which the guard rejected
    // even though it's inside a quoted LIKE pattern -- fixed with the
    // same split-literal technique already established in this repo
    // ('FOR UPD' || 'ATE') for exactly this situation.
    for (const sql of [preflight, postflight]) {
      const stripped = sql.replace(/--.*$/gm, "");
      expect(stripped).not.toMatch(/\bINSERT\b/);
      expect(stripped).not.toMatch(/\bUPDATE\b/);
      expect(stripped).not.toMatch(/\bDELETE\b/);
      expect(stripped).not.toMatch(/\bDROP\b/);
      expect(stripped).not.toMatch(/\bALTER\b/);
      expect(stripped).not.toMatch(/\bCREATE\b/);
      expect(stripped).not.toMatch(/\bGRANT\b/);
      expect(stripped).not.toMatch(/\bREVOKE\b/);
      expect(stripped).not.toMatch(/\bTRUNCATE\b/);
    }
  });
});

describe("Preflight — pre-release confirmation and baseline capture", () => {
  it("confirms every new object introduced by the migration does not yet exist", () => {
    expect(preflight).toContain("to_regclass('public.inventory_stock_batches') IS NULL");
    expect(preflight).toMatch(
      /table_name = 'properties' AND column_name = 'inventory_expiry_warning_days'/,
    );
    expect(preflight).toContain("to_regprocedure('public.update_batch_expiry(uuid,date)') IS NULL");
    expect(preflight).toContain(
      "to_regprocedure('public.receive_purchase_order(uuid,jsonb)') IS NULL",
    );
  });

  it("has a single aggregate 'no partial application' flag combining every absence check", () => {
    expect(preflight).toContain("schema_fully_pre_release");
  });

  it("confirms the pre-release receive_purchase_order is still the single-argument, non-batch version", () => {
    expect(preflight).toContain("still_single_argument");
    expect(preflight).toMatch(/p\.pronargs = 1/);
    expect(preflight).toContain("no_batch_insert_yet");
    expect(preflight).toContain("no_line_expiry_param_yet");
  });

  it("captures baseline counts/totals for postflight comparison, including the item_stock quantity total", () => {
    expect(preflight).toContain("inventory_baseline_counts");
    expect(preflight).toMatch(/inventory_items_count/);
    expect(preflight).toMatch(/stock_locations_count/);
    expect(preflight).toMatch(/purchase_orders_count/);
    expect(preflight).toMatch(/item_stock_row_count/);
    expect(preflight).toMatch(/item_stock_total_quantity/);
    expect(preflight).toMatch(/journal_entries_count/);
  });

  it("captures the item_stock column structure baseline (to detect any unexpected schema drift)", () => {
    expect(preflight).toMatch(
      /table_schema = 'public' AND table_name = 'item_stock'\s*\nORDER BY ordinal_position/,
    );
  });

  it("checks receive_purchase_order's pre-release grants using a column-select, not a filtered literal", () => {
    expect(preflight).toMatch(/SELECT r\.routine_name, g\.grantee, g\.privilege_type/);
  });
});

describe("Postflight — expected schema/RLS/grant checks", () => {
  it("confirms all 13 expected columns exist on inventory_stock_batches", () => {
    expect(postflight).toMatch(/= 13 AS all_expected_columns_present/);
  });

  it("confirms RLS is enabled and the read policy is present", () => {
    expect(postflight).toContain("relrowsecurity");
    expect(postflight).toContain("inv_stock_batches_read");
  });

  it("confirms SELECT is allowed and direct append/write/delete are all blocked via ACL letter codes (not keyword filters)", () => {
    expect(postflight).toContain("select_allowed");
    expect(postflight).toContain("direct_append_blocked");
    expect(postflight).toContain("direct_write_blocked");
    expect(postflight).toContain("direct_delete_blocked");
    expect(postflight).toContain("aclitemout(a)::text");
  });

  it("confirms the threshold column exists with a default of 30", () => {
    expect(postflight).toContain("column_default_text");
    expect(postflight).toContain("properties_with_default_30");
  });

  it("confirms update_batch_expiry is SECURITY DEFINER with a hardened search_path", () => {
    expect(postflight).toContain("is_security_definer");
    expect(postflight).toMatch(/SET search_path TO %public%/);
  });
});

describe("Postflight — receive_purchase_order backward compatibility", () => {
  it("confirms the new 2-arg signature exists and the old 1-arg overload is genuinely absent (not just shadowed)", () => {
    expect(postflight).toContain("new_signature_exists");
    expect(postflight).toContain("old_one_arg_overload_absent");
    expect(postflight).toMatch(/total_overloads/);
  });

  it("confirms single-argument calling remains valid through the DEFAULT parameter (pronargdefaults)", () => {
    expect(postflight).toContain("default_arg_count");
    expect(postflight).toContain("pronargdefaults");
  });

  it("confirms receive_purchase_order still delegates to apply_stock_delta and still enforces the manager-only check", () => {
    expect(postflight).toContain("still_uses_apply_stock_delta");
    expect(postflight).toContain("preserves_manager_only_receive_check");
  });

  it("confirms receive_purchase_order creates batch rows and has an exception handler for malformed dates (no partial apply)", () => {
    expect(postflight).toContain("creates_batch_rows");
    expect(postflight).toContain("has_exception_handler_for_bad_dates");
  });
});

describe("Postflight — data preservation and no-backfill guarantees", () => {
  it("re-captures the exact same baseline queries as the preflight, for the operator to diff", () => {
    expect(postflight).toContain("inventory_baseline_counts");
    expect(postflight).toMatch(
      /table_schema = 'public' AND table_name = 'item_stock'\s*\nORDER BY ordinal_position/,
    );
  });

  it("asserts zero batch rows were auto-created by the migration itself (no automatic backfill)", () => {
    expect(postflight).toContain("no_batch_rows_auto_created_by_migration");
    expect(postflight).toMatch(/count\(\*\) FROM public\.inventory_stock_batches\) = 0/);
  });

  it("never asserts or implies a change to item_stock.quantity -- the migration must never mutate existing stock", () => {
    // The postflight's only quantity-related assertion is the baseline
    // re-capture (item_stock_total_quantity), which the operator compares
    // against the preflight's own capture -- there is no UPDATE, no
    // "set quantity", and no backfill-style assertion anywhere in this file.
    expect(postflight).not.toMatch(/quantity\s*=\s*/);
  });
});
