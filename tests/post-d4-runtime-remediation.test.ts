import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Normalized to LF on read: a Windows checkout can materialize tracked files
// with CRLF, and every assertion here is about SQL text.
const readNormalized = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const root = resolve(__dirname, "..");

const migration = readNormalized(
  resolve(root, "supabase/migrations/20260909170000_revenue_posting_payroll_approval_leave_balances.sql"),
);

/** The last definition of `name` in the migration, body included. */
function fn(name: string): string {
  const matches = migration.match(
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\b[\\s\\S]*?\\$function\\$;`, "g"),
  );
  if (!matches?.length) throw new Error(`Could not find function ${name} in the migration`);
  return matches[matches.length - 1];
}

describe("revenue posting: authorization", () => {
  it("moves the posting engine into post_journal_internal, with no caller role test", () => {
    const internal = fn("post_journal_internal");
    expect(internal).toContain("INSERT INTO public.journal_entries");
    expect(internal).toContain("Journal not balanced");
    // The role gate belongs to the public entry point, not the engine.
    expect(internal).not.toContain("has_any_role");
  });

  it("keeps post_journal itself accountant-and-above, and delegates the work", () => {
    const entry = fn("post_journal");
    expect(entry).toContain("has_any_role(auth.uid()");
    expect(entry).toContain("'super_admin','hotel_owner','general_manager','accountant'");
    expect(entry).toContain("Not permitted to post journal");
    expect(entry).toContain("RETURN public.post_journal_internal(");
  });

  it("keeps the engine unreachable from client roles", () => {
    for (const role of ["PUBLIC", "anon", "authenticated"]) {
      expect(migration).toContain(
        `REVOKE ALL ON FUNCTION public.post_journal_internal(uuid, date, text, text, journal_source, text, jsonb) FROM ${role};`,
      );
    }
  });

  it("lets the operational posting functions reach the engine", () => {
    expect(fn("post_reservation_checkout")).toContain("public.post_journal_internal(");
    expect(fn("post_pos_order_close")).toContain("public.post_journal_internal(");
  });
});

describe("revenue posting: currency", () => {
  it("posts a folio in the property's own currency, never a literal", () => {
    const checkout = fn("post_reservation_checkout");
    expect(checkout).toContain("_currency := _prop.base_currency;");
    expect(checkout).not.toContain("'USD'");
    // The fix must not swap one hardcoded currency for another.
    expect(checkout).not.toContain("'GHS'");
  });

  it("posts a POS order in the property's own currency, never a literal", () => {
    const pos = fn("post_pos_order_close");
    expect(pos).toContain("_currency := _prop.base_currency;");
    expect(pos).not.toContain("'USD'");
    expect(pos).not.toContain("'GHS'");
  });

  it("refuses to post when a property has no base currency rather than guessing one", () => {
    expect(fn("post_reservation_checkout")).toContain("has no base currency configured");
    expect(fn("post_pos_order_close")).toContain("has no base currency configured");
  });
});

describe("revenue posting: failures are no longer silent", () => {
  it("no longer swallows a posting failure on checkout", () => {
    const checkout = fn("post_reservation_checkout");
    expect(checkout).not.toContain("EXCEPTION WHEN OTHERS");
    expect(checkout).not.toContain("RAISE NOTICE");
  });

  it("no longer swallows a posting failure on a POS close", () => {
    const pos = fn("post_pos_order_close");
    expect(pos).not.toContain("EXCEPTION WHEN OTHERS");
    expect(pos).not.toContain("RAISE NOTICE");
  });

  it("still reports an incomplete chart of accounts instead of posting a half journal", () => {
    expect(fn("post_reservation_checkout")).toContain("Accounting setup is incomplete");
    expect(fn("post_pos_order_close")).toContain("Accounting setup is incomplete");
  });

  it("keeps both postings idempotent", () => {
    expect(fn("post_reservation_checkout")).toContain("WHERE source='folio' AND source_ref=_res_id::text");
    expect(fn("post_pos_order_close")).toContain("WHERE source='pos' AND source_ref=_order_id::text");
  });
});

describe("payroll approval", () => {
  it("releases the review lock on every transition out of locked_for_review", () => {
    const transition = fn("payroll_approval_transition");
    expect(transition).toContain(
      "review_locked_by=CASE WHEN new_status='locked_for_review' THEN review_locked_by ELSE NULL END",
    );
    expect(transition).toContain(
      "review_locked_at=CASE WHEN new_status='locked_for_review' THEN review_locked_at ELSE NULL END",
    );
  });

  it("leaves the state machine itself alone", () => {
    const transition = fn("payroll_approval_transition");
    expect(transition).toContain("new_status:='submitted_for_approval'");
    expect(transition).toContain("new_status:='approved'");
    expect(transition).toContain("Requester cannot approve this payroll run");
  });
});

describe("payroll audit helper", () => {
  it("creates the log_audit_event() twelve payroll functions have always called", () => {
    const helper = fn("log_audit_event");
    expect(helper).toContain("_property_id uuid");
    expect(helper).toContain("_entity_type text");
    expect(helper).toContain("_entity_id text");
    expect(helper).toContain("_action text");
    expect(helper).toContain("_meta jsonb");
    expect(helper).toContain("INSERT INTO public.audit_logs");
  });

  it("keeps a non-uuid entity reference instead of dropping it", () => {
    expect(fn("log_audit_event")).toContain("jsonb_build_object('entity_ref', _entity_id)");
  });

  it("is an internal helper, not an endpoint", () => {
    for (const role of ["PUBLIC", "anon", "authenticated"]) {
      expect(migration).toContain(
        `REVOKE ALL ON FUNCTION public.log_audit_event(uuid, text, text, text, jsonb) FROM ${role};`,
      );
    }
  });
});

describe("payroll finalisation", () => {
  it("puts pgcrypto on the search path of every function that hashes", () => {
    expect(migration).toContain(
      "ALTER FUNCTION public.payroll_finalize_run(uuid, uuid, integer, uuid) SET search_path = public, extensions;",
    );
    expect(migration).toContain(
      "ALTER FUNCTION public.payroll_generate_payslips(uuid, uuid, uuid[]) SET search_path = public, extensions;",
    );
    expect(migration).toContain(
      "ALTER FUNCTION public.payroll_export_payment_batch(uuid, uuid, uuid) SET search_path = public, extensions;",
    );
  });

  it("aggregates the statutory line type instead of selecting it ungrouped", () => {
    const finalize = fn("payroll_finalize_run");
    expect(finalize).toContain("COALESCE(s.rule_category,min(fli.line_type))");
    expect(finalize).not.toContain("COALESCE(s.rule_category,fli.line_type)");
    // The grouping itself is unchanged: one summary row per statutory rule.
    expect(finalize).toContain(
      "GROUP BY fli.property_id,fli.statutory_rule_id,fli.statutory_rule_version,s.rule_category,s.verification_status",
    );
  });

  it("still requires an approved run before it will finalise", () => {
    expect(fn("payroll_finalize_run")).toContain("Payroll run must be approved before finalization");
  });
});

describe("leave balance initialisation", () => {
  it("renames the ambiguous period_start variable", () => {
    const initialise = fn("hr_initialize_leave_balances");
    expect(initialise).toContain("_period_start date");
    expect(initialise).not.toMatch(/DECLARE item record; period_start date;/);
    expect(initialise).toContain("b.period_start=_period_start");
  });

  it("keeps the authorization and the recalculation it delegates to", () => {
    const initialise = fn("hr_initialize_leave_balances");
    expect(initialise).toContain("has_hrm_permission(auth.uid(),_property_id,'leave_balances','read')");
    expect(initialise).toContain("PERFORM public.recalculate_hr_leave_balance(");
  });
});
