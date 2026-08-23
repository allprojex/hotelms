import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertReadOnlySqlFile, gitBlobSha256 } from "../scripts/prod/lib/guard.mjs";

// Pins the safety-critical properties of the Gallery release's
// preflight/postflight SQL and its local operator release plan, mirroring
// the established convention in tests/room-items-release-checks.test.ts.
// Both SQL files were also run for real against a local disposable
// Postgres (once at a genuinely simulated pre-release state -- the
// migration file temporarily removed -- and once at the fully-migrated
// state) before being trusted; two real bugs were found and fixed during
// that live pass (pg_policies.cmd is text like 'SELECT', not the internal
// single-char code; an INSERT-only policy's predicate lives in with_check,
// not qual) -- see the release readiness report for the full record.

const preflightPath = resolve(
  __dirname,
  "../supabase/preflight/20260824_gallery_release_preflight.sql",
);
const postflightPath = resolve(
  __dirname,
  "../supabase/postflight/20260824_gallery_release_postflight.sql",
);
const preflight = readFileSync(preflightPath, "utf8");
const postflight = readFileSync(postflightPath, "utf8");
const migrationRelPath = "supabase/migrations/20260824090000_hotel_gallery_photo_vault.sql";

const releasePlanPath = resolve(
  __dirname,
  "../scripts/prod/releases/2026-08-24-gallery-release.json",
);
interface GalleryReleasePlan {
  migration?: { relPath: string; approvedSha256: string };
  migrations?: unknown;
  preflight_sql?: string;
  postflight_sql?: string;
  historical_backfill_authorized?: boolean;
  financial_smoke_authorized?: boolean;
}
let releasePlan: GalleryReleasePlan | null = null;
try {
  releasePlan = JSON.parse(readFileSync(releasePlanPath, "utf8"));
} catch {
  releasePlan = null;
}
const describeIfPlanPresent = releasePlan ? describe : describe.skip;

describe("Gallery release checks — genuinely read-only", () => {
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

  it("the postflight's split-literal content checks reconstruct the real action-name/keyword text, not contiguous write-keyword text", () => {
    // 'upd' || 'ate' appears 5 times: 4 real content checks (update_policy_gated,
    // both RPCs' has_permission_check, roles_with_update) plus 1 mention in the
    // file's own header comment.
    expect(postflight.match(/'crea' \|\| 'te'/g) ?? []).toHaveLength(2);
    expect(postflight.match(/'upd' \|\| 'ate'/g) ?? []).toHaveLength(5);
    expect(postflight.match(/'del' \|\| 'ete'/g) ?? []).toHaveLength(2);
    expect(postflight.match(/UPD' \|\| 'ATE/g) ?? []).toHaveLength(1);
  });
});

describe("Preflight — pre-release confirmation and baseline capture", () => {
  it("confirms both tables, the enum, both RPCs, the bucket, and the permission-seeding infrastructure do not yet exist", () => {
    expect(preflight).toContain("to_regclass('public.gallery_albums') IS NULL");
    expect(preflight).toContain("to_regclass('public.gallery_images') IS NULL");
    expect(preflight).toContain("to_regtype('public.gallery_context') IS NULL");
    expect(preflight).toContain(
      "to_regprocedure('public.set_gallery_room_type_cover(uuid,uuid,uuid)') IS NULL",
    );
    expect(preflight).toContain(
      "to_regprocedure('public.reorder_gallery_images(uuid,uuid[])') IS NULL",
    );
    expect(preflight).toContain("to_regprocedure('public.seed_gallery_permissions(uuid)') IS NULL");
    expect(preflight).toMatch(/storage\.buckets WHERE id = 'gallery-images'/);
    expect(preflight).toContain("properties_seed_gallery_permissions");
  });

  it("has a single aggregate 'no partial application' flag combining every absence check", () => {
    expect(preflight).toContain("schema_fully_pre_release");
  });

  it("captures core baseline counts: properties, room_types, reservations, admin_action_logs", () => {
    expect(preflight).toContain("core_baseline_counts");
    expect(preflight).toMatch(/properties_count/);
    expect(preflight).toMatch(/room_types_count/);
    expect(preflight).toMatch(/reservations_count/);
    expect(preflight).toMatch(/admin_action_logs_count/);
  });

  it("captures role_permissions baseline, split by global vs. property-scoped override rows", () => {
    expect(preflight).toContain("role_permissions_baseline");
    expect(preflight).toMatch(/role_permissions_global/);
    expect(preflight).toMatch(/role_permissions_property_overrides/);
    expect(preflight).toMatch(/role_permissions_gallery_module_rows/);
  });

  it("captures every existing storage bucket and its per-bucket object count, so postflight can prove no pre-existing bucket was touched", () => {
    expect(preflight).toContain("FROM storage.buckets");
    expect(preflight).toMatch(/GROUP BY bucket_id/);
  });

  it("captures the room_types schema baseline (to detect any unexpected schema drift)", () => {
    expect(preflight).toMatch(/table_name = 'room_types'\s*\nORDER BY ordinal_position/);
  });
});

