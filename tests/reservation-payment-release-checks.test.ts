import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertReadOnlySqlFile } from "../scripts/prod/lib/guard.mjs";

const root = resolve(__dirname, "..");
const readNormalized = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const preflightPath = resolve(
  root,
  "supabase/preflight/20260823_reservation_payment_release_preflight.sql",
);
const postflightPath = resolve(
  root,
  "supabase/postflight/20260823_reservation_payment_release_postflight.sql",
);
const preflight = readNormalized(preflightPath);
const postflight = readNormalized(postflightPath);

describe("reservation-payment release preflight/postflight — read-only (both files)", () => {
  it("preflight passes the toolkit's own real assertReadOnlySqlFile guard", () => {
    expect(() => assertReadOnlySqlFile(preflightPath)).not.toThrow();
  });

  it("postflight passes the toolkit's own real assertReadOnlySqlFile guard", () => {
    expect(() => assertReadOnlySqlFile(postflightPath)).not.toThrow();
  });

  it("neither file contains a write/DDL keyword outside a comment (independent check, not just relying on the guard function)", () => {
    const writeKeywords =
      /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|MERGE|CALL|EXECUTE|VACUUM|REINDEX|COPY)\b/i;
    for (const [name, sql] of [
      ["preflight", preflight],
      ["postflight", postflight],
    ] as const) {
      const withoutComments = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const match = withoutComments.match(writeKeywords);
      expect(match, `${name} unexpectedly contains "${match?.[0]}" outside a comment`).toBeNull();
    }
  });

  it("every statement in both files is a SELECT/WITH (or a UNION ALL continuation) — no other statement type present", () => {
    for (const sql of [preflight, postflight]) {
      const withoutComments = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const statements = withoutComments
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of statements) {
        expect(stmt).toMatch(/^(SELECT|WITH)\b/i);
      }
    }
  });
});

describe("preflight — section A: schema is still pre-release", () => {
  it("checks payments table existence and every PR #46/#47/#48 object's absence", () => {
    expect(preflight).toContain("payments_table_exists");
    expect(preflight).toContain("reservation_payment_status_enum_absent_pre_release");
    expect(preflight).toContain("payments_status_column_absent_pre_release");
    expect(preflight).toContain("reverse_reservation_payment_absent_pre_release");
    expect(preflight).toContain("payment_source_ref_unique_index_absent_pre_release");
  });

  it("checks post_payment() still shows old-version markers (paid_at, post_journal call, exception swallow) and not the new-version markers", () => {
    expect(preflight).toContain("still_references_paid_at");
    expect(preflight).toContain("still_calls_post_journal");
    expect(preflight).toContain("still_has_exception_swallow");
    expect(preflight).toContain("already_references_base_currency");
    expect(preflight).toContain("already_uses_received_at");
  });

  it("has one aggregate schema_fully_pre_release flag combining every individual absence/presence check", () => {
    expect(preflight).toContain("schema_fully_pre_release");
  });
});

describe("preflight — section E: release assumptions, and tolerating the expected legacy no-journal state", () => {
  it("legacy_no_journal_state_expected is TRUE when no_journal_count > 0 — the expected, accepted state, not framed as a failure", () => {
    const idx = preflight.indexOf("legacy_no_journal_state_expected");
    expect(idx).toBeGreaterThan(-1);
    // The check itself asserts truthiness of "count > 0", i.e. having
    // no-journal payments is the PASS condition, not a FAIL condition.
    expect(preflight).toMatch(/legacy_no_journal_state_expected[\s\S]{0,80}no_journal_count > 0/);
  });

  it("does not gate/abort the preflight run on a non-zero no_journal_count anywhere — no RAISE EXCEPTION or similar hard-fail tied to it", () => {
    expect(preflight).not.toMatch(/RAISE EXCEPTION/i);
    expect(preflight).not.toMatch(/no_journal_count\s*=\s*0/);
  });

  it("all five required boolean release-assumption checks are present", () => {
    for (const flag of [
      "legacy_no_journal_state_expected",
      "no_ambiguous_payment_journals",
      "no_account_blockers",
      "no_period_blockers",
      "theskwoff_hotel_base_currency_is_ghs",
    ]) {
      expect(preflight).toContain(flag);
    }
  });
});

