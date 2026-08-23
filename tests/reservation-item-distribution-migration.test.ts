import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Source-level checks on the migration itself, mirroring the established
// convention in this repo (see tests/inventory-import-migration.test.ts)
// for pinning safety-critical SQL properties that live-database validation
// (run manually against a local disposable Postgres, see the PR
// description) already confirmed behaviorally — including the atomicity
// proof (overflow-forced rollback leaves 0 orphaned ledger rows and an
// unchanged item_stock quantity) and the zero-financial-side-effect proof
// (reservation_charges/payments/journal_entries/pos_orders all stayed at
// count 0 across every issue/return/adjustment scenario tested).

const migration = readFileSync(
  resolve(__dirname, "../supabase/migrations/20260823170000_reservation_item_distribution.sql"),
  "utf8",
);

describe("reservation_item_distributions — event-ledger shape, history never rewritten", () => {
  it("creates one append-only ledger table, not a mutable running-total row", () => {
    expect(migration).toContain("CREATE TABLE public.reservation_item_distributions");
    expect(migration).toContain(
      "action TEXT NOT NULL CHECK (action IN ('issue', 'return', 'adjustment'))",
    );
    expect(migration).not.toMatch(/quantity_issued|quantity_returned/);
  });

  it("captures room_id/guest_id at event time (not a live join to reservations), so history survives a later room reassignment", () => {
    expect(migration).toMatch(/room_id UUID REFERENCES public\.rooms\(id\) ON DELETE SET NULL/);
    expect(migration).toMatch(/guest_id UUID REFERENCES public\.guests\(id\) ON DELETE SET NULL/);
  });

  it("quantity is always positive -- direction is implied by action/stock_direction, never a signed quantity column", () => {
    expect(migration).toContain("quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0)");
  });

  it("a return/adjustment always references its original issue row, and the shape CHECK enforces action-specific column combinations", () => {
    expect(migration).toMatch(
      /CHECK \(\s*\(action = 'issue' AND related_distribution_id IS NULL AND stock_direction IS NULL\)\s*OR \(action = 'return' AND related_distribution_id IS NOT NULL AND stock_direction IS NULL\)\s*OR \(action = 'adjustment' AND related_distribution_id IS NOT NULL AND stock_direction IS NOT NULL\)\s*\)/,
    );
  });

  it("actor_id is NOT NULL and has no default -- every RPC must supply it from auth.uid(), never trusted as a plain insert default", () => {
    expect(migration).toContain("actor_id UUID NOT NULL REFERENCES auth.users(id)");
  });

  it("request_id is NOT NULL on every row and unique per property -- issue/return/adjustment are all replay-protected identically", () => {
    expect(migration).toContain("request_id UUID NOT NULL");
    expect(migration).toContain("UNIQUE (property_id, request_id)");
  });
});

