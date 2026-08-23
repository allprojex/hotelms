import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertServerPermission, type PermissionContext } from "@/lib/permissions.server";
import { captureAuditEvent } from "@/lib/audit.server";
import { GALLERY_PERMISSIONS, GALLERY_MANAGEMENT_ROLES } from "@/lib/gallery/permissions";
import {
  uuid,
  optionalUuid,
  optionalShortText,
  validateGalleryImageFile,
  validateGalleryContext,
  galleryImageStoragePath,
  galleryThumbnailStoragePath,
  assertGalleryImageNamespace,
  assertGalleryThumbnailNamespace,
} from "@/lib/gallery/domain";

const GALLERY_BUCKET = "gallery-images";

async function assertGalleryManagePermission(
  context: PermissionContext,
  propertyId: string,
  capability: (typeof GALLERY_PERMISSIONS)[keyof typeof GALLERY_PERMISSIONS] = GALLERY_PERMISSIONS.create,
): Promise<void> {
  await assertServerPermission(context, {
    propertyId,
    ...capability,
    defaultRoles: GALLERY_MANAGEMENT_ROLES,
  });
}

async function assertRoomTypeOwnership(
  context: PermissionContext,
  roomTypeId: string,
  propertyId: string,
): Promise<void> {
  const { data, error } = await context.supabase
    .from("room_types")
    .select("id,property_id")
    .eq("id", roomTypeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.property_id !== propertyId) throw new Error("Room type not found");
}

export const createGalleryUploadTicket = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { propertyId: string; fileName: string; fileType: string; fileSize: number }) => ({
      propertyId: uuid(d.propertyId),
      fileName: String(d.fileName ?? ""),
      fileType: String(d.fileType ?? ""),
      fileSize: Number(d.fileSize),
    }),
  )
  .handler(async ({ data, context }) => {
    validateGalleryImageFile({ type: data.fileType, size: data.fileSize });
    await assertGalleryManagePermission(context, data.propertyId, GALLERY_PERMISSIONS.create);
    const imageId = crypto.randomUUID();
    return {
      bucket: GALLERY_BUCKET,
      imageId,
      storagePath: galleryImageStoragePath({
        propertyId: data.propertyId,
        imageId,
        fileName: data.fileName,
      }),
      thumbnailPath: galleryThumbnailStoragePath({
        propertyId: data.propertyId,
        imageId,
        fileName: data.fileName,
      }),
    };
  });

export const confirmGalleryImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      propertyId: string;
      storagePath: string;
      thumbnailPath: string;
      context: string;
      albumId?: string;
      roomTypeId?: string;
      title?: string;
      caption?: string;
    }) => ({
      propertyId: uuid(d.propertyId),
      storagePath: String(d.storagePath ?? ""),
      thumbnailPath: String(d.thumbnailPath ?? ""),
      context: validateGalleryContext(d.context),
      albumId: optionalUuid(d.albumId),
      roomTypeId: optionalUuid(d.roomTypeId),
      title: optionalShortText(d.title, 150),
      caption: optionalShortText(d.caption, 500),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertGalleryManagePermission(context, data.propertyId, GALLERY_PERMISSIONS.create);
    assertGalleryImageNamespace(data.storagePath, data.propertyId);
    assertGalleryThumbnailNamespace(data.thumbnailPath, data.propertyId);

    if (data.context === "room_type") {
      if (!data.roomTypeId) throw new Error("A room type must be selected for room-type photos");
      await assertRoomTypeOwnership(context, data.roomTypeId, data.propertyId);
    } else if (data.roomTypeId) {
      throw new Error("Room type only applies to the room_type context");
    }

    const insert = await context.supabase
      .from("gallery_images")
      .insert({
        property_id: data.propertyId,
        album_id: data.albumId,
        context: data.context,
        room_type_id: data.roomTypeId,
        title: data.title,
        caption: data.caption,
        storage_path: data.storagePath,
        thumbnail_path: data.thumbnailPath,
        uploaded_by: context.userId,
      })
      .select("id")
      .single();
    if (insert.error) throw new Error(insert.error.message);

    await captureAuditEvent(context, {
      propertyId: data.propertyId,
      sourceModule: "gallery",
      action: "gallery_image.uploaded",
      resourceType: "gallery_image",
      resourceId: insert.data.id,
      newValues: {
        context: data.context,
        albumId: data.albumId,
        roomTypeId: data.roomTypeId,
        storagePath: data.storagePath,
      },
    });

    return { id: insert.data.id as string };
  });

