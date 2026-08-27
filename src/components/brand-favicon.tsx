import { useEffect } from "react";

import { useBrandSettings } from "@/hooks/use-brand-settings";

// Replaces the static browser icons with the organisation's uploaded favicon
// once branding has loaded, so staff see their own hotel's icon on the app's
// browser tab.
//
// MOUNTED FROM THE AUTHENTICATED LAYOUT ONLY (src/routes/_authenticated.tsx) —
// never from __root.tsx. This is load-bearing, not stylistic.
//
// PRODUCTION BUG this scoping fixes: while this ran globally from the root
// route it also ran on /auth, which is the page Google actually crawls (the
// site root 307s there). Googlebot renders JavaScript, so the head it indexed
// was the POST-hydration head — and this effect had already rewritten every
// `link[rel="icon"]` to `brand_settings.favicon_url`, a signed cross-origin
// Supabase Storage URL for a 1280x1098 JPEG. That fails Google's favicon
// requirements three ways at once (not 1:1 square, unstable tokenised URL,
// off-host), so Google discarded it and kept serving the previously cached
// scaffold icon in search results. The static same-origin set from
// public/ was correct and correctly deployed the whole time; a crawler simply
// never got to see it.
//
// The contract this file must keep: on every unauthenticated route the
// crawler-facing declarations in __root.tsx's head() survive hydration
// untouched. Anything mounted above the authenticated boundary breaks that,
// which is why the cleanup below also restores them — signing out unmounts
// this component and returns the SPA to /auth WITHOUT a full reload, so
// without the restore the tenant JPEG would linger in the head of a public
// page for the rest of the browser session.
export function BrandFavicon() {
  const { data: brandSettings } = useBrandSettings();

  useEffect(() => {
    const faviconUrl = brandSettings?.favicon_url || brandSettings?.logo_url;
    if (!faviconUrl) return;

    // head() declares several icon links (.ico + 32px + 16px PNG), so
    // overriding only the first would leave the browser free to select one of
    // the remaining static ones instead of the tenant's uploaded favicon.
    const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]'));
    if (links.length === 0) {
      const created = document.createElement("link");
      created.rel = "icon";
      created.href = faviconUrl;
      document.head.appendChild(created);
      return () => created.remove();
    }

    // Snapshot the static declarations as raw attributes (not the href IDL
    // property, which resolves "/favicon.ico" to an absolute URL) so the
    // restore below puts the crawler-facing head back exactly as authored.
    const originals = links.map((link) => ({
      link,
      href: link.getAttribute("href"),
      type: link.getAttribute("type"),
      sizes: link.getAttribute("sizes"),
    }));

    for (const link of links) {
      link.href = faviconUrl;
      // type/sizes describe the static PNGs, not whatever file was uploaded.
      link.removeAttribute("type");
      link.removeAttribute("sizes");
    }

    return () => {
      for (const { link, href, type, sizes } of originals) {
        for (const [name, value] of [
          ["href", href],
          ["type", type],
          ["sizes", sizes],
        ] as const) {
          if (value === null) link.removeAttribute(name);
          else link.setAttribute(name, value);
        }
      }
    };
  }, [brandSettings?.favicon_url, brandSettings?.logo_url]);

  return null;
}
