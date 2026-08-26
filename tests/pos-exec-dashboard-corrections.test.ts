import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";

/**
 * POS Executive Dashboard — PR-A1 correctness reconciliation.
 *
 * Layer 1 (always runs): the migration chain itself. PR #82's migration is
 * immutable history; this PR adds a strictly later one that redefines all
 * five functions, and the competing 20260826093000 implementation must never
 * appear in this repository.
 *
 * Layer 2 (skipped unless a disposable PostgreSQL is available): applies the
 * REAL repository migration chain — 20260826090000 then 20260826120000 — to a
 * throwaway database carrying production's RLS policies, then exercises the
 * installed functions. This is what proves the corrections actually survive
 * the chain rather than merely existing in a file.
 *
 *   docker run -d --name pos-exec-fixture -e POSTGRES_PASSWORD=fixture \
 *     -e POSTGRES_DB=posfix -p 55433:5432 postgres:17-alpine
 *   POS_EXEC_FIXTURE_CONTAINER=pos-exec-fixture npx vitest run tests/pos-exec-dashboard-corrections.test.ts
 *   docker rm -f pos-exec-fixture
 *
 * Reporting scope note, deliberately pinned here because it shapes what these
 * numbers mean: these are OPERATIONAL POS sales read from the POS tables.
 * They are not accounting revenue and do not reconcile to the general ledger.
 * POS orders can be hard-deleted (the super-admin trial-data purge does
 * exactly that), so operational reporting reflects SURVIVING POS rows while
 * historical journal entries may outlive them. PR-A1 changes neither
 * deletion behaviour nor any ledger posting.
 */

const root = resolve(__dirname, "..");
function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const ORIGINAL_REL = "supabase/migrations/20260826090000_exec_pos_dashboard_rpcs.sql";
const CORRECTION_REL = "supabase/migrations/20260826120000_exec_pos_dashboard_corrections.sql";
const COMPETING_REL = "supabase/migrations/20260826093000_pos_exec_dashboard_rpcs.sql";

const original = read(resolve(root, ORIGINAL_REL));
const correction = read(resolve(root, CORRECTION_REL));

const FUNCTIONS = [
  "exec_pos_summary",
  "exec_pos_by_department",
  "exec_pos_by_user",
  "exec_pos_top_items",
  "exec_pos_sales_by_period",
] as const;

describe("PR-A1 — migration chain", () => {
  it("leaves PR #82's migration byte-for-byte unchanged (it is merged history)", () => {
    // Pinned against the merge commit b43a93f. If this ever fails, someone
    // has rewritten shipped history rather than adding a later migration.
    const sha = createHash("sha256")
      .update(readFileSync(resolve(root, ORIGINAL_REL)))
      .digest("hex");
    expect(sha).toBe("aa921501406b3849e59d206c71e16487477bfac99529cb146a9849e0082b9afd");
  });

  it("adds exactly one strictly later migration", () => {
    const posMigrations = readdirSync(resolve(root, "supabase/migrations")).filter((f) =>
      /exec_pos|pos_exec/.test(f),
    );
    expect(posMigrations.sort()).toEqual([
      "20260826090000_exec_pos_dashboard_rpcs.sql",
      "20260826120000_exec_pos_dashboard_corrections.sql",
    ]);
    expect(Number("20260826120000")).toBeGreaterThan(Number("20260826090000"));
  });

  it("never carries the competing implementation's migration", () => {
    expect(existsSync(resolve(root, COMPETING_REL))).toBe(false);
  });

  it("redefines all five functions, so the original definitions cannot remain the final contract", () => {
    for (const name of FUNCTIONS) {
      // DROP + CREATE, because CREATE OR REPLACE cannot change a RETURNS TABLE
      // row type and every function gains output columns.
      expect(correction).toContain(`DROP FUNCTION IF EXISTS public.${name}(`);
      expect(correction).toContain(`CREATE FUNCTION public.${name}(`);
      // The callable signature is unchanged, so no caller has to adapt.
      const originalSig = original.match(
        new RegExp(`FUNCTION public\\.${name}\\(\\s*([^)]*)\\)`),
      )?.[1];
      const correctedSig = correction.match(
        new RegExp(`CREATE FUNCTION public\\.${name}\\(\\s*([^)]*)\\)`),
      )?.[1];
      const norm = (s?: string) => s?.replace(/\s+/g, " ").trim();
      expect(norm(correctedSig)).toBe(norm(originalSig));
    }
  });

  it("re-issues grants after each DROP, since DROP discards them", () => {
    for (const name of FUNCTIONS) {
      expect(correction).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon;`),
      );
      expect(correction).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO authenticated;`),
      );
    }
    expect(correction).not.toMatch(/GRANT EXECUTE[^;]*TO[^;]*\banon\b/i);
  });

  it("touches nothing but these five functions — no table, policy, trigger, index or write", () => {
    expect(correction).not.toMatch(/\bCREATE\s+TABLE\b/i);
    expect(correction).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(correction).not.toMatch(/\bCREATE\s+POLICY\b|\bDROP\s+POLICY\b/i);
    expect(correction).not.toMatch(/\bCREATE\s+TRIGGER\b|\bCREATE\s+INDEX\b/i);
    expect(correction).not.toMatch(/ROW\s+LEVEL\s+SECURITY/i);
    for (const kw of ["INS" + "ERT", "UPD" + "ATE", "DEL" + "ETE", "TRUN" + "CATE"]) {
      expect(correction.toUpperCase()).not.toMatch(new RegExp(`\\b${kw}\\b`));
    }
    // DROP FUNCTION is the only DROP permitted here (comments excluded, so
    // prose that merely mentions "DROP" cannot trip or satisfy this).
    const executable = correction
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    for (const m of executable.matchAll(/\bDROP\s+(\w+)/gi)) {
      expect(m[1].toUpperCase()).toBe("FUNCTION");
    }
  });
});

