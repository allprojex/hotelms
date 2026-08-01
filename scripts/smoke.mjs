#!/usr/bin/env node
/**
 * Full-route smoke test. Loads every route with a headless Chromium and
 * fails the process on runtime errors (uncaught exceptions, React hook
 * violations, console errors).
 *
 * Env:
 *   BASE_URL                              default http://localhost:8080
 *   LOVABLE_BROWSER_SUPABASE_STORAGE_KEY  optional; enables authenticated routes
 *   LOVABLE_BROWSER_SUPABASE_SESSION_JSON optional; paired with STORAGE_KEY
 *   SMOKE_PROPERTY_ID                     optional; tests parameterized booking results
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const STORAGE_KEY = process.env.LOVABLE_BROWSER_SUPABASE_STORAGE_KEY;
const SESSION_JSON = process.env.LOVABLE_BROWSER_SUPABASE_SESSION_JSON;
const HAS_AUTH = Boolean(STORAGE_KEY && SESSION_JSON);
const SMOKE_PROPERTY_ID = process.env.SMOKE_PROPERTY_ID;

const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const dayAfterTomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

const PUBLIC_ROUTES = [
  "/",
  "/auth",
  "/reset-password",
  "/book",
  "/book/manage",
  "/book/embed",
  ...(SMOKE_PROPERTY_ID
    ? [
        `/book/results?propertyId=${encodeURIComponent(SMOKE_PROPERTY_ID)}&checkIn=${tomorrow}&checkOut=${dayAfterTomorrow}&guests=1`,
      ]
    : []),
];

const AUTH_ROUTES = [
  "/dashboard",
  "/calendar",
  "/reservations",
  "/reservations/new",
  "/guests",
  "/rooms",
  "/rooms/types",
  "/rates",
  "/housekeeping",
  "/properties",
  "/users",
  "/settings",
  "/admin",
  "/analytics",
  "/reports",
  "/channels",
  "/pos",
  "/pos/menu",
  "/inventory",
  "/inventory/adjustments",
  "/inventory/transfers",
  "/inventory/purchase-orders",
  "/inventory/settings",
  "/accounting",
  "/accounting/accounts",
  "/accounting/ap",
  "/accounting/ar",
  "/accounting/fx",
  "/accounting/journal",
  "/accounting/periods",
  "/accounting/posting-rules",
  "/accounting/reports",
  "/accounting/night-audit",
  "/accounting/sync",
  "/accounting/expense-categories",
  "/accounting/vendors",
  "/accounting/cost-centres",
  "/accounting/expenses",
  "/accounting/expenses/new",
  "/accounting/approvals",
  "/accounting/corrections",
  "/security/passkeys",
  "/admin/security/passkeys",
];

const IGNORE_PATTERNS = [
  /data-tsd-source/i,
  /Download the React DevTools/i,
  /\[vite\]/i,
  /Failed to load resource.*favicon/i,
];

function isNoise(text) {
  return IGNORE_PATTERNS.some((r) => r.test(text));
}

async function run() {
  const routes = [...PUBLIC_ROUTES, ...(HAS_AUTH ? AUTH_ROUTES : [])];
  console.log(
    `Smoke testing ${routes.length} routes against ${BASE}` +
      (HAS_AUTH
        ? " (authenticated)"
        : " (public only — set LOVABLE_BROWSER_SUPABASE_* to include auth routes)"),
  );

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  if (HAS_AUTH) {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.evaluate(([k, v]) => window.localStorage.setItem(k, v), [STORAGE_KEY, SESSION_JSON]);
  }

  const failures = [];

  for (const route of routes) {
    const errors = [];
    const onConsole = (msg) => {
      if (msg.type() === "error" && !isNoise(msg.text()))
        errors.push(`console.error: ${msg.text()}`);
    };
    const onPageError = (err) => {
      if (!isNoise(err.message)) errors.push(`pageerror: ${err.message}`);
    };
    page.on("console", onConsole);
    page.on("pageerror", onPageError);

    try {
      const resp = await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(300);
      if (resp && resp.status() >= 500) errors.push(`http ${resp.status()}`);
    } catch (e) {
      errors.push(`navigation: ${e.message}`);
    }

    page.off("console", onConsole);
    page.off("pageerror", onPageError);

    if (errors.length) {
      failures.push({ route, errors });
      console.log(`FAIL  ${route}`);
      for (const e of errors) console.log(`      ${e}`);
    } else {
      console.log(`ok    ${route}`);
    }
  }

  await browser.close();

  if (failures.length) {
    console.error(`\n${failures.length} route(s) failed smoke.`);
    process.exit(1);
  }
  console.log(`\nAll ${routes.length} routes passed.`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
