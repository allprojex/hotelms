import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertReadOnlySqlFile, gitBlobSha256 } from "../scripts/prod/lib/guard.mjs";

// Pins the safety-critical properties of the reservation-payment PARTIAL
// REFUND release's (PR #67) preflight/postflight SQL and its local operator
// release plan, mirroring the established convention in
// tests/gallery-release-checks.test.ts and
// tests/reservation-payment-release-checks.test.ts. Both SQL files were
// also run for real against a local disposable Postgres (once at a
// genuinely simulated pre-release state -- the migration file temporarily
// removed -- and once at the fully-migrated state) before being trusted;
// every boolean check evaluated true on both runs, and
// reverse_reservation_payment()'s body_md5 fingerprint matched exactly
// between the two captures, confirming the grants-only REVOKE never
// touches that function's body. Two real bugs were found and fixed during
// that live pass: a `name[] = text[]` operator-does-not-exist type
// mismatch in the UNIQUE(property_id, request_id) column-set comparison
// (fixed by casting to text[]), and regexp_split_to_array's second
// argument being a POSIX regex rather than a literal (an unescaped ')' in
// a marker string broke it; replaced with a plain length-based substring
// count) -- see the release readiness report for the full record.

const preflightPath = resolve(
  __dirname,
  "../supabase/preflight/20260824_reservation_partial_refund_release_preflight.sql",
);
const postflightPath = resolve(
  __dirname,
  "../supabase/postflight/20260824_reservation_partial_refund_release_postflight.sql",
);
const preflight = readFileSync(preflightPath, "utf8");
const postflight = readFileSync(postflightPath, "utf8");
const migrationRelPath =
  "supabase/migrations/20260824130000_reservation_payment_partial_refund.sql";

const releasePlanPath = resolve(
  __dirname,
  "../scripts/prod/releases/2026-08-24-reservation-partial-refund-release.json",
);
interface ReleasePlan {
  migration?: { relPath: string; approvedSha256: string };
  migrations?: unknown;
  preflight_sql?: string;
  postflight_sql?: string;
  historical_backfill_authorized?: boolean;
  financial_smoke_authorized?: boolean;
}
let releasePlan: ReleasePlan | null = null;
try {
  releasePlan = JSON.parse(readFileSync(releasePlanPath, "utf8"));
} catch {
  releasePlan = null;
}
const describeIfPlanPresent = releasePlan ? describe : describe.skip;

describe("Reservation partial refund release checks — genuinely read-only", () => {
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
      expect(stripped).not.toMatch(/\bEXECUTE\b/);
    }
  });

  it("the postflight's split-literal 'FOR UPDATE' content check reconstructs the real phrase without ever writing it as contiguous text", () => {
    expect(postflight.match(/'FOR UPD' \|\| 'ATE'/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });
});

describe("Preflight — pre-release confirmation and baseline capture", () => {
  it("confirms the new table, RPC, and enum value do not yet exist", () => {
    expect(preflight).toContain("to_regclass('public.reservation_payment_refunds') IS NULL");
    expect(preflight).toContain(
      "to_regprocedure('public.refund_reservation_payment(uuid,numeric,text,uuid)') IS NULL",
    );
    expect(preflight).toContain("t.typname = 'journal_source' AND e.enumlabel = 'payment_refund'");
  });

  it("captures the old RPC's current (pre-release) grant state and body fingerprint for later comparison", () => {
    expect(preflight).toContain("reverse_reservation_payment");
    expect(preflight).toContain(
      "reverse_reservation_payment_still_authenticated_executable_pre_release",
    );
    expect(preflight).toContain("reverse_reservation_payment_body_fingerprint");
    expect(preflight).toContain("md5(pg_get_functiondef(oid))");
  });

  it("has a single aggregate 'no partial application' flag combining every absence/grant check", () => {
    expect(preflight).toContain("schema_fully_pre_release");
  });

  it("captures the payment baseline: total/posted/void counts, total amount, journal-entry coverage, per-property breakdown, reservation counts", () => {
    expect(preflight).toMatch(/total_payments/);
    expect(preflight).toMatch(/posted_payments/);
    expect(preflight).toMatch(/void_payments/);
    expect(preflight).toMatch(/total_payment_amount/);
    expect(preflight).toMatch(/payments_with_original_journal_entry/);
    expect(preflight).toMatch(/payments_without_journal_entry/);
    expect(preflight).toMatch(/reservation_count/);
  });

  it("captures the accounting baseline: journal_entries/lines counts, the full journal_source enum listing, locked/closed periods", () => {
    expect(preflight).toContain("journal_entries_count");
    expect(preflight).toContain("journal_lines_count");
    expect(preflight).toMatch(/t\.typname = 'journal_source'\s*\nORDER BY e\.enumsortorder/);
    expect(preflight).toMatch(/status IN \('locked', 'closed'\)/);
  });

  it("captures original-payment-journal shape facts against the RPC's own guarded assumption (two lines, each equal to the full amount)", () => {
    expect(preflight).toContain("matches_expected_two_line_full_amount_shape");
    expect(preflight).toContain("does_not_match_expected_shape");
  });

  it("captures the financial baseline: reservation_charges, payments, journal_entries, journal_lines, admin_action_logs", () => {
    expect(preflight).toContain("reservation_charges_count");
    expect(preflight).toContain("reservation_charges_total");
    expect(preflight).toContain("payments_count");
    expect(preflight).toContain("payments_total");
    expect(preflight).toContain("journal_entries_count");
    expect(preflight).toContain("journal_lines_count");
    expect(preflight).toContain("admin_action_logs_count");
  });
});

