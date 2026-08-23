import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertReadOnlySqlFile, gitBlobSha256 } from "../scripts/prod/lib/guard.mjs";

// Pins the safety-critical properties of the inventory-import release's
// preflight/postflight SQL and its local operator release plan, mirroring
// the established convention in tests/inventory-expiration-release-checks.test.ts.
// Both SQL files were also run for real against a local disposable
// Postgres (once at a genuinely simulated pre-release state -- both
// migration files temporarily removed -- and once at the fully-migrated
// state) before being trusted; see the PR description for that
// live-validation record, including the one real postflight-check bug
// found and fixed during that process (a bare "NOT LIKE '%EXCEPTION%'"
// check that also matched the function's own legitimate top-level RAISE
// EXCEPTION statements -- fixed to check for "EXCEPTION WHEN" specifically).

const preflightPath = resolve(
  __dirname,
  "../supabase/preflight/20260823_inventory_import_release_preflight.sql",
);
const postflightPath = resolve(
  __dirname,
  "../supabase/postflight/20260823_inventory_import_release_postflight.sql",
);
const preflight = readFileSync(preflightPath, "utf8");
const postflight = readFileSync(postflightPath, "utf8");

const migration1Path = "supabase/migrations/20260823150000_inventory_import_rpc.sql";
const migration2Path = "supabase/migrations/20260823160000_inventory_import_bulk_rpc.sql";

// The release plan itself is local-only (gitignored, never committed --
// same policy as every other *-release.json in scripts/prod/releases/),
// so this test reads it directly off disk rather than importing it; if
// it's missing (e.g. a fresh clone with no release in flight), these
// specific tests are skipped rather than failing the whole suite.
const releasePlanPath = resolve(
  __dirname,
  "../scripts/prod/releases/2026-08-23-inventory-import-release.json",
);
interface InventoryImportReleasePlan {
  migration?: unknown;
  migrations?: { relPath: string; approvedSha256: string }[];
  preflight_sql?: string;
  postflight_sql?: string;
  historical_backfill_authorized?: boolean;
  financial_smoke_authorized?: boolean;
  xlsx_dependency_cve_followup?: { tracked?: boolean; installed_version?: string; note?: string };
}
let releasePlan: InventoryImportReleasePlan | null = null;
try {
  releasePlan = JSON.parse(readFileSync(releasePlanPath, "utf8"));
} catch {
  releasePlan = null;
}
const describeIfPlanPresent = releasePlan ? describe : describe.skip;

