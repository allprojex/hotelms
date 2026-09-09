// Target resolution, guards and HTTP helpers for the demo seeder.
//
// Two rules govern this file:
//
//   1. The demo project ref is an explicit allowlist and the production ref is
//      an explicit denylist. Every request URL is checked against both, on
//      every call — not once at startup — so no later code path can construct
//      a production URL.
//   2. Business writes are made as a SIGNED-IN USER, never with the service
//      role. The application's own posting logic (post_payment,
//      post_reservation_checkout, post_journal, every expense_* and payroll_*
//      RPC) authorizes on auth.uid() and has_any_role(); a service-role write
//      has no auth.uid(), so it would either be refused or — worse — silently
//      skip the accounting side effect and leave the demo internally
//      inconsistent. The service key is used ONLY for the Auth Admin API
//      (account creation, which is what the application's own
//      createManagedAccount server function uses it for) and for read-only
//      verification queries.

export const DEMO_REF = "akcppyymgoubsqedpkch";
export const PROD_REF = "texhuavnrdhaohqzlyqw";

export function assertDemoUrl(url) {
  const u = String(url);
  if (u.includes(PROD_REF)) throw new Error(`STOP: URL names the PRODUCTION project (${PROD_REF})`);
  if (!u.includes(DEMO_REF)) throw new Error(`STOP: URL does not name the authorized demo project (${DEMO_REF})`);
  return u;
}