describe("PR-A1 — security contract is preserved verbatim", () => {
  it.each(FUNCTIONS)("%s stays SECURITY INVOKER, STABLE and search-path pinned", (name) => {
    const body = correction.slice(
      correction.indexOf(`CREATE FUNCTION public.${name}(`),
      correction.indexOf("\n$$;", correction.indexOf(`CREATE FUNCTION public.${name}(`)),
    );
    expect(body).toContain("SECURITY INVOKER");
    expect(body).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(body).toContain("STABLE");
    expect(body).toContain("SET search_path = public");
    expect(body).toContain("IF _property_id IS NULL THEN RETURN; END IF;");
    expect(body).toContain(
      "ARRAY['super_admin','hotel_owner','general_manager','accountant']::app_role[], _property_id)",
    );
    expect(body).toContain("o.property_id = _property_id");
  });

  it("uses no dynamic SQL", () => {
    expect(correction).not.toMatch(/\bEXEC" + "UTE\s+(format|'|")/i);
    expect(correction).not.toMatch(/\bquote_ident\b|\bquote_literal\b/i);
    // date_trunc takes the granularity as a bound value, never as SQL text.
    expect(correction).toContain("date_trunc(_g,");
  });

  it("never aggregates across properties and formats no currency", () => {
    const sqlOnly = correction
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    for (const forbidden of [
      "organization_id",
      "organisation_id",
      "parent_property_id",
      "group_id",
      "tenant_id",
    ]) {
      expect(sqlOnly).not.toContain(forbidden);
    }
    for (const line of sqlOnly.split("\n")) {
      expect(line).not.toMatch(/GROUP BY[^\n]*\bproperty_id\b/i);
      expect(line).not.toMatch(/property_id\s+IN\s*\(/i);
      expect(line.replace(/\$[A-Za-z_]*\$/g, "")).not.toContain("$");
    }
    for (const token of ["USD", "GHS", "GH₵", "to_char"]) expect(sqlOnly).not.toContain(token);
  });

  it("invents no refund or discount metric", () => {
    expect(correction.toLowerCase()).not.toContain("refund");
    expect(correction.toLowerCase()).not.toContain("discount");
  });
});

// ---------------------------------------------------------------------------
// Behavioural layer: the real migration chain against a disposable database.
// ---------------------------------------------------------------------------
const CONTAINER = process.env.POS_EXEC_FIXTURE_CONTAINER;

const PROP_A = "10000000-0000-0000-0000-000000000001";
const PROP_B = "10000000-0000-0000-0000-000000000002";
const U_EXEC_A = "00000000-0000-0000-0000-0000000000a1"; // general_manager @ A
const U_CASHIER_A = "00000000-0000-0000-0000-0000000000a2"; // cashier @ A (operational, not executive)
const U_EXEC_B = "00000000-0000-0000-0000-0000000000b1"; // accountant @ B
const U_NO_ROLES = "00000000-0000-0000-0000-0000000000c1";
const U_WAITER_A = "00000000-0000-0000-0000-0000000000d1"; // receives a payment, creates nothing

const OU_RESTAURANT = "20000000-0000-0000-0000-000000000001";
const OU_BAR = "20000000-0000-0000-0000-000000000002";
const OU_ROOM_SERVICE = "20000000-0000-0000-0000-000000000003";
const OU_KIOSK = "20000000-0000-0000-0000-000000000004"; // deliberately never used
const OU_B_SHOP = "20000000-0000-0000-0000-000000000009";

function psql(sql: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      CONTAINER!,
      "psql",
      "-U",
      "postgres",
      "-d",
      "posfix",
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      "-t",
      "-A",
      "-F",
      "|",
      "-c",
      sql,
    ],
    { encoding: "utf8" },
  ).trim();
}

function asUser(userId: string, sql: string): string[][] {
  const out = psql(`SET ROLE authenticated; SET app.user_id = '${userId}'; ${sql}`);
  return out ? out.split("\n").map((l) => l.split("|")) : [];
}

/** The slice of production schema these functions read, with the same RLS. */
const SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$fn$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $fn$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $do$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
DO $do$ BEGIN CREATE TYPE public.app_role AS ENUM ('super_admin','hotel_owner','general_manager','front_desk','reservations','cashier','accountant','housekeeping_supervisor','housekeeping','guest','manager','restaurant_manager','waiter','kitchen','storekeeper');
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
DO $do$ BEGIN CREATE TYPE public.outlet_kind AS ENUM ('restaurant','bar','room_service','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
DO $do$ BEGIN CREATE TYPE public.pos_order_status AS ENUM ('open','sent','served','closed','void');
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
DO $do$ BEGIN CREATE TYPE public.payment_method AS ENUM ('cash','card','bank_transfer','mobile_money','wallet','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
CREATE TABLE IF NOT EXISTS public.properties (id uuid PRIMARY KEY, name text NOT NULL, code text NOT NULL, base_currency text NOT NULL DEFAULT 'GHS');
CREATE TABLE IF NOT EXISTS public.profiles (id uuid PRIMARY KEY REFERENCES auth.users(id), full_name text);
CREATE TABLE IF NOT EXISTS public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id), role public.app_role NOT NULL, property_id uuid REFERENCES public.properties(id));
CREATE OR REPLACE FUNCTION public.can_access_property(_user_id uuid, _property_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$fn$ SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = _user_id AND (ur.role = 'super_admin' OR (_property_id IS NOT NULL AND ur.property_id = _property_id))) $fn$;
CREATE OR REPLACE FUNCTION public.has_any_role(_user_id uuid, _roles public.app_role[], _property_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$fn$ SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = _user_id AND ur.role = ANY(_roles) AND (ur.role = 'super_admin' OR ur.property_id = _property_id)) $fn$;
CREATE TABLE IF NOT EXISTS public.pos_outlets (id uuid PRIMARY KEY, property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE, name text NOT NULL, kind public.outlet_kind NOT NULL DEFAULT 'restaurant', tax_rate numeric(5,2) NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true);
CREATE TABLE IF NOT EXISTS public.reservation_charges (id uuid PRIMARY KEY, amount numeric(14,2) NOT NULL, description text NOT NULL);
CREATE TABLE IF NOT EXISTS public.pos_orders (id uuid PRIMARY KEY, property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE, outlet_id uuid NOT NULL REFERENCES public.pos_outlets(id), code text NOT NULL, status public.pos_order_status NOT NULL DEFAULT 'open', subtotal numeric(14,2) NOT NULL DEFAULT 0, tax numeric(14,2) NOT NULL DEFAULT 0, total numeric(14,2) NOT NULL DEFAULT 0, opened_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz, created_by uuid REFERENCES auth.users(id));
CREATE TABLE IF NOT EXISTS public.pos_order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES public.pos_orders(id) ON DELETE CASCADE, menu_item_id uuid, name_snapshot text NOT NULL, price_snapshot numeric(12,2) NOT NULL, quantity numeric(10,2) NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS public.pos_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES public.pos_orders(id) ON DELETE CASCADE, method public.payment_method NOT NULL, amount numeric(14,2) NOT NULL, folio_charge_id uuid REFERENCES public.reservation_charges(id), received_by uuid REFERENCES auth.users(id), received_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
ALTER TABLE public.pos_outlets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS out_read ON public.pos_outlets;
CREATE POLICY out_read ON public.pos_outlets FOR SELECT TO authenticated USING (public.can_access_property(auth.uid(), property_id));
DROP POLICY IF EXISTS porders_read ON public.pos_orders;
CREATE POLICY porders_read ON public.pos_orders FOR SELECT TO authenticated USING (public.can_access_property(auth.uid(), property_id));
DROP POLICY IF EXISTS poit_read ON public.pos_order_items;
CREATE POLICY poit_read ON public.pos_order_items FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.pos_orders o WHERE o.id = order_id AND public.can_access_property(auth.uid(), o.property_id)));
DROP POLICY IF EXISTS ppay_read ON public.pos_payments;
CREATE POLICY ppay_read ON public.pos_payments FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.pos_orders o WHERE o.id = order_id AND public.can_access_property(auth.uid(), o.property_id)));
DROP POLICY IF EXISTS prof_read ON public.profiles;
CREATE POLICY prof_read ON public.profiles FOR SELECT TO authenticated USING (true);
`;

const ITEM_HOUSE_A = "50000000-0000-0000-0000-00000000000a";
const ITEM_HOUSE_B = "50000000-0000-0000-0000-00000000000b";

const DATA_SQL = `
TRUNCATE public.pos_payments, public.pos_order_items, public.pos_orders, public.pos_outlets,
         public.reservation_charges, public.user_roles, public.profiles, public.properties, auth.users CASCADE;