describe("Idempotency -- replaying the same request_id must not apply a mutation twice (client requirement: authoritative server-side dedup, not a client-side disabled button)", () => {
  it("every mutating RPC requires a non-null request_id before doing anything else", () => {
    const occurrences =
      migration.match(
        /IF _request_id IS NULL THEN\s*\n\s*RAISE EXCEPTION 'A request id is required';/g,
      ) ?? [];
    expect(occurrences.length).toBe(3);
  });

  it("every mutating RPC takes a transaction-scoped advisory lock keyed on request_id, BEFORE any existing-row check or mutation -- this is what makes truly concurrent duplicate requests serialize instead of racing", () => {
    const occurrences =
      migration.match(
        /PERFORM pg_advisory_xact_lock\(hashtextextended\(_request_id::text, 0\)\);/g,
      ) ?? [];
    expect(occurrences.length).toBe(3);
    // Must appear before the corresponding existing-row check in each function.
    for (const [fnName, checkFragment] of [
      [
        "issue_reservation_item",
        "SELECT id INTO _existing_id FROM public.reservation_item_distributions",
      ],
      [
        "return_reservation_item",
        "SELECT id INTO _existing_id FROM public.reservation_item_distributions",
      ],
      [
        "adjust_reservation_item_distribution",
        "SELECT id INTO _existing_id FROM public.reservation_item_distributions",
      ],
    ] as const) {
      const fnStart = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${fnName}`);
      const lockIdx = migration.indexOf("PERFORM pg_advisory_xact_lock", fnStart);
      const checkIdx = migration.indexOf(checkFragment, fnStart);
      expect(lockIdx).toBeGreaterThan(fnStart);
      expect(lockIdx).toBeLessThan(checkIdx);
    }
  });

  it("every mutating RPC checks for an existing row with the same (property_id, request_id) and returns its id immediately on a replay -- a clean answer, not a raw constraint-violation error", () => {
    const occurrences =
      migration.match(
        /WHERE property_id = (?:res|orig)\.property_id AND request_id = _request_id;\s*\n\s*IF _existing_id IS NOT NULL THEN\s*\n\s*RETURN _existing_id;\s*\n\s*END IF;/g,
      ) ?? [];
    expect(occurrences.length).toBe(3);
  });

  it("the existing-request-id check happens AFTER the role check but BEFORE any business validation or stock mutation -- an unauthorized caller can never probe for a real event id via replay, and a replay never re-runs validation/mutation", () => {
    for (const fnName of [
      "issue_reservation_item",
      "return_reservation_item",
      "adjust_reservation_item_distribution",
    ] as const) {
      const fnStart = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${fnName}`);
      const fnEnd = migration.indexOf("\n$$;", fnStart);
      const body = migration.slice(fnStart, fnEnd);
      const roleCheckIdx = body.indexOf("has_any_role");
      const existingCheckIdx = body.indexOf("_existing_id IS NOT NULL");
      const applyStockIdx = body.indexOf("apply_stock_delta");
      expect(roleCheckIdx).toBeGreaterThan(-1);
      expect(existingCheckIdx).toBeGreaterThan(roleCheckIdx);
      if (applyStockIdx > -1) {
        expect(existingCheckIdx).toBeLessThan(applyStockIdx);
      }
    }
  });

  it("every INSERT into the ledger persists request_id -- the replay-detection column is actually populated, not just checked", () => {
    expect(migration).toContain("'issue', _quantity, _notes, auth.uid(), _request_id");
    expect(migration).toContain("'return', _quantity, orig.id, _notes, auth.uid(), _request_id");
    expect(migration).toContain(
      "'adjustment', _quantity, orig.id, _stock_direction, _reason, auth.uid(), _request_id",
    );
  });

  it("uses an advisory lock (auto-released on commit or rollback), never an explicit unlock -- a failed transaction can never leave the request_id permanently locked out", () => {
    expect(migration).not.toMatch(/pg_advisory_unlock/);
    // pg_advisory_XACT_lock specifically (not the session-scoped variant)
    // is what guarantees release on rollback without any unlock call.
    expect(migration).toMatch(/pg_advisory_xact_lock/);
    expect(migration).not.toMatch(/pg_advisory_lock\(/);
  });
});

describe("reservation_item_distributions — RLS: read-only to authenticated, mutation is RPC-only", () => {
  it("grants SELECT only to authenticated -- no direct INSERT/UPDATE/DELETE grant", () => {
    expect(migration).toContain(
      "GRANT SELECT ON public.reservation_item_distributions TO authenticated",
    );
    expect(migration).not.toMatch(
      /GRANT (SELECT, )?INSERT.*ON public\.reservation_item_distributions TO authenticated/,
    );
  });

  it("the one RLS policy is a SELECT policy scoped by can_access_property", () => {
    expect(migration).toContain(
      "CREATE POLICY rid_read ON public.reservation_item_distributions FOR SELECT TO authenticated",
    );
    expect(migration).toContain("public.can_access_property(auth.uid(), property_id)");
  });
});

