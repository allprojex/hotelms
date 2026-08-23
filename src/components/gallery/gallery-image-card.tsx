import { useState } from "react";
import { GripVertical, Pencil, Star, Trash2, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { galleryPublicUrl } from "@/lib/gallery/public-url";
import { GALLERY_CONTEXT_LABELS, type GalleryContext } from "@/lib/gallery/domain";

export type GalleryImageRow = {
  id: string;
  title: string | null;
  caption: string | null;
  context: GalleryContext;
  thumbnail_path: string;
  is_cover: boolean;
  active: boolean;
  room_type_id: string | null;
};

interface Props {
  image: GalleryImageRow;
  canEdit: boolean;
  canDelete: boolean;
  onSaveMeta: (input: { title: string; caption: string }) => Promise<void>;
  onToggleActive: () => Promise<void>;
  onSetCover?: () => Promise<void>;
  onDelete: () => Promise<void>;
  draggable?: boolean;
  onDragStart?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: () => void;
}

export function GalleryImageCard({
  image,
  canEdit,
  canDelete,
  onSaveMeta,
  onToggleActive,
  onSetCover,
  onDelete,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
}: Props) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [title, setTitle] = useState(image.title ?? "");
  const [caption, setCaption] = useState(image.caption ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await onSaveMeta({ title, caption });
      setEditOpen(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      data-testid="gallery-image-card"
      data-image-id={image.id}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className="group relative overflow-hidden rounded-md border bg-card"
    >
      <div className="relative aspect-square bg-muted">
        <img
          src={galleryPublicUrl(image.thumbnail_path)}
          alt={image.title ?? ""}
          className="h-full w-full object-cover"
          loading="lazy"
        />
        {draggable && (
          <div className="absolute left-1 top-1 rounded bg-background/80 p-0.5">
            <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
        )}
        {image.is_cover && (
          <Badge className="absolute right-1 top-1" variant="secondary">
            <Star className="mr-1 h-3 w-3" /> Cover
          </Badge>
        )}
        {!image.active && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60">
            <Badge variant="outline">Hidden</Badge>
          </div>
        )}
      </div>
      <div className="p-2 space-y-1">
        <div className="truncate text-xs font-medium">{image.title || "Untitled"}</div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {GALLERY_CONTEXT_LABELS[image.context]}
        </div>
      </div>

      {(canEdit || canDelete) && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-end gap-1 bg-background/90 p-1 opacity-0 transition-opacity group-hover:opacity-100">
          {canEdit && onSetCover && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              title="Set as cover"
              onClick={() => onSetCover()}
            >
              <Star className="h-3.5 w-3.5" />
            </Button>
          )}
          {canEdit && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              title={image.active ? "Hide" : "Show"}
              onClick={() => onToggleActive()}
            >
              {image.active ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </Button>
          )}
          {canEdit && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              title="Edit"
              onClick={() => setEditOpen(true)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          {canDelete && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-destructive"
              title="Delete"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      )}

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit photo</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Title</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={150} />
            </div>
            <div>
              <Label>Caption</Label>
              <Textarea
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                maxLength={500}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" onClick={handleSave} disabled={saving}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this photo?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the image and its file permanently. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => onDelete()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