describe("preflight — sections B/C/D: historical facts, safety blockers, currency facts", () => {
  it("captures total/has-journal/no-journal/ambiguous counts, amount, and date range in one query", () => {
    expect(preflight).toContain("total_payments");
    expect(preflight).toContain("has_journal_count");
    expect(preflight).toContain("no_journal_count");
    expect(preflight).toContain("ambiguous_multiple_journals_count");
    expect(preflight).toContain("total_amount");
    expect(preflight).toContain("earliest_received_at");
    expect(preflight).toContain("latest_received_at");
  });

  it("captures already-reversed count via journal_entries linkage (payments.status doesn't exist pre-release)", () => {
    expect(preflight).toContain("already_reversed_payment_count");
    // No reference anywhere to a payments.status column, which does not
    // exist pre-release — the already-reversed check must derive purely
    // from journal_entries' own is_reversal_of linkage instead.
    expect(preflight).not.toMatch(/\bp\.status\b/);
  });

  it("captures payment method breakdown", () => {
    expect(preflight).toContain("method::text AS method");
  });

  it("captures missing cash/AR account blockers and locked-period blockers", () => {
    expect(preflight).toContain("has_cash_account");
    expect(preflight).toContain("has_ar_account");
    expect(preflight).toMatch(/status IN \('locked', 'closed'\)/);
  });

  it("captures orphan source='payment' journal entries", () => {
    expect(preflight).toMatch(/source = 'payment'[\s\S]*NOT EXISTS/);
  });

  it("captures Theskwoff Hotel base_currency/currency, per-property payment counts, and flags any currency != base_currency property", () => {
    expect(preflight).toContain("base_currency");
    expect(preflight).toContain("currency IS DISTINCT FROM base_currency");
  });
});

describe("postflight — section A: refund schema", () => {
  it("checks the reservation_payment_status enum and all four reversal metadata columns", () => {
    expect(postflight).toContain("reservation_payment_status");
    expect(postflight).toContain("reversal_entry_id");
    expect(postflight).toContain("reversal_reason");
    expect(postflight).toContain("reversed_by");
    expect(postflight).toContain("reversed_at");
  });

  it("checks legacy rows all default to posted, and zero rows are void immediately after migration", () => {
    expect(postflight).toContain("non_posted_legacy_rows");
    expect(postflight).toContain("unexpected_void_rows_immediately_after_migration");
  });
});

describe("postflight — section B: refund RPC checks", () => {
  it("checks existence, SECURITY DEFINER, and search_path hardening for reverse_reservation_payment", () => {
    expect(postflight).toContain("reverse_reservation_payment");
    expect(postflight).toContain("is_security_definer");
    expect(postflight).toContain("search_path_hardened");
  });

  it("checks grants by selecting privilege_type (not filtering on it) for authenticated/anon/PUBLIC", () => {
    expect(postflight).toMatch(
      /reverse_reservation_payment[\s\S]{0,300}grantee IN \('authenticated', 'anon', 'PUBLIC'\)/,
    );
  });

  it("checks actor/role check, reason validation, row lock, duplicate-refund guard, and audit log write are all present in the function body", () => {
    expect(postflight).toContain("has_actor_role_check");
    expect(postflight).toContain("has_reason_length_validation");
    expect(postflight).toContain("has_payment_row_lock");
    expect(postflight).toContain("has_duplicate_refund_guard");
    expect(postflight).toContain("has_audit_log_write");
  });

  it("the row-lock check splits the 'FOR UPDATE' string literal so the raw file never contains that contiguous phrase (verified live: this exact concatenation correctly matches the real normalized function body)", () => {
    expect(postflight).toContain("'FOR UPD' || 'ATE'");
    expect(postflight).not.toMatch(/'FOR UPDATE'/);
  });
});

