import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ImagePlus, Loader2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { usePermission } from "@/hooks/use-permission";
import { PRODUCT_IMAGE_PERMISSIONS, PRODUCT_MANAGEMENT_ROLES } from "@/lib/inventory/permissions";
import { PRODUCT_IMAGE_MIME_TYPES, MAX_PRODUCT_IMAGE_BYTES, type ProductImageBackground } from "@/lib/inventory/domain";
import {
  applyProductImage,
  createProductImageUploadTicket,
  generateProductImage,
  getProductImageUrl,
} from "@/lib/inventory/product-images.functions";

export type ProductImageSelection = { path: string; source: "upload" | "ai" } | null;

interface Props {
  propertyId: string;
  itemId?: string | null;
  initialImagePath?: string | null;
  productName?: string;
  description?: string;
  category?: string;
  color?: string;
  onChange: (selection: ProductImageSelection) => void;
}

const BACKGROUND_LABELS: Record<ProductImageBackground, string> = {
  studio: "Studio (opaque)",
  lifestyle: "Lifestyle (opaque)",
  transparent: "Transparent",
};

function buildDefaultPrompt(input: {
  productName?: string;
  description?: string;
  category?: string;
  color?: string;
}): string {
  const subject = input.productName ? `a ${input.productName}` : "the product";
  const parts = [`Professional ecommerce product photograph of ${subject}`];
  if (input.color) parts.push(`in ${input.color}`);
  if (input.category) parts.push(`(${input.category})`);
  parts.push("centered on a clean studio background, realistic texture, soft commercial lighting");
  if (input.description) parts.push(`Details: ${input.description}`);
  return parts.join(", ") + ".";
}

