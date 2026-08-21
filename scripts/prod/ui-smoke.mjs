#!/usr/bin/env node
// Section E/F — authenticated production UI smoke testing.
//
// Authentication model (per instruction — never store plaintext prod
// credentials):
//   1. A human signs into the production app once, in a real browser.
//   2. That session is exported to a Playwright `storageState` JSON file
//      (cookies + localStorage) via a one-time helper — see
//      docs/prod-release-runbook.md — and saved OUTSIDE this repo (e.g.
//      ~/.secrets/hotel-pms-prod-storage-state.json), never committed,
//      never in .env.
//   3. This script loads that file via PROD_SMOKE_STORAGE_STATE and reuses
//      the session. If the very first authenticated navigation lands back
//      on /auth, the session has expired — this script stops immediately
//      and asks for re-authentication. It never attempts to log in with a
//      stored username/password, because none is ever stored.
//
// Tag gating: @prod-readonly always runs. @prod-write / @prod-financial
// only run if the release plan's ui_smoke.authorize_write_tests /
// authorize_financial_tests are true — release-plan.mjs already refuses to
// load a plan that requests one of those tags without its matching
// authorization flag, so this script's own tag intersection is a second,
// independent gate on top of that.

import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { loadProductionConfig, log, pass, fail } from "./lib/guard.mjs";
import { loadReleasePlan } from "./lib/release-plan.mjs";
import { routesForTags } from "./ui-routes.mjs";
import { runArInvoiceFinancialScenario } from "./ui-scenarios/ar-invoice-financial.mjs";

const LABEL = "ui-smoke";

function parseArgs(argv) {
  const out = { tags: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--plan") out.plan = argv[++i];
    if (argv[i] === "--tags") out.tags = argv[++i].split(",");
  }
  return out;
}

const IGNORE_PATTERNS = [
  /data-tsd-source/i,
  /Download the React DevTools/i,
  /\[vite\]/i,
  /Failed to load resource.*favicon/i,
];
function isNoise(text) {
  return IGNORE_PATTERNS.some((r) => r.test(text));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadProductionConfig();
  const baseUrl = `https://${config.production_domain}`;

  let planTags = ["@prod-readonly"];
  let authorizeWrite = false;
  let authorizeFinancial = false;
  if (args.plan) {
    const { plan } = loadReleasePlan(args.plan);
    if (plan.ui_smoke) {
      planTags = plan.ui_smoke.tags ?? planTags;
      authorizeWrite = !!plan.ui_smoke.authorize_write_tests;
      authorizeFinancial = !!plan.ui_smoke.authorize_financial_tests;
    }
  }
  // Independent second gate: never run a tag the plan didn't authorize, even
  // if the CLI --tags flag asks for it.
  const authorizedTags = ["@prod-readonly"];
  if (planTags.includes("@prod-write") && authorizeWrite) authorizedTags.push("@prod-write");
  if (planTags.includes("@prod-financial") && authorizeFinancial)
    authorizedTags.push("@prod-financial");

  const runTags = args.tags ? args.tags.filter((t) => authorizedTags.includes(t)) : authorizedTags;
  log(LABEL, `Authorized tags: ${authorizedTags.join(", ")} | running: ${runTags.join(", ")}`);

  const storageStatePath = process.env.PROD_SMOKE_STORAGE_STATE;
  if (!storageStatePath || !existsSync(storageStatePath)) {
    throw new Error(
      "PROD_SMOKE_STORAGE_STATE is not set or the file doesn't exist. This must point at a Playwright " +
        "storageState JSON file saved OUTSIDE this repo from a human's one-time production sign-in. " +
        "See docs/prod-release-runbook.md.",
    );
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    storageState: storageStatePath,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  // Session-expiry check: hit a known authenticated route first. A redirect
  // to /auth means the saved session is dead — stop, don't try to log in.
  await page.goto(`${baseUrl}/dashboard`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(500);
  if (page.url().includes("/auth")) {
    await browser.close();
    throw new Error(
      "The saved production session appears to be expired (redirected to /auth). Stopping — " +
        "re-authenticate in a real browser and re-export PROD_SMOKE_STORAGE_STATE. Not attempting " +
        "any stored-credential login, per policy.",
    );
  }
  pass(LABEL, "production session is valid (no redirect to /auth)");

  const failures = [];
  const results = { readonly: [], write: [], financial: [] };

  if (runTags.includes("@prod-readonly")) {
    const routes = routesForTags(["@prod-readonly"]);
    log(LABEL, `Running ${routes.length} read-only route checks ...`);
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
        const resp = await page.goto(`${baseUrl}${route.path}`, {
          waitUntil: "networkidle",
          timeout: 30_000,
        });
        await page.waitForTimeout(300);
        if (resp && resp.status() >= 500) errors.push(`http ${resp.status()}`);
      } catch (e) {
        errors.push(`navigation: ${e.message}`);
      }
      page.off("console", onConsole);
      page.off("pageerror", onPageError);

      results.readonly.push({ route: route.path, ok: errors.length === 0, errors });
      if (errors.length) {
        failures.push({ route: route.path, errors });
        log(LABEL, `FAIL  ${route.path}`);
        for (const e of errors) log(LABEL, `      ${e}`);
      } else {
        log(LABEL, `ok    ${route.path}`);
      }
    }
  }

  if (runTags.includes("@prod-financial")) {
    log(LABEL, "Running @prod-financial scenario: ar-invoice-financial ...");
    try {
      const r = await runArInvoiceFinancialScenario(page, { baseUrl });
      results.financial.push(r);
      if (r.ok) pass(LABEL, `ar-invoice-financial: ${r.note}`);
      else log(LABEL, `ar-invoice-financial skipped: ${r.note}`);
    } catch (e) {
      results.financial.push({ scenario: "ar-invoice-financial", ok: false, note: e.message });
      failures.push({ route: "(scenario) ar-invoice-financial", errors: [e.message] });
      fail(LABEL, `ar-invoice-financial: ${e.message}`);
    }
  }

  // @prod-write has no generic implementation yet — this is a deliberate,
  // documented gap (see docs/prod-release-runbook.md "Extending UI smoke
  // coverage") rather than a silent no-op that looks like a pass.
  if (runTags.includes("@prod-write")) {
    log(
      LABEL,
      "@prod-write authorized but no non-financial write scenario is implemented yet — " +
        "nothing ran for this tag. Add one under scripts/prod/ui-scenarios/ following ar-invoice-financial.mjs.",
    );
  }

  await browser.close();

  process.stdout.write("\n" + JSON.stringify({ authorizedTags, runTags, results }, null, 2) + "\n");

  if (failures.length) {
    fail(LABEL, `${failures.length} check(s) failed`);
    process.exit(1);
  }
  pass(LABEL, "all authorized UI smoke checks passed");
}

main().catch((e) => {
  fail(LABEL, e.message);
  process.exit(1);
});
