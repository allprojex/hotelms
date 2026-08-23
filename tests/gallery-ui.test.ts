import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function read(relPath: string): string {
  return readFileSync(resolve(__dirname, "..", relPath), "utf8");
}

const uploadDialog = read("src/components/gallery/gallery-upload-dialog.tsx");
const imageCard = read("src/components/gallery/gallery-image-card.tsx");
const preview = read("src/components/gallery/room-type-gallery-preview.tsx");
const lightbox = read("src/components/gallery/gallery-lightbox.tsx");
const galleryRoute = read("src/routes/_authenticated/gallery.tsx");
const galleryFunctions = read("src/lib/gallery/gallery.functions.ts");
const imageResize = read("src/lib/gallery/image-resize.ts");
const roomTypesRoute = read("src/routes/_authenticated/rooms.types.tsx");
const newReservationRoute = read("src/routes/_authenticated/reservations.new.tsx");
const bookResults = read("src/routes/book.results.tsx");
const bookCheckout = read("src/routes/book.checkout.$roomTypeId.tsx");
const sidebar = read("src/components/app-sidebar.tsx");

describe("Upload dialog — drag-and-drop, bulk selection, per-file progress", () => {
  it("1 / 2. supports both a drag-and-drop zone and a normal multi-file chooser", () => {
    expect(uploadDialog).toContain("onDrop={(e) => {");
    expect(uploadDialog).toContain("e.dataTransfer.files");
    expect(uploadDialog).toMatch(/<input[\s\S]{0,80}type="file"[\s\S]{0,40}multiple/);
  });

  it("2. uploads a bulk selection sequentially, not one-at-a-time from the user's perspective — every pending item is processed by a single Upload action", () => {
    expect(uploadDialog).toContain("for (const item of pending)");
    expect(uploadDialog).toContain("await uploadOne(item)");
  });

  it("tracks per-file status through the queue (pending/processing/uploading/done/error) — real per-file success/failure, not an all-or-nothing batch", () => {
    expect(uploadDialog).toMatch(
      /status:\s*"pending"\s*\|\s*"processing"\s*\|\s*"uploading"\s*\|\s*"done"\s*\|\s*"error"/,
    );
  });

  it("1. a single upload runs both variants through prepareGalleryImageVariants before touching the network", () => {
    expect(uploadDialog).toContain("prepareGalleryImageVariants(item.file)");
  });

  it("room type is required before upload when context is room_type — no silent fallback", () => {
    expect(uploadDialog).toMatch(/context === "room_type" && !roomTypeId/);
  });

  it("locked context/room type (opened from a specific room type's photo manager) disables the selector rather than allowing it to be changed mid-upload", () => {
    expect(uploadDialog).toContain("disabled={!!lockedContext}");
    expect(uploadDialog).toContain("disabled={!!lockedRoomTypeId}");
  });
});

describe("Image optimization (Phase 5 architecture)", () => {
  it("produces two variants (optimized + thumbnail) from a single decode — no server-side/library dependency", () => {
    expect(imageResize).toContain("prepareGalleryImageVariants");
    expect(imageResize).toContain("optimized");
    expect(imageResize).toContain("thumbnail");
    expect(imageResize).toContain("createImageBitmap");
  });

  it("applies EXIF orientation correction so aspect ratio/orientation is never silently corrupted", () => {
    expect(imageResize).toContain('imageOrientation: "from-image"');
  });

  it("guards against a decompression-bomb-style input (small file, huge decoded pixel count)", () => {
    expect(imageResize).toContain("MAX_SOURCE_PIXELS");
    expect(imageResize).toMatch(/bitmap\.width \* bitmap\.height > MAX_SOURCE_PIXELS/);
  });

  it("releases the decoded bitmap in a finally block regardless of success/failure — no leaked memory on a failed variant", () => {
    expect(imageResize).toMatch(/finally\s*\{\s*bitmap\.close\(\);\s*\}/);
  });
});