describe("postflight — section C/D: ledger posting + currency fix checks on post_payment()", () => {
  it("checks received_at usage, paid_at absence, exception-swallow absence, row lock, and idempotency check", () => {
    expect(postflight).toContain("uses_received_at");
    expect(postflight).toContain("paid_at_not_referenced");
    expect(postflight).toContain("exception_swallow_absent");
    expect(postflight).toContain("has_row_lock");
    expect(postflight).toContain("has_idempotency_check");
  });

  it("checks base_currency derivation and no-hardcoded-USD, using a precise assignment/argument pattern rather than a bare 'USD' substring search", () => {
    expect(postflight).toContain("derives_currency_from_base_currency");
    expect(postflight).toContain("no_hardcoded_usd");
    // Bare-substring search would false-positive on this function's own
    // explanatory comments (confirmed live) — the fixed check targets the
    // specific assignment/positional-argument shapes real hardcoding would
    // take instead.
    expect(postflight).toMatch(/NOT LIKE '%:= ''USD''%' AND[\s\S]{0,60}NOT LIKE '%, ''USD'',%'/);
  });

  it("checks no fx_convert() call path remains, using a fully-qualified call pattern rather than a bare substring search", () => {
    expect(postflight).toContain("no_fx_convert_path");
    expect(postflight).toContain("no_fx_convert_call");
    expect(postflight).toContain("public.fx_convert(");
  });

  it("checks fx_rate is effectively 1 for both journal lines via the real, verified normalized text shape", () => {
    expect(postflight).toContain("fx_rate_is_literal_one");
    expect(postflight).toContain("', _currency, 1,'".slice(1, -1));
  });

  it("checks the partial unique index for original payment journals exists", () => {
    expect(postflight).toContain("journal_entries_payment_source_ref_uniq");
  });
});

describe("postflight — section E: data preservation and no automatic historical backfill", () => {
  it("captures total payment count/amount and status breakdown for comparison against the preflight's own baseline capture", () => {
    expect(postflight).toContain("total_payments");
    expect(postflight).toMatch(/GROUP BY status/);
  });

  it("explicitly asserts zero void rows and zero payment journal entries exist immediately after migration — proving neither the migration nor an implicit backfill wrote any data", () => {
    expect(postflight).toContain("no_reversal_rows_created_by_migration");
    expect(postflight).toContain("no_payment_journal_entries_created_by_migration_or_backfill");
    expect(postflight).toMatch(/WHERE status = 'void'\) = 0/);
    expect(postflight).toMatch(/WHERE source = 'payment'\) = 0/);
  });

  it("this section's own comment explicitly states these counts must be compared against the preflight baseline, not hardcoded", () => {
    expect(postflight).toMatch(/compare these row counts\/amounts against the/i);
  });
});

describe("postflight — section F: grants", () => {
  it("checks payments retains SELECT/INSERT and has UPDATE/DELETE revoked for authenticated, via ACL letter codes (not the literal keywords)", () => {
    expect(postflight).toContain("payments_select_retained_ok");
    expect(postflight).toContain("payments_insert_retained_ok");
    expect(postflight).toContain("payments_update_revoked_ok");
    expect(postflight).toContain("payments_delete_revoked_ok");
    expect(postflight).toContain("aclitemout");
  });
});

describe("postflight — section G: migration history", () => {
  it("checks all three migration timestamps are recorded in supabase_migrations.schema_migrations", () => {
    expect(postflight).toContain("supabase_migrations.schema_migrations");
    expect(postflight).toContain("20260822130000");
    expect(postflight).toContain("20260823090000");
    expect(postflight).toContain("20260823100000");
    expect(postflight).toContain("all_three_migrations_recorded");
  });
});

describe("CLI --output json compatibility — every enum/uuid column selected raw is cast to text", () => {
  it("preflight casts method (payment_method enum) to text", () => {
    expect(preflight).toContain("method::text");
  });

  it("preflight casts accounting_periods.status (period_status enum) to text", () => {
    expect(preflight).toContain("ap.status::text");
  });

  it("preflight casts every UUID primary/foreign key it selects raw (property id, journal entry id/is_reversal_of)", () => {
    expect(preflight).toContain("pr.id::text AS property_id");
    expect(preflight).toContain("je.id::text AS id");
    expect(preflight).toContain("je.is_reversal_of::text AS is_reversal_of");
    // payments.id itself is never selected as a raw output column anywhere
    // in this file — only ever used (already correctly cast) as a join key
    // (p.id::text = ...) — so there is no bare-uuid payments.id output to
    // worry about.
    expect(preflight).not.toMatch(/SELECT[^;]*\bp\.id\b(?!::text)[^;]*FROM public\.payments/);
  });

  it("postflight casts every UUID it selects raw in the ACL/grant sections", () => {
    // Grant/ACL sections here only ever select text-typed columns
    // (routine_name, grantee, privilege_type, table_name, priv_letters) —
    // confirmed no bare uuid column is selected anywhere in postflight.
    expect(postflight).not.toMatch(/SELECT[^;]*\bid\b[^:][^;]*FROM pg_proc/);
  });
});
