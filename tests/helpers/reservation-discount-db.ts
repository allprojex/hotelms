// In-process Postgres harness for the Reservation Discounts Phase 1 RPCs.
//
// PGlite is a real PostgreSQL build, so these tests execute the ACTUAL
// migration SQL and the ACTUAL plpgsql bodies -- including RLS, roles, enums,
// CHECK constraints, advisory locks and SELECT ... FOR UPDATE. Only the
// objects the discount migration touches are created, copied faithfully from
// the shipped schema migrations rather than invented.
//
// Columns the discount RPCs never read (guest_id, room_type_id, ...) are
// relaxed to nullable here; everything the RPCs DO read keeps its real type,
// precision and constraint.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

export const DISCOUNT_MIGRATION = "supabase/migrations/20260827120000_reservation_discounts.sql";

const ROOT = resolve(__dirname, "..", "..");

export function migrationSql(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), "utf8").replace(/\r\n/g, "\n");
}

// ---- stable fixture ids ----
export const PROP_GHS = "aaaaaaaa-0000-4000-8000-000000000001";
export const PROP_AUD = "bbbbbbbb-0000-4000-8000-000000000002";

export const USER_GM = "11111111-0000-4000-8000-000000000001"; // general_manager @ GHS
export const USER_OWNER = "11111111-0000-4000-8000-000000000002"; // hotel_owner @ GHS
export const USER_SUPER = "11111111-0000-4000-8000-000000000003"; // super_admin
export const USER_FRONT_DESK = "22222222-0000-4000-8000-000000000001"; // front_desk @ GHS -- NOT authorised
export const USER_RESERVATIONS = "22222222-0000-4000-8000-000000000002"; // reservations @ GHS -- NOT authorised
export const USER_GM_AUD = "33333333-0000-4000-8000-000000000001"; // general_manager @ AUD only

// Reservations: one per scenario so tests never interfere.
export const RES_CONFIRMED = "c0000000-0000-4000-8000-000000000001"; // 1000, unpaid
export const RES_CHECKED_IN = "c0000000-0000-4000-8000-000000000002"; // 1000, unpaid
export const RES_PART_PAID = "c0000000-0000-4000-8000-000000000003"; // 1000, paid 700 -> outstanding 300
export const RES_FULLY_PAID = "c0000000-0000-4000-8000-000000000004"; // 1000, paid 1000 -> outstanding 0
export const RES_CHECKED_OUT = "c0000000-0000-4000-8000-000000000005"; // 1000
export const RES_CANCELLED = "c0000000-0000-4000-8000-000000000006"; // 1000
export const RES_WITH_POS = "c0000000-0000-4000-8000-000000000007"; // room 1000 + POS 250 incidental
export const RES_REFUNDED = "c0000000-0000-4000-8000-000000000008"; // 1000, paid 1000, refunded 400
export const RES_ROUNDING = "c0000000-0000-4000-8000-000000000009"; // 333.33
export const RES_AUD = "d0000000-0000-4000-8000-000000000001"; // AUD property, 1000

const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
  SELECT NULLIF(current_setting('app.uid', true), '')::uuid
$fn$;

CREATE TYPE public.app_role AS ENUM (
  'super_admin','hotel_owner','general_manager','front_desk',
  'reservations','cashier','accountant',
  'housekeeping_supervisor','housekeeping','guest'
);
CREATE TYPE public.reservation_status AS ENUM
  ('confirmed','checked_in','checked_out','cancelled','no_show');
CREATE TYPE public.payment_method AS ENUM
  ('cash','card','bank_transfer','mobile_money','wallet','other');

CREATE TABLE public.properties (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  currency text NOT NULL DEFAULT 'GHS',
  base_currency text NOT NULL DEFAULT 'GHS'
);

CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text);

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, role app_role NOT NULL, property_id uuid
);

