/**
 * Deployment identity — the handful of strings that differ between one
 * deployment of this application and another, and nothing else.
 *
 * WHY THIS EXISTS
 * The application already resolves *tenant* branding at runtime from the
 * database (system_settings + property_branding, surfaced by
 * useBrandSettings / get_brand_settings). What the database cannot reach are
 * the places that must produce a string before any query has run, or that run
 * outside React entirely:
 *
 *   - route `head()` meta titles, which are evaluated when the route module is
 *     defined, long before a session or a brand query exists;
 *   - crawler-facing <meta> in __root.tsx;
 *   - server-rendered print/PDF/export headers and footers;
 *   - the WebAuthn relying-party name shown in the browser's own passkey UI.
 *
 * Every one of those had the operator's brand name compiled into it. That is
 * fine for exactly one deployment and wrong for any second one, so those
 * literals now read from here instead.
 *
 * DEFAULTS ARE THE CURRENT PRODUCTION VALUES. With none of these variables
 * set — which is the state of the production environment file today — every
 * export below evaluates to the byte-identical string the code contained
 * before this module existed. Setting them is opt-in, per deployment.
 *
 * VITE_ PREFIX. Values consumed in the browser bundle must be inlined at build
 * time, so each key is read as `VITE_<KEY>` first and plain `<KEY>` second.
 * That lets a server-only caller be configured with `SITE_URL=…` while a
 * browser-facing caller reads the same value from `VITE_SITE_URL=…`; a
 * deployment that wants both simply sets both, which is what
 * .env.demo.example does.
 */

function readEnv(key: string): string | undefined {
  // import.meta.env is populated by Vite in both the client and the SSR
  // bundle; process.env is the fallback for plain-Node contexts (scripts,
  // the Nitro server's own environment) where Vite never transformed the file.
  const viteEnv = (import.meta as unknown as { env?: Record<string, unknown> })?.env;
  const fromVite = viteEnv?.[`VITE_${key}`];
  if (typeof fromVite === "string" && fromVite.trim()) return fromVite.trim();

  const fromNode =
    typeof process !== "undefined" && process.env
      ? (process.env[`VITE_${key}`] ?? process.env[key])
      : undefined;
  if (typeof fromNode === "string" && fromNode.trim()) return fromNode.trim();

  return undefined;
}

/** The brand name this deployment shipped with before it was configurable. */
export const FALLBACK_BRAND_NAME = "ThesKwoff Hotel";

/** The canonical origin this deployment shipped with before it was configurable. */
export const FALLBACK_SITE_ORIGIN = "https://theskwoffhotel.com";

/**
 * Display name for build-time and out-of-band surfaces (tab titles, print
 * footers, PDF metadata, the passkey prompt). Runtime, in-app branding still
 * comes from the database and continues to win wherever it is available.
 */
export const BRAND_NAME = readEnv("APP_BRAND_NAME") ?? FALLBACK_BRAND_NAME;

/**
 * Absolute origin for crawler-facing absolute URLs (og:image, twitter:image).
 * Trailing slashes are stripped so callers can always append a rooted path.
 */
export const SITE_ORIGIN = (readEnv("SITE_URL") ?? FALLBACK_SITE_ORIGIN).replace(/\/+$/, "");

/**
 * Which deployment this is. Deliberately NOT derived from NODE_ENV: a demo
 * deployment is a production build in every technical sense — it is minified,
 * it runs with NODE_ENV=production, and it must keep behaving that way (the
 * RBAC test harness, for one, refuses to activate unless NODE_ENV is *not*
 * production, and that protection must hold on the demo host too).
 */
export const APP_ENV = readEnv("APP_ENV") ?? "production";

/** True only on a deployment that has explicitly declared itself a demo. */
export const IS_DEMO = APP_ENV === "demo";

/**
 * Short, human-facing environment tag rendered by <EnvironmentBanner />.
 * Empty on production, which is what makes the banner render nothing there.
 */
export const ENVIRONMENT_LABEL = readEnv("APP_ENV_LABEL") ?? (IS_DEMO ? "DEMO" : "");

/**
 * Domain used to mint the non-routable placeholder address for an
 * identifier-only staff account (see users.functions.ts). `.invalid` is
 * reserved by RFC 2606 and can never be delivered to, but it should still
 * carry this deployment's own name rather than another operator's.
 */
export const ACCOUNTS_EMAIL_DOMAIN =
  readEnv("ACCOUNTS_EMAIL_DOMAIN") ?? "accounts.theskwoffhotel.invalid";

/**
 * Builds a document title. All three separators that already appear across the
 * route table are supported ("·" on most screens, "—" on a handful, "-" on the
 * payroll pages) so this change stays a pure substitution — no route's rendered
 * title changes by so much as a character on a deployment that sets no
 * variables. Normalising them to one separator would be a real, if tiny, UI
 * change and belongs in its own commit, not this one.
 */
export function pageTitle(page: string, separator: "·" | "—" | "-" = "·"): string {
  return `${page} ${separator} ${BRAND_NAME}`;
}
