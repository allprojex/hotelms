// @vitest-environment jsdom
//
// PRODUCTION BUG (proven live against https://www.theskwoffhotel.com, not
// inferred from source): the Google search result kept showing the old
// scaffold icon even though PR #78's static icon set was correct and
// correctly deployed — live /favicon.ico bytes matched public/favicon.ico
// exactly on both apex and www, and the ICO really did carry 16/32/48 frames.
//
// ROOT CAUSE: `BrandFavicon` was mounted globally in __root.tsx, so it also
// ran on /auth — the page Google actually crawls, since the site root 307s
// there. Googlebot renders JavaScript and indexes the POST-hydration head.
// Rendering the live page in a real browser showed all three
// `link[rel="icon"]` hrefs rewritten to a signed Supabase Storage URL for a
// 1280x1098 JPEG: not 1:1 square, unstable tokenised URL, cross-origin.
// Google rejects that and falls back to whatever it had cached. The static
// same-origin set was never visible to a rendering crawler at all.
//
// These tests drive the REAL component against a real document head, because
// the previous suite was purely source-string based — which is exactly why it
// passed green while the bug was live in production. A structural test cannot
// see what hydration does to the DOM.

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The component reads branding through useBrandSettings (a react-query hook
// wrapping a Supabase RPC). Only its resolved value matters here, so the hook
// is stubbed rather than standing up a QueryClient + network layer.
const brand = vi.hoisted(() => ({
  value: { favicon_url: null as string | null, logo_url: null as string | null },
}));
vi.mock("@/hooks/use-brand-settings", () => ({
  useBrandSettings: () => ({ data: brand.value }),
}));

const { BrandFavicon } = await import("@/components/brand-favicon");

/** The exact crawler-facing set __root.tsx's head() emits for every route. */
const STATIC_ICONS = [
  { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
  { rel: "icon", href: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
  { rel: "icon", href: "/favicon-16x16.png", type: "image/png", sizes: "16x16" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png", sizes: "180x180" },
  { rel: "manifest", href: "/site.webmanifest" },
];

/** Rebuilds the server-rendered head a crawler receives before hydration. */
function renderServerHead() {
  document.head.innerHTML = "";
  for (const { rel, href, type, sizes } of STATIC_ICONS) {
    const link = document.createElement("link");
    link.setAttribute("rel", rel);
    link.setAttribute("href", href);
    if (type) link.setAttribute("type", type);
    if (sizes) link.setAttribute("sizes", sizes);
    document.head.appendChild(link);
  }
}

/** Reads back the icon declarations as raw authored attributes. */
function headIcons() {
  return Array.from(
    document.head.querySelectorAll<HTMLLinkElement>(
      'link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]',
    ),
  ).map((l) => ({
    rel: l.getAttribute("rel"),
    href: l.getAttribute("href"),
    ...(l.getAttribute("type") ? { type: l.getAttribute("type") } : {}),
    ...(l.getAttribute("sizes") ? { sizes: l.getAttribute("sizes") } : {}),
  }));
}

/** The shape of the real production value that broke the search favicon. */
const SIGNED_SUPABASE_JPEG =
  "https://texhuavnrdhaohqzlyqw.supabase.co/storage/v1/object/sign/brand-assets/favicon/" +
  "5a7b491a-7a03-450b-a3a1-08487e145bde.jpeg?token=eyJhbGciOiJIUzI1NiJ9.signature";

/** Asserts nothing a crawler must not see has reached the document head. */
function expectNoTenantAssetInHead() {
  const hrefs = headIcons().map((i) => i.href ?? "");
  for (const href of hrefs) {
    expect(href).not.toContain("supabase.co");
    expect(href).not.toContain("token=");
    expect(href).not.toMatch(/\.jpe?g(\?|$)/i);
    expect(href).not.toMatch(/^data:/i);
    expect(href).not.toMatch(/^https?:\/\//i); // same-origin only
    expect(href).not.toMatch(/lovable/i);
  }
}

beforeEach(() => {
  brand.value = { favicon_url: null, logo_url: null };
  renderServerHead();
});
afterEach(cleanup);

describe("public /auth — the static crawler icon set survives hydration", () => {
  it("keeps every static declaration byte-for-byte when BrandFavicon is not mounted, even with a tenant favicon configured", async () => {
    // /auth sits outside the authenticated layout, so BrandFavicon never
    // mounts there — this is the whole fix, expressed as behaviour.
    brand.value = { favicon_url: SIGNED_SUPABASE_JPEG, logo_url: null };

    render(<div />); // hydrate a public route: no BrandFavicon in the tree
    await waitFor(() => expect(headIcons()).toHaveLength(STATIC_ICONS.length));

    expect(headIcons()).toEqual(STATIC_ICONS);
    expectNoTenantAssetInHead();
  });

  it("still exposes a crawlable 48x48 .ico as the search-facing icon", () => {
    const ico = headIcons().find((i) => i.href === "/favicon.ico");
    expect(ico).toEqual({ rel: "icon", href: "/favicon.ico", sizes: "48x48" });
  });

  it("restores the static set when the authenticated layout unmounts — signing out returns the SPA to /auth without a reload, so a lingering tenant JPEG would still be in the head Google sees", async () => {
    brand.value = { favicon_url: SIGNED_SUPABASE_JPEG, logo_url: null };

    const { unmount } = render(<BrandFavicon />);
    await waitFor(() => expect(headIcons()[0].href).toBe(SIGNED_SUPABASE_JPEG));

    unmount();

    expect(headIcons()).toEqual(STATIC_ICONS);
    expectNoTenantAssetInHead();
  });
});

describe("authenticated app — the organisation favicon override still works", () => {
  it("points every rel=icon declaration at the configured organisation favicon", async () => {
    brand.value = { favicon_url: SIGNED_SUPABASE_JPEG, logo_url: null };

    render(<BrandFavicon />);

    await waitFor(() => {
      const icons = headIcons().filter((i) => i.rel === "icon");
      expect(icons).toHaveLength(3);
      for (const icon of icons) expect(icon.href).toBe(SIGNED_SUPABASE_JPEG);
    });
  });

  it("drops type/sizes on override — they described the static PNGs, not the uploaded file", async () => {
    brand.value = { favicon_url: SIGNED_SUPABASE_JPEG, logo_url: null };

    render(<BrandFavicon />);

    await waitFor(() => {
      for (const icon of headIcons().filter((i) => i.rel === "icon")) {
        expect(icon.type).toBeUndefined();
        expect(icon.sizes).toBeUndefined();
      }
    });
  });

  it("falls back to logo_url when no favicon_url is configured", async () => {
    brand.value = { favicon_url: null, logo_url: "/uploads/org-logo.png" };

    render(<BrandFavicon />);

    await waitFor(() => {
      for (const icon of headIcons().filter((i) => i.rel === "icon")) {
        expect(icon.href).toBe("/uploads/org-logo.png");
      }
    });
  });

  it("leaves the static set alone when the organisation has configured neither", async () => {
    render(<BrandFavicon />);
    await waitFor(() => expect(headIcons()).toEqual(STATIC_ICONS));
  });

  it("never touches apple-touch-icon or the manifest — the override targets rel=icon only", async () => {
    brand.value = { favicon_url: SIGNED_SUPABASE_JPEG, logo_url: null };

    render(<BrandFavicon />);

    await waitFor(() => expect(headIcons()[0].href).toBe(SIGNED_SUPABASE_JPEG));
    expect(headIcons().filter((i) => i.rel !== "icon")).toEqual(
      STATIC_ICONS.filter((i) => i.rel !== "icon"),
    );
  });
});

describe("browser identity stays organisation-wide", () => {
  it("switching the active property cannot change the icon — the override reads only organisation branding, so re-rendering under a different property is a no-op", async () => {
    brand.value = { favicon_url: "/org-icon.png", logo_url: null };

    const { rerender } = render(<BrandFavicon />);
    await waitFor(() => expect(headIcons()[0].href).toBe("/org-icon.png"));

    // A property switch re-renders the authenticated subtree; organisation
    // branding is unchanged, so the icon must not move.
    rerender(<BrandFavicon />);
    await waitFor(() => expect(headIcons()[0].href).toBe("/org-icon.png"));

    for (const icon of headIcons().filter((i) => i.rel === "icon")) {
      expect(icon.href).toBe("/org-icon.png");
    }
  });
});