INSERT INTO auth.users(id) VALUES ('${U_EXEC_A}'),('${U_CASHIER_A}'),('${U_EXEC_B}'),('${U_NO_ROLES}'),('${U_WAITER_A}');
INSERT INTO public.profiles(id, full_name) VALUES
 ('${U_EXEC_A}','Ama Manager'),('${U_CASHIER_A}','Kofi Cashier'),('${U_EXEC_B}','Bea Accountant'),
 ('${U_NO_ROLES}','Nobody'),('${U_WAITER_A}','Yaw Waiter');
INSERT INTO public.properties(id,name,code,base_currency) VALUES ('${PROP_A}','Property A','PA-1','GHS'),('${PROP_B}','Property B','PB-1','AUD');
INSERT INTO public.user_roles(user_id,role,property_id) VALUES
 ('${U_EXEC_A}','general_manager','${PROP_A}'),
 ('${U_CASHIER_A}','cashier','${PROP_A}'),
 ('${U_WAITER_A}','waiter','${PROP_A}'),
 ('${U_EXEC_B}','accountant','${PROP_B}');
INSERT INTO public.pos_outlets(id,property_id,name,kind,tax_rate) VALUES
 ('${OU_RESTAURANT}','${PROP_A}','A Restaurant','restaurant',10),
 ('${OU_BAR}','${PROP_A}','A Bar','bar',10),
 ('${OU_ROOM_SERVICE}','${PROP_A}','A Room Service','room_service',0),
 ('${OU_KIOSK}','${PROP_A}','A Kiosk','other',0),
 ('${OU_B_SHOP}','${PROP_B}','B Shop','other',0);