export const updateGalleryImageMeta = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      propertyId: string;
      imageId: string;
      title?: string;
      caption?: string;
      albumId?: string;
      active?: boolean;
    }) => ({
      propertyId: uuid(d.propertyId),
      imageId: uuid(d.imageId),
      title: optionalShortText(d.title, 150),
      caption: optionalShortText(d.caption, 500),
      albumId: optionalUuid(d.albumId),
      active: d.active === undefined ? undefined : Boolean(d.active),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertGalleryManagePermission(context, data.propertyId, GALLERY_PERMISSIONS.edit);

    const before = await context.supabase
      .from("gallery_images")
      .select("id,property_id,title,caption,album_id,active")
      .eq("id", data.imageId)
      .maybeSingle();
    if (before.error) throw new Error(before.error.message);
    if (!before.data || before.data.property_id !== data.propertyId)
      throw new Error("Image not found");

    const payload: {
      title: string | null;
      caption: string | null;
      album_id: string | null;
      active?: boolean;
    } = {
      title: data.title,
      caption: data.caption,
      album_id: data.albumId,
    };
    if (data.active !== undefined) payload.active = data.active;

    const update = await context.supabase
      .from("gallery_images")
      .update(payload)
      .eq("id", data.imageId);
    if (update.error) throw new Error(update.error.message);

    await captureAuditEvent(context, {
      propertyId: data.propertyId,
      sourceModule: "gallery",
      action:
        data.active !== undefined ? "gallery_image.visibility_changed" : "gallery_image.updated",
      resourceType: "gallery_image",
      resourceId: data.imageId,
      oldValues: before.data,
      newValues: payload,
    });

    return { ok: true };
  });

export const setGalleryRoomTypeCover = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; roomTypeId: string; imageId: string }) => ({
    propertyId: uuid(d.propertyId),
    roomTypeId: uuid(d.roomTypeId),
    imageId: uuid(d.imageId),
  }))
  .handler(async ({ data, context }) => {
    await assertGalleryManagePermission(context, data.propertyId, GALLERY_PERMISSIONS.edit);
    const result = await context.supabase.rpc("set_gallery_room_type_cover", {
      _property_id: data.propertyId,
      _room_type_id: data.roomTypeId,
      _image_id: data.imageId,
    });
    if (result.error) throw new Error(result.error.message);

    await captureAuditEvent(context, {
      propertyId: data.propertyId,
      sourceModule: "gallery",
      action: "gallery_image.cover_set",
      resourceType: "gallery_image",
      resourceId: data.imageId,
      newValues: { roomTypeId: data.roomTypeId },
    });
    return { ok: true };
  });

export const reorderGalleryImages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; imageIds: string[] }) => ({
    propertyId: uuid(d.propertyId),
    imageIds: (Array.isArray(d.imageIds) ? d.imageIds : []).map((id) => uuid(id)),
  }))
  .handler(async ({ data, context }) => {
    await assertGalleryManagePermission(context, data.propertyId, GALLERY_PERMISSIONS.edit);
    const result = await context.supabase.rpc("reorder_gallery_images", {
      _property_id: data.propertyId,
      _image_ids: data.imageIds,
    });
    if (result.error) throw new Error(result.error.message);

    await captureAuditEvent(context, {
      propertyId: data.propertyId,
      sourceModule: "gallery",
      action: "gallery_image.reordered",
      resourceType: "gallery_image",
      resourceId: null,
      newValues: { orderedIds: data.imageIds },
    });
    return { ok: true };
  });

/**
 * Removes both storage objects (full + thumbnail) and the metadata row. The
 * storage removal is best-effort: a missing/already-gone object must never
 * block the metadata delete from completing, so the DB stays the source of
 * truth even if a prior partial failure already removed one of the objects.
 *
 * A left-behind object is inert, not a public leak: the bucket is private,
 * and the anon read policy on storage.objects requires a matching
 * gallery_images row to exist — once this row is gone, no anonymous signed
 * URL can ever be minted for either path again, regardless of the object's
 * physical presence. Staff with the gallery read permission for this
 * property can still sign it (by design — see the staff storage policy),
 * which is exactly what makes the failure below actionable: a
 * gallery_image.orphan_storage_object audit row records the exact paths so
 * a follow-up cleanup pass (or a support engineer, using their own
 * authenticated session) can find and remove it later.
 */
