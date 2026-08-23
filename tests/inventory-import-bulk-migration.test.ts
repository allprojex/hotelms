import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Source-level checks on the whole-file-atomicity fix migration, mirroring
// the established convention in this repo (see
// tests/inventory-import-migration.test.ts) for pinning safety-critical SQL
// properties that live-database validation (run manually against a local
// disposable Postgres, see the PR description) already confirmed
// behaviorally.

const migration = readFileSync(
  resolve(__dirname, "../supabase/migrations/20260823160000_inventory_import_bulk_rpc.sql"),
  "utf8",
);
const perRowMigration = readFileSync(
  resolve(__dirname, "../supabase/migrations/20260823150000_inventory_import_rpc.sql"),
  "utf8",
);

describe("import_inventory_items — purely additive, the per-row helper is untouched", () => {
  it("this migration contains no DROP/TRUNCATE/ALTER at all -- it only adds one new function", () => {
    expect(migration).not.toMatch(/\bDROP\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration).not.toMatch(/\bALTER TABLE\b/i);
  });

  it("import_inventory_item() (singular, the per-row helper) is not modified by this migration and still exists in its own file unchanged", () => {
    expect(migration).not.toContain("CREATE OR REPLACE FUNCTION public.import_inventory_item(");
    expect(perRowMigration).toContain("CREATE OR REPLACE FUNCTION public.import_inventory_item(");
  });
});

describe("import_inventory_items — role check, hardening, grants", () => {
  it("requires an admin-tier role scoped to the target property before doing anything else", () => {
    expect(migration).toMatch(
      /IF NOT public\.has_any_role\(auth\.uid\(\), ARRAY\['super_admin','hotel_owner','general_manager'\]::app_role\[\], _property_id\) THEN/,
    );
  });

  it("is SECURITY DEFINER with a hardened search_path", () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.import_inventory_items[\s\S]{0,400}SECURITY DEFINER/,
    );
    expect(migration).toContain("SET search_path = public");
  });

  it("grants EXECUTE only to authenticated, after revoking from PUBLIC", () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.import_inventory_items\([\s\S]{0,60}\) FROM PUBLIC/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.import_inventory_items\([\s\S]{0,60}\) TO authenticated/,
    );
  });

  it("validates duplicate mode and rejects an empty/malformed row set", () => {
    expect(migration).toMatch(/_duplicate_mode NOT IN \('skip', 'reject'\)/);
    expect(migration).toMatch(
      /jsonb_typeof\(_rows\) <> 'array' OR jsonb_array_length\(_rows\) = 0/,
    );
  });
});

describe("import_inventory_items — reuses the per-row helper rather than duplicating its logic", () => {
  it("calls import_inventory_item() inside its loop, once per array element", () => {
    expect(migration).toMatch(
      /FOR _row IN SELECT \* FROM jsonb_array_elements\(_rows\)\s*\n\s*LOOP\s*\n\s*_result := public\.import_inventory_item\(/,
    );
  });

  it("never wraps the per-row call in its own BEGIN/EXCEPTION block -- an uncaught exception must propagate out and abort the WHOLE function/transaction, not just that one row", () => {
    const loopStart = migration.indexOf("FOR _row IN SELECT * FROM jsonb_array_elements(_rows)");
    const loopEnd = migration.indexOf("END LOOP;", loopStart);
    const loopBody = migration.slice(loopStart, loopEnd);
    expect(loopBody).not.toMatch(/EXCEPTION\s+WHEN/);
    expect(loopBody).not.toMatch(/\bBEGIN\b/); // no nested block that would create its own savepoint
  });

  it("a per-row skip (known duplicate) is a normal return value, not an exception -- so skip-mode rows commit together with the rest of the accepted set", () => {
    expect(migration).toMatch(/IF \(_result ->> 'skipped'\)::boolean THEN/);
  });
});

describe("import_inventory_items — reject mode mutates zero rows on rejection (checked BEFORE the mutation loop)", () => {
  it("the reject-mode duplicate pre-check appears strictly before the mutation loop, and raises before touching anything", () => {
    const rejectCheckIdx = migration.indexOf("_duplicate_mode = 'reject' THEN");
    const loopIdx = migration.indexOf("FOR _row IN SELECT * FROM jsonb_array_elements(_rows)");
    expect(rejectCheckIdx).toBeGreaterThan(-1);
    expect(rejectCheckIdx).toBeLessThan(loopIdx);
    const rejectBlock = migration.slice(rejectCheckIdx, loopIdx);
    expect(rejectBlock).toMatch(
      /RAISE EXCEPTION 'Import rejected: duplicate SKU\(s\) already exist in this property: %'/,
    );
  });

  it("checks ALL requested SKUs against existing inventory in one query, not row-by-row (avoids a partial reject-check)", () => {
    expect(migration).toMatch(
      /SELECT array_agg\(sku\) INTO _existing_skus\s*\n\s*FROM public\.inventory_items\s*\n\s*WHERE property_id = _property_id AND sku = ANY\(_requested_skus\)/,
    );
  });
});
