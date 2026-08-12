import { beforeEach, describe, expect, it, vi } from "vitest";

const generateMock = vi.hoisted(() => vi.fn());

vi.mock("openai", () => {
  class MockOpenAI {
    images = { generate: generateMock };
  }
  return { default: MockOpenAI };
});

import {
  buildProductImagePrompt,
  generateProductImageBytes,
} from "@/lib/inventory/product-image-ai.server";
import {
  MAX_PRODUCT_IMAGE_PROMPT_LENGTH,
  productImageStoragePath,
  sanitizeProductImagePrompt,
  uuid,
  validateBackground,
  validateProductImageFile,
} from "@/lib/inventory/domain";

const PROPERTY_ID = "00000000-0000-4000-8000-00000000000a";
const ITEM_ID = "00000000-0000-4000-8000-00000000000b";

function b64ImagePayload(text = "fake-image-bytes") {
  return Buffer.from(text, "utf8").toString("base64");
}

describe("product image AI module — successful mocked generation", () => {
  beforeEach(() => {
    generateMock.mockReset();
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  });

  it("decodes the OpenAI base64 response into real bytes with the requested content type", async () => {
    const payload = b64ImagePayload("hello product photo");
    generateMock.mockResolvedValueOnce({ data: [{ b64_json: payload }] });

    const result = await generateProductImageBytes({ prompt: "a red mug", background: "studio" });

    expect(result.bytes.toString("utf8")).toBe("hello product photo");
    expect(result.contentType).toBe("image/webp");
    expect(result.extension).toBe("webp");
  });

  it("issues exactly one OpenAI request per call — no automatic retries", async () => {
    generateMock.mockResolvedValueOnce({ data: [{ b64_json: b64ImagePayload() }] });
    await generateProductImageBytes({ prompt: "a red mug", background: "studio" });
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("uses gpt-image-2 with an opaque background for studio/lifestyle requests", async () => {
    generateMock.mockResolvedValueOnce({ data: [{ b64_json: b64ImagePayload() }] });
    await generateProductImageBytes({ prompt: "a red mug", background: "studio" });
    const call = generateMock.mock.calls[0][0];
    expect(call.model).toBe("gpt-image-2");
    expect(call.background).toBe("opaque");
    expect(call.output_format).toBe("webp");
  });

  it("falls back to gpt-image-1 with a PNG output only when transparent is requested, since gpt-image-2 does not support it", async () => {
    generateMock.mockResolvedValueOnce({ data: [{ b64_json: b64ImagePayload() }] });
    await generateProductImageBytes({ prompt: "a red mug", background: "transparent" });
    const call = generateMock.mock.calls[0][0];
    expect(call.model).toBe("gpt-image-1");
    expect(call.background).toBe("transparent");
    expect(call.output_format).toBe("png");
  });

  it("requests exactly one image", async () => {
    generateMock.mockResolvedValueOnce({ data: [{ b64_json: b64ImagePayload() }] });
    await generateProductImageBytes({ prompt: "a red mug", background: "studio" });
    expect(generateMock.mock.calls[0][0].n).toBe(1);
  });
});

describe("product image AI module — failure handling", () => {
  beforeEach(() => {
    generateMock.mockReset();
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  });

  it("maps a missing API key to a safe error without leaking configuration details", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(generateProductImageBytes({ prompt: "x", background: "studio" })).rejects.toThrow(
      "AI image generation is not configured",
    );
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("maps an OpenAI 400/422 (content rejection) to the user-facing adjust-and-retry message", async () => {
    generateMock.mockRejectedValueOnce(Object.assign(new Error("content policy violation"), { status: 400 }));
    await expect(generateProductImageBytes({ prompt: "x", background: "studio" })).rejects.toThrow(
      "This image could not be generated. Please adjust the description and try again.",
    );
  });

  it("maps an OpenAI 429 to a rate-limit message", async () => {
    generateMock.mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }));
    await expect(generateProductImageBytes({ prompt: "x", background: "studio" })).rejects.toThrow(
      /temporarily rate-limited/,
    );
  });

  it("maps an OpenAI 5xx / timeout to a service-unavailable message", async () => {
    generateMock.mockRejectedValueOnce(Object.assign(new Error("upstream timeout"), { status: 503 }));
    await expect(generateProductImageBytes({ prompt: "x", background: "studio" })).rejects.toThrow(
      /temporarily unavailable/,
    );
  });

  it("never leaks the raw OpenAI error object/message to the caller", async () => {
    generateMock.mockRejectedValueOnce(
      Object.assign(new Error("secret upstream diagnostic detail, headers, trace id"), { status: 500 }),
    );
    await expect(generateProductImageBytes({ prompt: "x", background: "studio" })).rejects.not.toThrow(
      /secret upstream diagnostic/,
    );
  });

  it("handles a malformed response with no image data", async () => {
    generateMock.mockResolvedValueOnce({ data: [{}] });
    await expect(generateProductImageBytes({ prompt: "x", background: "studio" })).rejects.toThrow(
      "This image could not be generated. Please adjust the description and try again.",
    );
  });

  it("handles a response with an empty data array", async () => {
    generateMock.mockResolvedValueOnce({ data: [] });
    await expect(generateProductImageBytes({ prompt: "x", background: "studio" })).rejects.toThrow();
  });
});

