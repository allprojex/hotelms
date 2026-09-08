import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const root = resolve(__dirname, "..");
function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const MODULE = "../src/lib/deployment-identity";

/**
 * The module snapshots its environment at import time (these are constants, not
 * getters), so every "what does X do when configured" test has to reset the
 * module registry and re-import with the variable in place.
 */
async function importWith(env: Record<string, string | undefined>) {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  try {
    return await import(MODULE);
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

afterEach(() => {
  vi.resetModules();
});

describe("deployment identity — production defaults are unchanged", () => {
  it("with no variables set, every value is the string the code contained before it was configurable", async () => {
    const m = await importWith({
      APP_BRAND_NAME: undefined,
      VITE_APP_BRAND_NAME: undefined,
      SITE_URL: undefined,
      VITE_SITE_URL: undefined,
      APP_ENV: undefined,
      VITE_APP_ENV: undefined,
      APP_ENV_LABEL: undefined,
      VITE_APP_ENV_LABEL: undefined,
      ACCOUNTS_EMAIL_DOMAIN: undefined,
      VITE_ACCOUNTS_EMAIL_DOMAIN: undefined,
    });
    expect(m.BRAND_NAME).toBe("ThesKwoff Hotel");
    expect(m.SITE_ORIGIN).toBe("https://theskwoffhotel.com");
    expect(m.APP_ENV).toBe("production");
    expect(m.IS_DEMO).toBe(false);
    expect(m.ACCOUNTS_EMAIL_DOMAIN).toBe("accounts.theskwoffhotel.invalid");
  });

  it("the environment label is empty on production, which is what makes the banner render nothing there", async () => {
    const m = await importWith({
      APP_ENV: undefined,
      VITE_APP_ENV: undefined,
      APP_ENV_LABEL: undefined,
      VITE_APP_ENV_LABEL: undefined,
    });
    expect(m.ENVIRONMENT_LABEL).toBe("");
  });

  it("page titles render exactly as they did before, for all three separators already in use", async () => {
    const m = await importWith({ APP_BRAND_NAME: undefined, VITE_APP_BRAND_NAME: undefined });
    expect(m.pageTitle("Accounting")).toBe("Accounting · ThesKwoff Hotel");
    expect(m.pageTitle("Dashboard", "—")).toBe("Dashboard — ThesKwoff Hotel");
    expect(m.pageTitle("Payslips", "-")).toBe("Payslips - ThesKwoff Hotel");
  });
});

describe("deployment identity — a second deployment can rename itself from configuration alone", () => {
  it("APP_BRAND_NAME changes the brand name and every title built from it", async () => {
    const m = await importWith({ APP_BRAND_NAME: "Infinity Grand Hotel" });
    expect(m.BRAND_NAME).toBe("Infinity Grand Hotel");
    expect(m.pageTitle("Payroll Approvals", "-")).toBe("Payroll Approvals - Infinity Grand Hotel");
  });

  it("SITE_URL becomes the crawler-facing origin, with any trailing slash stripped", async () => {
    const m = await importWith({ SITE_URL: "https://pms-demo.infinitytechapp.com/" });
    expect(m.SITE_ORIGIN).toBe("https://pms-demo.infinitytechapp.com");
  });

  it("APP_ENV=demo marks the deployment and supplies a default label", async () => {
    const m = await importWith({ APP_ENV: "demo", APP_ENV_LABEL: undefined });
    expect(m.APP_ENV).toBe("demo");
    expect(m.IS_DEMO).toBe(true);
    expect(m.ENVIRONMENT_LABEL).toBe("DEMO");
  });

  it("APP_ENV_LABEL overrides the default label without changing APP_ENV", async () => {
    const m = await importWith({ APP_ENV: "demo", APP_ENV_LABEL: "SANDBOX" });
    expect(m.ENVIRONMENT_LABEL).toBe("SANDBOX");
    expect(m.IS_DEMO).toBe(true);
  });

  it("the VITE_-prefixed form wins, so a browser-bundle value and a server value can coexist", async () => {
    const m = await importWith({
      VITE_APP_BRAND_NAME: "Infinity Grand Hotel",
      APP_BRAND_NAME: "Something Else",
    });
    expect(m.BRAND_NAME).toBe("Infinity Grand Hotel");
  });

  it("a blank or whitespace-only value falls through to the default rather than producing an empty name", async () => {
    const m = await importWith({ APP_BRAND_NAME: "   " });
    expect(m.BRAND_NAME).toBe("ThesKwoff Hotel");
  });

  it("IS_DEMO is not derived from NODE_ENV — a demo deployment is still a production build", async () => {
    const source = read(resolve(root, "src/lib/deployment-identity.ts"));
    // The module may *explain* NODE_ENV in a comment; it must never read it.
    expect(source).not.toMatch(/env\.NODE_ENV/);
    expect(source).not.toMatch(/readEnv\(\s*"NODE_ENV"/);
    const m = await importWith({ APP_ENV: undefined, VITE_APP_ENV: undefined });
    expect(m.IS_DEMO).toBe(false);
  });
});

describe("no route hardcodes the operator's brand name in its document title", () => {
  function routeFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...routeFiles(full));
      else if (entry.name.endsWith(".tsx")) out.push(full);
    }
    return out;
  }

  const files = routeFiles(resolve(root, "src/routes"));

  it("finds the route table (guards against this test silently passing on an empty list)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("every head() title is built through pageTitle() or a page-specific literal, never a baked-in brand name", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = read(file);
      // A `title:` whose literal ends in the operator's own name is exactly
      // what a second deployment cannot override.
      if (/title: "[^"]*ThesKwoff Hotel"/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("the surfaces that always render the name — print footer, PDF metadata, passkey prompt, HRM report headers — read it from configuration", () => {
    expect(read(resolve(root, "src/lib/admin/print-html.ts"))).toContain("escapeHtml(BRAND_NAME)");
    expect(read(resolve(root, "src/lib/admin/pdf-render.server.ts"))).toContain(
      "const DEFAULT_BRAND_NAME = BRAND_NAME;",
    );
    expect(read(resolve(root, "src/lib/security/webauthn-config.server.ts"))).toContain(
      "process.env.WEBAUTHN_RP_NAME || `${BRAND_NAME} PMS`",
    );
    expect(read(resolve(root, "src/components/hrm/payroll-run-pages.tsx"))).toContain(
      "propertyName: BRAND_NAME,",
    );
    expect(read(resolve(root, "src/components/hrm/attendance-page.tsx"))).toContain(
      "propertyName: `${BRAND_NAME} (${result.timezone})`,",
    );
  });
});