describe("issue_reservation_item — role/property/state checks, floor-checked under a row lock, uses apply_stock_delta", () => {
  it("derives property_id from the reservation, never accepts it as a parameter", () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.issue_reservation_item\(\s*_reservation_id UUID,\s*_inventory_item_id UUID,\s*_location_id UUID,\s*_quantity NUMERIC,\s*_request_id UUID,\s*_notes TEXT DEFAULT NULL\s*\)/,
    );
    expect(migration).not.toMatch(/issue_reservation_item\([^)]*_property_id/);
  });

  it("requires the broader issue/return role set, scoped to the reservation's own property", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.issue_reservation_item");
    const end = migration.indexOf("CREATE OR REPLACE FUNCTION public.return_reservation_item");
    const body = migration.slice(start, end);
    expect(body).toMatch(
      /ARRAY\['super_admin','hotel_owner','general_manager','front_desk','housekeeping_supervisor','housekeeping','storekeeper'\]::app_role\[\]/,
    );
  });

  it("only allows issuing to a checked_in reservation", () => {
    expect(migration).toContain("IF res.status <> 'checked_in' THEN");
    expect(migration).toMatch(
      /RAISE EXCEPTION 'Items can only be issued to a checked-in reservation/,
    );
  });

  it("independently verifies the item and location both belong to the reservation's own property (never trusts the client pairing)", () => {
    expect(migration).toMatch(
      /SELECT 1 FROM public\.inventory_items WHERE id = _inventory_item_id AND property_id = res\.property_id AND active/,
    );
    expect(migration).toMatch(
      /SELECT 1 FROM public\.stock_locations WHERE id = _location_id AND property_id = res\.property_id/,
    );
  });

  it("locks the item_stock row with FOR UPDATE before checking availability -- the database, not the client's displayed quantity, is authoritative", () => {
    expect(migration).toMatch(
      /FROM public\.item_stock\s*\n\s*WHERE item_id = _inventory_item_id AND location_id = _location_id\s*\n\s*FOR UPDATE/,
    );
    expect(migration).toContain("IF COALESCE(_current_qty, 0) < _quantity THEN");
  });

  it("uses apply_stock_delta() as the sole quantity-mutation path (never writes item_stock directly)", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.issue_reservation_item");
    const end = migration.indexOf("CREATE OR REPLACE FUNCTION public.return_reservation_item");
    const body = migration.slice(start, end);
    expect(body).toMatch(
      /PERFORM public\.apply_stock_delta\(res\.property_id, _inventory_item_id, _location_id, -_quantity\)/,
    );
    expect(body).not.toMatch(/UPDATE public\.item_stock/);
  });

  it("calls audit_capture in the same transaction as the mutation", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.issue_reservation_item");
    const end = migration.indexOf("CREATE OR REPLACE FUNCTION public.return_reservation_item");
    const body = migration.slice(start, end);
    expect(body).toContain("PERFORM public.audit_capture(");
    expect(body).toContain("'reservation_item_distribution'");
  });

  it("never creates a reservation_charges, payments, journal_entries, or pos_orders row -- issuing is not automatically billing", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.issue_reservation_item");
    const end = migration.indexOf("CREATE OR REPLACE FUNCTION public.return_reservation_item");
    const body = migration.slice(start, end);
    expect(body).not.toMatch(/reservation_charges|public\.payments|journal_entries|pos_orders/);
  });

  it("is SECURITY DEFINER with a hardened search_path, granted to authenticated only after revoking from PUBLIC", () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.issue_reservation_item[\s\S]{0,600}SECURITY DEFINER/,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.issue_reservation_item\([\s\S]{0,80}\) FROM PUBLIC/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.issue_reservation_item\([\s\S]{0,80}\) TO authenticated/,
    );
  });
});