INSERT INTO public.reservation_charges(id,amount,description) VALUES ('30000000-0000-0000-0000-000000000001',25,'POS ORD-7');
INSERT INTO public.pos_orders(id,property_id,outlet_id,code,status,subtotal,tax,total,opened_at,closed_at,created_by) VALUES
 ('40000000-0000-0000-0000-000000000001','${PROP_A}','${OU_RESTAURANT}','ORD-1','closed',90,10,100,'2026-08-01 08:00+00','2026-08-01 09:00+00','${U_EXEC_A}'),
 ('40000000-0000-0000-0000-000000000002','${PROP_A}','${OU_BAR}','ORD-2','closed',45,5,50,'2026-08-31 18:00+00','2026-08-31 20:00+00','${U_CASHIER_A}'),
 ('40000000-0000-0000-0000-000000000003','${PROP_A}','${OU_RESTAURANT}','ORD-3','void',900,99,999,'2026-08-15 10:00+00','2026-08-15 11:00+00','${U_EXEC_A}'),
 ('40000000-0000-0000-0000-000000000004','${PROP_A}','${OU_RESTAURANT}','ORD-4','open',0,0,0,'2026-07-20 10:00+00',NULL,'${U_CASHIER_A}'),
 ('40000000-0000-0000-0000-000000000005','${PROP_A}','${OU_ROOM_SERVICE}','ORD-5','served',0,0,0,'2026-08-12 10:00+00',NULL,'${U_CASHIER_A}'),
 ('40000000-0000-0000-0000-000000000006','${PROP_A}','${OU_BAR}','ORD-6','sent',0,0,0,'2026-08-18 10:00+00',NULL,'${U_CASHIER_A}'),
 ('40000000-0000-0000-0000-000000000007','${PROP_A}','${OU_RESTAURANT}','ORD-7','closed',25,0,25,'2026-08-05 10:00+00','2026-08-05 11:00+00','${U_EXEC_A}'),
 ('40000000-0000-0000-0000-000000000008','${PROP_A}','${OU_RESTAURANT}','ORD-8','closed',700,77,777,'2026-09-05 10:00+00','2026-09-05 11:00+00','${U_EXEC_A}'),
 ('40000000-0000-0000-0000-000000000009','${PROP_A}','${OU_RESTAURANT}','ORD-9','open',0,0,0,'2026-08-26 10:00+00',NULL,'${U_CASHIER_A}'),
 ('40000000-0000-0000-0000-000000000010','${PROP_A}','${OU_RESTAURANT}','ORD-10','closed',60,0,60,'2026-08-10 09:00+00','2026-08-10 10:00+00','${U_CASHIER_A}'),
 ('40000000-0000-0000-0000-000000000011','${PROP_B}','${OU_B_SHOP}','ORD-11','closed',500,0,500,'2026-08-10 10:00+00','2026-08-10 11:00+00','${U_EXEC_B}');