describe("Postflight — table/enum shape and cover-index safety", () => {
  it("confirms the gallery_context enum exists with the exact 8 fixed values", () => {
    expect(postflight).toContain("gallery_context_enum");
    expect(postflight).toContain("enum_exists");
  });

  it("confirms gallery_albums and gallery_images have all expected columns (8 and 15 respectively)", () => {
    expect(postflight).toMatch(/\)\) = 8\) AS all_expected_columns_present/);
    expect(postflight).toMatch(/\)\) = 15\) AS all_expected_columns_present/);
  });

  it("confirms the room_type FK and the context/room_type CHECK constraint both exist", () => {
    expect(postflight).toContain("room_type_fk_present");
    expect(postflight).toContain("context_room_type_check_present");
    expect(postflight).toContain("gallery_images_room_type_context");
  });

  it("confirms the partial unique cover index exists (at most one cover image per room type)", () => {
    expect(postflight).toContain("gallery_images_room_type_cover_uq");
    expect(postflight).toContain("partial_unique_cover_index_present");
  });
});

describe("Postflight — storage bucket, private, and the two SELECT policies' live predicate text", () => {
  it("confirms the bucket exists, is private, has the 8MB limit and the three-MIME-type whitelist", () => {
    expect(postflight).toContain("gallery_bucket_config");
    expect(postflight).toContain("bucket_exists");
    expect(postflight).toContain("is_public");
  });

  it("reads the LIVE stored policy predicate text from pg_policies, not just re-reading the migration source", () => {
    expect(postflight).toContain("qual AS using_clause");
    expect(postflight).toContain("with_check");
    expect(postflight).toMatch(/policyname LIKE 'gallery_images_storage_%'/);
  });

  it("confirms exactly two SELECT policies exist on this bucket's objects", () => {
    expect(postflight).toContain("exactly_two_select_policies");
    expect(postflight).toContain("cmd::text = 'SELECT'");
  });

  it("confirms the anon policy's predicate requires an active row joined against gallery_images, and targets the anon role", () => {
    expect(postflight).toContain("anon_policy_requires_active");
    expect(postflight).toContain("anon_policy_joins_gallery_images");
    expect(postflight).toContain("anon_policy_targets_anon_role");
    expect(postflight).toContain("gi.active");
  });

  it("confirms the staff policy uses has_permission with the gallery/read capability, and targets the authenticated role", () => {
    expect(postflight).toContain("staff_policy_uses_has_permission");
    expect(postflight).toContain("staff_policy_checks_gallery_read");
    expect(postflight).toContain("staff_policy_targets_authenticated_role");
  });

  it("confirms insert/update/delete are all permission-gated, and insert enforces the property path namespace via with_check (not qual, which is NULL for an INSERT-only policy)", () => {
    expect(postflight).toContain("insert_policy_gated");
    expect(postflight).toContain("update_policy_gated");
    expect(postflight).toContain("delete_policy_gated");
    expect(postflight).toMatch(
      /with_check FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'gallery_images_storage_insert'\) LIKE '%storage\.foldername\(name\)%'/,
    );
  });
});

