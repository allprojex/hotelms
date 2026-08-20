import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
// Normalizes CRLF -> LF so literal multi-line `.toContain()` assertions
// don't depend on the working tree's checkout line-ending state.
function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const migration = read(resolve(root, "supabase/migrations/20260820120000_property_branding.sql"));
const useBrandSettings = read(resolve(root, "src/hooks/use-brand-settings.ts"));
const useEffectiveBranding = read(resolve(root, "src/hooks/use-effective-branding.ts"));
const brandModule = read(resolve(root, "src/components/admin/modules/brand-module.tsx"));
const brandMark = read(resolve(root, "src/components/brand-mark.tsx"));
const brandColorVars = read(resolve(root, "src/components/brand-color-vars.tsx"));
const appSidebar = read(resolve(root, "src/components/app-sidebar.tsx"));
const authRoute = read(resolve(root, "src/routes/auth.tsx"));
const rootRoute = read(resolve(root, "src/routes/__root.tsx"));
const pdfRenderServer = read(resolve(root, "src/lib/admin/pdf-render.server.ts"));
const pdfFunctions = read(resolve(root, "src/lib/admin/pdf.functions.ts"));
const arStatementPdfFunctions = read(
  resolve(root, "src/lib/accounting/ar-statement-pdf.functions.ts"),
);
const apStatementPdfFunctions = read(
  resolve(root, "src/lib/accounting/ap-statement-pdf.functions.ts"),
);
const styles = read(resolve(root, "src/styles.css"));