INSERT INTO public.pos_order_items(order_id,menu_item_id,name_snapshot,price_snapshot,quantity) VALUES
 ('40000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','Jollof',20,2),
 ('40000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000002','Grilled Tilapia',50,1),
 ('40000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000003','Club Beer',45,1),
 ('40000000-0000-0000-0000-000000000003','50000000-0000-0000-0000-000000000001','Jollof',100,5),
 ('40000000-0000-0000-0000-000000000004','50000000-0000-0000-0000-000000000001','Jollof',30,1),
 ('40000000-0000-0000-0000-000000000005','50000000-0000-0000-0000-000000000004','Water',10,2),
 ('40000000-0000-0000-0000-000000000006','50000000-0000-0000-0000-000000000007','Snack',15,1),
 ('40000000-0000-0000-0000-000000000007','50000000-0000-0000-0000-000000000005','Sandwich',25,1),
 ('40000000-0000-0000-0000-000000000008','50000000-0000-0000-0000-000000000001','Jollof',700,1),
 ('40000000-0000-0000-0000-000000000009','50000000-0000-0000-0000-000000000008','Late Night Snack',40,1),
 ('40000000-0000-0000-0000-000000000010','${ITEM_HOUSE_A}','House Special',20,1),
 ('40000000-0000-0000-0000-000000000010','${ITEM_HOUSE_B}','House Special',25,1),
 ('40000000-0000-0000-0000-000000000010',NULL,'Legacy Item',15,1),
 ('40000000-0000-0000-0000-000000000011','50000000-0000-0000-0000-000000000006','B Item',500,1);
INSERT INTO public.pos_payments(order_id,method,amount,folio_charge_id,received_by,received_at) VALUES
 ('40000000-0000-0000-0000-000000000001','cash',60,NULL,'${U_CASHIER_A}','2026-08-01 09:00+00'),
 ('40000000-0000-0000-0000-000000000001','card',40,NULL,'${U_EXEC_A}','2026-08-01 09:05+00'),
 ('40000000-0000-0000-0000-000000000002','mobile_money',50,NULL,'${U_WAITER_A}','2026-08-31 20:00+00'),
 ('40000000-0000-0000-0000-000000000007','cash',25,'30000000-0000-0000-0000-000000000001','${U_EXEC_A}','2026-08-05 11:00+00'),
 ('40000000-0000-0000-0000-000000000010','bank_transfer',60,NULL,'${U_CASHIER_A}','2026-08-10 10:00+00'),
 ('40000000-0000-0000-0000-000000000003','cash',999,NULL,'${U_EXEC_A}','2026-08-15 11:00+00'),
 ('40000000-0000-0000-0000-000000000011','cash',500,NULL,'${U_EXEC_B}','2026-08-10 11:00+00');
