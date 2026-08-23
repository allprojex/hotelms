import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Plus, FolderPlus, Pencil, Trash2, Images } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { usePermission } from "@/hooks/use-permission";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  GALLERY_CONTEXTS,
  GALLERY_CONTEXT_LABELS,
  type GalleryContext,
} from "@/lib/gallery/domain";
import { GALLERY_PERMISSIONS, GALLERY_MANAGEMENT_ROLES } from "@/lib/gallery/permissions";
import { GalleryUploadDialog } from "@/components/gallery/gallery-upload-dialog";
import { GalleryImageCard, type GalleryImageRow } from "@/components/gallery/gallery-image-card";
import {
  updateGalleryImageMeta,
  setGalleryRoomTypeCover,
  reorderGalleryImages,
  deleteGalleryImage,
  createGalleryAlbum,
  updateGalleryAlbum,
  deleteGalleryAlbum,
} from "@/lib/gallery/gallery.functions";

const gallerySearchSchema = z.object({
  context: z.enum(GALLERY_CONTEXTS).optional(),
  roomTypeId: z.string().uuid().optional(),
});

export const Route = createFileRoute("/_authenticated/gallery")({
  head: () => ({ meta: [{ title: "Gallery" }] }),
  validateSearch: (s) => gallerySearchSchema.parse(s),
  component: GalleryPage,
});

function GalleryPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const search = Route.useSearch();
  const [contextFilter, setContextFilter] = useState<GalleryContext | "all">(
    search.context ?? "all",
  );
  const [albumFilter, setAlbumFilter] = useState<string>("all");
  const [dragId, setDragId] = useState<string | null>(null);
  const focusedRoomTypeId = search.roomTypeId ?? null;

  const { allowed: canView, loading: viewLoading } = usePermission({
    propertyId,
    ...GALLERY_PERMISSIONS.view,
    defaultRoles: GALLERY_MANAGEMENT_ROLES,
  });
  const { allowed: canCreate } = usePermission({
    propertyId,
    ...GALLERY_PERMISSIONS.create,
    defaultRoles: GALLERY_MANAGEMENT_ROLES,
  });
  const { allowed: canEdit } = usePermission({
    propertyId,
    ...GALLERY_PERMISSIONS.edit,
    defaultRoles: GALLERY_MANAGEMENT_ROLES,
  });
  const { allowed: canDelete } = usePermission({
    propertyId,
    ...GALLERY_PERMISSIONS.delete,
    defaultRoles: GALLERY_MANAGEMENT_ROLES,
  });

  const roomTypesQuery = useQuery({
    queryKey: ["room-types", propertyId],
    enabled: !!propertyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("room_types")
        .select("id,name")
        .eq("property_id", propertyId!)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const albumsQuery = useQuery({
    queryKey: ["gallery-albums", propertyId],
    enabled: !!propertyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("gallery_albums")
        .select("id,name,description,sort_order")
        .eq("property_id", propertyId!)
        .order("sort_order")
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const imagesQuery = useQuery({
    queryKey: ["gallery-images-admin", propertyId, contextFilter, albumFilter, focusedRoomTypeId],
    enabled: !!propertyId,
    queryFn: async () => {
      let q = supabase
        .from("gallery_images")
        .select(
          "id,title,caption,context,album_id,room_type_id,storage_path,thumbnail_path,is_cover,sort_order,active",
        )
        .eq("property_id", propertyId!)
        .order("sort_order")
        .order("created_at", { ascending: false });
      if (focusedRoomTypeId) q = q.eq("room_type_id", focusedRoomTypeId);
      else if (contextFilter !== "all") q = q.eq("context", contextFilter);
      if (albumFilter !== "all") q = q.eq("album_id", albumFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as (GalleryImageRow & { album_id: string | null; sort_order: number })[];
    },
  });

  const updateMetaFn = useServerFn(updateGalleryImageMeta);
  const setCoverFn = useServerFn(setGalleryRoomTypeCover);
  const reorderFn = useServerFn(reorderGalleryImages);
  const deleteFn = useServerFn(deleteGalleryImage);

  function invalidateImages() {
    qc.invalidateQueries({ queryKey: ["gallery-images-admin", propertyId] });
    qc.invalidateQueries({ queryKey: ["gallery-room-type-images"] });
    qc.invalidateQueries({ queryKey: ["gallery-room-type-covers"] });
  }

  const rows = imagesQuery.data ?? [];
  const roomTypeOptions = useMemo(
    () => (roomTypesQuery.data ?? []).map((rt) => ({ id: rt.id, name: rt.name })),
    [roomTypesQuery.data],
  );
  const albumOptions = useMemo(
    () => (albumsQuery.data ?? []).map((a) => ({ id: a.id, name: a.name })),
    [albumsQuery.data],
  );

  async function handleReorderDrop(targetId: string) {
    if (!dragId || dragId === targetId || !propertyId) return;
    const ids = rows.map((r) => r.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, dragId);
    setDragId(null);
    try {
      await reorderFn({ data: { propertyId, imageIds: next } });
      invalidateImages();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reorder");
    }
  }

  if (viewLoading) return null;
  if (!canView) {
    return (
      <div className="text-sm text-muted-foreground">
        You do not have permission to view the gallery.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Gallery</h1>
          <p className="text-sm text-muted-foreground">
            {focusedRoomTypeId
              ? `Photos for ${roomTypeOptions.find((rt) => rt.id === focusedRoomTypeId)?.name ?? "this room type"}.`
              : "Hotel photos, room types, facilities, and albums."}
          </p>
        </div>
        <div className="flex gap-2">
          {canCreate && !focusedRoomTypeId && (
            <AlbumDialog
              propertyId={propertyId}
              onDone={() => qc.invalidateQueries({ queryKey: ["gallery-albums", propertyId] })}
            />
          )}
          {canCreate && propertyId && (
            <GalleryUploadDialog
              propertyId={propertyId}
              lockedContext={focusedRoomTypeId ? "room_type" : undefined}
              lockedRoomTypeId={focusedRoomTypeId ?? undefined}
              roomTypes={roomTypeOptions}
              albums={albumOptions}
              onDone={invalidateImages}
              trigger={
                <Button type="button">
                  <Plus className="mr-1 h-4 w-4" /> Upload photos
                </Button>
              }
            />
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-3" hidden={!!focusedRoomTypeId}>
        <Select
          value={contextFilter}
          onValueChange={(v) => setContextFilter(v as GalleryContext | "all")}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {GALLERY_CONTEXTS.map((c) => (
              <SelectItem key={c} value={c}>
                {GALLERY_CONTEXT_LABELS[c]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={albumFilter} onValueChange={setAlbumFilter}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All albums</SelectItem>
            {albumOptions.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {albumOptions.length > 0 && !focusedRoomTypeId && (
        <div className="flex flex-wrap gap-2">
          {(albumsQuery.data ?? []).map((a) => (
            <AlbumChip
              key={a.id}
              album={a}
              propertyId={propertyId}
              canEdit={canEdit}
              canDelete={canDelete}
              onChanged={() => qc.invalidateQueries({ queryKey: ["gallery-albums", propertyId] })}
            />
          ))}
        </div>
      )}

      {imagesQuery.isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
      {!imagesQuery.isLoading && rows.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed p-12 text-center text-muted-foreground">
          <Images className="h-8 w-8" />
          <div className="text-sm">No photos yet.</div>
        </div>
      )}

      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
        data-testid="gallery-grid"
      >
        {rows.map((image) => (
          <GalleryImageCard
            key={image.id}
            image={image}
            canEdit={canEdit}
            canDelete={canDelete}
            draggable={canEdit}
            onDragStart={() => setDragId(image.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => handleReorderDrop(image.id)}
            onSaveMeta={async ({ title, caption }) => {
              if (!propertyId) return;
              try {
                await updateMetaFn({ data: { propertyId, imageId: image.id, title, caption } });
                invalidateImages();
                toast.success("Saved");
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Could not save");
              }
            }}
            onToggleActive={async () => {
              if (!propertyId) return;
              try {
                await updateMetaFn({
                  data: { propertyId, imageId: image.id, active: !image.active },
                });
                invalidateImages();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Could not update visibility");
              }
            }}
            onSetCover={
              image.room_type_id
                ? async () => {
                    if (!propertyId || !image.room_type_id) return;
                    try {
                      await setCoverFn({
                        data: { propertyId, roomTypeId: image.room_type_id, imageId: image.id },
                      });
                      invalidateImages();
                      toast.success("Cover image updated");
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : "Could not set cover");
                    }
                  }
                : undefined
            }
            onDelete={async () => {
              if (!propertyId) return;
              try {
                await deleteFn({ data: { propertyId, imageId: image.id } });
                invalidateImages();
                toast.success("Deleted");
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Could not delete");
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}

function AlbumDialog({
  propertyId,
  existing,
  trigger,
  onDone,
}: {
  propertyId: string | null;
  existing?: { id: string; name: string; description: string | null };
  trigger?: React.ReactNode;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const createFn = useServerFn(createGalleryAlbum);
  const updateFn = useServerFn(updateGalleryAlbum);

  async function save() {
    if (!propertyId || !name.trim()) return;
    try {
      if (existing) {
        await updateFn({ data: { propertyId, albumId: existing.id, name, description } });
      } else {
        await createFn({ data: { propertyId, name, description } });
      }
      toast.success("Saved");
      setOpen(false);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save album");
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button type="button" variant="outline">
            <FolderPlus className="mr-1 h-4 w-4" /> New album
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? "Edit" : "New"} album</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={150} />
          </div>
          <div>
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" onClick={save} disabled={!name.trim()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AlbumChip({
  album,
  propertyId,
  canEdit,
  canDelete,
  onChanged,
}: {
  album: { id: string; name: string; description: string | null };
  propertyId: string | null;
  canEdit: boolean;
  canDelete: boolean;
  onChanged: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const deleteFn = useServerFn(deleteGalleryAlbum);

  async function handleDelete() {
    if (!propertyId) return;
    try {
      await deleteFn({ data: { propertyId, albumId: album.id } });
      toast.success("Album deleted");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete album");
    }
  }

  return (
    <div className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-3 py-1 text-xs">
      <span>{album.name}</span>
      {canEdit && (
        <AlbumDialog
          propertyId={propertyId}
          existing={album}
          trigger={
            <button type="button" className="text-muted-foreground hover:text-foreground">
              <Pencil className="h-3 w-3" />
            </button>
          }
          onDone={onChanged}
        />
      )}
      {canDelete && (
        <>
          <button
            type="button"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 className="h-3 w-3" />
          </button>
          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete album "{album.name}"?</AlertDialogTitle>
                <AlertDialogDescription>
                  Photos in this album are kept and simply become unalbumed. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
}
