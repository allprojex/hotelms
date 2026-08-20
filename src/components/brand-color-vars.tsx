import { useEffect } from "react";
import { useEffectiveBranding } from "@/hooks/use-effective-branding";

/**
 * Applies the resolved brand accent colors as CSS custom properties,
 * deliberately scoped to --brand-primary/--brand-secondary rather than
 * the design system's own --primary/--secondary tokens (which drive
 * buttons, links, and focus rings across the whole app). Overriding
 * those globally would touch far more UI surface than has been reviewed
 * here and risks damaging contrast/readability app-wide.
 * --success/--warning/--destructive are never touched — status colors
 * always keep their semantic meaning regardless of brand configuration.
 * Consumers (login gradient, sidebar accent, PDFs) opt in explicitly via
 * var(--brand-primary)/var(--brand-secondary), falling back to the
 * existing static design-system values when unset.
 */
export function BrandColorVars() {
  const { data } = useEffectiveBranding();

  useEffect(() => {
    const root = document.documentElement;
    if (data.primaryColor) root.style.setProperty("--brand-primary", data.primaryColor);
    else root.style.removeProperty("--brand-primary");
    if (data.secondaryColor) root.style.setProperty("--brand-secondary", data.secondaryColor);
    else root.style.removeProperty("--brand-secondary");
  }, [data.primaryColor, data.secondaryColor]);

  return null;
}