describe("Inventory import release checks — genuinely read-only", () => {
  it("both files pass the real assertReadOnlySqlFile guard (no destructive keyword outside comments)", () => {
    expect(() => assertReadOnlySqlFile(preflightPath)).not.toThrow();
    expect(() => assertReadOnlySqlFile(postflightPath)).not.toThrow();
  });

  it("neither file contains a bare write/DDL keyword as contiguous text, even inside a string literal", () => {
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
  it("confirms both new functions do not yet exist, and data_uploads.status is still pre-release", () => {
    expect(preflight).toContain(
      "to_regprocedure('public.import_inventory_item(uuid,text,text,text,text,numeric,numeric,numeric,text,numeric,date)') IS NULL",
    );
    expect(preflight).toContain(
      "to_regprocedure('public.import_inventory_items(uuid,jsonb,text)') IS NULL",
    );
    expect(preflight).toContain("status_check_still_pre_release");
  });

  it("has a single aggregate 'no partial application' flag combining every absence check", () => {
    expect(preflight).toContain("schema_fully_pre_release");
  });

  it("captures baseline counts for postflight comparison, including item_stock quantity and batch/upload counts", () => {
    expect(preflight).toContain("inventory_import_baseline_counts");
    expect(preflight).toMatch(/inventory_items_count/);
    expect(preflight).toMatch(/item_stock_row_count/);
    expect(preflight).toMatch(/item_stock_total_quantity/);
    expect(preflight).toMatch(/inventory_stock_batches_count/);
    expect(preflight).toMatch(/data_uploads_count/);
    expect(preflight).toMatch(/data_upload_rows_count/);
  });

  it("captures existing SKU and location facts without writing anything", () => {
    expect(preflight).toMatch(/FROM public\.inventory_items\s*\nORDER BY property_id, sku/);
    expect(preflight).toMatch(/FROM public\.stock_locations\s*\nORDER BY property_id, name/);
  });

  it("captures the existing inventory_items/item_stock schema baseline (to detect any unexpected schema drift)", () => {
    expect(preflight).toMatch(/table_name = 'inventory_items'\s*\nORDER BY ordinal_position/);
    expect(preflight).toMatch(/table_name = 'item_stock'\s*\nORDER BY ordinal_position/);
  });

  it("captures current RLS/policy baseline for the tables this release's functions touch", () => {
    expect(preflight).toContain("relrowsecurity");
    expect(preflight).toMatch(/FROM pg_policies/);
  });
});

describe("Postflight — both functions exist, hardened, correctly granted", () => {
  it("confirms import_inventory_item() is SECURITY DEFINER with a hardened search_path and authenticated-only EXECUTE", () => {
    expect(postflight).toContain("import_inventory_item_definition");
    expect(postflight).toContain("is_security_definer");
    expect(postflight).toMatch(/SET search_path TO %public%/);
  });

  it("confirms import_inventory_items() is SECURITY DEFINER with a hardened search_path and authenticated-only EXECUTE", () => {
    expect(postflight).toContain("import_inventory_items_definition");
  });

  it("confirms import_inventory_item's role/property check, duplicate-safety, property-scoped location, apply_stock_delta usage, and conditional batch creation", () => {
    expect(postflight).toContain("has_role_and_property_check");
    expect(postflight).toContain("is_duplicate_safe");
    expect(postflight).toContain("location_is_property_scoped");
    expect(postflight).toContain("uses_apply_stock_delta");
    expect(postflight).toContain("creates_batch_rows_when_applicable");
  });

  it("confirms expiry is isolated to the inventory_stock_batches INSERT -- never present in inventory_items' own column list", () => {
    expect(postflight).toContain("inventory_items_insert_has_no_expiry_column");
  });
});

describe("Postflight — bulk atomicity markers (whole-file rollback verification)", () => {
  it("confirms the bulk RPC accepts JSONB input and has both a reject-mode precheck and a skip-mode path", () => {
    expect(postflight).toContain("accepts_bulk_jsonb_input");
    expect(postflight).toContain("has_reject_mode_precheck");
    expect(postflight).toContain("has_skip_mode_path");
  });

  it("confirms the bulk RPC calls the per-row helper rather than duplicating its logic", () => {
    expect(postflight).toContain("calls_the_row_helper");
  });

  it("confirms no per-row EXCEPTION WHEN catch block exists -- this is the actual whole-file-rollback guarantee", () => {
    expect(postflight).toContain("no_per_row_exception_handler");
    expect(postflight).toContain("EXCEPTION WHEN");
  });
});

describe("Postflight — data_uploads.status widened correctly", () => {
  it("confirms 'processing' is now allowed and every pre-release status value is preserved", () => {
    expect(postflight).toContain("processing_now_allowed");
    expect(postflight).toContain("pending_preserved");
    expect(postflight).toContain("approved_preserved");
    expect(postflight).toContain("rejected_preserved");
    expect(postflight).toContain("imported_preserved");
  });
});

describe("Postflight — data preservation and no-backfill guarantees", () => {
  it("re-captures the exact same baseline queries as the preflight, for the operator to diff", () => {
    expect(postflight).toContain("inventory_import_baseline_counts");
    expect(postflight).toMatch(/table_name = 'inventory_items'\s*\nORDER BY ordinal_position/);
    expect(postflight).toMatch(/table_name = 'item_stock'\s*\nORDER BY ordinal_position/);
  });

  it("asserts zero import-created batch rows and zero upload rows exist from the migrations themselves (no automatic backfill)", () => {
    expect(postflight).toContain("no_import_created_batches_from_the_migration_itself");
    expect(postflight).toContain("no_upload_rows_created_by_the_migration_itself");
  });

  it("never asserts or implies a change to item_stock.quantity -- the migrations must never mutate existing stock", () => {
    expect(postflight).not.toMatch(/quantity\s*=\s*/);
  });

  it("re-captures the same RLS/policy tables as the preflight for a diff, and never issues a policy/grant statement itself (outside explanatory comments)", () => {
    expect(postflight).toMatch(/FROM pg_policies/);
    const stripped = postflight.replace(/--.*$/gm, "");
    expect(stripped).not.toMatch(/\bGRANT\b/);
  });
});

describeIfPlanPresent(
  "Local release plan (scripts/prod/releases/2026-08-23-inventory-import-release.json)",
  () => {
    it("declares both migrations, in the correct chronological order, via the plural migrations[] path", () => {
      expect(Array.isArray(releasePlan.migrations)).toBe(true);
      expect(releasePlan.migrations).toHaveLength(2);
      expect(releasePlan.migrations[0].relPath).toBe(migration1Path);
      expect(releasePlan.migrations[1].relPath).toBe(migration2Path);
      expect(releasePlan.migration).toBeUndefined(); // the plural form only, never both
    });

    it("pins the pristine git-blob SHA256 for each migration, matching what's actually committed at HEAD", () => {
      for (const [relPath, entry] of [
        [migration1Path, releasePlan.migrations[0]],
        [migration2Path, releasePlan.migrations[1]],
      ] as const) {
        expect(entry.approvedSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(entry.approvedSha256).toBe(gitBlobSha256("HEAD", relPath));
      }
    });

    it("points at the dedicated inventory-import preflight/postflight files", () => {
      expect(releasePlan.preflight_sql).toBe(
        "supabase/preflight/20260823_inventory_import_release_preflight.sql",
      );
      expect(releasePlan.postflight_sql).toBe(
        "supabase/postflight/20260823_inventory_import_release_postflight.sql",
      );
    });

    it("does not authorize historical backfill or financial smoke", () => {
      expect(releasePlan.historical_backfill_authorized).toBe(false);
      expect(releasePlan.financial_smoke_authorized).toBe(false);
    });

    it("records the xlsx CVE follow-up as a separately tracked item, without claiming the 10MB cap fixes it", () => {
      expect(releasePlan.xlsx_dependency_cve_followup?.tracked).toBe(true);
      expect(releasePlan.xlsx_dependency_cve_followup?.installed_version).toBe("0.18.5");
      const note = String(releasePlan.xlsx_dependency_cve_followup?.note ?? "");
      expect(note).not.toMatch(/10\s*MB\s*cap\s*(fixes|mitigates|resolves|patches)/i);
    });
  },
);
