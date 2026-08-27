import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
// Normalizes CRLF -> LF so literal multi-line `.toContain()` assertions
// don't depend on the working tree's checkout line-ending state.
function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}
function bytes(path: string): Buffer {
  return readFileSync(resolve(root, path));
}

const rootRoute = read(resolve(root, "src/routes/__root.tsx"));
const authRoute = read(resolve(root, "src/routes/auth.tsx"));
const brandFaviconComponent = read(resolve(root, "src/components/brand-favicon.tsx"));
const authenticatedLayout = read(resolve(root, "src/routes/_authenticated/route.tsx"));
const manifest = JSON.parse(read(resolve(root, "public/site.webmanifest")));

/** Reads a PNG's IHDR dimensions (and asserts the file really is a PNG). */
function pngSize(buffer: Buffer): { width: number; height: number } {
  expect(buffer.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  expect(buffer.subarray(12, 16).toString("latin1")).toBe("IHDR");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Parses an ICO directory into its declared entry sizes. */
function icoEntries(buffer: Buffer): { width: number; height: number; png: boolean }[] {
  expect(buffer.readUInt16LE(0)).toBe(0); // reserved
  expect(buffer.readUInt16LE(2)).toBe(1); // type: icon
  const count = buffer.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => {
    const dir = 6 + 16 * i;
    const size = buffer.readUInt32LE(dir + 8);
    const offset = buffer.readUInt32LE(dir + 12);
    expect(offset + size).toBeLessThanOrEqual(buffer.length);
    return {
      width: buffer[dir] || 256,
      height: buffer[dir + 1] || 256,
      png: buffer.subarray(offset, offset + 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    };
  });
}

describe("favicon assets — the Theskwoff browser icon set exists on disk", () => {
  it("favicon.ico carries real 16/32/48 entries (the replaced scaffold default was a single 256px icon, which browsers and Google both downscale badly)", () => {
    const entries = icoEntries(bytes("public/favicon.ico"));
    expect(entries.map((e) => e.width)).toEqual([16, 32, 48]);
    expect(entries.map((e) => e.height)).toEqual([16, 32, 48]);
    expect(entries.every((e) => e.png)).toBe(true);
  });

  it.each([
    ["public/favicon-16x16.png", 16],
    ["public/favicon-32x32.png", 32],
    ["public/apple-touch-icon.png", 180],
    ["public/icon-192.png", 192],
    ["public/icon-512.png", 512],
  ])("%s is a square %ipx PNG (correct aspect ratio, not a stretched source)", (path, size) => {
    expect(pngSize(bytes(path))).toEqual({ width: size, height: size });
  });

  it("og-image.png is the standard 1200x630 social/search card", () => {
    expect(pngSize(bytes("public/og-image.png"))).toEqual({ width: 1200, height: 630 });
  });

  it("the icons are derived from the approved logo, not the scaffold heart — the generator and its committed source logo are both in the tree", () => {
    expect(read(resolve(root, "scripts/branding/generate-favicons.ps1"))).toContain(
      "theskwoff-logo-source.jpg",
    );
    // JPEG SOI marker — the approved logo supplied for this fix.
    expect(bytes("scripts/branding/theskwoff-logo-source.jpg").subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8]),
    );
  });
});

describe("document head — one coherent set of icon declarations", () => {
  it("declares .ico + both PNG sizes + apple-touch-icon + manifest", () => {
    expect(rootRoute).toContain('{ rel: "icon", href: "/favicon.ico", sizes: "48x48" }');
    expect(rootRoute).toContain('href: "/favicon-32x32.png"');
    expect(rootRoute).toContain('href: "/favicon-16x16.png"');
    expect(rootRoute).toContain('{ rel: "apple-touch-icon", href: "/apple-touch-icon.png"');
    expect(rootRoute).toContain('{ rel: "manifest", href: "/site.webmanifest" }');
  });

  it("no obsolete default icon declaration survives — the inline data: URI 'TS' placeholder is gone, and no other route declares a competing icon link", () => {
    expect(rootRoute).not.toContain("FALLBACK_FAVICON");
    expect(rootRoute).not.toContain("data:image/svg+xml");
    for (const route of ["book.index.tsx", "book.embed.tsx", "auth.tsx"]) {
      expect(read(resolve(root, "src/routes", route))).not.toMatch(
        /rel: "(icon|apple-touch-icon)"/,
      );
    }
  });

  it("og:image/twitter:image point at this deployment's own card rather than the scaffold's external upload bucket", () => {
    expect(rootRoute).not.toContain("gpt-engineer-file-uploads");
    expect(rootRoute).toContain('{ property: "og:image", content: `${SITE_ORIGIN}/og-image.png` }');
    expect(rootRoute).toContain(
      '{ name: "twitter:image", content: `${SITE_ORIGIN}/og-image.png` }',
    );
    // Crawlers do not resolve relative og:image URLs.
    expect(rootRoute).toContain('const SITE_ORIGIN = "https://theskwoffhotel.com"');
  });

  it("every declared static icon path actually resolves to a file in public/", () => {
    const declared = [...rootRoute.matchAll(/href: "(\/[^"]+\.(?:ico|png|webmanifest))"/g)].map(
      (m) => m[1],
    );
    expect(declared.length).toBeGreaterThanOrEqual(5);
    for (const href of declared) expect(() => bytes(`public${href}`)).not.toThrow();
  });
});