CREATE TABLE public.reservations (
  id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  code text NOT NULL,
  guest_id uuid,
  room_type_id uuid,
  check_in date NOT NULL,
  check_out date NOT NULL,
  status reservation_status NOT NULL DEFAULT 'confirmed',
  rate_total numeric(12,2) NOT NULL DEFAULT 0,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.reservation_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  description text NOT NULL,
  amount numeric(12,2) NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES auth.users(id)
);

CREATE TABLE public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  method payment_method NOT NULL,
  amount numeric(12,2) NOT NULL,
  received_by uuid REFERENCES auth.users(id),
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.reservation_payment_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
  amount numeric NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  refunded_by uuid NOT NULL REFERENCES auth.users(id),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Audit sink, matching the shipped audit_capture() target.
CREATE TABLE public.admin_action_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid, actor_id uuid, entity_type text, entity_id text, action text,
  before_snapshot jsonb, after_snapshot jsonb, memo text,
  ip text, user_agent text, os text, browser text,
  device_fingerprint text, session_id text,
  success boolean, remarks text, full_name_snapshot text, role_snapshot text,
  created_at timestamptz NOT NULL DEFAULT now()
);

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
    WHERE ur.user_id = _user_id AND (ur.role = 'super_admin' OR ur.property_id = _property_id)
  )
$fn$;

CREATE FUNCTION public.audit_capture(
  _property_id UUID, _entity_type TEXT, _entity_id TEXT, _action TEXT,
  _before JSONB, _after JSONB, _memo TEXT,
  _ip TEXT, _user_agent TEXT, _os TEXT, _browser TEXT,
  _fingerprint TEXT, _session_id TEXT, _success BOOLEAN, _remarks TEXT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE _id UUID; _name TEXT; _role TEXT;
BEGIN
  SELECT full_name INTO _name FROM public.profiles WHERE id = auth.uid();
  SELECT role::text INTO _role FROM public.user_roles WHERE user_id = auth.uid() LIMIT 1;
  INSERT INTO public.admin_action_logs(
    property_id, actor_id, entity_type, entity_id, action,
    before_snapshot, after_snapshot, memo,
    ip, user_agent, os, browser, device_fingerprint, session_id,
    success, remarks, full_name_snapshot, role_snapshot
  ) VALUES (
    _property_id, auth.uid(), _entity_type, _entity_id, _action,
    _before, _after, _memo, _ip, _user_agent, _os, _browser,
    _fingerprint, _session_id, COALESCE(_success, true), _remarks, _name, _role
  ) RETURNING id INTO _id;
  RETURN _id;
END; $fn$;

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reservations, public.reservation_charges,
  public.payments, public.reservation_payment_refunds TO authenticated;
GRANT SELECT ON public.properties, public.profiles TO anon, authenticated;
-- Read-only visibility of the audit sink so tests can assert the trail.
GRANT SELECT ON public.admin_action_logs TO authenticated;

ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;
CREATE POLICY res_read ON public.reservations FOR SELECT TO authenticated
  USING (public.can_access_property(auth.uid(), property_id));
CREATE POLICY res_write ON public.reservations FOR ALL TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','front_desk','reservations']::app_role[], property_id))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager','front_desk','reservations']::app_role[], property_id));

ALTER TABLE public.reservation_charges ENABLE ROW LEVEL SECURITY;
CREATE POLICY charges_read ON public.reservation_charges FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.reservations r WHERE r.id = reservation_id AND public.can_access_property(auth.uid(), r.property_id)));

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY payments_read ON public.payments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.reservations r WHERE r.id = reservation_id AND public.can_access_property(auth.uid(), r.property_id)));
`;

function reservation(id: string, prop: string, code: string, status: string, rate: string) {
  return `INSERT INTO public.reservations (id, property_id, code, check_in, check_out, status, rate_total, created_by)
          VALUES ('${id}','${prop}','${code}','2026-09-01','2026-09-03','${status}',${rate},'${USER_GM}');
          INSERT INTO public.reservation_charges (reservation_id, description, amount, posted_by)
          VALUES ('${id}','Room charge · 2 nights · Standard',${rate},'${USER_GM}');`;
}

const FIXTURES = `
INSERT INTO public.properties (id, name, currency, base_currency) VALUES
  ('${PROP_GHS}', 'Ghana Property', 'GHS', 'GHS'),
  -- Mirrors ThesKwoff Bar in production: currency and base_currency DISAGREE.
  ('${PROP_AUD}', 'Australia Property', 'GHS', 'AUD');