describe("buildProductImagePrompt", () => {
  it("appends the fixed ecommerce quality suffix without dropping the user's own wording", () => {
    const prompt = buildProductImagePrompt({ prompt: "a navy blue bathrobe", productName: "Bathrobe" });
    expect(prompt).toContain("a navy blue bathrobe");
    expect(prompt).toContain("No text, no watermark");
  });

  it("never includes cost, supplier, or other unlisted fields since the function has no parameter for them", () => {
    const prompt = buildProductImagePrompt({ prompt: "a mug", productName: "Mug" });
    expect(prompt).not.toMatch(/cost|supplier|price/i);
  });
});

describe("product image domain validation", () => {
  it("rejects an empty prompt", () => {
    expect(() => sanitizeProductImagePrompt("")).toThrow();
  });

  it("rejects a whitespace-only prompt", () => {
    expect(() => sanitizeProductImagePrompt("    \n\t  ")).toThrow();
  });

  it("rejects an oversized prompt", () => {
    expect(() => sanitizeProductImagePrompt("a".repeat(MAX_PRODUCT_IMAGE_PROMPT_LENGTH + 1))).toThrow();
  });

  it("accepts and trims a normal prompt", () => {
    expect(sanitizeProductImagePrompt("  a red mug  ")).toBe("a red mug");
  });

  it("rejects a malformed product/item id", () => {
    expect(() => uuid("not-a-uuid")).toThrow();
  });

  it("accepts a well-formed uuid", () => {
    expect(uuid(ITEM_ID)).toBe(ITEM_ID);
  });

  it("rejects unsupported image mime types", () => {
    expect(() => validateProductImageFile({ type: "application/pdf", size: 1000 })).toThrow();
    expect(() => validateProductImageFile({ type: "image/gif", size: 1000 })).toThrow();
  });

  it("rejects an oversized or zero-byte image file", () => {
    expect(() => validateProductImageFile({ type: "image/png", size: 0 })).toThrow();
    expect(() => validateProductImageFile({ type: "image/png", size: 9 * 1024 * 1024 })).toThrow();
  });

  it("accepts a valid image file within bounds", () => {
    expect(() => validateProductImageFile({ type: "image/webp", size: 500_000 })).not.toThrow();
  });

  it("falls back to a safe default background for an unrecognized value", () => {
    expect(validateBackground("not-a-real-option")).toBe("studio");
    expect(validateBackground(undefined)).toBe("studio");
  });

  it("accepts the three supported background options", () => {
    expect(validateBackground("studio")).toBe("studio");
    expect(validateBackground("transparent")).toBe("transparent");
    expect(validateBackground("lifestyle")).toBe("lifestyle");
  });

  it("generates a unique storage path per image, scoped under the property and item", () => {
    const a = productImageStoragePath({
      propertyId: PROPERTY_ID,
      itemId: ITEM_ID,
      imageId: "00000000-0000-4000-8000-0000000000c1",
      fileName: "photo.png",
    });
    const b = productImageStoragePath({
      propertyId: PROPERTY_ID,
      itemId: ITEM_ID,
      imageId: "00000000-0000-4000-8000-0000000000c2",
      fileName: "photo.png",
    });
    expect(a).not.toBe(b);
    expect(a.startsWith(`${PROPERTY_ID}/inventory-items/${ITEM_ID}/`)).toBe(true);
  });

  it("rejects a storage path built from a non-uuid identifier", () => {
    expect(() =>
      productImageStoragePath({
        propertyId: "../../etc",
        itemId: ITEM_ID,
        imageId: "00000000-0000-4000-8000-0000000000c1",
        fileName: "photo.png",
      }),
    ).toThrow();
  });
});
