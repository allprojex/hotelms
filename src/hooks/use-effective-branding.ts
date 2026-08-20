import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { useBrandSettings } from "@/hooks/use-brand-settings";

export type EffectiveBranding = {
  name: string;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  hasPropertyOverride: boolean;
};

/**
 * Resolved branding for the authenticated, property-aware application:
 * property_branding override -> global system_settings -> DEFAULTS.
 * Browser identity (favicon, document title) is deliberately NOT sourced
 * from here — that stays organisation-wide only, via useBrandSettings()
 * directly, per the approved Branding Phase 1 scope. This hook is for
 * everything that SHOULD represent the active property: sidebar header,
 * and (server-side) property-specific documents.
 *
 * Falls back to global-only branding when no property is active yet
 * (matches pre-property-selection and login-page behavior exactly, since
 * property selection happens client-side, after authentication).
 */
export function useEffectiveBranding(): { data: EffectiveBranding; isLoading: boolean } {
  const propertyId = useActiveProperty();
  const global = useBrandSettings();

  const property = useQuery({
    queryKey: ["effective-branding", propertyId],
    enabled: !!propertyId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)("get_effective_branding", {
        _property_id: propertyId,
      });
      if (error || !data) return null;
      const row = Array.isArray(data) ? data[0] : data;
      return row ?? null;
    },
  });

  const g = global.data;
  const row = propertyId ? property.data : null;

  if (row) {
    return {
      data: {
        name: row.effective_name || row.org_app_name || g?.app_name || "",
        logoUrl: row.logo_url ?? null,
        logoDarkUrl: row.logo_dark_url ?? null,
        primaryColor: row.primary_color ?? null,
        secondaryColor: row.secondary_color ?? null,
        supportEmail: row.support_email ?? null,
        supportPhone: row.support_phone ?? null,
        hasPropertyOverride: !!row.has_property_override,
      },
      isLoading: property.isLoading,
    };
  }

  return {
    data: {
      name: g?.app_short_name || g?.app_name || "",
      logoUrl: g?.logo_url ?? null,
      logoDarkUrl: g?.logo_dark_url ?? null,
      primaryColor: g?.primary_color ?? null,
      secondaryColor: g?.secondary_color ?? null,
      supportEmail: g?.support_email ?? null,
      supportPhone: g?.support_phone ?? null,
      hasPropertyOverride: false,
    },
    isLoading: global.isLoading || (!!propertyId && property.isLoading),
  };
}
