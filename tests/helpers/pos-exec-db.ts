// In-process Postgres harness for the exec_pos_* analytical RPCs.
//
// PGlite is a real PostgreSQL build (not a mock), so these tests execute the
// ACTUAL migration SQL and the ACTUAL function bodies -- including plpgsql,
// RLS, roles, enums and generate_series. That is what makes it possible to
// reproduce the real production upgrade path in CI, which the PR-A tests
// could only describe in prose:
//
//   1. create the schema the migrations expect
//   2. apply 20260826090000 (the definitions live in production today)
//   3. assert the OLD contract is what is installed
//   4. apply 20260826133000 (the forward correction)
//   5. assert the corrected contract replaced it
//   6. run behavioural assertions against that final state
//
// Only the objects the exec_pos_* functions actually touch are created --
// faithfully, from the shipped schema migration (20260705032118) and the
// role helpers (20260705091747), not invented.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

export const ORIGINAL_MIGRATION = "supabase/migrations/20260826090000_exec_pos_dashboard_rpcs.sql";
export const CORRECTION_MIGRATION =
  "supabase/migrations/20260826133000_exec_pos_dashboard_corrections.sql";

const ROOT = resolve(__dirname, "..", "..");

export function migrationSql(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), "utf8").replace(/\r\n/g, "\n");
}

// ---- fixture identifiers (stable, so assertions can reference them) ----
export const PROP_A = "aaaaaaaa-0000-4000-8000-000000000001";
export const PROP_B = "bbbbbbbb-0000-4000-8000-000000000002";
export const OUTLET_A_BAR = "a0000000-0000-4000-8000-00000000000b";
export const OUTLET_A_RESTAURANT = "a0000000-0000-4000-8000-00000000000r".replace("r", "1");
export const OUTLET_A_QUIET = "a0000000-0000-4000-8000-00000000000c";
export const OUTLET_B = "b0000000-0000-4000-8000-00000000000b";

export const USER_EXEC = "11111111-0000-4000-8000-000000000001"; // general_manager on A
export const USER_ACCOUNTANT = "11111111-0000-4000-8000-000000000004"; // accountant on A
export const USER_CASHIER = "22222222-0000-4000-8000-000000000002"; // cashier on A -- NOT executive
export const USER_SUPER = "33333333-0000-4000-8000-000000000003"; // super_admin (all properties)
export const USER_RECEIVER_ONLY = "44444444-0000-4000-8000-000000000004";
export const USER_EXEC_B = "55555555-0000-4000-8000-000000000005"; // general_manager on B only

export const MENU_COFFEE = "cccccccc-0000-4000-8000-000000000001";
export const MENU_COFFEE_TWIN = "cccccccc-0000-4000-8000-000000000002"; // same NAME, different product

/** The minimum faithful slice of the shipped schema these RPCs read. */
const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE auth.users (id uuid PRIMARY KEY);

-- Supabase's auth.uid(), backed by a settable GUC so a test can "log in".
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
  SELECT NULLIF(current_setting('app.uid', true), '')::uuid
$fn$;

CREATE TYPE public.app_role AS ENUM (
  'super_admin','hotel_owner','general_manager','front_desk',
  'reservations','cashier','accountant',
  'housekeeping_supervisor','housekeeping','guest'
);
CREATE TYPE public.payment_method AS ENUM ('cash','card','bank_transfer','mobile_money','wallet','other');
CREATE TYPE public.outlet_kind AS ENUM ('restaurant','bar','room_service','other');
CREATE TYPE public.pos_order_status AS ENUM ('open','sent','served','closed','void');

CREATE TABLE public.properties (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  base_currency text NOT NULL DEFAULT 'GHS'
);

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  full_name text
);

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role app_role NOT NULL,
  property_id uuid
);

CREATE TABLE public.reservation_charges (id uuid PRIMARY KEY);