describe("Postflight — enum / table shape", () => {
  it("confirms journal_source now contains 'payment_refund' and the new table exists", () => {
    expect(postflight).toContain("journal_source_contains_payment_refund");
    expect(postflight).toContain("reservation_payment_refunds_exists");
  });

  it("confirms the exact expected column set", () => {
    expect(postflight).toContain("reservation_payment_refunds_exact_column_set");
    expect(postflight).toContain("'id'), ('property_id'), ('payment_id'), ('amount'), ('reason')");
  });

  it("confirms the fractional-cent CHECK constraint and the UNIQUE(property_id, request_id) constraint both exist", () => {
    expect(postflight).toContain("fractional_cent_check_present");
    expect(postflight).toContain("reservation_payment_refunds_amount_no_fractional_cents");
    expect(postflight).toContain("unique_property_request_id_present");
  });

  it("confirms the two named indexes are present", () => {
    expect(postflight).toContain("expected_indexes_present");
    expect(postflight).toContain("idx_reservation_payment_refunds_payment");
    expect(postflight).toContain("idx_reservation_payment_refunds_property");
  });

  it("confirms RLS is enabled, and authenticated gets SELECT only — no direct authenticated INSERT/UPDATE/DELETE", () => {
    expect(postflight).toContain("rls_enabled");
    expect(postflight).toContain("reservation_payment_refunds_authenticated_acl");
    expect(postflight).toContain("select_granted_ok");
    expect(postflight).toContain("insert_absent_ok");
    expect(postflight).toContain("update_absent_ok");
    expect(postflight).toContain("delete_absent_ok");
  });
});

describe("Postflight — new RPC safety and hardening properties", () => {
  it("confirms the RPC exists, is SECURITY DEFINER, has a hardened search_path, and never accepts a client-supplied property/reservation id", () => {
    expect(postflight).toContain("refund_reservation_payment_exists");
    expect(postflight).toContain("is_security_definer");
    expect(postflight).toContain("search_path_hardened");
    expect(postflight).toContain("refund_reservation_payment_no_client_supplied_property");
  });

  it("confirms authenticated-only EXECUTE — PUBLIC/anon revoked", () => {
    expect(postflight).toContain("refund_reservation_payment_grant_posture");
    expect(postflight).toContain("authenticated_can_execute");
    expect(postflight).toContain("anon_public_cannot_execute");
  });

  it("confirms authorization (has_any_role) runs BEFORE the idempotent-replay lookup", () => {
    expect(postflight).toContain("role_check_before_replay");
  });

  it("confirms reason normalization, reason-length validation, amount positivity, and fractional-cent rejection ALL run before the replay lookup", () => {
    expect(postflight).toContain("reason_normalized_before_replay");
    expect(postflight).toContain("reason_validated_before_replay");
    expect(postflight).toContain("amount_positivity_validated_before_replay");
    expect(postflight).toContain("fractional_cent_validated_before_replay");
  });

  it("confirms the replay match uses exact NUMERIC equality (existing.amount = _amount), never a ROUND-based comparison", () => {
    expect(postflight).toContain("exact_replay_payload_comparison");
    expect(postflight).toContain("existing.amount = _amount");
    expect(postflight).toContain("strpos(fd, 'ROUND(existing.amount");
  });

  it("confirms a mismatched replay payload raises an explicit, named idempotency conflict", () => {
    expect(postflight).toContain("has_explicit_idempotency_conflict");
    expect(postflight).toContain("was already used for a different refund");
  });

  it("confirms the advisory lock and the payment FOR UPDATE row lock are both present", () => {
    expect(postflight).toContain("has_advisory_lock");
    expect(postflight).toContain("has_payment_row_lock");
  });

  it("confirms the replay lookup runs BEFORE the void-status rejection, and the void-status rejection itself is present", () => {
    expect(postflight).toContain("replay_check_before_void_status_rejection");
    expect(postflight).toContain("has_void_status_rejection");
  });

  it("confirms the server-side refundable SUM, the exact-cent over-refund comparison, and the absence of any tolerance band anywhere in the function", () => {
    expect(postflight).toContain("computes_server_side_refundable_sum");
    expect(postflight).toContain("exact_cent_over_refund_comparison");
    expect(postflight).toContain("no_tolerance_band_anywhere");
  });

  it("confirms the accounting-period lock check, the original-journal two-line/full-amount shape guard, and the balanced-reversal assertion", () => {
    expect(postflight).toContain("has_accounting_period_lock");
    expect(postflight).toContain("has_original_journal_shape_guard");
    expect(postflight).toContain("has_balance_assertion");
  });

  it("confirms exactly one audit-log write site in the function, and no exception-swallowing handler", () => {
    expect(postflight).toContain("has_audit_insert_call_site");
    expect(postflight).toContain("refund_reservation_payment_exactly_one_audit_write_site");
    expect(postflight).toContain("no_exception_swallowing");
  });
});

