import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertReadOnlySqlFile, gitBlobSha256 } from "../scripts/prod/lib/guard.mjs";

// Pins the safety-critical properties of the Room Items release's
// preflight/postflight SQL and its local operator release plan, mirroring
// the established convention in tests/inventory-import-release-checks.test.ts.
// Both SQL files were also run for real against a local disposable
// Postgres (once at a genuinely simulated pre-release state -- the
// migration file temporarily removed -- and once at the fully-migrated
// state) before being trusted; see the PR description for that
// live-validation record.

const preflightPath = resolve(
  __dirname,
  "../supabase/preflight/20260823_room_items_release_preflight.sql",
);
const postflightPath = resolve(
  __dirname,
  "../supabase/postflight/20260823_room_items_release_postflight.sql",
);
const preflight = readFileSync(preflightPath, "utf8");
const postflight = readFileSync(postflightPath, "utf8");
const migrationRelPath = "supabase/migrations/20260823170000_reservation_item_distribution.sql";

const releasePlanPath = resolve(
  __dirname,
  "../scripts/prod/releases/2026-08-23-room-items-release.json",
);
interface RoomItemsReleasePlan {
  migration?: { relPath: string; approvedSha256: string };
  migrations?: unknown;
  preflight_sql?: string;
  postflight_sql?: string;
  historical_backfill_authorized?: boolean;
  financial_smoke_authorized?: boolean;
}
let releasePlan: RoomItemsReleasePlan | null = null;
try {
  releasePlan = JSON.parse(readFileSync(releasePlanPath, "utf8"));
} catch {
  releasePlan = null;
}
const describeIfPlanPresent = releasePlan ? describe : describe.skip;

describe("Room Items release checks — genuinely read-only", () => {
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

  it("the postflight's two FOR UPDATE content-checks use the established split-literal technique, not contiguous 'UPDATE' text", () => {
    // 3 occurrences: the two real content-check LIKE patterns, plus one
    // mention of the same technique in the file's own header comment.
    const occurrences = postflight.match(/FOR UPD' \|\| 'ATE/g) ?? [];
    expect(occurrences.length).toBe(3);
  });
});

describe("Preflight — pre-release confirmation and baseline capture", () => {
  it("confirms the table and all three RPCs do not yet exist", () => {
    expect(preflight).toContain("to_regclass('public.reservation_item_distributions') IS NULL");
    expect(preflight).toContain(
      "to_regprocedure('public.issue_reservation_item(uuid,uuid,uuid,numeric,uuid,text)') IS NULL",
    );
    expect(preflight).toContain(
      "to_regprocedure('public.return_reservation_item(uuid,numeric,uuid,text)') IS NULL",
    );
    expect(preflight).toContain(
      "to_regprocedure('public.adjust_reservation_item_distribution(uuid,numeric,text,text,uuid)') IS NULL",
    );
  });

  it("has a single aggregate 'no partial application' flag combining every absence check", () => {
    expect(preflight).toContain("schema_fully_pre_release");
  });

  it("captures reservation counts broken down by every status value", () => {
    expect(preflight).toContain("reservation_baseline_counts");
    expect(preflight).toMatch(/status = 'confirmed'/);
    expect(preflight).toMatch(/status = 'checked_in'/);
    expect(preflight).toMatch(/status = 'checked_out'/);
    expect(preflight).toMatch(/status = 'cancelled'/);
    expect(preflight).toMatch(/status = 'no_show'/);
  });

  it("captures every table this release must never touch: inventory, batches, and every financial table", () => {
    expect(preflight).toContain("inventory_and_financial_baseline_counts");
    expect(preflight).toMatch(/inventory_stock_batches_count/);
    expect(preflight).toMatch(/reservation_charges_count/);
    expect(preflight).toMatch(/payments_count/);
    expect(preflight).toMatch(/journal_entries_count/);
    expect(preflight).toMatch(/pos_orders_count/);
    expect(preflight).toMatch(/admin_action_logs_count/);
  });

  it("captures the item_stock and reservations schema baseline (to detect any unexpected schema drift)", () => {
    expect(preflight).toMatch(/table_name = 'item_stock'\s*\nORDER BY ordinal_position/);
    expect(preflight).toMatch(/table_name = 'reservations'\s*\nORDER BY ordinal_position/);
  });
});

