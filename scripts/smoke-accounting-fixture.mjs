#!/usr/bin/env node
// One-off fixture + authenticated smoke test for Phase 6A accounting/expense routes, run
// against the disposable local Supabase stack only. Creates a throwaway super_admin user +
// property, signs in, and drives the new routes with Playwright to catch runtime errors.
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const SB_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const BASE = process.env.BASE_URL ?? "http://localhost:8080";
if (!SERVICE_KEY || !ANON_KEY) throw new Error("Set SUPABASE_SERVICE_ROLE_KEY and SUPABASE_PUBLISHABLE_KEY");

const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
const anon = createClient(SB_URL, ANON_KEY, { auth: { persistSession: false } });

const email = `phase6a-smoke-${Date.now()}@example.test`;
const password = "Phase6ASmoke!2026x";

const created = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { full_name: "Phase 6A Smoke", identifier: `ADMIN-SMOKE-${Date.now()}`, account_type: "admin" },
});
if (created.error) throw created.error;
const userId = created.data.user.id;

const prop = await admin
  .from("properties")
  .insert({ name: "Phase 6A Smoke Property", code: `P6ASMOKE${Date.now()}`.slice(0, 20) })
  .select("id")
  .single();
if (prop.error) throw prop.error;
const propertyId = prop.data.id;

await admin.from("profiles").update({ status: "active", default_property_id: propertyId }).eq("id", userId);
await admin.from("user_roles").upsert({ user_id: userId, role: "super_admin", property_id: null });

const signed = await anon.auth.signInWithPassword({ email, password });
if (signed.error) throw signed.error;
const session = signed.data.session;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: "domcontentloaded" });

const projectRef = new URL(SB_URL).hostname === "127.0.0.1" ? "127" : new URL(SB_URL).hostname.split(".")[0];
const storageKey = `sb-${projectRef}-auth-token`;
await page.evaluate(
  ([k, v]) => window.localStorage.setItem(k, v),
  [storageKey, JSON.stringify(session)],
);

const routes = [
  "/accounting",
  "/accounting/periods",
  "/accounting/expense-categories",
  "/accounting/vendors",
  "/accounting/cost-centres",
  "/accounting/expenses",
  "/accounting/expenses/new",
  "/accounting/approvals",
  "/accounting/corrections",
  "/accounting/reports",
];
const failures = [];
for (const route of routes) {
  const errors = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`); });
  page.on("pageerror", (err) => errors.push(err.message));
  const resp = await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForTimeout(500);
  const text = await page.textContent("body");
  const status = resp?.status();
  console.log(`${route} -> http ${status}`);
  console.log(`  body sample: ${text?.slice(0, 160).replace(/\s+/g, " ")}`);
  if (status && status >= 500) errors.push(`http ${status}`);
  if (errors.length) failures.push({ route, errors });
}
await browser.close();

await admin.auth.admin.deleteUser(userId);
await admin.from("properties").delete().eq("id", propertyId);

if (failures.length) {
  console.error("FAILURES:", JSON.stringify(failures, null, 2));
  process.exit(1);
}
console.log("Phase 6A authenticated route smoke test passed.");
