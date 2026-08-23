import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ImageOff, Images } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { galleryPublicUrl } from "@/lib/gallery/public-url";
import { GalleryLightbox } from "@/components/gallery/gallery-lightbox";

type PreviewImage = {
  id: string;
  title: string | null;
  storage_path: string;
  thumbnail_path: string;
  is_cover: boolean;
};

/**
 * Reads the same gallery_images rows regardless of caller: RLS alone decides
 * what's visible (staff see everything for their property, anonymous public
 * booking sees only active=true) — there is no separate public vs. staff
 * query or duplicate data source, satisfying Phase 11's "no separate
 * duplicate image source" requirement by construction.
 */
function useRoomTypeGalleryImages(roomTypeId: string | null | undefined) {
  return useQuery({
    queryKey: ["gallery-room-type-images", roomTypeId],
    enabled: !!roomTypeId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("gallery_images")
        .select("id,title,storage_path,thumbnail_path,is_cover")
        .eq("room_type_id", roomTypeId!)
        .eq("context", "room_type")
        .order("is_cover", { ascending: false })
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as PreviewImage[];
    },
  });
}

/** Batched cover lookup for a list of room types (public booking results grid) — one query, not N. */
export function useRoomTypeCoverImages(roomTypeIds: string[]) {
  return useQuery({
    queryKey: ["gallery-room-type-covers", roomTypeIds.slice().sort().join(",")],
    enabled: roomTypeIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("gallery_images")
        .select("id,room_type_id,thumbnail_path,is_cover,sort_order")
        .in("room_type_id", roomTypeIds)
        .eq("context", "room_type")
        .order("is_cover", { ascending: false })
        .order("sort_order", { ascending: true });
      if (error) throw error;
      const byRoomType = new Map<string, string>();
      for (const row of data ?? []) {
        if (!byRoomType.has(row.room_type_id as string)) {
          byRoomType.set(row.room_type_id as string, row.thumbnail_path as string);
        }
      }
      return byRoomType;
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
      {cover ? (
        <img
          src={galleryPublicUrl(cover.thumbnail_path)}
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
  const rows = images.data ?? [];

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
              src={galleryPublicUrl(img.thumbnail_path)}
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
          images={rows.map((r) => ({
            id: r.id,
            url: galleryPublicUrl(r.storage_path),
            title: r.title,
          }))}
          startIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}
