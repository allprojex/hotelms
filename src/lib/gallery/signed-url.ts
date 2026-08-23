import { supabase } from "@/integrations/supabase/client";

/**
 * The gallery-images bucket is private. A signed URL is minted per request
 * and only succeeds if the calling session (anon or authenticated) currently
 * passes a storage.objects RLS SELECT policy — for anon that means a live
 * gallery_images row with active=true, for staff it means the gallery read
 * permission on that property (any visibility). This is what makes hiding an
 * image (active=false) actually revoke NEW access, unlike a public bucket.
 *
 * Short TTL: long enough to survive a normal booking/checkout browsing
 * session without expiring mid-view, short enough that the exposure window
 * after hiding an image (an already-issued URL keeps working until its own
 * expiry — inherent to any signed-URL design) stays bounded. Never mint a
 * multi-year URL for gallery content the way brand-assets does for a logo.
 */
export const GALLERY_SIGNED_URL_TTL_SECONDS = 900;

export async function gallerySignedUrl(storagePath: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from("gallery-images")
    .createSignedUrl(storagePath, GALLERY_SIGNED_URL_TTL_SECONDS);
  if (error || !data) return null;
  return data.signedUrl;
}

/**
 * One request signs every path — the batching this whole module exists to
 * make possible for a grid of many cards (public booking results, the admin
 * gallery grid) instead of one round-trip per image.
 */
export async function gallerySignedUrls(storagePaths: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (storagePaths.length === 0) return map;
  const { data, error } = await supabase.storage
    .from("gallery-images")
    .createSignedUrls(storagePaths, GALLERY_SIGNED_URL_TTL_SECONDS);
  if (error || !data) return map;
  for (const row of data) {
    if (row.signedUrl && row.path) map.set(row.path, row.signedUrl);
  }
  return map;
}
