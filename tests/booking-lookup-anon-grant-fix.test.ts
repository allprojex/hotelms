import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Incident fix regression coverage: the entire public booking lifecycle
// (booking_lookup, booking_create, booking_cancel, booking_modify) lost
// anon EXECUTE to a blanket revoke loop in 20260705105030 and was never
// restored (unlike its sibling booking_search_availability, restored in
// 20260712183400). This suite follows the same structural (source-text)
// convention as tests/product-image-rpc-anon-execute-fix.test.ts and
// tests/branding-phase1.test.ts — vitest runs in a `node` environment here
// (see vitest.config.ts), with no live database wired into the automated
// suite. The behavioral claims below (anon/authenticated can execute,
// wrong credentials fail as normal business-validation errors rather than
// 42501, correct code+email returns exactly the expected booking, one
// booking cannot leak into or be mutated by another lookup/cancel/modify,
// booking_search_availability is unaffected, PostgREST discovers each RPC,
// and every full functional path — including genuine booking_create /
// booking_modify / booking_cancel happy paths — actually works end to
// end) were additionally verified live against a real local disposable
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

const FUNCTIONS: Record<string, string> = {
  booking_lookup: "public.booking_lookup(text, text)",
  booking_create:
    "public.booking_create(uuid, uuid, date, date, integer, integer, text, text, text, text, text, text, text, text)",
  booking_cancel: "public.booking_cancel(text, text)",
  booking_modify: "public.booking_modify(text, text, date, date, integer, integer)",
};

describe("public booking RPC anon-grant incident fix — migration restores all four affected functions (items 1-4)", () => {
  for (const [name, signature] of Object.entries(FUNCTIONS)) {
    it(`restores EXECUTE to anon and authenticated on ${name}'s exact original signature`, () => {
      expect(fix).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO anon;`);
      expect(fix).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO authenticated;`);
    });
  }
});

