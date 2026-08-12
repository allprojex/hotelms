import OpenAI from "openai";
import type { ProductImageBackground } from "@/lib/inventory/domain";

/**
 * Single server-side configuration point for product image generation.
 * gpt-image-2 is the current default model but does not support transparent
 * backgrounds; gpt-image-1 is used only for that case. Nothing here is ever
 * sent to the browser.
 */
const PRODUCT_IMAGE_MODEL_CONFIG = {
  opaqueModel: "gpt-image-2",
  transparentModel: "gpt-image-1",
  size: "1024x1024" as const,
  quality: "medium" as const,
  defaultFormat: "webp" as const,
  transparentFormat: "png" as const,
};

const QUALITY_SUFFIX =
  "Professional ecommerce product photograph, centered composition, realistic materials and lighting, " +
  "suitable for a product catalogue. No text, no watermark, no logos, no props unrelated to the product.";

let client: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("AI image generation is not configured");
  }
  if (!client) {
    client = new OpenAI({ apiKey });
  }
  return client;
}

export function buildProductImagePrompt(input: {
  prompt: string;
  productName?: string | null;
  category?: string | null;
  color?: string | null;
}): string {
  const context = [
    input.productName ? `Product: ${input.productName}.` : null,
    input.category ? `Category: ${input.category}.` : null,
    input.color ? `Colour: ${input.color}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return [input.prompt, context, QUALITY_SUFFIX].filter(Boolean).join(" ").slice(0, 4000);
}

export type GeneratedProductImage = {
  bytes: Buffer;
  contentType: string;
  extension: "webp" | "png";
};

/**
 * Calls OpenAI to generate exactly one image for the given prompt. Never
 * retries automatically — one call in, one billable request out. Errors are
 * normalized to safe, user-facing messages; no OpenAI headers, error bodies,
 * or the API key are ever exposed to the caller.
 */
export async function generateProductImageBytes(input: {
  prompt: string;
  background: ProductImageBackground;
}): Promise<GeneratedProductImage> {
  const transparent = input.background === "transparent";
  const model = transparent
    ? PRODUCT_IMAGE_MODEL_CONFIG.transparentModel
    : PRODUCT_IMAGE_MODEL_CONFIG.opaqueModel;
  const outputFormat = transparent
    ? PRODUCT_IMAGE_MODEL_CONFIG.transparentFormat
    : PRODUCT_IMAGE_MODEL_CONFIG.defaultFormat;

  const openai = getOpenAIClient();

  let response: OpenAI.Images.ImagesResponse;
  try {
    response = await openai.images.generate({
      model,
      prompt: input.prompt,
      size: PRODUCT_IMAGE_MODEL_CONFIG.size,
      quality: PRODUCT_IMAGE_MODEL_CONFIG.quality,
      background: transparent ? "transparent" : "opaque",
      output_format: outputFormat,
      n: 1,
    });
  } catch (error) {
    throw new Error(mapGenerationError(error));
  }

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("This image could not be generated. Please adjust the description and try again.");
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64, "base64");
  } catch {
    throw new Error("The generated image could not be processed. Please try again.");
  }
  if (bytes.length === 0) {
    throw new Error("The generated image could not be processed. Please try again.");
  }

  return {
    bytes,
    contentType: `image/${outputFormat}`,
    extension: outputFormat,
  };
}

function mapGenerationError(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  if (status === 400 || status === 422) {
    return "This image could not be generated. Please adjust the description and try again.";
  }
  if (status === 429) {
    return "Image generation is temporarily rate-limited. Please wait a moment and try again.";
  }
  if (status !== undefined && status >= 500) {
    return "The image generation service is temporarily unavailable. Please try again shortly.";
  }
  return "Image generation failed. Please try again.";
}