export const deleteGalleryImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; imageId: string }) => ({
    propertyId: uuid(d.propertyId),
    imageId: uuid(d.imageId),
  }))
  .handler(async ({ data, context }) => {
    await assertGalleryManagePermission(context, data.propertyId, GALLERY_PERMISSIONS.delete);

    const existing = await context.supabase
      .from("gallery_images")
      .select("id,property_id,storage_path,thumbnail_path,context,room_type_id,album_id")
      .eq("id", data.imageId)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (!existing.data || existing.data.property_id !== data.propertyId)
      throw new Error("Image not found");

    const del = await context.supabase.from("gallery_images").delete().eq("id", data.imageId);
    if (del.error) throw new Error(del.error.message);

    const removed = await context.supabase.storage
      .from(GALLERY_BUCKET)
      .remove([existing.data.storage_path, existing.data.thumbnail_path]);
    if (removed.error) {
      console.warn(
        "[gallery] failed to remove storage objects for deleted image",
        data.imageId,
        removed.error,
      );
      await captureAuditEvent(context, {
        propertyId: data.propertyId,
        sourceModule: "gallery",
        action: "gallery_image.orphan_storage_object",
        resourceType: "gallery_image",
        resourceId: data.imageId,
        newValues: {
          storagePath: existing.data.storage_path,
          thumbnailPath: existing.data.thumbnail_path,
          error: removed.error.message,
        },
        success: false,
      });
    }

    await captureAuditEvent(context, {
      propertyId: data.propertyId,
      sourceModule: "gallery",
      action: "gallery_image.deleted",
      resourceType: "gallery_image",
      resourceId: data.imageId,
      oldValues: existing.data,
    });

    return { ok: true };
  });

export const createGalleryAlbum = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; name: string; description?: string }) => ({
    propertyId: uuid(d.propertyId),
    name: String(d.name ?? "")
      .trim()
      .slice(0, 150),
    description: optionalShortText(d.description, 500),
  }))
  .handler(async ({ data, context }) => {
    if (!data.name) throw new Error("Album name is required");
    await assertGalleryManagePermission(context, data.propertyId, GALLERY_PERMISSIONS.create);

    const insert = await context.supabase
      .from("gallery_albums")
      .insert({
        property_id: data.propertyId,
        name: data.name,
        description: data.description,
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (insert.error) throw new Error(insert.error.message);

    await captureAuditEvent(context, {
      propertyId: data.propertyId,
      sourceModule: "gallery",
      action: "gallery_album.created",
      resourceType: "gallery_album",
      resourceId: insert.data.id,
      newValues: { name: data.name, description: data.description },
    });
    return { id: insert.data.id as string };
  });

export const updateGalleryAlbum = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { propertyId: string; albumId: string; name: string; description?: string }) => ({
      propertyId: uuid(d.propertyId),
      albumId: uuid(d.albumId),
      name: String(d.name ?? "")
        .trim()
        .slice(0, 150),
      description: optionalShortText(d.description, 500),
    }),
  )
  .handler(async ({ data, context }) => {
    if (!data.name) throw new Error("Album name is required");
    await assertGalleryManagePermission(context, data.propertyId, GALLERY_PERMISSIONS.edit);

    const before = await context.supabase
      .from("gallery_albums")
      .select("id,property_id,name,description")
      .eq("id", data.albumId)
      .maybeSingle();
    if (before.error) throw new Error(before.error.message);
    if (!before.data || before.data.property_id !== data.propertyId)
      throw new Error("Album not found");

    const update = await context.supabase
      .from("gallery_albums")
      .update({ name: data.name, description: data.description })
      .eq("id", data.albumId);
    if (update.error) throw new Error(update.error.message);

    await captureAuditEvent(context, {
      propertyId: data.propertyId,
      sourceModule: "gallery",
      action: "gallery_album.updated",
      resourceType: "gallery_album",
      resourceId: data.albumId,
      oldValues: before.data,
      newValues: { name: data.name, description: data.description },
    });
    return { ok: true };
  });

export const deleteGalleryAlbum = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; albumId: string }) => ({
    propertyId: uuid(d.propertyId),
    albumId: uuid(d.albumId),
  }))
  .handler(async ({ data, context }) => {
    await assertGalleryManagePermission(context, data.propertyId, GALLERY_PERMISSIONS.delete);

    const before = await context.supabase
      .from("gallery_albums")
      .select("id,property_id,name")
      .eq("id", data.albumId)
      .maybeSingle();
    if (before.error) throw new Error(before.error.message);
    if (!before.data || before.data.property_id !== data.propertyId)
      throw new Error("Album not found");

    // Images in this album are not deleted — the FK is ON DELETE SET NULL,
    // so they simply become unalbumed rather than disappearing.
    const del = await context.supabase.from("gallery_albums").delete().eq("id", data.albumId);
    if (del.error) throw new Error(del.error.message);

    await captureAuditEvent(context, {
      propertyId: data.propertyId,
      sourceModule: "gallery",
      action: "gallery_album.deleted",
      resourceType: "gallery_album",
      resourceId: data.albumId,
      oldValues: before.data,
    });
    return { ok: true };
  });