describe("public booking RPC anon-grant incident fix — PUBLIC pseudo-role and exact signatures (items 6-7)", () => {
  for (const [name, signature] of Object.entries(FUNCTIONS)) {
    it(`explicitly keeps PUBLIC excluded for ${name} (defense-in-depth, matches the original never-granted-to-PUBLIC contract)`, () => {
      expect(fix).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`);
    });
  }

  it("pins the exact identity-argument signature for every function — no ambiguity across overloads", () => {
    expect(fix).toContain("public.booking_lookup(text, text)");
    expect(fix).toContain(
      "public.booking_create(uuid, uuid, date, date, integer, integer, text, text, text, text, text, text, text, text)",
    );
    expect(fix).toContain("public.booking_cancel(text, text)");
    expect(fix).toContain("public.booking_modify(text, text, date, date, integer, integer)");
  });

  it("does not grant service_role on any of the four — none of the original 2026-07-05 contracts included it", () => {
    expect(fix).not.toMatch(/TO[^;]*service_role/);
  });
});

describe("public booking RPC anon-grant incident fix — no unrelated grant is touched (items 9-10, 14)", () => {
  it("never issues a real GRANT/REVOKE statement against booking_search_availability — its grant is already correct and must not be re-issued or disturbed (the migration's own explanatory header comment names it, which is fine — only the executable statements matter here)", () => {
    const statementLines = fix.split("\n").filter((line) => /^(GRANT|REVOKE)\b/.test(line.trim()));
    expect(statementLines.length).toBeGreaterThan(0);
    for (const line of statementLines) {
      expect(line).not.toMatch(/booking_search_availability/);
    }
  });

  it("touches no table, RLS policy, or unrelated function — every GRANT/REVOKE line names one of the four intended functions only", () => {
    expect(fix).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
    expect(fix).not.toMatch(/DROP (FUNCTION|TABLE|POLICY)/);
    expect(fix).not.toMatch(/ALTER TABLE/);
    expect(fix).not.toMatch(/CREATE POLICY/);
    const grantLines = fix.match(/^(GRANT|REVOKE)[^\n]+$/gm) ?? [];
    expect(grantLines.length).toBe(12); // 3 statements (REVOKE ALL, GRANT anon, GRANT authenticated) x 4 functions
    for (const line of grantLines) {
      expect(line).toMatch(/booking_lookup|booking_create|booking_cancel|booking_modify/);
    }
  });

  it("grants no table-level privilege (GRANT ... ON TABLE / ON public.<table>) — function EXECUTE only", () => {
    expect(fix).not.toMatch(/GRANT[^;]*ON (TABLE|public\.(?!booking_))/);
  });
});

describe("public booking RPC anon-grant incident fix — root cause evidence, cross-checked against the actual migration history", () => {
  it("the original migration already granted anon+authenticated to all four at creation time (confirms this is a regression, not functions that were never meant to be public)", () => {
    expect(originalMigration).toContain(
      "GRANT EXECUTE ON FUNCTION public.booking_lookup(text,text) TO anon, authenticated;",
    );
    expect(originalMigration).toContain(
      "GRANT EXECUTE ON FUNCTION public.booking_create(uuid,uuid,date,date,integer,integer,text,text,text,text,text,text,text,text) TO anon, authenticated;",
    );
    expect(originalMigration).toContain(
      "GRANT EXECUTE ON FUNCTION public.booking_cancel(text,text) TO anon, authenticated;",
    );
    expect(originalMigration).toContain(
      "GRANT EXECUTE ON FUNCTION public.booking_modify(text,text,date,date,integer,integer) TO anon, authenticated;",
    );
  });

  it("none of the four were ever redefined after their original creation (no DROP+CREATE, no CREATE OR REPLACE anywhere else) — ruling out a function-replacement grant reset as the cause (item 8)", () => {
    const migrationsDir = resolve(root, "supabase/migrations");
    const files = readdirSync(migrationsDir).filter((f: string) => f.endsWith(".sql"));
    for (const name of Object.keys(FUNCTIONS)) {
      const redefinitions: string[] = [];
      for (const file of files) {
        const text = read(resolve(migrationsDir, file));
        if (new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${name}\\(`).test(text)) {
          redefinitions.push(file);
        }
      }
      expect(redefinitions, name).toEqual([
        "20260705033256_32cbc4d2-9ff4-4c30-8fdc-25259f1d9723.sql",
      ]);
    }
  });

  it("the actual regressing statement is a single, uniform catalog-scan loop over every SECURITY DEFINER function in public, with no function-specific carve-out and no re-grant anywhere in that file", () => {
    expect(secondRevokeMigration).toContain(
      "REVOKE EXECUTE ON FUNCTION %I.%I(%s) FROM PUBLIC, anon",
    );
    expect(secondRevokeMigration).toContain("p.prosecdef = true");
    for (const name of Object.keys(FUNCTIONS)) {
      expect(secondRevokeMigration).not.toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}`),
      );
    }
  });

  it("booking_search_availability received an equivalent restoration a week later; this migration fills the identical gap for the other four", () => {
    expect(searchAvailabilityRestoreMigration).toContain(
      "GRANT EXECUTE ON FUNCTION public.booking_search_availability(uuid, date, date, integer)",
    );
    for (const name of Object.keys(FUNCTIONS)) {
      expect(searchAvailabilityRestoreMigration).not.toMatch(new RegExp(name));
    }
  });
});

describe("public booking RPC anon-grant incident fix — function safety properties (unchanged, verified against each original body) (item 15)", () => {
  function fn(source: string, name: string): string {
    const match = source.match(
      new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}[\\s\\S]*?\\$\\$;`),
    )?.[0];
    if (!match) throw new Error(`Could not find function ${name} in source`);
    return match;
  }

  it("all four are SECURITY DEFINER with search_path pinned — matches the codebase's established hardening convention", () => {
    for (const name of Object.keys(FUNCTIONS)) {
      const body = fn(originalMigration, name);
      expect(body, name).toContain("SECURITY DEFINER");
      expect(body, name).toMatch(/SET search_path = public/);
    }
  });

  it("this migration does not modify any function body — the fix is grants-only for all four, no hardening was found necessary", () => {
    for (const name of Object.keys(FUNCTIONS)) {
      expect(fix).not.toMatch(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${name}`));
    }
  });

  describe("booking_lookup", () => {
    const body = fn(originalMigration, "booking_lookup");
    it("requires BOTH _confirmation_code AND _email (AND, not OR) — item 11's structural guarantee: wrong credentials fail the WHERE match and return zero rows, never a 42501", () => {
      expect(body).toContain("WHERE r.confirmation_code = _confirmation_code");
      expect(body).toContain("AND lower(r.confirmation_email) = lower(_email)");
    });
    it("returns at most one row (LIMIT 1) and no payment-instrument/admin-only fields", () => {
      expect(body).toContain("LIMIT 1;");
      expect(body).not.toMatch(/card|payment_method|token|iban|account_number/i);
    });
  });

  describe("booking_create", () => {
    const body = fn(originalMigration, "booking_create");
    it("checks availability via booking_search_availability (already scoped to is_public/active) BEFORE any insert — a mismatched property/room-type pair or an unavailable room raises before any write (item 13's structural guarantee)", () => {
      expect(body).toContain(
        "FROM public.booking_search_availability(_property_id, _check_in, _check_out, GREATEST(_adults,1))",
      );
      const availabilityCheckIdx = body.indexOf("IF _avail IS NULL OR _avail < 1 THEN");
      const insertIdx = body.indexOf("INSERT INTO public.reservations(");
      expect(availabilityCheckIdx).toBeGreaterThan(-1);
      expect(insertIdx).toBeGreaterThan(availabilityCheckIdx);
    });
    it("hardcodes status to 'confirmed' and computes rate_total server-side — never accepted as client parameters", () => {
      expect(body).not.toMatch(/_status\s+text/);
      expect(body).not.toMatch(/_rate_total\s+numeric/);
      expect(body).toContain("'confirmed', _source, _external_ref,");
    });
    it("accepts no admin/privileged field — parameter list is entirely guest-facing contact and stay details", () => {
      expect(body).not.toMatch(/_role|_permission|_is_admin/i);
    });
  });

  describe("booking_cancel and booking_modify — booking-secret authentication, narrow fields, cross-booking isolation (items 11-12)", () => {
    it("both require an exact confirmation_code + email match before selecting any row — no reservation id/uuid parameter exists, so one booking can never mutate another", () => {
      for (const name of ["booking_cancel", "booking_modify"]) {
        const body = fn(originalMigration, name);
        expect(body, name).toContain("WHERE confirmation_code");
        expect(body, name).toMatch(/confirmation_code\s*[=,]\s*_confirmation_code/);
        expect(body, name).not.toMatch(/_reservation_id|_id\s+uuid/);
        expect(body, name).toContain(
          "IF r IS NULL THEN RAISE EXCEPTION 'Booking not found'; END IF;",
        );
      }
    });

    it("booking_modify only accepts check_in/check_out/adults/children — property_id, room_type_id, and guest_id are never modifiable", () => {
      const body = fn(originalMigration, "booking_modify");
      expect(body).toContain(
        "_confirmation_code text, _email text,\n  _check_in date, _check_out date, _adults integer, _children integer",
      );
      expect(body).not.toMatch(/_property_id|_room_type_id|_guest_id/);
    });

    it("booking_modify blocks modifying a reservation that is not 'confirmed', and re-checks availability for the new dates excluding itself", () => {
      const body = fn(originalMigration, "booking_modify");
      expect(body).toContain(
        "IF r.status NOT IN ('confirmed') THEN RAISE EXCEPTION 'Booking cannot be modified in status %', r.status; END IF;",
      );
      expect(body).toContain("AND id != r.id");
    });

    it("booking_cancel blocks cancelling a checked_in or checked_out reservation", () => {
      const body = fn(originalMigration, "booking_cancel");
      expect(body).toContain(
        "IF r.status = 'checked_in' OR r.status = 'checked_out' THEN RAISE EXCEPTION 'Cannot cancel a % booking', r.status; END IF;",
      );
    });
  });
});
