import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Incident fix regression coverage: public.booking_lookup(text, text) lost
// anon EXECUTE to a blanket revoke loop in 20260705105030 and was never
// restored (unlike its sibling booking_search_availability, restored in
// 20260712183400). This suite follows the same structural (source-text)
// convention as tests/product-image-rpc-anon-execute-fix.test.ts and
// tests/branding-phase1.test.ts — vitest runs in a `node` environment here
// (see vitest.config.ts), with no live database wired into the automated
// suite. The behavioral claims below (anon/authenticated can execute,
// wrong code/email returns no row, correct code+email returns exactly the
// expected booking, one property's booking cannot leak into another
// lookup, booking_search_availability is unaffected, PostgREST discovers
// the RPC) were additionally verified live against a real local disposable
// Postgres replaying this repo's full migration history end to end — see
// the fix migration's own header comment and the incident report for the
// exact commands and results. That live pass is a manual authoring-time
// verification (matching this repo's established convention — see e.g.
// the Gallery release plan's "Live-validated against a local disposable
// Postgres" note) — it is not re-run by `vitest run`.

const root = resolve(__dirname, "..");
function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const fix = read(
  resolve(root, "supabase/migrations/20260824120000_restore_booking_lookup_anon_grant.sql"),
);
const originalMigration = read(
  resolve(root, "supabase/migrations/20260705033256_32cbc4d2-9ff4-4c30-8fdc-25259f1d9723.sql"),
);
const secondRevokeMigration = read(
  resolve(root, "supabase/migrations/20260705105030_7bcf27a3-77c9-4066-8930-b9fb839d4381.sql"),
);
const searchAvailabilityRestoreMigration = read(
  resolve(root, "supabase/migrations/20260712183400_restore_public_booking_availability_grant.sql"),
);

describe("booking_lookup anon-grant incident fix — migration content", () => {
  it("restores EXECUTE to anon and authenticated on the exact original signature (text, text)", () => {
    expect(fix).toContain("GRANT EXECUTE ON FUNCTION public.booking_lookup(text, text) TO anon;");
    expect(fix).toContain(
      "GRANT EXECUTE ON FUNCTION public.booking_lookup(text, text) TO authenticated;",
    );
  });

  it("explicitly keeps PUBLIC pseudo-role excluded (defense-in-depth, matches the original never-granted-to-PUBLIC contract)", () => {
    expect(fix).toContain("REVOKE ALL ON FUNCTION public.booking_lookup(text, text) FROM PUBLIC;");
  });

  it("touches no other function, table, or policy — a pure, narrow grant restoration", () => {
    expect(fix).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
    expect(fix).not.toMatch(/DROP (FUNCTION|TABLE|POLICY)/);
    expect(fix).not.toMatch(/ALTER TABLE/);
    expect(fix).not.toMatch(/CREATE POLICY/);
    const grantLines = fix.match(/^(GRANT|REVOKE)[^\n]+$/gm) ?? [];
    expect(grantLines.length).toBeGreaterThan(0);
    for (const line of grantLines) {
      expect(line).toMatch(/booking_lookup/);
    }
  });

  it("does not grant service_role — the original 2026-07-05 contract never included it, and this migration restores that exact contract, not a broader one", () => {
    expect(fix).not.toMatch(/TO[^;]*service_role/);
  });
});

describe("booking_lookup anon-grant incident fix — root cause evidence, cross-checked against the actual migration history", () => {
  it("the original migration already granted anon+authenticated at creation time (confirms this is a regression, not a function that was never meant to be public)", () => {
    expect(originalMigration).toContain(
      "GRANT EXECUTE ON FUNCTION public.booking_lookup(text,text) TO anon, authenticated;",
    );
  });

  it("booking_lookup was never redefined after its original creation (no DROP+CREATE, no CREATE OR REPLACE anywhere else) — ruling out a function-replacement grant reset as the cause", () => {
    const migrationsDir = resolve(root, "supabase/migrations");
    const files = readdirSync(migrationsDir).filter((f: string) => f.endsWith(".sql"));
    const redefinitions: string[] = [];
    for (const file of files) {
      const text = read(resolve(migrationsDir, file));
      if (/CREATE (OR REPLACE )?FUNCTION public\.booking_lookup/.test(text)) {
        redefinitions.push(file);
      }
    }
    expect(redefinitions).toEqual(["20260705033256_32cbc4d2-9ff4-4c30-8fdc-25259f1d9723.sql"]);
  });

  it("the actual regressing statement is the later, broader anon-revoke loop (20260705105030), which targets every SECURITY DEFINER function in public and never re-grants the booking flow", () => {
    expect(secondRevokeMigration).toContain(
      "REVOKE EXECUTE ON FUNCTION %I.%I(%s) FROM PUBLIC, anon",
    );
    expect(secondRevokeMigration).toContain("p.prosecdef = true");
    expect(secondRevokeMigration).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.booking_lookup/);
  });

  it("booking_search_availability received an equivalent restoration a week later; booking_lookup's is this migration, filling the identical gap", () => {
    expect(searchAvailabilityRestoreMigration).toContain(
      "GRANT EXECUTE ON FUNCTION public.booking_search_availability(uuid, date, date, integer)",
    );
    expect(searchAvailabilityRestoreMigration).not.toMatch(/booking_lookup/);
  });
});

describe("booking_lookup anon-grant incident fix — function safety properties (unchanged, verified against the original body)", () => {
  function fn(source: string, name: string): string {
    const match = source.match(
      new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}[\\s\\S]*?\\$\\$;`),
    )?.[0];
    if (!match) throw new Error(`Could not find function ${name} in source`);
    return match;
  }
  const original = fn(originalMigration, "booking_lookup");

  it("is SECURITY DEFINER with search_path pinned — matches the codebase's established hardening convention", () => {
    expect(original).toContain("SECURITY DEFINER");
    expect(original).toMatch(/SET search_path = public/);
  });

  it("requires BOTH _confirmation_code AND _email (AND, not OR) — a code-only or email-only lookup is structurally impossible", () => {
    expect(original).toContain("WHERE r.confirmation_code = _confirmation_code");
    expect(original).toContain("AND lower(r.confirmation_email) = lower(_email)");
    expect(original).not.toMatch(/WHERE[^;]*\bOR\b[^;]*confirmation_code/);
  });

  it("returns at most one row (LIMIT 1)", () => {
    expect(original).toContain("LIMIT 1;");
  });

  it("returns no payment-instrument or admin-only fields — only what a guest's own confirmation page already displays", () => {
    expect(original).not.toMatch(/card|payment_method|token|iban|account_number/i);
  });

  it("does not accept or interpolate any dynamic/caller-controlled SQL — parameters are plain typed function arguments, not string-built", () => {
    expect(original).not.toMatch(/format\(|EXECUTE\s+'/);
  });

  it("this migration does not modify the function body — the fix is grants-only", () => {
    expect(fix).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.booking_lookup/);
  });
});