INSERT INTO auth.users (id) VALUES
  ('${USER_GM}'),('${USER_OWNER}'),('${USER_SUPER}'),
  ('${USER_FRONT_DESK}'),('${USER_RESERVATIONS}'),('${USER_GM_AUD}');

INSERT INTO public.profiles (id, full_name) VALUES
  ('${USER_GM}','Ama Manager'),('${USER_OWNER}','Kofi Owner'),('${USER_SUPER}','Root Admin'),
  ('${USER_FRONT_DESK}','Yaw FrontDesk'),('${USER_RESERVATIONS}','Esi Reservations'),
  ('${USER_GM_AUD}','Bruce Manager');

INSERT INTO public.user_roles (user_id, role, property_id) VALUES
  ('${USER_GM}','general_manager','${PROP_GHS}'),
  ('${USER_OWNER}','hotel_owner','${PROP_GHS}'),
  ('${USER_SUPER}','super_admin',NULL),
  ('${USER_FRONT_DESK}','front_desk','${PROP_GHS}'),
  ('${USER_RESERVATIONS}','reservations','${PROP_GHS}'),
  ('${USER_GM_AUD}','general_manager','${PROP_AUD}');

${reservation(RES_CONFIRMED, PROP_GHS, "R-CONF", "confirmed", "1000.00")}
${reservation(RES_CHECKED_IN, PROP_GHS, "R-IN", "checked_in", "1000.00")}
${reservation(RES_PART_PAID, PROP_GHS, "R-PART", "confirmed", "1000.00")}
${reservation(RES_FULLY_PAID, PROP_GHS, "R-FULL", "confirmed", "1000.00")}
${reservation(RES_CHECKED_OUT, PROP_GHS, "R-OUT", "checked_out", "1000.00")}
${reservation(RES_CANCELLED, PROP_GHS, "R-CANC", "cancelled", "1000.00")}
${reservation(RES_WITH_POS, PROP_GHS, "R-POS", "checked_in", "1000.00")}
${reservation(RES_REFUNDED, PROP_GHS, "R-REF", "confirmed", "1000.00")}
${reservation(RES_ROUNDING, PROP_GHS, "R-ROUND", "confirmed", "333.33")}
${reservation(RES_AUD, PROP_AUD, "R-AUD", "confirmed", "1000.00")}

-- Partially paid: 700 of 1000 -> outstanding 300.
INSERT INTO public.payments (reservation_id, method, amount, received_by)
VALUES ('${RES_PART_PAID}','cash',700.00,'${USER_GM}');

-- Fully paid: outstanding 0.
INSERT INTO public.payments (reservation_id, method, amount, received_by)
VALUES ('${RES_FULLY_PAID}','cash',1000.00,'${USER_GM}');

-- POS/incidental posted to the room: must NEVER widen the discount basis.
INSERT INTO public.reservation_charges (reservation_id, description, amount, posted_by)
VALUES ('${RES_WITH_POS}','POS · Bar tab',250.00,'${USER_GM}');

