import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Unified POS Executive Dashboard — PR-A: the exec_pos_* analytical RPCs.
//
// Structural (source-text) tests over the real migration, following this
// repo's established convention for migration contracts. The BEHAVIOURAL
// proof for these functions was performed separately against a real
// disposable local Postgres (supabase start + db reset) with fixtures
// spanning two properties (different base_currency), three outlets
// including restaurant/bar kinds, four users, cash/card/mobile_money/
// bank_transfer payments, multi-payment and multi-item orders, all five
// order statuses, boundary dates and an empty outlet -- results quoted in
// the PR description. CI has no Postgres, so those runs cannot be
// re-executed here; what this file guarantees is that the SQL semantics
// they validated cannot be silently changed afterwards.

const root = resolve(__dirname, "..");
const migration = readFileSync(
  resolve(root, "supabase/migrations/20260826090000_exec_pos_dashboard_rpcs.sql"),
  "utf8",
).replace(/\r\n/g, "\n");

// Strip -- comments before asserting on SQL: the header documents, in
// prose, the very things some assertions forbid (e.g. "SECURITY DEFINER"),
// which would otherwise make those checks false-positive against the
// explanation rather than the code.
const sql = migration.replace(/--[^\n]*/g, "");

const FUNCTIONS = [
  "exec_pos_summary",
  "exec_pos_by_department",
  "exec_pos_by_user",
  "exec_pos_top_items",
  "exec_pos_sales_by_period",
] as const;

function bodyOf(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} must be defined`).toBeGreaterThan(-1);
  const end = sql.indexOf("\n$$;", start);
  expect(end, `${name} must terminate`).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe("exec_pos_* — security posture", () => {
  it("defines exactly the five approved functions and no others", () => {
    const defined = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map(
      (m) => m[1],
    );
    expect(defined.sort()).toEqual([...FUNCTIONS].sort());
  });

  for (const fn of FUNCTIONS) {
    it(`${fn} is SECURITY INVOKER, never SECURITY DEFINER`, () => {
      const body = bodyOf(fn);
      expect(body).toContain("SECURITY INVOKER");
      expect(body).not.toMatch(/SECURITY DEFINER/);
    });

    it(`${fn} is STABLE and pins search_path`, () => {
      const body = bodyOf(fn);
      expect(body).toContain("STABLE");
      expect(body).toContain("SET search_path = public");
    });

    it(`${fn} requires _property_id as its first parameter`, () => {
      expect(bodyOf(fn)).toMatch(
        new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(\\s*\\n?\\s*_property_id uuid`),
      );
    });

    it(`${fn} gates on the same admin/accountant boundary Executive Analytics already uses`, () => {
      expect(bodyOf(fn)).toContain(
        "ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id)",
      );
    });
  }

  it("grants EXECUTE to authenticated only, revoking PUBLIC and anon for every function", () => {
    for (const fn of FUNCTIONS) {
      const revoke = new RegExp(
        `REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon;`,
      );
      const grant = new RegExp(
        `GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO authenticated;`,
      );
      expect(sql, `${fn} revoke`).toMatch(revoke);
      expect(sql, `${fn} grant`).toMatch(grant);
    }
    expect(sql).not.toMatch(/GRANT[^;]*TO\s+anon/);
    expect(sql).not.toMatch(/GRANT[^;]*TO\s+PUBLIC/);
  });

  it("contains no dynamic SQL — no EXECUTE, no format(), no string-built statements", () => {
    expect(sql).not.toMatch(/\bEXECUTE\s+(?!ON FUNCTION)/i);
    expect(sql).not.toMatch(/\bformat\s*\(/i);
    expect(sql).not.toMatch(/\bquote_ident\b|\bquote_literal\b/i);
  });

  it("is purely additive — no table, column, index, policy, trigger or data change", () => {
    expect(sql).not.toMatch(/\bCREATE TABLE\b|\bALTER TABLE\b|\bDROP TABLE\b/i);
    expect(sql).not.toMatch(/\bCREATE INDEX\b|\bDROP INDEX\b/i);
    expect(sql).not.toMatch(/\bCREATE POLICY\b|\bALTER POLICY\b|\bDROP POLICY\b/i);
    expect(sql).not.toMatch(/\bCREATE TRIGGER\b|\bDROP TRIGGER\b/i);
    expect(sql).not.toMatch(/\bINSERT INTO\b|\bUPDATE\s+public\.|\bDELETE FROM\b|\bTRUNCATE\b/i);
  });
});