describe("web manifest", () => {
  it("uses the same site identity as the branding defaults, and both icons resolve", () => {
    expect(manifest.name).toBe("ThesKwoff Hotel");
    expect(manifest.short_name).toBe("ThesKwoff Hotel");
    expect(read(resolve(root, "src/hooks/use-brand-settings.ts"))).toContain(
      'app_name: "ThesKwoff Hotel"',
    );
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(["192x192", "512x512"]);
    for (const icon of manifest.icons as { src: string }[]) {
      expect(() => bytes(`public${icon.src}`)).not.toThrow();
    }
  });

  it("stays a plain browser manifest — declaring icons must not turn the PMS into an installable standalone PWA", () => {
    expect(manifest.display).toBe("browser");
  });
});

describe("browser identity is unchanged by this fix", () => {
  it("the root static title is still the organisation name", () => {
    expect(rootRoute).toContain('{ title: "ThesKwoff Hotel" }');
  });

  it("the login page keeps its own page-specific title", () => {
    expect(authRoute).toContain('title: "Staff & Admin Sign In"');
  });
});

describe("branding architecture is preserved", () => {
  it("a tenant-configured favicon still overrides the static set — and still overrides every declared icon link, not just the first", () => {
    expect(brandFaviconComponent).toContain("useBrandSettings");
    expect(brandFaviconComponent).toContain(
      "brandSettings?.favicon_url || brandSettings?.logo_url",
    );
    expect(brandFaviconComponent).toContain(
      "querySelectorAll<HTMLLinkElement>('link[rel=\"icon\"]')",
    );
    expect(brandFaviconComponent).not.toContain("querySelector<HTMLLinkElement>");
  });

  it("browser identity stays organisation-wide — the favicon is never sourced from property-level branding, so one property cannot leak its icon into another", () => {
    expect(brandFaviconComponent).not.toContain("useEffectiveBranding");
    expect(read(resolve(root, "src/hooks/use-effective-branding.ts"))).not.toContain("favicon_url");
  });
});

// Googlebot renders JavaScript and indexes the resulting head. Mounting the
// organisation favicon override above the authenticated boundary therefore put
// a signed, non-square, cross-origin Supabase JPEG in front of Google on /auth
// and cost the site its search-result icon. The behavioural proof lives in
// tests/favicon-crawler-hydration.test.tsx; these pin the mount point itself,
// which is the part a future refactor is most likely to undo by accident.
describe("the organisation favicon override is scoped to authenticated routes", () => {
  it("is not defined or mounted anywhere in the root route", () => {
    expect(rootRoute).not.toContain("function BrandFavicon(");
    expect(rootRoute).not.toContain("<BrandFavicon />");
    expect(rootRoute).not.toMatch(/import .*BrandFavicon/);
  });

  it("is mounted from the authenticated layout, which redirects unauthenticated visitors to /auth", () => {
    expect(authenticatedLayout).toContain(
      'import { BrandFavicon } from "@/components/brand-favicon";',
    );
    expect(authenticatedLayout).toContain("<BrandFavicon />");
    expect(authenticatedLayout).toContain('throw redirect({ to: "/auth" })');
  });

  it("no public route mounts it — /auth, the booking pages and the password routes are all crawler-facing", () => {
    for (const route of [
      "auth.tsx",
      "index.tsx",
      "reset-password.tsx",
      "change-password.tsx",
      "book.index.tsx",
      "book.embed.tsx",
    ]) {
      expect(read(resolve(root, "src/routes", route))).not.toContain("BrandFavicon");
    }
  });

  it("restores the static declarations on unmount, so signing out cannot leave the tenant icon in the head of a public page", () => {
    expect(brandFaviconComponent).toContain("getAttribute");
    expect(brandFaviconComponent).toContain("removeAttribute");
    expect(brandFaviconComponent).toContain("return () => {");
  });
});
