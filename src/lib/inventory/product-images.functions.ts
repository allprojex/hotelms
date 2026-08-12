import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertServerPermission } from "@/lib/permissions.server";
import { captureAuditEvent } from "@/lib/audit.server";
import { PRODUCT_IMAGE_PERMISSIONS, PRODUCT_MANAGEMENT_ROLES } from "@/lib/inventory/permissions";
import {
  uuid,
  optionalUuid,
  optionalShortText,
  validateBackground,
  validateProductImageFile,
  sanitizeProductImagePrompt,
  productImageStoragePath,
} from "@/lib/inventory/domain";
import { buildProductImagePrompt, generateProductImageBytes } from "@/lib/inventory/product-image-ai.server";

const PRODUCT_IMAGES_BUCKET = "product-images";
const SIGNED_URL_TTL_SECONDS = 300;
const GENERATION_RATE_LIMIT_WINDOW_MS = 60_000;
const GENERATION_RATE_LIMIT_MAX = 6;

async function assertProductManagePermission(
  context: { userId: string; supabase: any },
  propertyId: string,
): Promise<void> {
  await assertServerPermission(context, {
    propertyId,
    ...PRODUCT_IMAGE_PERMISSIONS.imagesCreate,
    defaultRoles: PRODUCT_MANAGEMENT_ROLES,
  });
}

async function assertProductImageOwnership(
  context: { supabase: any },
  itemId: string,
  propertyId: string,
): Promise<void> {
  const { data: item, error } = await context.supabase
    .from("inventory_items")
    .select("id,property_id")
    .eq("id", itemId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!item || item.property_id !== propertyId) throw new Error("Product not found");
}

/** Cost control only — never the authorization gate. Fails open on read errors. */
async function checkGenerationRateLimit(context: { userId: string; supabase: any }): Promise<void> {
  const since = new Date(Date.now() - GENERATION_RATE_LIMIT_WINDOW_MS).toISOString();
  const result = await context.supabase
    .from("admin_action_logs")
    .select("id", { count: "exact", head: true })
    .eq("actor_id", context.userId)
    .eq("action", "product_image.generated")
    .gte("created_at", since);
  if (result.error) return;
  if ((result.count ?? 0) >= GENERATION_RATE_LIMIT_MAX) {
    throw new Error("Too many image generation requests. Please wait a moment and try again.");
  }
}

export const createProductImageUploadTicket = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      propertyId: string;
      itemId?: string;
      fileName: string;
      fileType: string;
      fileSize: number;
    }) => ({
      propertyId: uuid(d.propertyId),
      itemId: optionalUuid(d.itemId),
      fileName: String(d.fileName ?? ""),
      fileType: String(d.fileType ?? ""),
      fileSize: Number(d.fileSize),
    }),
  )
  .handler(async ({ data, context }) => {
    validateProductImageFile({ type: data.fileType, size: data.fileSize });
    await assertProductManagePermission(context, data.propertyId);
    if (data.itemId) {
      await assertProductImageOwnership(context, data.itemId, data.propertyId);
    }
    const imageId = crypto.randomUUID();
    const itemId = data.itemId ?? crypto.randomUUID();
    return {
      bucket: PRODUCT_IMAGES_BUCKET,
      storagePath: productImageStoragePath({
        propertyId: data.propertyId,
        itemId,
        imageId,
        fileName: data.fileName,
      }),
    };
  });

export const generateProductImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      propertyId: string;
      itemId?: string;
      productName?: string;
      description?: string;
      category?: string;
      color?: string;
      prompt: string;
      background?: string;
    }) => ({
      propertyId: uuid(d.propertyId),
      itemId: optionalUuid(d.itemId),
      productName: optionalShortText(d.productName, 120),
      description: optionalShortText(d.description, 300),
      category: optionalShortText(d.category, 80),
      color: optionalShortText(d.color, 40),
      prompt: sanitizeProductImagePrompt(d.prompt),
      background: validateBackground(d.background),
    }),
  )
  .handler(async ({ data, context }) => {
    if (data.itemId) {
      await assertProductImageOwnership(context, data.itemId, data.propertyId);
    }
    await assertProductManagePermission(context, data.propertyId);
    await checkGenerationRateLimit(context);

    const finalPrompt = buildProductImagePrompt({
      prompt: data.prompt,
      productName: data.productName,
      category: data.category,
      color: data.color,
    });

    const generated = await generateProductImageBytes({
      prompt: finalPrompt,
      background: data.background,
    });

    const itemId = data.itemId ?? crypto.randomUUID();
    const storagePath = productImageStoragePath({
      propertyId: data.propertyId,
      itemId,
      imageId: crypto.randomUUID(),
      fileName: `ai-generated.${generated.extension}`,
    });

    const uploaded = await context.supabase.storage
      .from(PRODUCT_IMAGES_BUCKET)
      .upload(storagePath, generated.bytes, { contentType: generated.contentType, upsert: false });
    if (uploaded.error) {
      throw new Error("Could not save the generated image. Please try again.");
    }

    const signed = await context.supabase.storage
      .from(PRODUCT_IMAGES_BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
    if (signed.error) {
      throw new Error("Could not preview the generated image. Please try again.");
    }

    // Prompt text is stored truncated and only as a memo; no base64 or OpenAI
    // response data is ever written to the audit log.
    await captureAuditEvent(context, {
      propertyId: data.propertyId,
      sourceModule: "inventory",
      action: "product_image.generated",
      resourceType: "inventory_item",
      resourceId: data.itemId ?? null,
      newValues: { storagePath, background: data.background },
      memo: data.prompt.slice(0, 200),
    });

    return { storagePath, previewUrl: signed.data.signedUrl as string, background: data.background };
  });

export const applyProductImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { propertyId: string; itemId?: string; storagePath: string; source: string }) => ({
      propertyId: uuid(d.propertyId),
      itemId: optionalUuid(d.itemId),
      storagePath: String(d.storagePath ?? ""),
      source: d.source === "ai" ? "ai" : "upload",
    }),
  )
  .handler(async ({ data, context }) => {
    await assertProductManagePermission(context, data.propertyId);
    if (!data.storagePath.startsWith(`${data.propertyId}/`) || data.storagePath.includes("..")) {
      throw new Error("Invalid image reference");
    }
    // Audit only: this does not persist to inventory_items. The product form
    // still requires an explicit Save/Update through the normal product
    // workflow before the image is attached to the product record.
    await captureAuditEvent(context, {
      propertyId: data.propertyId,
      sourceModule: "inventory",
      action: "product_image.applied",
      resourceType: "inventory_item",
      resourceId: data.itemId ?? null,
      newValues: { storagePath: data.storagePath, source: data.source },
    });
    return { ok: true };
  });

export const getProductImageUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; storagePath: string }) => ({
    propertyId: uuid(d.propertyId),
    storagePath: String(d.storagePath ?? ""),
  }))
  .handler(async ({ data, context }) => {
    await assertServerPermission(context, {
      propertyId: data.propertyId,
      ...PRODUCT_IMAGE_PERMISSIONS.imagesView,
      defaultRoles: PRODUCT_MANAGEMENT_ROLES,
    });
    if (!data.storagePath.startsWith(`${data.propertyId}/`) || data.storagePath.includes("..")) {
      throw new Error("Invalid image reference");
    }
    const signed = await context.supabase.storage
      .from(PRODUCT_IMAGES_BUCKET)
      .createSignedUrl(data.storagePath, SIGNED_URL_TTL_SECONDS);
    if (signed.error) throw new Error(signed.error.message);
    return { url: signed.data.signedUrl as string };
  });
