// Section F — route coverage manifest for production UI smoke testing.
// Every entry here is @prod-readonly: navigate, wait for network idle, fail
// on a 5xx response or an uncaught console/page error. Nothing on this list
// creates, edits, or deletes data.
//
// Coverage gaps (documented, not silently missing): a few Section F items
// are nested UI, not their own route, and need an interactive Playwright
// locator rather than a bare navigation check — folio detail (nested under
// a specific reservation/POS order id), the AR customer-statement dialog
// (opened from within /accounting/ar for a specific customer), and property
// switching (a header control, exercised separately in ui-smoke.mjs's
// propertySwitchCheck). Add dedicated interactive checks for these as this
// harness matures; a bare route visit can't reach them because they require
// an existing record id or a prior click.

export const READONLY_ROUTES = [
  // --- login / session ---
  { path: "/auth", tags: ["@prod-readonly"], label: "login page" },
  { path: "/dashboard", tags: ["@prod-readonly"], label: "dashboard (session validity)" },

  // --- reservations / rooms / housekeeping ---
  { path: "/calendar", tags: ["@prod-readonly"] },
  { path: "/reservations", tags: ["@prod-readonly"] },
  { path: "/guests", tags: ["@prod-readonly"] },
  { path: "/rooms", tags: ["@prod-readonly"] },
  { path: "/rooms/types", tags: ["@prod-readonly"] },
  { path: "/rates", tags: ["@prod-readonly"] },
  { path: "/housekeeping", tags: ["@prod-readonly"] },

  // --- properties / users / admin / branding (branding renders inside /admin) ---
  { path: "/properties", tags: ["@prod-readonly"] },
  { path: "/users", tags: ["@prod-readonly"] },
  { path: "/settings", tags: ["@prod-readonly"] },
  { path: "/admin", tags: ["@prod-readonly"], label: "admin (includes branding module)" },
  { path: "/admin/health", tags: ["@prod-readonly"] },
  { path: "/admin/security/passkeys", tags: ["@prod-readonly"] },

  // --- reports / analytics / channels ---
  { path: "/analytics", tags: ["@prod-readonly"] },
  { path: "/reports", tags: ["@prod-readonly"] },
  { path: "/channels", tags: ["@prod-readonly"] },

  // --- POS / inventory (folio detail lives under a specific pos/order/:id) ---
  { path: "/pos", tags: ["@prod-readonly"] },
  { path: "/pos/menu", tags: ["@prod-readonly"] },
  { path: "/inventory", tags: ["@prod-readonly"] },
  { path: "/inventory/adjustments", tags: ["@prod-readonly"] },
  { path: "/inventory/transfers", tags: ["@prod-readonly"] },
  { path: "/inventory/purchase-orders", tags: ["@prod-readonly"] },
  { path: "/inventory/settings", tags: ["@prod-readonly"] },

  // --- accounting: AR, AP, journal, reports ---
  { path: "/accounting", tags: ["@prod-readonly"] },
  { path: "/accounting/accounts", tags: ["@prod-readonly"] },
  { path: "/accounting/ap", tags: ["@prod-readonly"], label: "Accounts Payable" },
  {
    path: "/accounting/ar",
    tags: ["@prod-readonly"],
    label: "Accounts Receivable (invoices/receipts/credit notes)",
  },
  { path: "/accounting/fx", tags: ["@prod-readonly"] },
  { path: "/accounting/journal", tags: ["@prod-readonly"] },
  { path: "/accounting/periods", tags: ["@prod-readonly"] },
  { path: "/accounting/posting-rules", tags: ["@prod-readonly"] },
  { path: "/accounting/reports", tags: ["@prod-readonly"] },
  { path: "/accounting/night-audit", tags: ["@prod-readonly"] },
  { path: "/accounting/expense-categories", tags: ["@prod-readonly"] },
  { path: "/accounting/vendors", tags: ["@prod-readonly"] },
  { path: "/accounting/cost-centres", tags: ["@prod-readonly"] },
  { path: "/accounting/expenses", tags: ["@prod-readonly"] },
  { path: "/accounting/approvals", tags: ["@prod-readonly"] },
  { path: "/accounting/corrections", tags: ["@prod-readonly"] },
];

export function routesForTags(authorizedTags) {
  return READONLY_ROUTES.filter((r) => r.tags.some((t) => authorizedTags.includes(t)));
}