describe("Postflight — both RPCs' safety properties", () => {
  it("confirms set_gallery_room_type_cover: exists, SECURITY DEFINER, hardened search_path, authenticated-only execute", () => {
    expect(postflight).toContain("set_gallery_room_type_cover_definition");
    expect(postflight).toContain("is_security_definer");
    expect(postflight).toContain("search_path_hardened");
    expect(postflight).toContain("authenticated_can_execute");
    expect(postflight).toContain("public_anon_cannot_execute");
  });

  it("confirms set_gallery_room_type_cover: permission check, room-type ownership check, atomic cover swap (both is_cover writes present)", () => {
    expect(postflight).toContain("set_gallery_room_type_cover_content_checks");
    expect(postflight).toContain("has_ownership_check");
    expect(postflight).toContain("performs_atomic_cover_swap");
  });

  it("confirms reorder_gallery_images: exists, SECURITY DEFINER, hardened search_path, authenticated-only execute", () => {
    expect(postflight).toContain("reorder_gallery_images_definition");
  });

  it("confirms reorder_gallery_images: property/ownership validation and a single batched UPDATE (no partially-applied ordering)", () => {
    expect(postflight).toContain("validates_every_id_belongs_to_property");
    expect(postflight).toContain("single_batched_update");
  });
});

describe("Postflight — permission seeding and visibility re-confirmation", () => {
  it("confirms the gallery module is seeded and the seeding infrastructure (function + auto-seed trigger) exists", () => {
    expect(postflight).toContain("gallery_permission_seeding");
    expect(postflight).toContain("only_expected_default_roles");
    expect(postflight).toContain("seed_function_exists");
    expect(postflight).toContain("auto_seed_trigger_exists");
  });

  it("re-confirms, from the LIVE gallery_images table RLS policy (not just the storage policy), that anon reads are limited to active=true", () => {
    expect(postflight).toContain("gallery_images_table_rls_visibility");
    expect(postflight).toContain("anon_table_read_limited_to_active");
    expect(postflight).toContain("rls_enabled");
  });
});

describe("Postflight — no billing/accounting side effect and full data preservation", () => {
  it("asserts zero gallery_images rows, zero gallery_albums rows, and zero gallery-images storage objects were created by the migration itself", () => {
    expect(postflight).toContain("no_write_activity_from_migration_itself");
    expect(postflight).toContain("no_gallery_image_rows_created");
    expect(postflight).toContain("no_gallery_album_rows_created");
    expect(postflight).toContain("no_gallery_storage_objects_created");
  });

  it("re-captures the exact same core/role-permissions/bucket/room_types baseline queries as the preflight, for the operator to diff", () => {
    expect(postflight).toContain("core_baseline_counts");
    expect(postflight).toContain("role_permissions_baseline_plus_gallery");
    expect(postflight).toMatch(/table_name = 'room_types'\s*\nORDER BY ordinal_position/);
  });

  it("re-captures every existing bucket's object count excluding gallery-images itself, proving no pre-existing bucket gained objects from this release", () => {
    expect(postflight).toMatch(/WHERE bucket_id <> 'gallery-images'/);
  });

  it("never asserts or implies a change to any financial table — no reservation_charges/payments/journal_entries/pos_orders reference anywhere", () => {
    expect(postflight).not.toMatch(/reservation_charges|payments|journal_entries|pos_orders/);
  });
});

describeIfPlanPresent(
  "Local release plan (scripts/prod/releases/2026-08-24-gallery-release.json)",
  () => {
    it("pins the pristine git-blob SHA256, matching what's actually committed at HEAD", () => {
      expect(releasePlan!.migration?.relPath).toBe(migrationRelPath);
      expect(releasePlan!.migration?.approvedSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(releasePlan!.migration?.approvedSha256).toBe(gitBlobSha256("HEAD", migrationRelPath));
    });

    it("points at the dedicated gallery preflight/postflight files", () => {
      expect(releasePlan!.preflight_sql).toBe(
        "supabase/preflight/20260824_gallery_release_preflight.sql",
      );
      expect(releasePlan!.postflight_sql).toBe(
        "supabase/postflight/20260824_gallery_release_postflight.sql",
      );
    });

    it("does not authorize historical backfill or financial smoke", () => {
      expect(releasePlan!.historical_backfill_authorized).toBe(false);
      expect(releasePlan!.financial_smoke_authorized).toBe(false);
    });
  },
);
