import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ImageOff, Images } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { gallerySignedUrls, GALLERY_SIGNED_URL_TTL_SECONDS } from "@/lib/gallery/signed-url";
import { GalleryLightbox } from "@/components/gallery/gallery-lightbox";

type PreviewImage = {
  id: string;
  title: string | null;
  storage_path: string;
  thumbnail_path: string;
  is_cover: boolean;
  url: string | null;
  thumbnailUrl: string | null;
};

/**
 * Reads the same gallery_images rows regardless of caller: RLS alone decides
 * what's visible (staff see everything for their property, anonymous public
 * booking sees only active=true) — there is no separate public vs. staff
 * query or duplicate data source. Signed URLs are resolved in the same
 * queryFn right after the metadata fetch, batched via gallerySignedUrls, so
 * a card never needs its own extra round-trip. react-query's staleTime is
 * kept below the signed URL TTL so a stale-but-still-cached entry never
 * outlives the URL it points to.
 */
function useRoomTypeGalleryImages(roomTypeId: string | null | undefined) {
  return useQuery({
    queryKey: ["gallery-room-type-images", roomTypeId],
    enabled: !!roomTypeId,
    staleTime: (GALLERY_SIGNED_URL_TTL_SECONDS / 2) * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("gallery_images")
        .select("id,title,storage_path,thumbnail_path,is_cover")
        .eq("room_type_id", roomTypeId!)
        .eq("context", "room_type")
        .order("is_cover", { ascending: false })
        .order("sort_order", { ascending: true });
      if (error) throw error;
      const rows = data ?? [];
      const urls = await gallerySignedUrls(rows.flatMap((r) => [r.storage_path, r.thumbnail_path]));
      return rows.map(
        (r): PreviewImage => ({
          ...r,
          url: urls.get(r.storage_path) ?? null,
          thumbnailUrl: urls.get(r.thumbnail_path) ?? null,
        }),
      );
    },
  });
}

/** Batched cover lookup for a list of room types (public booking results grid) — one metadata query + one bulk sign call, not N. */
export function useRoomTypeCoverImages(roomTypeIds: string[]) {
  return useQuery({
    queryKey: ["gallery-room-type-covers", roomTypeIds.slice().sort().join(",")],
    enabled: roomTypeIds.length > 0,
    staleTime: (GALLERY_SIGNED_URL_TTL_SECONDS / 2) * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("gallery_images")
        .select("id,room_type_id,thumbnail_path,is_cover,sort_order")
        .in("room_type_id", roomTypeIds)
        .eq("context", "room_type")
        .order("is_cover", { ascending: false })
        .order("sort_order", { ascending: true });
      if (error) throw error;
      const coverByRoomType = new Map<string, string>();
      for (const row of data ?? []) {
        const roomTypeId = row.room_type_id as string;
        if (!coverByRoomType.has(roomTypeId))
          coverByRoomType.set(roomTypeId, row.thumbnail_path as string);
      }
      const urls = await gallerySignedUrls([...coverByRoomType.values()]);
      const result = new Map<string, string>();
      for (const [roomTypeId, path] of coverByRoomType) {
        const url = urls.get(path);
        if (url) result.set(roomTypeId, url);
      }
      return result;
    },
  });
}

export function RoomTypeCoverThumbnail({
  roomTypeId,
  className,
}: {
  roomTypeId: string;
  className?: string;
}) {
  const images = useRoomTypeGalleryImages(roomTypeId);
  const cover = images.data?.[0];
  return (
    <div className={`overflow-hidden rounded-md bg-muted ${className ?? "h-16 w-16"}`}>
      {cover?.thumbnailUrl ? (
        <img
          src={cover.thumbnailUrl}
          alt={cover.title ?? ""}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          <ImageOff className="h-5 w-5" />
        </div>
      )}
    </div>
  );
}

/** Thumbnail strip with a click-to-open lightbox showing every image for the room type. */
export function RoomTypeGalleryStrip({
  roomTypeId,
  className,
}: {
  roomTypeId: string;
  className?: string;
}) {
  const images = useRoomTypeGalleryImages(roomTypeId);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const rows = (images.data ?? []).filter((img) => img.thumbnailUrl);

  if (images.isLoading) return null;
  if (rows.length === 0) {
    return (
      <div className={`flex items-center gap-2 text-xs text-muted-foreground ${className ?? ""}`}>
        <ImageOff className="h-4 w-4" /> No photos yet
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="flex gap-2 overflow-x-auto">
        {rows.map((img, idx) => (
          <button
            key={img.id}
            type="button"
            onClick={() => setLightboxIndex(idx)}
            className="h-16 w-16 shrink-0 overflow-hidden rounded-md border bg-muted"
          >
            <img
              src={img.thumbnailUrl!}
              alt={img.title ?? ""}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          </button>
        ))}
      </div>
      {rows.length > 1 && (
        <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
          <Images className="h-3 w-3" /> {rows.length} photos
        </div>
      )}
      {lightboxIndex !== null && (
        <GalleryLightbox
          images={rows.filter((r) => r.url).map((r) => ({ id: r.id, url: r.url!, title: r.title }))}
          startIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}