-- Paid 1000 then refunded 400 -> outstanding 400.
WITH p AS (
  INSERT INTO public.payments (reservation_id, method, amount, received_by)
  VALUES ('${RES_REFUNDED}','cash',1000.00,'${USER_GM}') RETURNING id
)
INSERT INTO public.reservation_payment_refunds (property_id, payment_id, amount, reason, refunded_by, request_id)
SELECT '${PROP_GHS}', p.id, 400.00, 'Guest complaint', '${USER_GM}', gen_random_uuid() FROM p;
`;

export type Db = {
  raw: PGlite;
  admin(sql: string): Promise<void>;
  callAs<T = Record<string, unknown>>(
    uid: string | null,
    sql: string,
    role?: "authenticated" | "anon",
  ): Promise<T[]>;
  close(): Promise<void>;
};

export async function freshDb(): Promise<Db> {
  const raw = await new PGlite();
  const db: Db = {
    raw,
    async admin(sql: string) {
      await raw.exec(sql);
    },
    async callAs<T>(
      uid: string | null,
      sql: string,
      role: "authenticated" | "anon" = "authenticated",
    ) {
      await raw.query(`SELECT set_config('app.uid', $1, false)`, [uid ?? ""]);
      await raw.exec(`SET ROLE ${role};`);
      try {
        return (await raw.query(sql)).rows as T[];
      } finally {
        await raw.exec("RESET ROLE;");
      }
    },
    async close() {
      await raw.close();
    },
  };
  await db.admin(SCHEMA);
  await db.admin(FIXTURES);
  await db.admin(migrationSql(DISCOUNT_MIGRATION));
  return db;
}

export const num = (v: unknown) => Number(v);

/** rate_total for one reservation. */
export async function rateTotal(db: Db, reservationId: string): Promise<number> {
  const rows = await db.callAs<{ rate_total: string }>(
    USER_SUPER,
    `SELECT rate_total FROM reservations WHERE id = '${reservationId}'`,
  );
  return num(rows[0]?.rate_total);
}

/** Signed sum of every folio line. */
export async function folioTotal(db: Db, reservationId: string): Promise<number> {
  const rows = await db.callAs<{ total: string }>(
    USER_SUPER,
    `SELECT COALESCE(SUM(amount),0) AS total FROM reservation_charges WHERE reservation_id = '${reservationId}'`,
  );
  return num(rows[0]?.total);
}

export async function outstanding(db: Db, reservationId: string): Promise<number> {
  const rows = await db.callAs<{ b: string }>(
    USER_SUPER,
    `SELECT public.reservation_outstanding_balance('${reservationId}') AS b`,
  );
  return num(rows[0]?.b);
}

export async function discountRows(db: Db, reservationId: string) {
  return db.callAs<Record<string, unknown>>(
    USER_SUPER,
    `SELECT * FROM reservation_discounts WHERE reservation_id = '${reservationId}' ORDER BY applied_at`,
  );
}

export async function chargeRows(db: Db, reservationId: string) {
  return db.callAs<Record<string, unknown>>(
    USER_SUPER,
    `SELECT description, amount FROM reservation_charges WHERE reservation_id = '${reservationId}' ORDER BY posted_at, description`,
  );
}

export async function auditRows(db: Db, entityId?: string) {
  return db.callAs<Record<string, unknown>>(
    USER_SUPER,
    `SELECT entity_type, entity_id, action, memo, actor_id, after_snapshot
       FROM admin_action_logs
      WHERE entity_type = 'reservation_discount'
      ${entityId ? `AND entity_id = '${entityId}'` : ""}
      ORDER BY created_at`,
  );
}

export function applySql(
  reservationId: string,
  type: "amount" | "percentage",
  value: number | string,
  reason = "Loyalty",
  requestId?: string,
) {
  const rid = requestId ?? `gen_random_uuid()`;
  const ridExpr = requestId ? `'${requestId}'` : rid;
  return `SELECT public.apply_reservation_discount('${reservationId}','${type}',${value},'${reason}',${ridExpr}) AS id`;
}

export function reverseSql(discountId: string, reason = "Applied in error", requestId?: string) {
  const ridExpr = requestId ? `'${requestId}'` : `gen_random_uuid()`;
  return `SELECT public.reverse_reservation_discount('${discountId}','${reason}',${ridExpr}) AS id`;
}