export function loadContext(argv = process.argv.slice(2)) {
  const flags = Object.fromEntries(
    argv
      .filter((a) => a.startsWith("--"))
      .map((a) => {
        const [k, v = "true"] = a.replace(/^--/, "").split("=");
        return [k, v];
      }),
  );

  const ref = process.env.DEMO_SUPABASE_REF ?? DEMO_REF;
  if (ref !== DEMO_REF) throw new Error(`STOP: DEMO_SUPABASE_REF '${ref}' is not the authorized demo ref`);
  if (ref === PROD_REF) throw new Error("STOP: target is the production ref");

  const url = assertDemoUrl(process.env.DEMO_SUPABASE_URL ?? `https://${ref}.supabase.co`);
  const serviceKey = process.env.DEMO_SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.DEMO_SUPABASE_ANON_KEY;
  const propertyId = process.env.DEMO_PROPERTY_ID;
  const adminEmail = process.env.DEMO_ADMIN_EMAIL;
  const adminPassword = process.env.DEMO_ADMIN_PASSWORD;

  const missing = Object.entries({
    DEMO_SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    DEMO_SUPABASE_ANON_KEY: anonKey,
    DEMO_PROPERTY_ID: propertyId,
    DEMO_ADMIN_EMAIL: adminEmail,
    DEMO_ADMIN_PASSWORD: adminPassword,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`STOP: missing environment: ${missing.join(", ")}`);

  return {
    ref,
    url,
    serviceKey,
    anonKey,
    propertyId,
    adminEmail,
    adminPassword,
    asOf: flags["as-of"] ?? "2026-09-09",
    dryRun: flags["dry-run"] === "true",
    only: flags.only ? flags.only.split(",").map((s) => s.trim()).filter(Boolean) : null,
    allowTransactionalRerun: flags["allow-transactional-rerun"] === "true",
  };
}

// ── HTTP ────────────────────────────────────────────────────────────────────

async function request(ctx, path, init = {}, key = ctx.anonKey, token = null) {
  const url = assertDemoUrl(`${ctx.url}${path}`);
  const res = await fetch(url, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token ?? key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { ok: res.ok, status: res.status, body };
}

/** Sign a user in and return a client bound to that user's JWT. */
export async function signIn(ctx, email, password, label = email) {
  const res = await request(ctx, "/auth/v1/token?grant_type=password", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`STOP: sign-in failed for ${label}: ${res.status} ${JSON.stringify(res.body)}`);
  return makeClient(ctx, res.body.access_token, res.body.user.id, label);
}

export function makeClient(ctx, token, userId, label) {
  const call = (path, init) => request(ctx, path, init, ctx.anonKey, token);
  const api = {
    label,
    userId,
    token,
    raw: call,
    async select(table, query = "select=*") {
      const r = await call(`/rest/v1/${table}?${query}`);
      return must(`${label}: select ${table}`, r);
    },
    async insert(table, rows, prefer = "return=representation") {
      const payload = Array.isArray(rows) ? rows : [rows];
      if (!payload.length) return [];
      const r = await call(`/rest/v1/${table}`, {
        method: "POST",
        headers: { Prefer: prefer },
        body: JSON.stringify(payload),
      });
      return must(`${label}: insert ${table}`, r);
    },
    async upsert(table, rows, onConflict) {
      const payload = Array.isArray(rows) ? rows : [rows];
      if (!payload.length) return [];
      const r = await call(`/rest/v1/${table}?on_conflict=${onConflict}`, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(payload),
      });
      return must(`${label}: upsert ${table}`, r);
    },
    async update(table, filter, values) {
      const r = await call(`/rest/v1/${table}?${filter}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(values),
      });
      return must(`${label}: update ${table}`, r);
    },
    async rpc(fn, args = {}) {
      const r = await call(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
      return must(`${label}: rpc ${fn}`, r);
    },
    async tryRpc(fn, args = {}) {
      return call(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
    },
    /** Upload bytes to Storage as this user, exactly as the browser client does. */
    async upload(bucket, path, bytes, contentType) {
      const url = assertDemoUrl(`${ctx.url}/storage/v1/object/${bucket}/${path}`);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          apikey: ctx.anonKey,
          Authorization: `Bearer ${token}`,
          "Content-Type": contentType,
        },
        body: bytes,
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, body: text.slice(0, 300) };
    },
  };
  return api;
}

/** Service-role client. Auth Admin API and read-only verification only. */
export function serviceClient(ctx) {
  const call = (path, init) => request(ctx, path, init, ctx.serviceKey, ctx.serviceKey);
  return {
    raw: call,
    async select(table, query = "select=*") {
      return must(`service: select ${table}`, await call(`/rest/v1/${table}?${query}`));
    },
    async createUser(payload) {
      return must("service: createUser", await call("/auth/v1/admin/users", { method: "POST", body: JSON.stringify(payload) }));
    },
    async listUsers(perPage = 200) {
      return must("service: listUsers", await call(`/auth/v1/admin/users?per_page=${perPage}`));
    },
    async deleteUser(id) {
      return must("service: deleteUser", await call(`/auth/v1/admin/users/${id}`, { method: "DELETE" }));
    },
    async update(table, filter, values) {
      return must(
        `service: update ${table}`,
        await call(`/rest/v1/${table}?${filter}`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(values),
        }),
      );
    },
    async insert(table, rows) {
      const payload = Array.isArray(rows) ? rows : [rows];
      if (!payload.length) return [];
      return must(
        `service: insert ${table}`,
        await call(`/rest/v1/${table}`, {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(payload),
        }),
      );
    },
  };
}

export function must(label, r) {
  if (!r.ok) {
    const detail = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    throw new Error(`FAILED ${label}: ${r.status} ${String(detail).slice(0, 700)}`);
  }
  return r.body;
}

/** Run promise-returning work with a small concurrency limit. */
export async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Insert only the rows that are not already present, matched on a natural key.
 * Keeps every configuration stage safely rerunnable without needing a unique
 * constraint to exist for PostgREST's on_conflict.
 */
export async function ensureByKey(client, table, listQuery, rows, keyOf) {
  const existing = await client.select(table, listQuery);
  const have = new Set(existing.map((r) => keyOf(r)));
  const missing = rows.filter((r) => !have.has(keyOf(r)));
  const inserted = missing.length ? await client.insert(table, missing) : [];
  return { rows: [...existing, ...inserted], created: inserted.length, existing: existing.length };
}
