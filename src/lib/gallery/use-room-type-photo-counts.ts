import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { GALLERY_SIGNED_URL_TTL_SECONDS } from "@/lib/gallery/signed-url";

/**
 * Batched photo counts for a list of room types: ONE query for the whole
 * grid, never one per card.
 *
 * This lives beside useRoomTypeCoverImages rather than inside it on purpose.
 * That hook resolves cover URLs and is currently being refactored by the
 * Rooms-list thumbnail work (PR #92); widening its return type here would
 * collide with that change for no functional gain. Both hooks issue one
 * batched request each, so the Room Types grid costs two queries in total
 * regardless of how many room types exist -- the N+1 this replaces cost one
 * metadata query plus one signing round-trip per card.
 *
 * Once PR #92 has landed, these two batched reads can be folded into a single
 * query that returns cover path and count together.
 *
 * No property filter is applied here, exactly as in useRoomTypeCoverImages:
 * the ids passed in are already scoped to the active property, and RLS on
 * gallery_images decides what is visible. Counting without an `active` filter
 * is deliberate -- it matches what the Manage photos screen will show.
 */
export function useRoomTypePhotoCounts(roomTypeIds: string[]) {
  return useQuery({
    queryKey: ["gallery-room-type-photo-counts", roomTypeIds.slice().sort().join(",")],
    enabled: roomTypeIds.length > 0,
    staleTime: (GALLERY_SIGNED_URL_TTL_SECONDS / 2) * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("gallery_images")
        .select("room_type_id")
        .in("room_type_id", roomTypeIds)
        .eq("context", "room_type");
      if (error) throw error;
      return countByRoomType((data ?? []) as { room_type_id: string | null }[]);
    },
  });
}

/** Pure reducer, split out so the tally is testable without a network call. */
export function countByRoomType(rows: { room_type_id: string | null }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.room_type_id) continue;
    counts.set(row.room_type_id, (counts.get(row.room_type_id) ?? 0) + 1);
  }
  return counts;
}