export function ProductImageField({
  propertyId,
  itemId,
  initialImagePath,
  productName,
  description,
  category,
  color,
  onChange,
}: Props) {
  const ticketFn = useServerFn(createProductImageUploadTicket);
  const generateFn = useServerFn(generateProductImage);
  const applyFn = useServerFn(applyProductImage);
  const previewUrlFn = useServerFn(getProductImageUrl);

  const { allowed: canManageImages, loading: permissionLoading } = usePermission({
    propertyId,
    ...PRODUCT_IMAGE_PERMISSIONS.imagesCreate,
    defaultRoles: PRODUCT_MANAGEMENT_ROLES,
  });

  const [selected, setSelected] = useState<{ path: string; source: "upload" | "ai" } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const [aiOpen, setAiOpen] = useState(false);
  const [prompt, setPrompt] = useState(() => buildDefaultPrompt({ productName, description, category, color }));
  const [background, setBackground] = useState<ProductImageBackground>("studio");
  const [generating, setGenerating] = useState(false);
  const [aiPreview, setAiPreview] = useState<{ path: string; previewUrl: string } | null>(null);
  const [applying, setApplying] = useState(false);

  // Existing saved image (edit mode): resolve a signed preview URL once.
  useEffect(() => {
    let cancelled = false;
    if (!initialImagePath) return;
    previewUrlFn({ data: { propertyId, storagePath: initialImagePath } })
      .then((res) => {
        if (cancelled) return;
        setPreviewUrl(res.url);
      })
      .catch(() => {
        if (!cancelled) toast.error("Could not load the current product image");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialImagePath, propertyId]);

  async function handleFileSelected(file: File) {
    if (!PRODUCT_IMAGE_MIME_TYPES.includes(file.type as (typeof PRODUCT_IMAGE_MIME_TYPES)[number])) {
      toast.error("Unsupported image file type");
      return;
    }
    if (file.size <= 0 || file.size > MAX_PRODUCT_IMAGE_BYTES) {
      toast.error("Image must be 8 MB or smaller");
      return;
    }
    setUploading(true);
    try {
      const ticket = await ticketFn({
        data: {
          propertyId,
          itemId: itemId ?? undefined,
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
        },
      });
      const stored = await supabase.storage
        .from(ticket.bucket)
        .upload(ticket.storagePath, file, { contentType: file.type, upsert: false });
      if (stored.error) throw stored.error;

      const objectUrl = URL.createObjectURL(file);
      setSelected({ path: ticket.storagePath, source: "upload" });
      setPreviewUrl(objectUrl);
      onChange({ path: ticket.storagePath, source: "upload" });
      toast.success("Image uploaded — remember to save the product");
    } catch (err: any) {
      toast.error(err?.message ?? "Could not upload image");
    } finally {
      setUploading(false);
    }
  }

  async function handleGenerate() {
    setGenerating(true);
    try {
      const result = await generateFn({
        data: {
          propertyId,
          itemId: itemId ?? undefined,
          productName,
          description,
          category,
          color,
          prompt,
          background,
        },
      });
      setAiPreview({ path: result.storagePath, previewUrl: result.previewUrl });
    } catch (err: any) {
      toast.error(err?.message ?? "This image could not be generated. Please adjust the description and try again.");
    } finally {
      setGenerating(false);
    }
  }

  async function handleUseImage() {
    if (!aiPreview) return;
    setApplying(true);
    try {
      await applyFn({
        data: { propertyId, itemId: itemId ?? undefined, storagePath: aiPreview.path, source: "ai" },
      });
      setSelected({ path: aiPreview.path, source: "ai" });
      setPreviewUrl(aiPreview.previewUrl);
      onChange({ path: aiPreview.path, source: "ai" });
      setAiPreview(null);
      setAiOpen(false);
      toast.success("AI image selected — remember to save the product");
    } catch (err: any) {
      toast.error(err?.message ?? "Could not apply the generated image");
    } finally {
      setApplying(false);
    }
  }

  function handleCancelAi() {
    setAiPreview(null);
    setAiOpen(false);
  }

  const displayImage = aiPreview?.previewUrl ?? previewUrl;

  return (
    <div className="space-y-2">
      <Label>Product Image</Label>
      <div className="flex items-center gap-3">
        <div className="h-20 w-20 shrink-0 overflow-hidden rounded-md border bg-muted flex items-center justify-center">
          {displayImage ? (
            <img src={displayImage} alt="Product" className="h-full w-full object-cover" />
          ) : (
            <ImagePlus className="h-6 w-6 text-muted-foreground" />
          )}
        </div>
        {!permissionLoading && canManageImages ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-2">
              <label>
                <Button type="button" size="sm" variant="outline" disabled={uploading} asChild>
                  <span>
                    {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    Upload Image
                  </span>
                </Button>
                <input
                  type="file"
                  accept={PRODUCT_IMAGE_MIME_TYPES.join(",")}
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFileSelected(file);
                    e.target.value = "";
                  }}
                />
              </label>
              <Button type="button" size="sm" variant="outline" onClick={() => setAiOpen((v) => !v)}>
                <Sparkles className="h-3.5 w-3.5" />
                Generate with AI
              </Button>
            </div>
            {selected ? (
              <span className="text-xs text-muted-foreground">
                Selected via {selected.source === "ai" ? "AI generation" : "upload"} — not saved yet
              </span>
            ) : null}
          </div>
        ) : !permissionLoading ? (
          <span className="text-xs text-muted-foreground">You do not have permission to change the product image.</span>
        ) : null}
      </div>

      {aiOpen ? (
        <div className="rounded-md border p-3 space-y-3 bg-muted/30">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Generate with AI</span>
            <Button type="button" size="icon" variant="ghost" className="h-6 w-6" onClick={handleCancelAi}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>

          {!aiPreview ? (
            <>
              <div className="space-y-1">
                <Label className="text-xs">Prompt</Label>
                <Textarea
                  rows={3}
                  value={prompt}
                  maxLength={800}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Describe the product image to generate"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Background</Label>
                <Select value={background} onValueChange={(v) => setBackground(v as ProductImageBackground)}>
                  <SelectTrigger className="h-8 w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(BACKGROUND_LABELS) as ProductImageBackground[]).map((bg) => (
                      <SelectItem key={bg} value={bg}>
                        {BACKGROUND_LABELS[bg]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" size="sm" variant="outline" onClick={handleCancelAi}>
                  Cancel
                </Button>
                <Button type="button" size="sm" onClick={handleGenerate} disabled={generating || prompt.trim().length < 3}>
                  {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Generate
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="h-40 w-40 overflow-hidden rounded-md border">
                <img src={aiPreview.previewUrl} alt="Generated preview" className="h-full w-full object-cover" />
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" size="sm" variant="outline" onClick={handleCancelAi}>
                  Cancel
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={handleGenerate} disabled={generating}>
                  {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Regenerate
                </Button>
                <Button type="button" size="sm" onClick={handleUseImage} disabled={applying}>
                  {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Use Image
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