describe("environment banner", () => {
  const banner = read(resolve(root, "src/components/environment-banner.tsx"));
  const layout = read(resolve(root, "src/routes/_authenticated/route.tsx"));

  it("renders nothing when no label is configured — production must never show it", () => {
    expect(banner).toContain("if (!ENVIRONMENT_LABEL) return null;");
  });

  it("cannot widen the page on a phone: it is a min-w-0 block whose text truncates", () => {
    expect(banner).toMatch(/className="[^"]*\bw-full\b[^"]*"/);
    expect(banner).toMatch(/className="[^"]*\bmin-w-0\b[^"]*"/);
    expect(banner).toContain("truncate");
    // No fixed widths, no whitespace-nowrap on the long text: either would
    // reintroduce the sideways scrolling the top bar was just fixed for.
    expect(banner).not.toMatch(/\bw-\[\d/);
  });

  it("is mounted inside the authenticated shell only, above the app header and sharing its sticky container", () => {
    expect(layout).toContain('import { EnvironmentBanner } from "@/components/environment-banner"');
    expect(layout).toContain('<div className="sticky top-0 z-30 bg-background/80 backdrop-blur">');
    const bannerAt = layout.indexOf("<EnvironmentBanner />");
    const headerAt = layout.indexOf("<header");
    expect(bannerAt).toBeGreaterThan(-1);
    expect(bannerAt).toBeLessThan(headerAt);
  });

  it("is NOT mounted on /auth — that is the page crawlers render, and it stays exactly as the favicon fix left it", () => {
    expect(read(resolve(root, "src/routes/auth.tsx"))).not.toContain("EnvironmentBanner");
    expect(read(resolve(root, "src/routes/__root.tsx"))).not.toContain("EnvironmentBanner");
  });
});
