import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { UploadCloud, X, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import {
  GALLERY_CONTEXTS,
  GALLERY_CONTEXT_LABELS,
  GALLERY_IMAGE_MIME_TYPES,
  MAX_GALLERY_IMAGE_BYTES,
  type GalleryContext,
} from "@/lib/gallery/domain";
import { prepareGalleryImageVariants } from "@/lib/gallery/image-resize";
import { createGalleryUploadTicket, confirmGalleryImage } from "@/lib/gallery/gallery.functions";

type QueueItem = {
  id: string;
  file: File;
  title: string;
  status: "pending" | "processing" | "uploading" | "done" | "error";
  error?: string;
};

type RoomTypeOption = { id: string; name: string };
type AlbumOption = { id: string; name: string };

interface Props {
  propertyId: string;
  /** Locks the context selector — used when opened from a room type's own photo manager. */
  lockedContext?: GalleryContext;
  lockedRoomTypeId?: string;
  roomTypes: RoomTypeOption[];
  albums: AlbumOption[];
  onDone: () => void;
  trigger: React.ReactNode;
}

export function GalleryUploadDialog({
  propertyId,
  lockedContext,
  lockedRoomTypeId,
  roomTypes,
  albums,
  onDone,
  trigger,
}: Props) {
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<GalleryContext>(lockedContext ?? "hotel");
  const [roomTypeId, setRoomTypeId] = useState<string>(lockedRoomTypeId ?? "");
  const [albumId, setAlbumId] = useState<string>("");
  const [items, setItems] = useState<QueueItem[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const ticketFn = useServerFn(createGalleryUploadTicket);
  const confirmFn = useServerFn(confirmGalleryImage);

  function reset() {
    setItems([]);
    setContext(lockedContext ?? "hotel");
    setRoomTypeId(lockedRoomTypeId ?? "");
    setAlbumId("");
  }

  function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    const accepted: QueueItem[] = [];
    for (const file of files) {
      if (
        !GALLERY_IMAGE_MIME_TYPES.includes(file.type as (typeof GALLERY_IMAGE_MIME_TYPES)[number])
      ) {
        toast.error(`${file.name}: unsupported file type`);
        continue;
      }
      if (file.size <= 0 || file.size > MAX_GALLERY_IMAGE_BYTES) {
        toast.error(`${file.name}: must be 8 MB or smaller`);
        continue;
      }
      accepted.push({
        id: crypto.randomUUID(),
        file,
        title: file.name.replace(/\.[^./]+$/, ""),
        status: "pending",
      });
    }
    if (accepted.length) setItems((prev) => [...prev, ...accepted]);
  }

  function updateItem(id: string, patch: Partial<QueueItem>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  async function uploadOne(item: QueueItem) {
    updateItem(item.id, { status: "processing" });
    try {
      const { optimized, thumbnail } = await prepareGalleryImageVariants(item.file);
      const ticket = await ticketFn({
        data: {
          propertyId,
          fileName: item.file.name,
          fileType: item.file.type,
          fileSize: item.file.size,
        },
      });

      updateItem(item.id, { status: "uploading" });
      const [fullUpload, thumbUpload] = await Promise.all([
        supabase.storage
          .from(ticket.bucket)
          .upload(ticket.storagePath, optimized.blob, { contentType: "image/webp", upsert: false }),
        supabase.storage.from(ticket.bucket).upload(ticket.thumbnailPath, thumbnail.blob, {
          contentType: "image/webp",
          upsert: false,
        }),
      ]);
      if (fullUpload.error) throw fullUpload.error;
      if (thumbUpload.error) throw thumbUpload.error;

      await confirmFn({
        data: {
          propertyId,
          storagePath: ticket.storagePath,
          thumbnailPath: ticket.thumbnailPath,
          context,
          albumId: albumId || undefined,
          roomTypeId: context === "room_type" ? roomTypeId : undefined,
          title: item.title,
        },
      });
      updateItem(item.id, { status: "done" });
    } catch (err) {
      updateItem(item.id, {
        status: "error",
        error: err instanceof Error ? err.message : "Upload failed",
      });
    }
  }

  async function handleUploadAll() {
    if (context === "room_type" && !roomTypeId) {
      toast.error("Select a room type for room-type photos");
      return;
    }
    const pending = items.filter((it) => it.status === "pending" || it.status === "error");
    if (!pending.length) return;
    setSubmitting(true);
    // Sequential, not parallel: each item already runs two concurrent
    // storage uploads internally, and this keeps memory/network pressure
    // bounded for a genuinely large bulk selection rather than decoding and
    // holding dozens of full-resolution canvases at once.
    for (const item of pending) {
      await uploadOne(item);
    }
    setSubmitting(false);
    const anyError = items.some((it) => it.status === "error");
    if (!anyError) {
      toast.success("Upload complete");
      onDone();
      setOpen(false);
      reset();
    } else {
      toast.error("Some images failed — fix and retry the failed ones");
      onDone();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <div onClick={() => setOpen(true)}>{trigger}</div>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Upload photos</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Category</Label>
            <Select
              value={context}
              onValueChange={(v) => setContext(v as GalleryContext)}
              disabled={!!lockedContext}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GALLERY_CONTEXTS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {GALLERY_CONTEXT_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {context === "room_type" ? (
            <div>
              <Label>Room type</Label>
              <Select
                value={roomTypeId}
                onValueChange={setRoomTypeId}
                disabled={!!lockedRoomTypeId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a room type…" />
                </SelectTrigger>
                <SelectContent>
                  {roomTypes.map((rt) => (
                    <SelectItem key={rt.id} value={rt.id}>
                      {rt.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div>
              <Label>Album (optional)</Label>
              <Select
                value={albumId || "__none"}
                onValueChange={(v) => setAlbumId(v === "__none" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="No album" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">No album</SelectItem>
                  {albums.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <div
          data-testid="gallery-dropzone"
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
            if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-8 text-center transition-colors ${
            dragActive ? "border-primary bg-primary/5" : "border-muted-foreground/25"
          }`}
        >
          <UploadCloud className="h-8 w-8 text-muted-foreground" />
          <div className="text-sm font-medium">
            Drag and drop photos here, or click to choose files
          </div>
          <div className="text-xs text-muted-foreground">
            JPEG, PNG, or WebP · up to 8 MB each · multiple files supported
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={GALLERY_IMAGE_MIME_TYPES.join(",")}
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        {items.length > 0 && (
          <div className="max-h-60 space-y-2 overflow-y-auto">
            {items.map((item) => (
              <div key={item.id} className="flex items-center gap-3 rounded-md border p-2">
                <div className="h-10 w-10 shrink-0 overflow-hidden rounded bg-muted">
                  <img
                    src={URL.createObjectURL(item.file)}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                </div>
                <Input
                  value={item.title}
                  onChange={(e) => updateItem(item.id, { title: e.target.value })}
                  placeholder="Title"
                  className="h-8 flex-1"
                  disabled={
                    item.status === "uploading" ||
                    item.status === "processing" ||
                    item.status === "done"
                  }
                />
                <div className="w-24 shrink-0 text-right text-xs">
                  {item.status === "pending" && (
                    <span className="text-muted-foreground">Ready</span>
                  )}
                  {(item.status === "processing" || item.status === "uploading") && (
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />{" "}
                      {item.status === "processing" ? "Optimizing" : "Uploading"}
                    </span>
                  )}
                  {item.status === "done" && (
                    <span className="inline-flex items-center gap-1 text-green-600">
                      <CheckCircle2 className="h-3 w-3" /> Done
                    </span>
                  )}
                  {item.status === "error" && (
                    <span
                      className="inline-flex items-center gap-1 text-destructive"
                      title={item.error}
                    >
                      <AlertCircle className="h-3 w-3" /> Failed
                    </span>
                  )}
                </div>
                {item.status !== "uploading" && item.status !== "processing" && (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0"
                    onClick={() => setItems((prev) => prev.filter((it) => it.id !== item.id))}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            onClick={handleUploadAll}
            disabled={submitting || items.every((it) => it.status === "done")}
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
            Upload{" "}
            {items.filter((it) => it.status === "pending" || it.status === "error").length || ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