describe("return_reservation_item — locks the original issue row, outstanding-bounded, restores stock to the same location", () => {
  it("locates and locks the original issue row with FOR UPDATE, so concurrent returns against the same issue serialize", () => {
    expect(migration).toMatch(
      /SELECT \* INTO orig FROM public\.reservation_item_distributions\s*\n\s*WHERE id = _distribution_id AND action = 'issue' FOR UPDATE/,
    );
  });

  it("computes outstanding from the full related-rows aggregate before allowing a return", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.return_reservation_item");
    const end = migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.adjust_reservation_item_distribution",
    );
    const body = migration.slice(start, end);
    expect(body).toContain("IF _quantity > _outstanding THEN");
    expect(body).toMatch(/RAISE EXCEPTION 'Return exceeds outstanding quantity/);
  });

  it("restores stock to the SAME item/location the original issue came from", () => {
    expect(migration).toMatch(
      /PERFORM public\.apply_stock_delta\(orig\.property_id, orig\.inventory_item_id, orig\.location_id, _quantity\)/,
    );
  });

  it("never deletes or updates the original issue row -- inserts a new 'return' row instead", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.return_reservation_item");
    const end = migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.adjust_reservation_item_distribution",
    );
    const body = migration.slice(start, end);
    expect(body).not.toMatch(/UPDATE public\.reservation_item_distributions/);
    expect(body).not.toMatch(/DELETE FROM public\.reservation_item_distributions/);
    expect(body).toContain("'return', _quantity, orig.id, _notes, auth.uid()");
  });
});

describe("adjust_reservation_item_distribution — narrower supervisory role set, mandatory reason, explicit stock direction", () => {
  it("requires the same role set as the existing stock_adjustments precedent, not the broader issue/return set", () => {
    const start = migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.adjust_reservation_item_distribution",
    );
    const body = migration.slice(start);
    expect(body).toMatch(
      /ARRAY\['super_admin','hotel_owner','general_manager','housekeeping_supervisor'\]::app_role\[\]/,
    );
    expect(body).not.toMatch(/'front_desk'|'storekeeper'/);
  });

  it("rejects a blank reason", () => {
    expect(migration).toContain("IF _reason IS NULL OR btrim(_reason) = '' THEN");
    expect(migration).toMatch(/RAISE EXCEPTION 'A reason is required for an adjustment'/);
  });

  it("supports exactly three stock directions with distinct, explicit stock effects", () => {
    expect(migration).toContain("IF _stock_direction NOT IN ('restore', 'deduct', 'none') THEN");
    expect(migration).toContain("IF _stock_direction = 'restore' THEN");
    expect(migration).toContain("ELSIF _stock_direction = 'deduct' THEN");
    // 'none' (write-off) intentionally has no apply_stock_delta call at all.
    const noneComment = migration.match(/-- 'none' \(write-off\): no stock movement at all\./);
    expect(noneComment).not.toBeNull();
  });

  it("'restore' and 'none' are bounded by outstanding; 'deduct' is floor-checked against current item_stock instead", () => {
    const start = migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.adjust_reservation_item_distribution",
    );
    const body = migration.slice(start);
    expect(body).toMatch(/IF _stock_direction IN \('restore', 'none'\) THEN/);
    expect(body).toMatch(/RAISE EXCEPTION 'Adjustment exceeds outstanding quantity/);
    expect(body).toMatch(/RAISE EXCEPTION 'Insufficient stock for this adjustment/);
  });

  it("locks item_stock with FOR UPDATE before a 'deduct' adjustment, same as issue's own floor-check", () => {
    const start = migration.indexOf("ELSIF _stock_direction = 'deduct' THEN");
    const end = migration.indexOf("END IF;", start);
    const body = migration.slice(start, end);
    expect(body).toContain("FOR UPDATE");
  });
});

describe("all three RPCs are purely additive -- no destructive change to any existing table/function", () => {
  it("contains no DROP/TRUNCATE, and the only ALTER TABLE is enabling RLS on this migration's own new table", () => {
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION)\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    const alterStatements = migration.match(/ALTER TABLE [^\n;]+/g) ?? [];
    for (const stmt of alterStatements) {
      expect(stmt).toContain("public.reservation_item_distributions ENABLE ROW LEVEL SECURITY");
    }
    expect(alterStatements.length).toBe(1);
  });
});