CREATE TABLE public.pos_outlets (
  id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind outlet_kind NOT NULL DEFAULT 'restaurant',
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE public.pos_menu_items (id uuid PRIMARY KEY, name text NOT NULL);

CREATE TABLE public.pos_orders (
  id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  outlet_id uuid NOT NULL REFERENCES public.pos_outlets(id) ON DELETE RESTRICT,
  code text NOT NULL,
  status pos_order_status NOT NULL DEFAULT 'open',
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  tax numeric(14,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL DEFAULT 0,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  created_by uuid REFERENCES auth.users(id)
);

CREATE TABLE public.pos_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.pos_orders(id) ON DELETE CASCADE,
  menu_item_id uuid REFERENCES public.pos_menu_items(id) ON DELETE SET NULL,
  name_snapshot text NOT NULL,
  price_snapshot numeric(12,2) NOT NULL,
  quantity numeric(10,2) NOT NULL DEFAULT 1
);

CREATE TABLE public.pos_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.pos_orders(id) ON DELETE CASCADE,
  method payment_method NOT NULL,
  amount numeric(14,2) NOT NULL,
  folio_charge_id uuid REFERENCES public.reservation_charges(id) ON DELETE SET NULL,
  received_by uuid REFERENCES auth.users(id),
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Role helpers, copied from 20260705091747 (SECURITY DEFINER there too, so
-- they can read user_roles regardless of the caller's own RLS).
CREATE FUNCTION public.has_any_role(_user_id uuid, _roles app_role[], _property_id uuid DEFAULT NULL::uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = _user_id AND (
      ur.role = 'super_admin'
      OR (ur.role = ANY(_roles) AND (_property_id IS NULL OR ur.property_id = _property_id))
    )
  )
$fn$;

CREATE FUNCTION public.can_access_property(_user_id uuid, _property_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = _user_id AND (
      ur.role = 'super_admin'
      OR ur.property_id = _property_id
    )
  )
$fn$;

-- Supabase's API roles.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
GRANT SELECT ON public.properties, public.profiles, public.pos_outlets,
  public.pos_orders, public.pos_order_items, public.pos_payments,
  public.pos_menu_items TO anon, authenticated;

-- RLS, verbatim in shape from the shipped POS migration.
ALTER TABLE public.pos_outlets ENABLE ROW LEVEL SECURITY;
CREATE POLICY out_read ON public.pos_outlets FOR SELECT TO authenticated
  USING (public.can_access_property(auth.uid(), property_id));

ALTER TABLE public.pos_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY porders_read ON public.pos_orders FOR SELECT TO authenticated
  USING (public.can_access_property(auth.uid(), property_id));

ALTER TABLE public.pos_order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY poit_read ON public.pos_order_items FOR SELECT TO authenticated
  USING (EXISTS(SELECT 1 FROM public.pos_orders o WHERE o.id=order_id AND public.can_access_property(auth.uid(), o.property_id)));

ALTER TABLE public.pos_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY ppay_read ON public.pos_payments FOR SELECT TO authenticated
  USING (EXISTS(SELECT 1 FROM public.pos_orders o WHERE o.id=order_id AND public.can_access_property(auth.uid(), o.property_id)));

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_self_select ON public.profiles FOR SELECT TO authenticated
  USING (auth.uid() = id);
CREATE POLICY profiles_admin_select ON public.profiles FOR SELECT TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager']::app_role[], NULL));
`;

/**
 * Fixtures. Deliberately covers: two properties, an executive user, an
 * accountant, a NON-executive (cashier), a super_admin, a payment-only
 * receiver, a quiet outlet, a pre-range live order, a post-_to live order,
 * a void order (with a payment), a folio settlement, ordinary cash/card/
 * mobile-money settlements, a multi-item + multi-payment order, two
 * distinct menu items sharing one name, and a NULL menu_item_id row.
 *
 * REPORT WINDOW used by the tests is 2026-08-01 .. 2026-08-31.
 */
const FIXTURES = `
INSERT INTO public.properties (id, name, base_currency) VALUES
  ('${PROP_A}', 'Property A', 'GHS'),
  ('${PROP_B}', 'Property B', 'AUD');

INSERT INTO auth.users (id) VALUES
  ('${USER_EXEC}'), ('${USER_ACCOUNTANT}'), ('${USER_CASHIER}'),
  ('${USER_SUPER}'), ('${USER_RECEIVER_ONLY}'), ('${USER_EXEC_B}');

INSERT INTO public.profiles (id, full_name) VALUES
  ('${USER_EXEC}', 'Ama Exec'),
  ('${USER_ACCOUNTANT}', 'Kofi Accountant'),
  ('${USER_CASHIER}', 'Yaw Cashier'),
  ('${USER_SUPER}', 'Root Admin'),
  ('${USER_RECEIVER_ONLY}', 'Esi Receiver'),
  ('${USER_EXEC_B}', 'Bee Manager');

INSERT INTO public.user_roles (user_id, role, property_id) VALUES
  ('${USER_EXEC}', 'general_manager', '${PROP_A}'),
  ('${USER_ACCOUNTANT}', 'accountant', '${PROP_A}'),
  ('${USER_CASHIER}', 'cashier', '${PROP_A}'),
  ('${USER_SUPER}', 'super_admin', NULL),
  ('${USER_RECEIVER_ONLY}', 'cashier', '${PROP_A}'),
  ('${USER_EXEC_B}', 'general_manager', '${PROP_B}');

INSERT INTO public.reservation_charges (id) VALUES ('ffffffff-0000-4000-8000-00000000000f');

INSERT INTO public.pos_outlets (id, property_id, name, kind) VALUES
  ('${OUTLET_A_BAR}', '${PROP_A}', 'A Bar', 'bar'),
  ('${OUTLET_A_RESTAURANT}', '${PROP_A}', 'A Restaurant', 'restaurant'),
  ('${OUTLET_A_QUIET}', '${PROP_A}', 'A Quiet Room Service', 'room_service'),
  ('${OUTLET_B}', '${PROP_B}', 'B Bar', 'bar');

INSERT INTO public.pos_menu_items (id, name) VALUES
  ('${MENU_COFFEE}', 'Coffee'),
  ('${MENU_COFFEE_TWIN}', 'Coffee');

-- O1: closed, multi-item AND multi-payment (join-multiplication fixture).
--     subtotal 100, tax 10, total 110. Items: 2x30 + 1x40 = 100.
--     Payments: cash 60 + card 50 = 110 (two till rows, one order).
INSERT INTO public.pos_orders (id, property_id, outlet_id, code, status, subtotal, tax, total, opened_at, closed_at, created_by) VALUES
  ('01000000-0000-4000-8000-000000000001', '${PROP_A}', '${OUTLET_A_BAR}', 'O1', 'closed', 100, 10, 110,
   '2026-08-05T09:00:00Z', '2026-08-05T12:00:00Z', '${USER_EXEC}');
INSERT INTO public.pos_order_items (order_id, menu_item_id, name_snapshot, price_snapshot, quantity) VALUES
  ('01000000-0000-4000-8000-000000000001', '${MENU_COFFEE}', 'Coffee', 30, 2),
  ('01000000-0000-4000-8000-000000000001', NULL, 'Deleted Pastry', 40, 1);
INSERT INTO public.pos_payments (order_id, method, amount, folio_charge_id, received_by, received_at) VALUES
  ('01000000-0000-4000-8000-000000000001', 'cash', 60, NULL, '${USER_EXEC}', '2026-08-05T12:00:00Z'),
  ('01000000-0000-4000-8000-000000000001', 'card', 50, NULL, '${USER_EXEC}', '2026-08-05T12:05:00Z');

-- O2: closed, settled ENTIRELY to a guest folio -- must NOT hit till figures,
--     but MUST still count as an operational sale. total 200.
INSERT INTO public.pos_orders (id, property_id, outlet_id, code, status, subtotal, tax, total, opened_at, closed_at, created_by) VALUES
  ('02000000-0000-4000-8000-000000000002', '${PROP_A}', '${OUTLET_A_RESTAURANT}', 'O2', 'closed', 180, 20, 200,
   '2026-08-06T09:00:00Z', '2026-08-06T13:00:00Z', '${USER_EXEC}');
INSERT INTO public.pos_order_items (order_id, menu_item_id, name_snapshot, price_snapshot, quantity) VALUES
  ('02000000-0000-4000-8000-000000000002', '${MENU_COFFEE_TWIN}', 'Coffee', 90, 2);
INSERT INTO public.pos_payments (order_id, method, amount, folio_charge_id, received_by, received_at) VALUES
  ('02000000-0000-4000-8000-000000000002', 'other', 200, 'ffffffff-0000-4000-8000-00000000000f', '${USER_EXEC}', '2026-08-06T13:00:00Z');

-- O3: closed, mobile money, received by a user who created NO orders.
INSERT INTO public.pos_orders (id, property_id, outlet_id, code, status, subtotal, tax, total, opened_at, closed_at, created_by) VALUES
  ('03000000-0000-4000-8000-000000000003', '${PROP_A}', '${OUTLET_A_BAR}', 'O3', 'closed', 50, 0, 50,
   '2026-08-07T09:00:00Z', '2026-08-07T10:00:00Z', NULL);
INSERT INTO public.pos_payments (order_id, method, amount, folio_charge_id, received_by, received_at) VALUES
  ('03000000-0000-4000-8000-000000000003', 'mobile_money', 50, NULL, '${USER_RECEIVER_ONLY}', '2026-08-07T10:00:00Z');

-- O4: VOID, with a payment row -- neither may reach any figure.
INSERT INTO public.pos_orders (id, property_id, outlet_id, code, status, subtotal, tax, total, opened_at, closed_at, created_by) VALUES
  ('04000000-0000-4000-8000-000000000004', '${PROP_A}', '${OUTLET_A_BAR}', 'O4', 'void', 900, 90, 990,
   '2026-08-08T09:00:00Z', '2026-08-08T11:00:00Z', '${USER_EXEC}');
INSERT INTO public.pos_order_items (order_id, menu_item_id, name_snapshot, price_snapshot, quantity) VALUES
  ('04000000-0000-4000-8000-000000000004', '${MENU_COFFEE}', 'Coffee', 900, 1);
INSERT INTO public.pos_payments (order_id, method, amount, folio_charge_id, received_by, received_at) VALUES
  ('04000000-0000-4000-8000-000000000004', 'cash', 990, NULL, '${USER_EXEC}', '2026-08-08T11:00:00Z');

-- O5: LIVE, opened BEFORE the window and still open -> must be INCLUDED.
--     total deliberately 0 (open orders are not priced) while items are real.
INSERT INTO public.pos_orders (id, property_id, outlet_id, code, status, subtotal, tax, total, opened_at, closed_at, created_by) VALUES
  ('05000000-0000-4000-8000-000000000005', '${PROP_A}', '${OUTLET_A_BAR}', 'O5', 'open', 0, 0, 0,
   '2026-07-20T09:00:00Z', NULL, '${USER_EXEC}');
INSERT INTO public.pos_order_items (order_id, menu_item_id, name_snapshot, price_snapshot, quantity) VALUES
  ('05000000-0000-4000-8000-000000000005', '${MENU_COFFEE}', 'Coffee', 25, 3);

-- O6: LIVE 'served', opened INSIDE the window -> INCLUDED. items 2x15 = 30.
INSERT INTO public.pos_orders (id, property_id, outlet_id, code, status, subtotal, tax, total, opened_at, closed_at, created_by) VALUES
  ('06000000-0000-4000-8000-000000000006', '${PROP_A}', '${OUTLET_A_RESTAURANT}', 'O6', 'served', 0, 0, 0,
   '2026-08-10T09:00:00Z', NULL, '${USER_EXEC}');
INSERT INTO public.pos_order_items (order_id, menu_item_id, name_snapshot, price_snapshot, quantity) VALUES
  ('06000000-0000-4000-8000-000000000006', '${MENU_COFFEE}', 'Coffee', 15, 2);

-- O7: LIVE 'sent', opened AFTER _to -> must be EXCLUDED (case B).
INSERT INTO public.pos_orders (id, property_id, outlet_id, code, status, subtotal, tax, total, opened_at, closed_at, created_by) VALUES
  ('07000000-0000-4000-8000-000000000007', '${PROP_A}', '${OUTLET_A_BAR}', 'O7', 'sent', 0, 0, 0,
   '2026-09-15T09:00:00Z', NULL, '${USER_EXEC}');
INSERT INTO public.pos_order_items (order_id, menu_item_id, name_snapshot, price_snapshot, quantity) VALUES
  ('07000000-0000-4000-8000-000000000007', '${MENU_COFFEE}', 'Coffee', 500, 1);

-- O8: Property B, closed -- isolation fixture. Never visible under A.
INSERT INTO public.pos_orders (id, property_id, outlet_id, code, status, subtotal, tax, total, opened_at, closed_at, created_by) VALUES
  ('08000000-0000-4000-8000-000000000008', '${PROP_B}', '${OUTLET_B}', 'O8', 'closed', 700, 70, 770,
   '2026-08-05T09:00:00Z', '2026-08-05T12:00:00Z', '${USER_EXEC_B}');
INSERT INTO public.pos_order_items (order_id, menu_item_id, name_snapshot, price_snapshot, quantity) VALUES
  ('08000000-0000-4000-8000-000000000008', '${MENU_COFFEE}', 'Coffee', 770, 1);
INSERT INTO public.pos_payments (order_id, method, amount, folio_charge_id, received_by, received_at) VALUES
  ('08000000-0000-4000-8000-000000000008', 'cash', 770, NULL, '${USER_EXEC_B}', '2026-08-05T12:00:00Z');

-- O9: closed in a DIFFERENT month, for the monthly-gap test. total 400.
INSERT INTO public.pos_orders (id, property_id, outlet_id, code, status, subtotal, tax, total, opened_at, closed_at, created_by) VALUES
  ('09000000-0000-4000-8000-000000000009', '${PROP_A}', '${OUTLET_A_BAR}', 'O9', 'closed', 400, 0, 400,
   '2026-06-10T09:00:00Z', '2026-06-10T12:00:00Z', '${USER_EXEC}');
INSERT INTO public.pos_payments (order_id, method, amount, folio_charge_id, received_by, received_at) VALUES
  ('09000000-0000-4000-8000-000000000009', 'bank_transfer', 400, NULL, '${USER_EXEC}', '2026-06-10T12:00:00Z');
`;

export type Db = {
  raw: PGlite;
  /** Run SQL as the database owner (setup/mutation only, never as a caller). */
  admin(sql: string): Promise<void>;
  /** Call an RPC as `uid` in the `authenticated` role, with RLS enforced. */
  callAs<T = Record<string, unknown>>(
    uid: string | null,
    sql: string,
    role?: "authenticated" | "anon",
  ): Promise<T[]>;
  close(): Promise<void>;
};

async function connect(): Promise<Db> {
  const raw = await new PGlite();
  return {
    raw,
    async admin(sql: string) {
      await raw.exec(sql);
    },
    async callAs<T>(
      uid: string | null,
      sql: string,
      role: "authenticated" | "anon" = "authenticated",
    ) {
      await raw.exec(`SET LOCAL ROLE NONE;`).catch(() => undefined);
      await raw.query(`SELECT set_config('app.uid', $1, false)`, [uid ?? ""]);
      await raw.exec(`SET ROLE ${role};`);
      try {
        const res = await raw.query(sql);
        return res.rows as T[];
      } finally {
        await raw.exec("RESET ROLE;");
      }
    },
    async close() {
      await raw.close();
    },
  };
}

/** Schema + fixtures, with NO exec_pos_* function installed yet. */
export async function freshDb(): Promise<Db> {
  const db = await connect();
  await db.admin(SCHEMA);
  await db.admin(FIXTURES);
  return db;
}

/** Schema + fixtures + ONLY the original 20260826090000 definitions. */
export async function dbWithOriginalOnly(): Promise<Db> {
  const db = await freshDb();
  await db.admin(migrationSql(ORIGINAL_MIGRATION));
  return db;
}

/**
 * The REAL production upgrade path: original applied first, then the
 * forward correction applied over it -- never the correction alone.
 */
export async function dbWithMigrationChain(): Promise<Db> {
  const db = await dbWithOriginalOnly();
  await db.admin(migrationSql(CORRECTION_MIGRATION));
  return db;
}

/**
 * Column names of a RETURNS TABLE function, in order.
 *
 * Read from pg_get_function_result(), not pg_get_function_arguments():
 * for a RETURNS TABLE function the table columns are part of the RESULT
 * ("TABLE(a numeric, b bigint, ...)"), not the argument list.
 */
export async function returnColumns(db: Db, fnName: string): Promise<string[]> {
  const rows = await db.callAs<{ res: string }>(
    USER_SUPER,
    `SELECT pg_get_function_result(p.oid) AS res
     FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = '${fnName}'`,
  );
  const result = rows[0]?.res ?? "";
  const inner = result.replace(/^TABLE\(/, "").replace(/\)$/, "");
  if (inner === result) return [];
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(/\s+/)[0]);
}

/**
 * A `date` column comes back from PGlite as a JS Date at UTC midnight;
 * normalise it to the plain yyyy-mm-dd the SQL actually returned.
 */
export function dateKey(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

export const WINDOW_FROM = "2026-08-01";
export const WINDOW_TO = "2026-08-31";
