import { supabase } from "@/integrations/supabase/client";

/**
 * The gallery-images bucket is public, so building a URL is a pure string
 * operation with no network round-trip and no expiry to manage — unlike the
 * signed URLs product-images/brand-assets need for their private buckets.
 * Safe to call synchronously in render, including for grids of many cards.
 */
export function galleryPublicUrl(storagePath: string): string {
  return supabase.storage.from("gallery-images").getPublicUrl(storagePath).data.publicUrl;
}
