#!/usr/bin/env node
// Infinity PMS — demo environment seeder.
//
//   node scripts/demo/seed-demo.mjs [--dry-run] [--only=users,rooms] [--as-of=YYYY-MM-DD]
//
// Seeds the DEMO Supabase project (and only that project) with a coherent
// fictional operating hotel: Infinity Grand Hotel, Accra, GHS, Africa/Accra.
//
// Design rules, all enforced in code rather than by convention:
//
//   * Target allowlist / production denylist — scripts/demo/lib/env.mjs checks
//     every request URL, not just the startup configuration.
//   * No secrets in this repository. Everything comes from the environment.
//   * Business data is written as a SIGNED-IN USER with the role that would
//     really do the work (front desk opens reservations, the cashier takes
//     payments, the storekeeper receives stock, the accountant posts
//     expenses), so RLS, grants, triggers and the automatic accounting
//     postings all execute exactly as they do in the running application.
//   * Reference and configuration data (room types, outlets, menus, chart of
//     accounts extensions) is inserted directly — the same thing the admin
//     screens do.
//   * Stages that create transactional history refuse to run twice unless
//     --allow-transactional-rerun is passed, so a partial rerun cannot
//     silently double the demo's revenue.
//
// Required environment (see .env.demo.example for the deployment's own copy):
//   DEMO_SUPABASE_URL, DEMO_SUPABASE_ANON_KEY, DEMO_SUPABASE_SERVICE_ROLE_KEY,
//   DEMO_PROPERTY_ID, DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD,
//   DEMO_CREDENTIAL_FILE

import { loadContext, signIn, serviceClient } from "./lib/env.mjs";

const STAGES = [
  ["users", () => import("./stages/01-users.mjs")],
  ["property", () => import("./stages/02-property.mjs")],
  ["catalog", () => import("./stages/03-catalog.mjs")],
  ["operations", () => import("./stages/04-operations.mjs")],
  ["nightaudit", () => import("./stages/05-nightaudit.mjs")],
  ["accounting", () => import("./stages/06-accounting.mjs")],
  ["hrm", () => import("./stages/07-hrm.mjs")],
  ["payroll", () => import("./stages/08-payroll.mjs")],
  ["gallery", () => import("./stages/09-gallery.mjs")],
];

const started = Date.now();
const ctx = loadContext();
const log = (msg) => console.log(msg);

log(`Infinity PMS demo seeder`);
log(`  target project : ${ctx.ref}  (${ctx.url})`);
log(`  property       : ${ctx.propertyId}`);
log(`  business date  : ${ctx.asOf}`);
log(`  mode           : ${ctx.dryRun ? "DRY RUN — no writes" : "write"}`);

const service = serviceClient(ctx);
const property = await service.select(
  "properties",
  `select=id,name,code,base_currency,timezone&id=eq.${ctx.propertyId}`,
);
if (!property.length) throw new Error(`STOP: property ${ctx.propertyId} not found in ${ctx.ref}`);
log(`  property is    : ${property[0].name} (${property[0].code}) ${property[0].base_currency} ${property[0].timezone}`);

const admin = await signIn(ctx, ctx.adminEmail, ctx.adminPassword, "demo.admin");
log(`  signed in as   : ${admin.userId}\n`);

const state = { property: property[0], results: {} };
const selected = ctx.only ? STAGES.filter(([name]) => ctx.only.includes(name)) : STAGES;
if (ctx.only) {
  const unknown = ctx.only.filter((n) => !STAGES.some(([name]) => name === n));
  if (unknown.length) throw new Error(`STOP: unknown stage(s): ${unknown.join(", ")}`);
}

for (const [name, load] of selected) {
  const stage = await load();
  log(`── ${name} ${"─".repeat(Math.max(0, 60 - name.length))}`);
  const t = Date.now();
  const result = await stage.run({ ctx, admin, service, state, log, signIn: (e, p, l) => signIn(ctx, e, p, l) });
  state.results[name] = result ?? {};
  Object.assign(state, result?.state ?? {});
  log(`   done in ${((Date.now() - t) / 1000).toFixed(1)}s\n`);
}

log(`All requested stages complete in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
