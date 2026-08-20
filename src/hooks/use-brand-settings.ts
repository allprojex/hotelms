import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type BrandSettings = {
  app_name: string;
  app_short_name: string | null;
  tagline: string | null;
  logo_url: string | null;
  logo_dark_url: string | null;
  favicon_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  support_email: string | null;
  support_phone: string | null;
};

const DEFAULTS: BrandSettings = {
  app_name: "ThesKwoff Hotel",
  app_short_name: "ThesKwoff Hotel",
  tagline: null,
  logo_url: null,
  logo_dark_url: null,
  favicon_url: null,
  primary_color: null,
  secondary_color: null,
  support_email: null,
  support_phone: null,
};

export function useBrandSettings() {
  return useQuery({
    queryKey: ["brand-settings"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<BrandSettings> => {
      const { data, error } = await (supabase.rpc as any)("get_brand_settings");
      if (error || !data) return DEFAULTS;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return DEFAULTS;
      return { ...DEFAULTS, ...(row as Partial<BrandSettings>) };
    },
  });
}
