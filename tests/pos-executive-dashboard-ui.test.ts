import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { staffLabel } from "@/lib/pos-staff-label";

// PR-B — Unified POS Executive Dashboard UI.
//
// Behavioural tests cover the pure logic the route exports (staffLabel).
// The rest are contract tests over the real source: mounting this route
// would require standing up TanStack Router, five server functions and a
// Supabase client, which tests the harness more than the dashboard. The
// figures themselves are already proven behaviourally against a real
// PostgreSQL by the PR-A suites; what must be guarded here is that the UI
// consumes those RPCs faithfully -- right property, right currency source,
// no client-side re-aggregation, and no metric the schema cannot support.

const root = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n");

const route = read("src/routes/_authenticated/analytics_.pos.tsx");
const fns = read("src/lib/pos-analytics.functions.ts");
// Comments legitimately discuss things the assertions forbid (e.g. the word
// "refund" when explaining its absence), so strip them before matching.
const routeCode = route.replace(/\/\/[^\n]*/g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const fnsCode = fns.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("staffLabel — behavioural", () => {
  it("prefers a real full name", () => {
    expect(staffLabel({ full_name: "Ama Mensah", user_id: "abcdef12-3456" })).toBe("Ama Mensah");
  });

  it("falls back to a shortened id when full_name is NULL (a real production case)", () => {
    expect(staffLabel({ full_name: null, user_id: "abcdef12-3456-7890-abcd-ef1234567890" })).toBe(
      "Staff abcdef12",
    );
  });

  it("treats a blank/whitespace name as missing", () => {
    expect(staffLabel({ full_name: "   ", user_id: "abcdef12-3456" })).toBe("Staff abcdef12");
  });

  it("never renders a raw full UUID", () => {
    const uuid = "abcdef12-3456-7890-abcd-ef1234567890";
    expect(staffLabel({ full_name: null, user_id: uuid })).not.toContain(uuid);
  });

  it("degrades honestly when there is no identifier at all", () => {
    expect(staffLabel({ full_name: null, user_id: null })).toBe("Unknown staff");
  });
});

describe("data-access layer", () => {
  it("wraps all five exec_pos_* RPCs and no others", () => {
    const called = [...fnsCode.matchAll(/callPosRpc\(context\.supabase, "(\w+)"/g)]
      .map((m) => m[1])
      .sort();
    expect(called).toEqual([
      "exec_pos_by_department",
      "exec_pos_by_user",
      "exec_pos_sales_by_period",
      "exec_pos_summary",
      "exec_pos_top_items",
    ]);
  });

  it("uses createServerFn with the authenticated Supabase middleware and zod validation", () => {
    expect(fnsCode).toContain('createServerFn({ method: "POST" })');
    expect(fnsCode).toContain("requireSupabaseAuth");
    expect(fnsCode).toContain('from "zod"');
    expect((fnsCode.match(/\.inputValidator\(/g) ?? []).length).toBe(5);
  });

  it("validates property as a uuid and dates as date-only strings", () => {
    expect(fnsCode).toContain("propertyId: z.string().uuid()");
    expect(fnsCode).toMatch(/from: z\.string\(\)\.regex\(\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//);
  });

  it("constrains granularity to the values the RPC accepts", () => {
    expect(fnsCode).toContain('granularity: z.enum(["day", "month"])');
  });

  it("bounds the top-items limit to the RPC's supported range", () => {
    expect(fnsCode).toContain("limit: z.number().int().min(1).max(100).optional()");
  });

  it("passes the caller's property/date arguments straight through to every RPC", () => {
    expect((fnsCode.match(/_property_id: data\.propertyId/g) ?? []).length).toBe(5);
    expect((fnsCode.match(/_from: data\.from/g) ?? []).length).toBe(5);
    expect((fnsCode.match(/_to: data\.to/g) ?? []).length).toBe(5);
  });

  it("returns null (not fabricated zeroes) when the summary RPC yields no row", () => {
    expect(fnsCode).toContain("return rows[0] ?? null;");
  });

  it("does not opt out of type checking with `any`", () => {
    expect(fnsCode).not.toMatch(/\bany\b/);
  });

  it("performs no aggregation of its own — it is a pass-through to the RPCs", () => {
    expect(fnsCode).not.toMatch(/\.reduce\(|\.filter\(|\bsum\b/i);
  });
});

describe("route — access control", () => {
  it("gates on the same Executive role set the RPCs enforce", () => {
    expect(routeCode).toContain("useHasAnyRole(EXEC_ROLES, propertyId)");
    expect(routeCode).toContain('from "@/hooks/use-user-roles"');
  });

  it("renders AccessDenied rather than an empty dashboard for non-Executive users", () => {
    expect(routeCode).toContain("if (!allowed)");
    expect(routeCode).toContain("<AccessDenied");
  });

  it("does not invent a new permission module or capability", () => {
    expect(routeCode).not.toMatch(/usePermission\(|module:\s*"/);
  });

  it("waits for the role check before deciding access", () => {
    expect(routeCode).toContain("if (rolesLoading)");
  });
});

describe("route — active property only", () => {
  it("reads the active property and disables every query without one", () => {
    expect(routeCode).toContain("const propertyId = useActiveProperty();");
    // The range half of this condition is named so the sections can distinguish
    // "no rows came back" from "the query never ran" -- same operands, same
    // meaning. See pos-executive-dashboard-pr-b-findings.test.ts.
    expect(routeCode).toContain("const rangeRequested = from <= to;");
    expect(routeCode).toContain("const enabled = !!propertyId && allowed && rangeRequested;");
  });

  it("includes the property in every dashboard query key, so a switch cannot serve stale rows", () => {
    const keys = [...routeCode.matchAll(/queryKey: \[([^\]]+)\]/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(6);
    for (const k of keys) {
      expect(k, `query key must be property-scoped: ${k}`).toMatch(/args|propertyId/);
    }
  });

  it("builds one args object carrying the property and range for all RPC calls", () => {
    expect(routeCode).toContain("const args = { propertyId: propertyId!, from, to };");
  });

  it("never aggregates across properties or infers an organisation", () => {
    expect(routeCode).not.toMatch(
      /properties\s*\.\s*map|allProperties|organization|parent_property/i,
    );
    // The only properties table read is the single active property's own row.
    expect(routeCode).toContain('.eq("id", propertyId!)');
  });
});

describe("route — currency", () => {
  it("resolves currency from the active property's base_currency", () => {
    expect(routeCode).toContain('.select("name, base_currency")');
    expect(routeCode).toContain("execCurrency(property.data?.base_currency)");
  });

  it("formats every monetary value through execMoney with that currency", () => {
    expect(routeCode).toContain("const money = (v: unknown) => execMoney(v, currency);");
  });

  it("hardcodes no currency symbol or code anywhere", () => {
    expect(route).not.toMatch(/GH₵|\bGHS\b|\bAUD\b|\bUSD\b|€|£/);
    // A bare "$" would also be wrong; allow none outside template syntax.
    expect(routeCode).not.toMatch(/["'`]\s*\$\s*["'`]/);
  });

  it("renders counts and quantities with execNumber, never the money formatter", () => {
    expect(routeCode).toContain("execNumber(s.closed_order_count)");
    expect(routeCode).toContain("execNumber(s.open_order_count)");
    expect(routeCode).toContain("execNumber(s.void_order_count)");
    expect(routeCode).toContain("execNumber(u.orders_created_count)");
    expect(routeCode).toContain("execNumber(i.total_quantity)");
  });

  it("uses the money formatter inside chart tooltips too", () => {
    expect((routeCode.match(/formatter=\{\(v: number\) => money\(v\)\}/g) ?? []).length).toBe(2);
  });
});

describe("route — date range", () => {
  it("formats date-only values with date-fns, never toISOString", () => {
    expect(routeCode).toContain('const dateKey = (d: Date) => format(d, "yyyy-MM-dd");');
    expect(routeCode).not.toMatch(/toISOString\(\)/);
  });

  it("defaults to month-to-date and offers a reset", () => {
    expect(routeCode).toContain("useState(dateKey(startOfMonth(today)))");
    expect(routeCode).toContain("Reset");
  });

  it("carries from/to in the shared args so a range change refetches every query", () => {
    expect(routeCode).toContain("const args = { propertyId: propertyId!, from, to };");
  });

  it("refuses to query an inverted range and says so", () => {
    expect(routeCode).toContain("from <= to");
    expect(routeCode).toContain("The start date is after the end date");
  });

  it("labels the period actually being shown", () => {
    expect(routeCode).toContain("const rangeLabel = `${from} → ${to}`;");
  });
});

describe("route — KPI truthfulness", () => {
  it("shows the corrected PR-A field names", () => {
    for (const f of [
      "operational_sales",
      "operational_sales_net",
      "operational_tax",
      "closed_order_count",
      "void_order_count",
      "open_order_count",
      "open_order_line_value",
      "till_payment_amount",
      "folio_posted_amount",
    ]) {
      expect(routeCode, `${f} must be displayed`).toContain(f);
    }
  });

  it("never references the superseded pre-correction field names", () => {
    expect(routeCode).not.toMatch(/gross_sales|open_order_value\b/);
  });

  it("shows no Refunds metric — the POS schema does not represent refunds", () => {
    expect(routeCode).not.toMatch(/refund/i);
  });

  it("shows no Discounts metric — the POS schema does not represent discounts", () => {
    expect(routeCode).not.toMatch(/discount/i);
  });

  it("presents all six payment methods from till money only", () => {
    for (const f of [
      "cash_amount",
      "card_amount",
      "mobile_money_amount",
      "bank_transfer_amount",
      "wallet_amount",
      "other_amount",
    ]) {
      expect(routeCode).toContain(f);
    }
    expect(route).toContain("Payment methods (till only)");
  });

  it("keeps folio visibly separate from till takings", () => {
    expect(route).toContain("Folio Posted");
    expect(route).toMatch(/Folio settlements are reported separately/);
    expect(route).toMatch(/Excludes amounts posted to a guest folio/);
  });

  it("labels live value honestly and explains it is not a final bill", () => {
    expect(route).toContain("Live Order Value");
    expect(route).toMatch(/Not a final tax-inclusive bill/);
    expect(route).not.toMatch(/Outstanding Bill/i);
  });

  it("states plainly that these are operational figures, not ledger revenue", () => {
    expect(route).toMatch(/not audited General Ledger revenue/);
    expect(route).toMatch(/not General Ledger revenue/);
  });
});

describe("route — sections", () => {
  it("department table shows outlet, kind, sales, closed, live and live value", () => {
    expect(routeCode).toContain("d.outlet_name");
    expect(routeCode).toContain("d.outlet_kind");
    expect(routeCode).toContain("money(d.operational_sales)");
    expect(routeCode).toContain("execNumber(d.order_count)");
    expect(routeCode).toContain("execNumber(d.live_order_count)");
    expect(routeCode).toContain("money(d.open_order_line_value)");
  });

  it("keeps zero-sales outlets visible (only the chart filters them, never the table)", () => {
    expect(routeCode).toMatch(/deptChart[\s\S]*?\.filter\(\(d\) => d\.sales > 0\)/);
    const tableBlock = routeCode.slice(routeCode.indexOf("(departments.data ?? []).map"));
    expect(tableBlock.slice(0, 400)).not.toMatch(/\.filter\(/);
  });

  it("keeps order-creator and payment-receiver as separate labelled columns", () => {
    expect(route).toContain("Orders Created");
    expect(route).toContain("Till Payments Received");
    expect(route).toContain("Till Amount Received");
    // The prose deliberately mentions "sales by user" in order to say it is
    // NOT computed, so only headings and column labels are checked here.
    const labels = [
      ...routeCode.matchAll(/<CardTitle[^>]*>([^<]+)</g),
      ...routeCode.matchAll(/<TableHead[^>]*>\s*([^<]+?)\s*</g),
    ].map((m) => m[1]);
    expect(labels.length).toBeGreaterThan(10);
    for (const l of labels) {
      expect(l, `column/heading must not imply attribution: ${l}`).not.toMatch(
        /sales by user|salesperson/i,
      );
    }
  });

  it("explains that a zero creator count reflects missing capture, not a defect", () => {
    expect(route).toMatch(
      /Orders created can read\s*\n?\s*zero where POS orders were saved without a recorded creator/,
    );
  });

  it("uses historical item names and says so", () => {
    expect(routeCode).toContain("i.item_name");
    expect(route).toMatch(/historical names recorded at the time of sale/);
  });

  it("supports switching the trend between daily and monthly", () => {
    expect(routeCode).toContain('useState<Granularity>("day")');
    expect(routeCode).toContain('<SelectItem value="day">Daily</SelectItem>');
    expect(routeCode).toContain('<SelectItem value="month">Monthly</SelectItem>');
    expect(routeCode).toContain('queryKey: ["pos-exec-periods", args, granularity]');
  });

  it("plots operational sales and till payments as two separate series", () => {
    expect(routeCode).toContain('name="Operational Sales"');
    expect(routeCode).toContain('name="Till Payments Received"');
  });
});

describe("route — states, performance and realtime", () => {
  it("gives every section a loading, error and empty state", () => {
    expect((routeCode.match(/<SectionState/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(routeCode).toContain("if (loading)");
    expect(routeCode).toContain("if (error)");
    expect(routeCode).toContain("if (empty)");
  });

  it("fails a section rather than blanking the page", () => {
    expect(route).toContain("Could not load this section.");
  });

  it("does no client-side aggregation of raw POS rows", () => {
    expect(routeCode).not.toMatch(/pos_orders|pos_payments|pos_order_items/);
  });

  it("only maps RPC output for charting, never recomputes a KPI", () => {
    // useMemo blocks map RPC rows into chart shape; no reduce/sum anywhere.
    expect(routeCode).not.toMatch(/\.reduce\(/);
  });

  it("uses a periodic refetch rather than a realtime subscription, and does not add one", () => {
    expect(routeCode).toContain("refetchInterval: LIVE_REFETCH_MS");
    expect(routeCode).not.toMatch(/\.channel\(|postgres_changes|\.subscribe\(/);
  });
});

describe("route — exports", () => {
  it("reuses the shared report toolkit rather than a bespoke exporter", () => {
    expect(routeCode).toContain('import("@/lib/reports/report-export.client")');
    expect(routeCode).toContain("createClientOnlyFn(");
    expect(routeCode).not.toMatch(/new Blob\(|jsPDF|XLSX\./);
  });

  it("offers CSV, XLSX, PDF and Print", () => {
    for (const f of ["csv", "xlsx", "pdf", "print"]) {
      expect(routeCode).toContain(`exportAll("${f}")`);
    }
  });

  // What the report itself contains is covered behaviourally by
  // pos-executive-dashboard-export.test.ts, which runs the real CSV/XLSX
  // pipeline. What the route still owns is feeding that builder the FULL
  // result sets -- not the chart-shaped, filtered data.
  it("hands the builder the complete RPC result sets, not the truncated chart data", () => {
    for (const src of ["departments.data", "users.data", "topItems.data", "periods.data"]) {
      expect(routeCode).toContain(`(${src} ?? [])`);
    }
    expect(routeCode).not.toMatch(/deptChart,|trendData,|: deptChart|: trendData/);
  });

  it("passes the active property, range, granularity and currency to the builder", () => {
    const call = routeCode.slice(
      routeCode.indexOf("buildPosExecReport({"),
      routeCode.indexOf("return runExport"),
    );
    for (const field of ["format: fmt", "currency", "propertyName", "from", "to", "granularity"]) {
      expect(call, `builder call must pass ${field}`).toContain(field);
    }
  });

  it("never emits a Refund or Discount column", () => {
    const builder = read("src/lib/pos-analytics-report.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(builder).not.toMatch(/refund|discount/i);
  });
});

describe("route — responsive and accessibility", () => {
  it("reflows KPI cards across breakpoints instead of a fixed grid", () => {
    expect(routeCode).toContain("grid-cols-2 lg:grid-cols-4");
    expect(routeCode).toContain("grid-cols-2 lg:grid-cols-3");
  });

  it("lets the filter row wrap and keeps export buttons reachable on narrow screens", () => {
    expect(routeCode).toContain("flex flex-wrap items-end gap-3");
    expect(routeCode).toContain("ml-auto flex items-center gap-2 flex-wrap");
  });

  it("scrolls wide tables inside their own container rather than the page", () => {
    expect((routeCode.match(/overflow-x-auto/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("uses semantic headings and scoped table headers", () => {
    expect(routeCode).toContain("<h1");
    expect(routeCode).toContain("<h2");
    expect(routeCode).toContain('scope="col"');
  });

  it("labels every filter control", () => {
    expect(routeCode).toContain('htmlFor="pos-from"');
    expect(routeCode).toContain('htmlFor="pos-to"');
    expect(routeCode).toContain('htmlFor="pos-grain"');
  });

  it("gives the trend chart a table equivalent for assistive technology", () => {
    expect(routeCode).toContain('<caption className="sr-only">');
  });

  it("gives icon-only tooltip triggers an accessible name and visible focus", () => {
    expect(routeCode).toContain("aria-label={`About ${label}`}");
    expect(routeCode).toContain("focus-visible:ring-2");
  });

  it("does not rely on colour alone for payment method or outlet kind", () => {
    expect(routeCode).toContain(
      '<Badge variant="outline">{d.outlet_kind.replace("_", " ")}</Badge>',
    );
  });
});
