import { useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type LightboxImage = { id: string; url: string; title?: string | null };

interface Props {
  images: LightboxImage[];
  startIndex: number;
  onClose: () => void;
}

export function GalleryLightbox({ images, startIndex, onClose }: Props) {
  const [index, setIndex] = useState(startIndex);
  const current = images[index];
  if (!current) return null;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl bg-background/95 p-0">
        <div className="relative flex items-center justify-center">
          <img
            src={current.url}
            alt={current.title ?? ""}
            className="max-h-[80vh] w-full object-contain"
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="absolute right-2 top-2"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
          {images.length > 1 && (
            <>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="absolute left-2 top-1/2 -translate-y-1/2"
                onClick={() => setIndex((i) => (i - 1 + images.length) % images.length)}
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="absolute right-2 top-1/2 -translate-y-1/2"
                onClick={() => setIndex((i) => (i + 1) % images.length)}
              >
                <ChevronRight className="h-5 w-5" />
              </Button>
            </>
          )}
        </div>
        {current.title && (
          <div className="p-3 text-center text-sm text-muted-foreground">{current.title}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}