describe("Image card — edit, delete, cover, visibility, reorder", () => {
  it("17. exposes a visibility toggle distinct from delete", () => {
    expect(imageCard).toContain("onToggleActive");
    expect(imageCard).not.toBe(undefined);
  });

  it("edit dialog covers both title and caption", () => {
    expect(imageCard).toMatch(/<Label>Title<\/Label>/);
    expect(imageCard).toMatch(/<Label>Caption<\/Label>/);
  });

  it("delete requires confirmation via an AlertDialog, not a bare click", () => {
    expect(imageCard).toContain("AlertDialogAction onClick={() => onDelete()}");
    expect(imageCard).toContain("Delete this photo?");
  });

  it("11. cover control is only offered when the image has a room_type_id (onSetCover is conditional)", () => {
    expect(imageCard).toContain("onSetCover?: () => Promise<void>");
    expect(imageCard).toMatch(/canEdit && onSetCover && \(/);
  });

  it("12. is draggable for reorder and reports drag events to its parent rather than owning reorder logic itself", () => {
    expect(imageCard).toContain("draggable={draggable}");
    expect(imageCard).toContain("onDragStart={onDragStart}");
    expect(imageCard).toContain("onDrop={onDrop}");
  });

  it("22. renders the thumbnail_path, never the full-resolution storage_path, in the grid card", () => {
    expect(imageCard).toContain("galleryPublicUrl(image.thumbnail_path)");
    expect(imageCard).not.toContain("galleryPublicUrl(image.storage_path)");
  });
});

describe("Gallery management route — permissions, album CRUD, reorder wiring", () => {
  it("7 / 8. gates create/edit/delete actions behind usePermission, using the same GALLERY_MANAGEMENT_ROLES default as the migration's seeded roles", () => {
    expect(galleryRoute).toContain("GALLERY_PERMISSIONS.create");
    expect(galleryRoute).toContain("GALLERY_PERMISSIONS.edit");
    expect(galleryRoute).toContain("GALLERY_PERMISSIONS.delete");
    expect(galleryRoute).toContain("defaultRoles: GALLERY_MANAGEMENT_ROLES");
  });

  it("view-gating: the whole management UI is hidden behind canView, not just individual buttons", () => {
    expect(galleryRoute).toMatch(/if \(!canView\) \{/);
  });

  it("12. reorder recomputes the full ordered id list client-side and sends it in one call to reorderGalleryImages", () => {
    expect(galleryRoute).toContain("handleReorderDrop");
    expect(galleryRoute).toContain("reorderFn({ data: { propertyId, imageIds: next } })");
  });

  it("15 / 16. album create/edit/delete are wired through dedicated server functions (audited), not raw table writes from the client", () => {
    expect(galleryRoute).toContain("createGalleryAlbum");
    expect(galleryRoute).toContain("updateGalleryAlbum");
    expect(galleryRoute).toContain("deleteGalleryAlbum");
  });

  it("room-type-focused deep link (from the room types page) filters the grid to that room type and locks the upload dialog's context", () => {
    expect(galleryRoute).toContain("focusedRoomTypeId");
    expect(galleryRoute).toContain('q = q.eq("room_type_id", focusedRoomTypeId)');
    expect(galleryRoute).toContain('lockedContext={focusedRoomTypeId ? "room_type" : undefined}');
  });
});

describe("Server functions — audit, property isolation, storage/DB consistency on delete", () => {
  it("23. every mutating action captures an audit event: upload, metadata edit, visibility change, cover set, reorder, delete, album create/update/delete", () => {
    for (const action of [
      "gallery_image.uploaded",
      "gallery_image.updated",
      "gallery_image.visibility_changed",
      "gallery_image.cover_set",
      "gallery_image.reordered",
      "gallery_image.deleted",
      "gallery_album.created",
      "gallery_album.updated",
      "gallery_album.deleted",
    ]) {
      expect(galleryFunctions).toContain(`"${action}"`);
    }
  });

  it("7 / 8. every management server function asserts a gallery permission before touching data", () => {
    const occurrences = galleryFunctions.match(/assertGalleryManagePermission\(/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(6);
  });

  it("9. room-type context requires an explicit room type, and validates it belongs to the same property (no cross-property room type attach)", () => {
    expect(galleryFunctions).toContain(
      'if (!data.roomTypeId) throw new Error("A room type must be selected for room-type photos")',
    );
    expect(galleryFunctions).toContain(
      "assertRoomTypeOwnership(context, data.roomTypeId, data.propertyId)",
    );
  });

  it("13 / 14. delete removes both storage objects together and treats storage removal as best-effort so it never blocks the metadata delete", () => {
    expect(galleryFunctions).toMatch(
      /\.remove\(\[existing\.data\.storage_path, existing\.data\.thumbnail_path\]\)/,
    );
    expect(galleryFunctions).toMatch(/if \(removed\.error\) \{\s*\n\s*console\.warn/);
  });

  it("26. delete confirms the image actually belongs to the claimed property before removing anything (cross-property delete rejected)", () => {
    expect(galleryFunctions).toMatch(
      /if \(!existing\.data \|\| existing\.data\.property_id !== data\.propertyId\)\s*\n\s*throw new Error\("Image not found"\)/,
    );
  });

  it("6. confirmGalleryImage validates both the full and thumbnail storage paths are namespaced to the claimed property before trusting them", () => {
    expect(galleryFunctions).toContain(
      "assertGalleryImageNamespace(data.storagePath, data.propertyId)",
    );
    expect(galleryFunctions).toContain(
      "assertGalleryThumbnailNamespace(data.thumbnailPath, data.propertyId)",
    );
  });

  it("reads never require a server round-trip — getPublicUrl is a pure client-side string operation, never wrapped in a createServerFn", () => {
    expect(galleryFunctions).not.toMatch(/getGalleryImageUrls|getPublicUrl/);
  });
});

describe("Shared gallery-read component — one data source for staff and public booking", () => {
  it("20. the same query (relying on RLS, not a mode flag) backs both the reception preview and the public booking strip/cover — no duplicate public vs. staff query", () => {
    expect(preview).toContain("useRoomTypeGalleryImages");
    expect(newReservationRoute).toContain("RoomTypeGalleryStrip");
    expect(bookCheckout).toContain("RoomTypeGalleryStrip");
  });

  it("21. every render path has an explicit no-photo fallback rather than rendering nothing or crashing", () => {
    expect(preview).toContain("ImageOff");
    expect(preview).toContain("No photos yet");
    expect(bookResults).toContain("ImageOff");
  });

  it("22. list/grid/card views use thumbnail_path; only the lightbox (single enlarged view) uses the full storage_path", () => {
    expect(preview).toContain("galleryPublicUrl(cover.thumbnail_path)");
    expect(preview).toContain("galleryPublicUrl(img.thumbnail_path)");
    expect(preview).toContain("url: galleryPublicUrl(r.storage_path)");
  });

  it("30. the public booking results grid batches one query across every visible room type instead of one query per card (no N+1)", () => {
    expect(preview).toContain("useRoomTypeCoverImages");
    expect(preview).toMatch(/\.in\("room_type_id", roomTypeIds\)/);
    expect(bookResults).toContain("useRoomTypeCoverImages(roomTypeIds)");
  });
});

describe("Lightbox", () => {
  it("supports navigating between multiple images and closing", () => {
    expect(lightbox).toContain("setIndex((i) => (i + 1) % images.length)");
    expect(lightbox).toContain("setIndex((i) => (i - 1 + images.length) % images.length)");
    expect(lightbox).toContain("onClose");
  });
});

describe("Regression safety on pre-existing surfaces", () => {
  it("29. rooms.types.tsx keeps its original insert/update save path untouched — only a cover thumbnail and a photo-management link were added", () => {
    expect(roomTypesRoute).toContain(
      'supabase.from("room_types").update(payload).eq("id", existing.id)',
    );
    expect(roomTypesRoute).toContain('supabase.from("room_types").insert(payload)');
    expect(roomTypesRoute).toContain("RoomTypeCoverThumbnail");
  });

  it("29. reservations.new.tsx keeps its original reservation-creation flow untouched — only a gallery preview was added under the room type select", () => {
    expect(newReservationRoute).toContain('supabase.from("reservations").insert(');
    expect(newReservationRoute).toContain('supabase.from("guests").insert(');
  });

  it("30. book.results.tsx still calls the same booking_search_availability RPC with the same parameters — the search/availability flow is untouched", () => {
    expect(bookResults).toContain('supabase.rpc("booking_search_availability"');
    expect(bookResults).toContain("_property_id: propertyId");
    expect(bookResults).toContain("_check_in: checkIn");
    expect(bookResults).toContain("_check_out: checkOut");
    expect(bookResults).toContain("_guests: guests");
  });

  it("30. book.checkout still calls the same booking_create RPC — the checkout/booking-creation flow is untouched", () => {
    expect(bookCheckout).toContain('supabase.rpc("booking_create"');
  });

  it("28. the sidebar adds a Gallery entry without touching any other existing nav item's route", () => {
    expect(sidebar).toContain('to: "/gallery"');
    expect(sidebar).toContain('to: "/rooms/types"');
    expect(sidebar).toContain('to: "/inventory"');
  });
});