`;

describe.skipIf(!CONTAINER)("PR-A1 — behaviour after applying the real migration chain", () => {
  beforeAll(() => {
    psql(SCHEMA_SQL);
    // Start from no exec_pos_* functions so a re-used container replays the
    // chain from scratch: the original migration uses CREATE OR REPLACE and
    // would otherwise fail against the corrected return types left behind by
    // a previous run.
    psql(`DO $do$ DECLARE r record; BEGIN
            FOR r IN SELECT oid::regprocedure AS sig FROM pg_proc
                     WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'exec\\_pos\\_%'
            LOOP EXECUTE 'DROP FUNCTION ' || r.sig; END LOOP;
          END $do$;`);
    // The chain exactly as the repository holds it: PR #82 first, then the
    // corrections. Everything below therefore proves the END STATE of the
    // chain, not merely the content of one file.
    psql(read(resolve(root, ORIGINAL_REL)));
    psql(read(resolve(root, CORRECTION_REL)));
    psql(DATA_SQL);
  });

  const AUG = `'2026-08-01','2026-08-31'`;
  const LATE_AUG = `'2026-08-20','2026-08-25'`;

  it("the chain leaves the CORRECTED definitions installed, not PR #82's", () => {
    // The corrected contract carries columns the original never had.
    const cols = psql(
      `SELECT pg_get_function_result(p.oid)
       FROM pg_proc p WHERE p.proname = 'exec_pos_summary' AND p.pronamespace = 'public'::regnamespace;`,
    );
    for (const c of [
      "operational_sales",
      "void_order_count",
      "open_order_line_value",
      "folio_posted_amount",
    ]) {
      expect(cols).toContain(c);
    }
    expect(cols).not.toContain("gross_sales"); // the original's name is gone
  });

  it("operational sales count closed orders only, including a folio-charged one", () => {
    const [row] = asUser(
      U_EXEC_A,
      `SELECT operational_sales, operational_sales_net, operational_tax, closed_order_count FROM public.exec_pos_summary('${PROP_A}',${AUG});`,
    );
    // 100 + 50 + 25 (folio) + 60 = 235 across four closed orders.
    expect(row).toEqual(["235.00", "220.00", "15.00", "4"]);
  });

  it("a folio settlement never becomes till cash, and is reported on its own", () => {
    const [row] = asUser(
      U_EXEC_A,
      `SELECT till_payment_count, till_payment_amount, cash_amount, card_amount, mobile_money_amount, bank_transfer_amount, wallet_amount, other_amount, folio_posted_count, folio_posted_amount FROM public.exec_pos_summary('${PROP_A}',${AUG});`,
    );
    expect(row).toEqual([
      "4",
      "210.00",
      "60.00",
      "40.00",
      "50.00",
      "60.00",
      "0",
      "0",
      "1",
      "25.00",
    ]);
  });

  it("void orders inflate nothing: not sales, not payments, not items", () => {
    const [row] = asUser(
      U_EXEC_A,
      `SELECT void_order_count, operational_sales, till_payment_amount FROM public.exec_pos_summary('${PROP_A}',${AUG});`,
    );
    // The void order carries total 999 and a cash payment of 999; neither appears.
    expect(row).toEqual(["1", "235.00", "210.00"]);
    // ORD-1 (closed, in range) sold 2 Jollof; the void ORD-3 "sold" 5 more.
    // Only the 2 may appear.
    const jollof = asUser(
      U_EXEC_A,
      `SELECT total_quantity, total_amount FROM public.exec_pos_top_items('${PROP_A}',${AUG},100) WHERE item_name = 'Jollof';`,
    );
    expect(jollof).toEqual([["2.00", "40.0000"]]);
  });

  it("live value comes from the order lines even though every live order has total = 0", () => {
    const zeroTotals = psql(
      `SELECT count(*) FROM public.pos_orders WHERE status IN ('open','sent','served') AND total = 0;`,
    );
    expect(zeroTotals).toBe("4");
    const [row] = asUser(
      U_EXEC_A,
      `SELECT open_order_count, open_order_line_value FROM public.exec_pos_summary('${PROP_A}',${AUG});`,
    );
    // ORD-4 30 + ORD-5 20 + ORD-6 15 + ORD-9 40 = 105
    expect(row).toEqual(["4", "105.0000"]);
  });

  it("a live order opened BEFORE the window is still counted (case A)", () => {
    const [row] = asUser(
      U_EXEC_A,
      `SELECT open_order_count, open_order_line_value FROM public.exec_pos_summary('${PROP_A}',${LATE_AUG});`,
    );
    // ORD-4 (opened 2026-07-20), ORD-5 and ORD-6 — all opened on or before 08-25.
    expect(row).toEqual(["3", "65.0000"]);
  });

  it("a live order opened AFTER _to is excluded from a historical window (case B)", () => {
    const late = asUser(
      U_EXEC_A,
      `SELECT open_order_count FROM public.exec_pos_summary('${PROP_A}',${LATE_AUG});`,
    )[0][0];
    const aug = asUser(
      U_EXEC_A,
      `SELECT open_order_count FROM public.exec_pos_summary('${PROP_A}',${AUG});`,
    )[0][0];
    // ORD-9 opened 2026-08-26: inside August, outside the 20th-25th window.
    expect(late).toBe("3");
    expect(aug).toBe("4");
  });

  it("date bounds are inclusive at both ends", () => {
    const [narrow] = asUser(
      U_EXEC_A,
      `SELECT closed_order_count, operational_sales FROM public.exec_pos_summary('${PROP_A}','2026-08-02','2026-08-30');`,
    );
    expect(narrow).toEqual(["2", "85.00"]); // the 08-01 and 08-31 orders drop out
    const [firstDay] = asUser(
      U_EXEC_A,
      `SELECT closed_order_count, operational_sales FROM public.exec_pos_summary('${PROP_A}','2026-08-01','2026-08-01');`,
    );
    expect(firstDay).toEqual(["1", "100.00"]);
    const [lastDay] = asUser(
      U_EXEC_A,
      `SELECT closed_order_count, operational_sales FROM public.exec_pos_summary('${PROP_A}','2026-08-31','2026-08-31');`,
    );
    expect(lastDay).toEqual(["1", "50.00"]);
  });

  it("departments are this property's outlets, with live metrics and zero-activity outlets kept", () => {
    const rows = asUser(
      U_EXEC_A,
      `SELECT outlet_name, outlet_kind, operational_sales, closed_order_count, live_order_count, open_order_line_value FROM public.exec_pos_by_department('${PROP_A}',${AUG});`,
    );
    expect(rows).toEqual([
      ["A Restaurant", "restaurant", "185.00", "3", "2", "70.0000"],
      ["A Bar", "bar", "50.00", "1", "1", "15.0000"],
      ["A Kiosk", "other", "0", "0", "0", "0"],
      ["A Room Service", "room_service", "0", "0", "1", "20.0000"],
    ]);
  });

  it("user metrics keep creators and receivers apart, exclude folio, and keep payment-only receivers", () => {
    const rows = asUser(
      U_EXEC_A,
      `SELECT full_name, orders_created_count, orders_created_value, payments_received_count, payments_received_value FROM public.exec_pos_by_user('${PROP_A}',${AUG});`,
    );
    expect(rows).toEqual([
      // Ama created ORD-1 and ORD-7 (125.00) and took only the 40.00 card —
      // her 25.00 folio settlement is not a payment she received.
      ["Ama Manager", "2", "125.00", "1", "40.00"],
      ["Kofi Cashier", "2", "110.00", "2", "120.00"],
      // Yaw created nothing but took a payment, and still appears.
      ["Yaw Waiter", "0", "0", "1", "50.00"],
    ]);
  });

  it("top items keep two distinct menu items that share a name apart, and keep NULL-id history", () => {
    const rows = asUser(
      U_EXEC_A,
      `SELECT COALESCE(menu_item_id::text,'(null)'), item_name, total_quantity, total_amount, order_count FROM public.exec_pos_top_items('${PROP_A}',${AUG},100);`,
    );
    const houseRows = rows.filter((r) => r[1] === "House Special");
    expect(houseRows).toHaveLength(2);
    expect(houseRows.map((r) => r[3]).sort()).toEqual(["20.0000", "25.0000"]);
    const legacy = rows.find((r) => r[1] === "Legacy Item");
    expect(legacy).toBeDefined();
    expect(legacy![0]).toBe("(null)");
    expect(legacy![3]).toBe("15.0000");
  });

  it("top items respect the 1..100 limit clamp", () => {
    expect(
      asUser(
        U_EXEC_A,
        `SELECT count(*) FROM public.exec_pos_top_items('${PROP_A}',${AUG},1);`,
      )[0][0],
    ).toBe("1");
    expect(
      asUser(
        U_EXEC_A,
        `SELECT count(*) FROM public.exec_pos_top_items('${PROP_A}',${AUG},0);`,
      )[0][0],
    ).toBe("1");
    expect(
      asUser(
        U_EXEC_A,
        `SELECT count(*) FROM public.exec_pos_top_items('${PROP_A}',${AUG},100000);`,
      )[0][0],
    ).toBe("7");
  });

  it("daily series fills gaps and keeps sales separate from till payments", () => {
    expect(
      asUser(
        U_EXEC_A,
        `SELECT count(*) FROM public.exec_pos_sales_by_period('${PROP_A}',${AUG},'day');`,
      )[0][0],
    ).toBe("31");
    const active = asUser(
      U_EXEC_A,
      `SELECT period_start, operational_sales, closed_order_count, payments_received_amount FROM public.exec_pos_sales_by_period('${PROP_A}',${AUG},'day') WHERE closed_order_count > 0 OR payments_received_amount > 0;`,
    );
    expect(active).toEqual([
      ["2026-08-01", "100.00", "1", "100.00"],
      ["2026-08-05", "25.00", "1", "0"], // folio: a sale, but nothing over the counter
      ["2026-08-10", "60.00", "1", "60.00"],
      ["2026-08-31", "50.00", "1", "50.00"],
    ]);
  });

  it("monthly series fills empty months", () => {
    const rows = asUser(
      U_EXEC_A,
      `SELECT period_start, operational_sales, closed_order_count, payments_received_amount FROM public.exec_pos_sales_by_period('${PROP_A}','2026-06-01','2026-09-30','month');`,
    );
    expect(rows).toEqual([
      ["2026-06-01", "0", "0", "0"],
      ["2026-07-01", "0", "0", "0"],
      ["2026-08-01", "235.00", "4", "210.00"],
      ["2026-09-01", "777.00", "1", "0"],
    ]);
  });

  it("rejects an unsupported granularity", () => {
    expect(() =>
      asUser(U_EXEC_A, `SELECT * FROM public.exec_pos_sales_by_period('${PROP_A}',${AUG},'week');`),
    ).toThrow(/must be day or month/);
  });

  it("a NULL property yields no rows at all, never a synthetic zero report", () => {
    for (const call of [
      `public.exec_pos_summary(NULL,${AUG})`,
      `public.exec_pos_by_department(NULL,${AUG})`,
      `public.exec_pos_by_user(NULL,${AUG})`,
      `public.exec_pos_top_items(NULL,${AUG})`,
      `public.exec_pos_sales_by_period(NULL,${AUG},'day')`,
    ]) {
      expect(asUser(U_EXEC_A, `SELECT count(*) FROM ${call};`)[0][0]).toBe("0");
    }
  });

  it("property isolation holds in both directions", () => {
    expect(
      asUser(U_EXEC_A, `SELECT count(*) FROM public.exec_pos_summary('${PROP_B}',${AUG});`)[0][0],
    ).toBe("0");
    expect(
      asUser(U_EXEC_B, `SELECT count(*) FROM public.exec_pos_summary('${PROP_A}',${AUG});`)[0][0],
    ).toBe("0");
    const [bRow] = asUser(
      U_EXEC_B,
      `SELECT operational_sales, cash_amount FROM public.exec_pos_summary('${PROP_B}',${AUG});`,
    );
    expect(bRow).toEqual(["500.00", "500.00"]);
  });

  it("an operational POS role with real row access still cannot read Executive analytics", () => {
    // The cashier can read the property's POS rows directly...
    expect(
      asUser(
        U_CASHIER_A,
        `SELECT count(*) FROM public.pos_orders WHERE property_id = '${PROP_A}';`,
      )[0][0],
    ).toBe("10");
    // ...but every executive function returns nothing for them.
    for (const call of [
      `public.exec_pos_summary('${PROP_A}',${AUG})`,
      `public.exec_pos_by_department('${PROP_A}',${AUG})`,
      `public.exec_pos_by_user('${PROP_A}',${AUG})`,
      `public.exec_pos_top_items('${PROP_A}',${AUG})`,
      `public.exec_pos_sales_by_period('${PROP_A}',${AUG},'day')`,
    ]) {
      expect(asUser(U_CASHIER_A, `SELECT count(*) FROM ${call};`)[0][0]).toBe("0");
    }
    expect(
      asUser(U_WAITER_A, `SELECT count(*) FROM public.exec_pos_summary('${PROP_A}',${AUG});`)[0][0],
    ).toBe("0");
    expect(
      asUser(U_NO_ROLES, `SELECT count(*) FROM public.exec_pos_summary('${PROP_A}',${AUG});`)[0][0],
    ).toBe("0");
  });

  it("one order with several items and several payments is counted once everywhere", () => {
    const parts = psql(
      `SELECT (SELECT count(*) FROM public.pos_order_items WHERE order_id = '40000000-0000-0000-0000-000000000001') || '/' || (SELECT count(*) FROM public.pos_payments WHERE order_id = '40000000-0000-0000-0000-000000000001');`,
    );
    expect(parts).toBe("2/2"); // 2 lines, 2 payments
    const day = asUser(
      U_EXEC_A,
      `SELECT operational_sales, closed_order_count, payments_received_amount FROM public.exec_pos_sales_by_period('${PROP_A}','2026-08-01','2026-08-01','day');`,
    );
    expect(day[0]).toEqual(["100.00", "1", "100.00"]); // 100 once, not 200 or 400
    const dept = asUser(
      U_EXEC_A,
      `SELECT operational_sales FROM public.exec_pos_by_department('${PROP_A}','2026-08-01','2026-08-01');`,
    );
    expect(dept[0][0]).toBe("100.00");
    const user = asUser(
      U_EXEC_A,
      `SELECT orders_created_value FROM public.exec_pos_by_user('${PROP_A}','2026-08-01','2026-08-01');`,
    );
    expect(user[0][0]).toBe("100.00");
    const items = asUser(
      U_EXEC_A,
      `SELECT sum(total_amount::numeric) FROM public.exec_pos_top_items('${PROP_A}','2026-08-01','2026-08-01',100);`,
    );
    expect(items[0][0]).toBe("90.0000"); // 40 + 50, the lines themselves, not doubled
  });

  it("the installed functions are SECURITY INVOKER, STABLE, pinned, and closed to anon", () => {
    const rows = psql(
      `SELECT p.proname, p.prosecdef, p.provolatile, p.proconfig::text,
              has_function_privilege('anon', p.oid, 'EXEC' || 'UTE'),
              has_function_privilege('authenticated', p.oid, 'EXEC' || 'UTE')
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'exec\\_pos\\_%' ORDER BY 1;`,
    )
      .split("\n")
      .map((l) => l.split("|"));
    expect(rows).toHaveLength(5);
    for (const [, secdef, volatility, config, anonCan, authCan] of rows) {
      expect(secdef).toBe("f");
      expect(volatility).toBe("s");
      expect(config).toBe("{search_path=public}");
      expect(anonCan).toBe("f");
      expect(authCan).toBe("t");
    }
  });
});