describe("exec_pos_* — property isolation and cross-property safety", () => {
  for (const fn of FUNCTIONS) {
    it(`${fn} constrains every aggregate to the requested property`, () => {
      const body = bodyOf(fn);
      expect(body).toMatch(/property_id = _property_id/);
    });
  }

  it("never aggregates across properties — no query omits the property predicate", () => {
    // Each FROM/JOIN of a POS table must be accompanied by a property
    // predicate somewhere in its statement. Assert the inverse: the
    // property parameter is never compared to anything but property_id,
    // and no IN/ANY list of properties is ever built.
    expect(sql).not.toMatch(/property_id\s+IN\s*\(/i);
    expect(sql).not.toMatch(/property_id\s*=\s*ANY/i);
    expect(sql).not.toMatch(/JOIN\s+properties\b/i);
  });

  it("returns no currency code or symbol — money is emitted as bare numeric fact only", () => {
    expect(sql).not.toMatch(/base_currency|currencies\b/i);
    expect(migration).not.toMatch(/GH₵|\bGHS\b|\bUSD\b|\$\d|'\$'/);
  });
});

describe("exec_pos_summary — semantics", () => {
  const body = () => bodyOf("exec_pos_summary");

  it("derives completed sales from pos_orders only (never multiplied by items or payments)", () => {
    const closed = body().slice(body().indexOf("WITH closed AS"), body().indexOf("live AS"));
    expect(closed).toContain("FROM pos_orders o");
    expect(closed).not.toMatch(/JOIN\s+pos_order_items|JOIN\s+pos_payments/);
  });

  it("counts only genuinely closed orders, requiring a non-null closed_at", () => {
    expect(body()).toContain("o.status = 'closed'");
    expect(body()).toContain("o.closed_at IS NOT NULL");
  });

  it("uses closed_at (completion), inclusive on both bounds, for completed sales", () => {
    expect(body()).toContain("o.closed_at::date BETWEEN _from AND _to");
  });

  it("treats live/open orders as a point-in-time snapshot, deliberately NOT date-filtered", () => {
    const live = body().slice(body().indexOf("live AS"), body().indexOf("pay AS"));
    expect(live).toContain("o.status IN ('open','sent','served')");
    expect(live).not.toMatch(/_from|_to|closed_at|opened_at/);
  });

  it("derives payment-method figures from pos_payments, scoped via the parent order, excluding voids", () => {
    const pay = body().slice(body().indexOf("pay AS"));
    expect(pay).toContain("FROM pos_payments p");
    expect(pay).toContain("JOIN pos_orders o ON o.id = p.order_id");
    expect(pay).toContain("o.status <> 'void'");
    expect(pay).toContain("p.received_at::date BETWEEN _from AND _to");
    // Payment amounts must come from p.amount, never the order total.
    expect(pay).not.toMatch(/SUM\(o\.total\)/);
  });

  it("reports every payment_method enum member separately, with no refund or discount metric", () => {
    for (const m of ["cash", "card", "mobile_money", "bank_transfer", "wallet", "other"]) {
      expect(body()).toContain(`p.method = '${m}'`);
    }
    expect(sql).not.toMatch(/refund/i);
    expect(sql).not.toMatch(/discount/i);
  });
});

describe("exec_pos_by_department — semantics", () => {
  const body = () => bodyOf("exec_pos_by_department");

  it("groups by the real pos_outlets relationship, exposing outlet kind", () => {
    expect(body()).toContain("FROM pos_outlets ou");
    expect(body()).toContain("ou.kind::text");
    expect(body()).toContain("GROUP BY ou.id, ou.name, ou.kind");
  });

  it("LEFT JOINs orders so an outlet with no sales returns an explicit zero rather than vanishing", () => {
    expect(body()).toContain("LEFT JOIN pos_orders o");
    expect(body()).toContain("COALESCE(SUM(o.total), 0)");
  });

  it("restricts outlets to the requested property and counts only closed, in-range orders", () => {
    expect(body()).toContain("WHERE ou.property_id = _property_id");
    expect(body()).toContain("o.status = 'closed'");
    expect(body()).toContain("o.closed_at::date BETWEEN _from AND _to");
  });
});

describe("exec_pos_by_user — semantics", () => {
  const body = () => bodyOf("exec_pos_by_user");

  it("reports order-creator and payment-receiver as two separate, explicitly named domains", () => {
    expect(body()).toContain("orders_created_count");
    expect(body()).toContain("orders_created_value");
    expect(body()).toContain("payments_received_count");
    expect(body()).toContain("payments_received_value");
  });

  it("never labels either domain 'salesperson', which the schema cannot prove", () => {
    // Against comment-stripped SQL: the header legitimately uses the word
    // while explaining why no COLUMN is named that. What must hold is that
    // no identifier in the code itself claims that meaning.
    expect(sql).not.toMatch(/salesperson|sales_person|sold_by/i);
  });

  it("sources the creator domain from pos_orders.created_by and the receiver domain from pos_payments.received_by", () => {
    expect(body()).toContain("SELECT o.created_by AS uid");
    expect(body()).toContain("SELECT p.received_by AS uid");
  });

  it("FULL OUTER JOINs the two domains so a payment-only user is not dropped", () => {
    expect(body()).toContain("FULL OUTER JOIN receivers r ON r.uid = c.uid");
    expect(body()).toContain("COALESCE(c.uid, r.uid)");
  });
});

describe("exec_pos_top_items — semantics", () => {
  const body = () => bodyOf("exec_pos_top_items");

  it("aggregates pos_order_items reached through their parent order", () => {
    expect(body()).toContain("FROM pos_order_items i");
    expect(body()).toContain("JOIN pos_orders o ON o.id = i.order_id");
  });

  it("excludes voided orders and restricts to closed, in-range parents", () => {
    expect(body()).toContain("o.status = 'closed'");
    expect(body()).toContain("o.closed_at::date BETWEEN _from AND _to");
  });

  it("groups by name_snapshot, not the nullable menu_item_id", () => {
    expect(body()).toContain("GROUP BY i.name_snapshot");
    expect(body()).not.toMatch(/GROUP BY[^\n]*menu_item_id/);
  });

  it("values lines at the historical price_snapshot, not today's menu price", () => {
    expect(body()).toContain("SUM(i.price_snapshot * i.quantity)");
    expect(body()).not.toMatch(/pos_menu_items/);
  });

  it("counts DISTINCT parent orders so multiple lines of one item don't inflate order_count", () => {
    expect(body()).toContain("COUNT(DISTINCT i.order_id)");
  });

  it("bounds _limit defensively rather than trusting the caller", () => {
    expect(body()).toContain("LIMIT GREATEST(1, LEAST(COALESCE(_limit, 10), 100))");
  });
});

describe("exec_pos_sales_by_period — semantics", () => {
  const body = () => bodyOf("exec_pos_sales_by_period");

  it("validates _granularity against a fixed allow-list and raises otherwise", () => {
    expect(body()).toContain("IF _g NOT IN ('day','month') THEN");
    expect(body()).toContain("RAISE EXCEPTION");
  });

  it("aggregates server-side so the browser never downloads all transactions", () => {
    expect(body()).toContain("SUM(o.total)");
    expect(body()).toContain("generate_series");
  });

  it("gap-fills every period so an empty day/month is an explicit zero, not a missing point", () => {
    expect(body()).toContain("LEFT JOIN pos_orders o");
    expect(body()).toContain("COALESCE(SUM(o.total), 0)");
  });

  it("anchors the monthly series to the month start so a mid-month _from still yields that month", () => {
    expect(body()).toContain("date_trunc('month', _from::timestamp)");
    expect(body()).toContain("date_trunc('month', o.closed_at::date)::date = s.p");
  });

  it("counts only closed, non-void orders in both granularities", () => {
    const occurrences = body().match(/o\.status = 'closed'/g) ?? [];
    expect(occurrences.length).toBe(2);
  });
});