function fn(source: string, name: string): string {
  const match = source.match(
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\$\\$;`),
  )?.[0];
  if (!match) throw new Error(`Could not find function ${name} in source`);
  return match;
}

describe("Branding Phase 1 — pre-existing bug fix", () => {
  it("grants UPDATE on system_settings to authenticated — every prior migration only ever granted SELECT, so the existing save flow could never have succeeded before this fix", () => {
    expect(migration).toContain("GRANT UPDATE ON public.system_settings TO authenticated;");
  });
});

describe("Branding Phase 1 — system_settings: secondary_color + validation", () => {
  it("adds secondary_color as a new nullable column, without forcing existing primary_color data into strict hex", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS secondary_color text;");
    // The strict #rrggbb CHECK exists only on the new property_branding
    // table (no legacy data there); system_settings.primary_color keeps
    // its permissive not-blank-only CHECK so existing oklch(...) values
    // already in production remain valid.
    const systemSettingsSection = migration.slice(
      migration.indexOf("PART A —"),
      migration.indexOf("PART B —"),
    );
    expect(systemSettingsSection).not.toMatch(/primary_color ~ '\^#/);
  });

  it("adds a not-blank CHECK to both colors rather than a strict hex CHECK (preserves legacy oklch(...) values already in production)", () => {
    expect(migration).toContain("CHECK (primary_color IS NULL OR btrim(primary_color) <> '')");
    expect(migration).toContain("CHECK (secondary_color IS NULL OR btrim(secondary_color) <> '')");
  });

  it("extends get_brand_settings() additively — same 9 prior columns plus secondary_color, still LIMIT 1 from system_settings, still anon-readable", () => {
    const getBrand = fn(migration, "get_brand_settings");
    for (const col of [
      "app_name",
      "app_short_name",
      "tagline",
      "logo_url",
      "logo_dark_url",
      "favicon_url",
      "primary_color",
      "secondary_color",
      "support_email",
      "support_phone",
    ]) {
      expect(getBrand).toContain(col);
    }
    expect(getBrand).toContain("FROM public.system_settings s\n  LIMIT 1;");
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.get_brand_settings() TO anon, authenticated, service_role;",
    );
  });
});

describe("Branding Phase 1 — property_branding schema", () => {
  it("is one row per property, nullable overrides, no favicon_url column (browser identity stays organisation-wide only)", () => {
    const table = migration.match(/CREATE TABLE public\.property_branding \([\s\S]*?\n\);/)?.[0];
    expect(table).toBeDefined();
    expect(table).toContain("property_id UUID PRIMARY KEY REFERENCES public.properties(id)");
    for (const col of [
      "display_name TEXT",
      "logo_url TEXT",
      "logo_dark_url TEXT",
      "primary_color TEXT",
      "secondary_color TEXT",
      "support_email TEXT",
      "support_phone TEXT",
    ]) {
      expect(table).toContain(col);
    }
    expect(table).not.toContain("favicon_url");
  });

  it("enforces strict #rrggbb hex on both property-level colors (no legacy data to preserve, unlike system_settings)", () => {
    expect(migration).toContain(
      "CHECK (primary_color IS NULL OR primary_color ~ '^#[0-9a-fA-F]{6}$')",
    );
    expect(migration).toContain(
      "CHECK (secondary_color IS NULL OR secondary_color ~ '^#[0-9a-fA-F]{6}$')",
    );
  });

  it("rejects a blank (but non-null) display_name", () => {
    expect(migration).toContain(
      "CONSTRAINT property_branding_display_name_not_blank CHECK (display_name IS NULL OR btrim(display_name) <> '')",
    );
  });

  it("grants SELECT, INSERT, and UPDATE (the upsert() write path needs the base grant — RLS alone narrows an existing grant, it can't substitute for a missing one), but never DELETE (no row-delete workflow exists; clearing a field is an UPDATE to NULL)", () => {
    expect(migration).toContain(
      "GRANT SELECT, INSERT, UPDATE ON public.property_branding TO authenticated;",
    );
    expect(migration).not.toMatch(/GRANT[^;]*DELETE[^;]*ON public\.property_branding TO authenticated/);
  });

  it("read policy scopes to can_access_property", () => {
    expect(migration).toContain(
      'CREATE POLICY "property_branding read" ON public.property_branding FOR SELECT TO authenticated',
    );
    expect(migration).toContain("public.can_access_property(auth.uid(), property_id)");
  });

  it("write policy requires super_admin/hotel_owner/general_manager exactly — accountant and front_desk are excluded", () => {
    const writePolicy = migration.match(
      /CREATE POLICY "property_branding write"[\s\S]*?;\n\nCREATE TRIGGER/,
    )?.[0];
    expect(writePolicy).toBeDefined();
    expect(writePolicy).toContain(
      "ARRAY['super_admin','hotel_owner','general_manager']::app_role[]",
    );
    expect(writePolicy).not.toMatch(/accountant/);
    expect(writePolicy).not.toMatch(/front_desk/);
    // Both USING and WITH CHECK must be present — server-side enforcement,
    // not just a read-side guard.
    expect(writePolicy).toContain("USING (public.has_any_role(");
    expect(writePolicy).toContain("WITH CHECK (public.has_any_role(");
  });

  it("has an updated_at trigger reusing the existing tg_set_updated_at() convention", () => {
    expect(migration).toContain(
      "CREATE TRIGGER trg_property_branding_updated BEFORE UPDATE ON public.property_branding\n  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();",
    );
  });
});

describe("Branding Phase 1 — get_effective_branding() resolution", () => {
  const resolver = fn(migration, "get_effective_branding");

  it("resolves property override -> global system_settings via COALESCE, for every overridable field", () => {
    expect(resolver).toContain("COALESCE(pb.display_name, ss.app_short_name, ss.app_name)");
    expect(resolver).toContain("COALESCE(pb.logo_url, ss.logo_url)");
    expect(resolver).toContain("COALESCE(pb.logo_dark_url, ss.logo_dark_url)");
    expect(resolver).toContain("COALESCE(pb.primary_color, ss.primary_color)");
    expect(resolver).toContain("COALESCE(pb.secondary_color, ss.secondary_color)");
    expect(resolver).toContain("COALESCE(pb.support_email, ss.support_email)");
    expect(resolver).toContain("COALESCE(pb.support_phone, ss.support_phone)");
  });

  it("LEFT JOINs property_branding — a property with no override row still resolves (falls through entirely to system_settings)", () => {
    expect(resolver).toContain(
      "LEFT JOIN public.property_branding pb ON pb.property_id = _property_id",
    );
  });

  it("never returns favicon_url — browser identity is not part of the property-effective read model", () => {
    expect(resolver).not.toContain("favicon_url");
  });

  it("enforces property access inside the function itself, returning zero rows (not raising) for an inaccessible property", () => {
    expect(resolver).toContain("WHERE public.can_access_property(auth.uid(), _property_id)");
    expect(resolver).not.toMatch(/RAISE EXCEPTION/);
  });

  it("exposes has_property_override so the UI can distinguish an inherited value from an explicit override", () => {
    expect(resolver).toContain("(pb.property_id IS NOT NULL)");
    expect(resolver).toContain("has_property_override BOOLEAN");
  });

  it("is revoked from PUBLIC/anon and granted only to authenticated/service_role — unlike get_brand_settings, this is never anon-readable (it takes an arbitrary property id argument)", () => {
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.get_effective_branding(uuid) FROM PUBLIC, anon;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.get_effective_branding(uuid) TO authenticated, service_role;",
    );
  });

  it("is SECURITY DEFINER with search_path pinned, matching every other SECURITY DEFINER function in this codebase", () => {
    expect(resolver).toContain("SECURITY DEFINER SET search_path = public");
  });
});

describe("Branding Phase 1 — this migration only adds new objects (beyond the two documented, additive CREATE OR REPLACE extensions)", () => {
  it("never drops or destructively alters an existing table/column", () => {
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|DROP FUNCTION/);
  });

  it("system_settings changes are additive: new column + new CHECK constraints + a strict superset function replacement, nothing removed", () => {
    expect(migration).not.toMatch(/ALTER TABLE public\.system_settings\s+DROP COLUMN/);
  });
});

describe("Branding Phase 1 — useBrandSettings (global, unchanged call site) gains secondary_color", () => {
  it("BrandSettings type and DEFAULTS both carry secondary_color", () => {
    expect(useBrandSettings).toContain("secondary_color: string | null;");
    expect(useBrandSettings).toMatch(/DEFAULTS: BrandSettings = \{[\s\S]*?secondary_color: null,/);
  });

  it("still calls get_brand_settings() — the global RPC is reused, not replaced", () => {
    expect(useBrandSettings).toContain('(supabase.rpc as any)("get_brand_settings")');
  });
});

describe("Branding Phase 1 — useEffectiveBranding (property-aware hook)", () => {
  it("falls back to global-only branding when no property is active", () => {
    expect(useEffectiveBranding).toContain("useActiveProperty");
    expect(useEffectiveBranding).toContain("useBrandSettings");
    expect(useEffectiveBranding).toMatch(/if \(row\) \{/);
  });

  it("calls get_effective_branding with the active property id", () => {
    expect(useEffectiveBranding).toContain('"get_effective_branding"');
    expect(useEffectiveBranding).toContain("_property_id: propertyId");
  });

  it("never sources favicon_url or sets document.title — this hook is deliberately not used for browser identity (the module comment documents why, but the code itself never touches either)", () => {
    expect(useEffectiveBranding).not.toContain("favicon_url");
    expect(useEffectiveBranding).not.toContain("document.title");
  });
});

describe("Branding Phase 1 — browser identity stays organisation-wide only", () => {
  it("BrandTitle sources app_name from useBrandSettings (global), not useEffectiveBranding (property-aware)", () => {
    const brandTitleFn = rootRoute.match(/function BrandTitle\(\)[\s\S]*?\n\}/)?.[0];
    expect(brandTitleFn).toBeDefined();
    expect(brandTitleFn).toContain("useBrandSettings");
    expect(brandTitleFn).not.toContain("useEffectiveBranding");
  });

  it("BrandFavicon (pre-existing) still sources from useBrandSettings only — untouched", () => {
    const brandFaviconFn = rootRoute.match(/function BrandFavicon\(\)[\s\S]*?\n\}/)?.[0];
    expect(brandFaviconFn).toBeDefined();
    expect(brandFaviconFn).toContain("useBrandSettings");
    expect(brandFaviconFn).not.toContain("useEffectiveBranding");
  });

  it("BrandTitle re-applies on every client-side navigation (re-asserts after TanStack Router's HeadContent resets the static per-route title)", () => {
    expect(rootRoute).toContain("useRouterState");
    const brandTitleFn = rootRoute.match(/function BrandTitle\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(brandTitleFn).toContain("pathname");
  });

  it("BrandColorVars (property-aware) is mounted alongside BrandFavicon/BrandTitle at the root", () => {
    expect(rootRoute).toContain("<BrandFavicon />");
    expect(rootRoute).toContain("<BrandTitle />");
    expect(rootRoute).toContain("<BrandColorVars />");
  });

  it("the static head() meta title no longer hardcodes a tenant-specific brand name into the auth route (kept neutral; dynamic title is applied post-hydration)", () => {
    expect(authRoute).toContain('title: "Staff & Admin Sign In"');
    expect(authRoute).not.toContain('"Staff & Admin Sign In — ThesKwoff Hotel"');
  });

  it("the auth page headline reads the resolved organisation app_name/tagline, with the historical string preserved only as the final fallback", () => {
    expect(authRoute).toContain("useBrandSettings");
    expect(authRoute).toContain('brand?.app_name || "ThesKwoff Hotel"');
  });
});

describe("Branding Phase 1 — sidebar represents the active property, not the organisation default", () => {
  it("app-sidebar uses useEffectiveBranding (property-aware), not useBrandSettings directly", () => {
    expect(appSidebar).toContain("useEffectiveBranding");
  });

  it("the sidebar name and logo are sourced from the resolved brand, with the historical string only as final fallback", () => {
    expect(appSidebar).toContain("{brand.name ||");
    expect(appSidebar).toContain("logoUrl={brand.logoUrl}");
    expect(appSidebar).toContain("logoDarkUrl={brand.logoDarkUrl}");
  });

  it("applies the brand accent conservatively — only a border color, via the dedicated --brand-primary variable, never the design system's own interactive-element tokens", () => {
    expect(appSidebar).toContain("var(--brand-primary, var(--sidebar-primary))");
    expect(appSidebar).not.toMatch(/--brand-primary.*color:\s*var\(--brand-primary\)/);
  });
});

describe("Branding Phase 1 — BrandMark accepts property-effective overrides without changing its own default (global) behavior", () => {
  it("logoUrl/logoDarkUrl/alt are optional props, defaulting to the existing global useBrandSettings() data when omitted", () => {
    expect(brandMark).toContain("logoUrl?: string | null;");
    expect(brandMark).toContain("logoDarkUrl?: string | null;");
    expect(brandMark).toContain("logoUrlOverride !== undefined ? logoUrlOverride : data?.logo_url");
  });

  it("the login page's own BrandMark usage is unchanged (no override props passed) — still purely global", () => {
    expect(authRoute).toContain('<BrandMark className="mx-auto h-12" />');
    expect(authRoute).not.toMatch(/<BrandMark[^>]*logoUrl=/);
  });
});

describe("Branding Phase 1 — conservative color application (design-system semantics preserved)", () => {
  it("uses dedicated --brand-primary/--brand-secondary custom properties, never overwriting the design system's own --primary/--secondary tokens", () => {
    expect(brandColorVars).toContain('root.style.setProperty("--brand-primary"');
    expect(brandColorVars).toContain('root.style.setProperty("--brand-secondary"');
    expect(brandColorVars).not.toMatch(/setProperty\("--primary"/);
    expect(brandColorVars).not.toMatch(/setProperty\("--secondary"/);
  });

  it("clears the CSS variable (falls back to the design system default) when no brand color is configured, rather than leaving a stale value", () => {
    expect(brandColorVars).toContain('root.style.removeProperty("--brand-primary")');
    expect(brandColorVars).toContain('root.style.removeProperty("--brand-secondary")');
  });

  it("status/semantic colors (success, warning, destructive) are never assigned to by the branding system anywhere in the changed files (brand-color-vars.tsx's own comment names them only to disclaim touching them)", () => {
    for (const source of [brandColorVars, appSidebar, brandModule]) {
      expect(source).not.toMatch(/setProperty\("--(success|warning|destructive)"/);
      expect(source).not.toMatch(/--(success|warning|destructive):\s*var\(--brand-/);
    }
  });

  it("the design system's own --success/--warning/--destructive tokens remain defined independently in styles.css, unmodified by this feature", () => {
    expect(styles).toMatch(/--success:\s*oklch/);
    expect(styles).toMatch(/--warning:\s*oklch/);
    expect(styles).toMatch(/--destructive:\s*oklch/);
  });
});

describe("Branding Phase 1 — admin editor: organisation vs property sections are clearly distinguished", () => {
  it("has a top-level BrandModule composing two clearly labeled editors", () => {
    expect(brandModule).toContain("<OrganisationBrandingEditor />");
    expect(brandModule).toContain("<PropertyBrandingEditor />");
  });

  it("organisation section is labeled and permission-gated to super_admin only, unchanged", () => {
    expect(brandModule).toContain("Organisation branding");
    expect(brandModule).toContain('useHasAnyRole(["super_admin"], null)');
  });

  it("property section is labeled, has a property selector, and is permission-gated per-property to super_admin/hotel_owner/general_manager", () => {
    expect(brandModule).toContain("Property branding");
    expect(brandModule).toContain("Select a property");
    expect(brandModule).toContain(
      'useHasAnyRole(["super_admin", "hotel_owner", "general_manager"], propertyId)',
    );
  });

  it("every property field shows what it inherits when left blank, and clearing a field (empty string -> null) is how an override is removed", () => {
    expect(brandModule).toContain('hint={`Inherited: ${inheritedName || "—"}`}');
    expect(brandModule).toContain("nullify(values.display_name)");
  });

  it("both editors support image preview (AssetSlot) and a color swatch preview", () => {
    const orgSection = brandModule.slice(
      brandModule.indexOf("function OrganisationBrandingEditor"),
      brandModule.indexOf("function PropertyBrandingEditor"),
    );
    const propSection = brandModule.slice(brandModule.indexOf("function PropertyBrandingEditor"));
    for (const section of [orgSection, propSection]) {
      expect(section).toContain("<AssetSlot");
      expect(section).toMatch(/color preview/);
    }
  });

  it("property color inputs are validated as strict hex client-side before save, matching the DB CHECK constraint", () => {
    expect(brandModule).toContain("HEX_COLOR_RE");
    expect(brandModule).toContain("Primary color must be a #rrggbb hex value");
    expect(brandModule).toContain("Secondary color must be a #rrggbb hex value");
  });
});

describe("Branding Phase 1 — storage: private bucket reused, safe cleanup on replace", () => {
  it("uploadBrandAsset reuses the existing brand-assets private-bucket + signed-URL pattern, not a public bucket", () => {
    expect(brandModule).toContain('.from("brand-assets")');
    expect(brandModule).toContain("createSignedUrl");
    expect(brandModule).not.toMatch(/getPublicUrl/);
  });

  it("uses a random UUID path, never a user-controlled filename", () => {
    expect(brandModule).toContain("`${kind}/${crypto.randomUUID()}.${ext}`");
  });

  it("cleanup is conservative — it never deletes an object still referenced by another field in the same save payload", () => {
    expect(brandModule).toContain("stillReferenced.some((v) => v === oldUrl)");
  });

  it("both the organisation and property save paths call the cleanup helper only for genuinely replaced assets", () => {
    expect(brandModule).toContain("if (previous?.logo_url !== payload.logo_url)");
    expect(brandModule).toContain("await tryCleanupReplacedAsset(previous?.logo_url, nextValues);");
  });
});

describe("Branding Phase 1 — document/PDF branding integration", () => {
  it("DocData/StatementDocData both carry an optional brand field that changes nothing when absent (backward compatible with any caller not yet updated)", () => {
    expect(pdfRenderServer).toContain("brand?: DocBranding;");
    expect(pdfRenderServer).toContain("const brandName = data.brand?.name || DEFAULT_BRAND_NAME;");
  });

  it("producer/creator/footer are dynamic, no longer hardcoded to a specific tenant name", () => {
    expect(pdfRenderServer).toContain("pdf.setProducer(brandName);");
    expect(pdfRenderServer).toContain("pdf.setCreator(brandName);");
    expect(pdfRenderServer).toContain("Generated ${new Date().toISOString()} · ${brandName}");
    expect(pdfRenderServer).not.toMatch(/setProducer\("ThesKwoff Hotel"\)/);
  });

  it("logo embedding is best-effort — any failure is swallowed, never breaks document generation", () => {
    const embedFn = pdfRenderServer.match(/async function tryEmbedLogo[\s\S]*?\n}/)?.[0];
    expect(embedFn).toBeDefined();
    expect(embedFn).toContain("try {");
    expect(embedFn).toContain("} catch {");
  });

  it("unsupported image formats (SVG/ICO/WEBP) are skipped gracefully, not thrown", () => {
    const embedFn = pdfRenderServer.match(/async function tryEmbedLogo[\s\S]*?\n}/)?.[0] ?? "";
    expect(embedFn).toContain("pdf-lib only embeds PNG/JPEG");
  });

  it("with no logo configured, the layout is byte-for-byte unchanged from before branding support existed (y stays at H - M)", () => {
    expect(pdfRenderServer).toContain("if (data.brand?.logoUrl) {");
    expect(pdfRenderServer).toContain(
      "await tryEmbedLogo(pdf, page, data.brand.logoUrl, W - M, y);",
    );
  });

  it("title color only applies for a strict #rrggbb primary color — any other value (including legacy oklch(...)) safely falls back to the existing default navy, never mis-parsed", () => {
    expect(pdfRenderServer).toContain("function hexToRgbColor(");
    expect(pdfRenderServer).toContain("/^#([0-9a-fA-F]{6})$/");
    expect(pdfRenderServer).toContain("?? DEFAULT_TITLE_COLOR");
  });
});

describe("Branding Phase 1 — PDF callers fetch effective branding per-document, never let it block generation", () => {
  it("pdf.functions.ts (invoice/receipt/folio/bill/PO) fetches branding once per document and passes it through", () => {
    expect(pdfFunctions).toContain(
      "const brand = await fetchDocBranding(context, data.propertyId);",
    );
    expect(pdfFunctions).toContain("doc.brand = brand;");
  });

  it("fetchDocBranding never throws — any failure returns undefined so buildDocPdf falls back to its prior hardcoded behavior", () => {
    const fetchFn = pdfFunctions.match(/async function fetchDocBranding[\s\S]*?\n}/)?.[0];
    expect(fetchFn).toBeDefined();
    expect(fetchFn).toContain("try {");
    expect(fetchFn).toContain("} catch {\n    return undefined;\n  }");
  });

  it("calls get_effective_branding via the property already validated by assertAdmin for this exact document", () => {
    expect(pdfFunctions).toContain('"get_effective_branding"');
    expect(pdfFunctions).toContain("_property_id: propertyId");
  });

  it("both AR customer statements and AP supplier statements are wired to the same branding resolution and pass brand through to buildStatementPdf", () => {
    for (const source of [arStatementPdfFunctions, apStatementPdfFunctions]) {
      expect(source).toContain("fetchDocBranding");
      expect(source).toContain("brand,");
    }
  });

  it("does not replace the correctly property-scoped properties.name/address/phone/email 'from' block with global/org branding contact fields — that remains untouched", () => {
    for (const source of [pdfFunctions, arStatementPdfFunctions, apStatementPdfFunctions]) {
      expect(source).toMatch(
        /fromBlock: \[anyP\?\.name, anyP\?\.address, anyP\?\.phone, anyP\?\.email\]/,
      );
    }
  });
});

describe("Branding Phase 1 — no unrelated financial/accounting/HRM/payroll code touched", () => {
  it("the migration only creates/alters branding-related objects", () => {
    expect(migration).not.toMatch(/ar_invoices|ar_credit_notes|journal_entries|payroll|hrm/i);
  });
});