describe("Postflight — old RPC retirement", () => {
  it("captures the old RPC's body fingerprint for comparison against the preflight-captured value — must be identical", () => {
    expect(postflight).toContain("reverse_reservation_payment_body_fingerprint");
    expect(postflight).toContain("md5(pg_get_functiondef(oid))");
  });

  it("confirms the old RPC's authenticated EXECUTE grant is now revoked", () => {
    expect(postflight).toContain("reverse_reservation_payment_authenticated_execute_revoked");
  });

  it("confirms no alternate application-reachable full-refund path remains for any client role", () => {
    expect(postflight).toContain("no_alternate_reachable_full_refund_path");
  });
});

describe("Postflight — preservation and migration history", () => {
  it("re-captures the same financial baseline queries as the preflight, for the operator to diff", () => {
    expect(postflight).toContain("reservation_charges_count");
    expect(postflight).toContain("reservation_charges_total");
    expect(postflight).toContain("payments_count");
    expect(postflight).toContain("payments_total");
    expect(postflight).toContain("journal_entries_count");
    expect(postflight).toContain("journal_lines_count");
    expect(postflight).toContain("admin_action_logs_count");
  });

  it("asserts the migration itself created zero refund rows, zero new journal entries/lines, zero new audit records, and voided zero payments", () => {
    expect(postflight).toContain("no_write_activity_from_migration_itself");
    expect(postflight).toContain("zero_refund_event_rows");
    expect(postflight).toContain("zero_new_journal_entries");
    expect(postflight).toContain("zero_new_journal_lines");
    expect(postflight).toContain("zero_new_audit_records");
    expect(postflight).toContain("zero_payments_voided_by_migration");
  });

  it("confirms the migration's own version is recorded in supabase_migrations.schema_migrations", () => {
    expect(postflight).toContain("20260824130000");
    expect(postflight).toContain("migration_recorded");
  });
});

describeIfPlanPresent(
  "Local release plan (scripts/prod/releases/2026-08-24-reservation-partial-refund-release.json)",
  () => {
    it("pins the pristine git-blob SHA256, matching what's actually committed at HEAD", () => {
      expect(releasePlan!.migration?.relPath).toBe(migrationRelPath);
      expect(releasePlan!.migration?.approvedSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(releasePlan!.migration?.approvedSha256).toBe(gitBlobSha256("HEAD", migrationRelPath));
    });

    it("points at the dedicated reservation-partial-refund preflight/postflight files", () => {
      expect(releasePlan!.preflight_sql).toBe(
        "supabase/preflight/20260824_reservation_partial_refund_release_preflight.sql",
      );
      expect(releasePlan!.postflight_sql).toBe(
        "supabase/postflight/20260824_reservation_partial_refund_release_postflight.sql",
      );
    });

    it("does not authorize historical backfill or financial smoke", () => {
      expect(releasePlan!.historical_backfill_authorized).toBe(false);
      expect(releasePlan!.financial_smoke_authorized).toBe(false);
    });
  },
);
