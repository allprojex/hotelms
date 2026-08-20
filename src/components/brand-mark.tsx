import { useEffect, useState } from "react";
import { useBrandSettings } from "@/hooks/use-brand-settings";

const DEFAULT_LOGO_URL = "/iti360-logo.jpeg";

export function BrandMark({
  className = "h-8",
  logoUrl: logoUrlOverride,
  logoDarkUrl: logoDarkUrlOverride,
  alt: altOverride,
}: {
  className?: string;
  /** Optional property-effective overrides (falls back to global org branding when omitted — used by the login page, which has no property context). */
  logoUrl?: string | null;
  logoDarkUrl?: string | null;
  alt?: string | null;
}) {
  const { data } = useBrandSettings();

  // Detect dark class on <html> so we can pick logo_dark_url when set.
  const [isDark, setIsDark] = useState<boolean>(() => {
    if (typeof document === "undefined") return false;
    return document.documentElement.classList.contains("dark");
  });
  useEffect(() => {
    if (typeof document === "undefined") return;
    const el = document.documentElement;
    const obs = new MutationObserver(() => setIsDark(el.classList.contains("dark")));
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  const logoUrl = logoUrlOverride !== undefined ? logoUrlOverride : data?.logo_url;
  const logoDarkUrl = logoDarkUrlOverride !== undefined ? logoDarkUrlOverride : data?.logo_dark_url;
  const src = (isDark && logoDarkUrl) || logoUrl || DEFAULT_LOGO_URL;
  const alt = altOverride || data?.app_name || "ThesKwoff Hotel";

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onError={(event) => {
        if (event.currentTarget.src.endsWith(DEFAULT_LOGO_URL)) return;
        event.currentTarget.src = DEFAULT_LOGO_URL;
      }}
    />
  );
}