describe("Postflight — table shape, RLS/ACL, and all three RPCs", () => {
  it("confirms all 15 expected columns exist, including request_id NOT NULL", () => {
    expect(postflight).toMatch(/= 15 AS all_expected_columns_present/);
    expect(postflight).toContain("request_id_not_null");
  });

  it("confirms UNIQUE(property_id, request_id) is present", () => {
    expect(postflight).toContain("unique_property_request_id_present");
    expect(postflight).toContain("UNIQUE (property_id, request_id)");
  });

  it("confirms RLS is enabled, the read policy is present, and direct append/write/delete are all blocked via ACL letter codes", () => {
    expect(postflight).toContain("relrowsecurity");
    expect(postflight).toMatch(
      /FROM pg_policies WHERE tablename = 'reservation_item_distributions'/,
    );
    expect(postflight).toContain("select_allowed");
    expect(postflight).toContain("direct_append_blocked");
    expect(postflight).toContain("direct_write_blocked");
    expect(postflight).toContain("direct_delete_blocked");
    expect(postflight).toContain("aclitemout(a)::text");
  });

  it("confirms issue_reservation_item: role check, checked_in-only rule, item/location property validation, row lock, floor check, apply_stock_delta, idempotency shape, audit", () => {
    expect(postflight).toContain("has_role_check");
    expect(postflight).toContain("checked_in_only_rule");
    expect(postflight).toContain("item_property_validated");
    expect(postflight).toContain("location_property_validated");
    expect(postflight).toContain("uses_row_lock");
    expect(postflight).toContain("has_floor_check");
    expect(postflight).toContain("uses_apply_stock_delta");
    expect(postflight).toContain("has_request_id_advisory_lock");
    expect(postflight).toContain("replay_returns_existing_id");
    expect(postflight).toContain("calls_audit_capture");
  });

  it("confirms return_reservation_item: locks the original issue row, outstanding-bounded, restores to the same item/location, idempotency shape, audit", () => {
    expect(postflight).toContain("locks_original_issue_row");
    expect(postflight).toContain("has_outstanding_check");
    expect(postflight).toContain("restores_to_same_item_location");
  });

  it("confirms adjust_reservation_item_distribution: narrower role set, mandatory reason, three directions, outstanding check, idempotency shape, audit", () => {
    expect(postflight).toContain("has_narrower_role_check");
    expect(postflight).toContain("reason_mandatory");
    expect(postflight).toContain("supports_three_directions");
  });
});

describe("Postflight — no billing/accounting side effect and full data preservation", () => {
  it("re-captures the exact same baseline queries as the preflight, for the operator to diff", () => {
    expect(postflight).toContain("reservation_baseline_counts");
    expect(postflight).toContain("inventory_and_financial_baseline_counts");
    expect(postflight).toMatch(/table_name = 'item_stock'\s*\nORDER BY ordinal_position/);
    expect(postflight).toMatch(/table_name = 'reservations'\s*\nORDER BY ordinal_position/);
  });

  it("asserts zero distribution rows were created by the migration itself (no test/backfill data)", () => {
    expect(postflight).toContain("no_distribution_rows_created_by_migration_itself");
    expect(postflight).toMatch(/count\(\*\) FROM public\.reservation_item_distributions\) = 0/);
  });

  it("never asserts or implies a change to item_stock.quantity, reservations, or any financial table -- the migration must never mutate existing data", () => {
    const stripped = postflight.replace(/--.*$/gm, "");
    expect(stripped).not.toMatch(/quantity\s*=\s*\d/);
  });

  it("excludes this feature's own audit entries from the admin_action_logs baseline comparison (a correct issue/return/adjustment call during UI verification would legitimately add rows) while still proving no OTHER table was touched", () => {
    expect(postflight).toContain("admin_action_logs_count_excluding_this_feature");
    expect(postflight).toMatch(/entity_type != 'reservation_item_distribution'/);
  });
});

describeIfPlanPresent(
  "Local release plan (scripts/prod/releases/2026-08-23-room-items-release.json)",
  () => {
    it("pins the pristine git-blob SHA256, matching what's actually committed at HEAD", () => {
      expect(releasePlan!.migration?.relPath).toBe(migrationRelPath);
      expect(releasePlan!.migration?.approvedSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(releasePlan!.migration?.approvedSha256).toBe(gitBlobSha256("HEAD", migrationRelPath));
    });

    it("points at the dedicated room-items preflight/postflight files", () => {
      expect(releasePlan!.preflight_sql).toBe(
        "supabase/preflight/20260823_room_items_release_preflight.sql",
      );
      expect(releasePlan!.postflight_sql).toBe(
        "supabase/postflight/20260823_room_items_release_postflight.sql",
      );
    });

    it("does not authorize historical backfill or financial smoke", () => {
      expect(releasePlan!.historical_backfill_authorized).toBe(false);
      expect(releasePlan!.financial_smoke_authorized).toBe(false);
    });
  },
);
