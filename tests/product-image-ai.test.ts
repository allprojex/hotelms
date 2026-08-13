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
  assertProductImageNamespace,
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

  it("explicitly disables the OpenAI SDK's own automatic retry for this call, so a transient 5xx/timeout cannot silently turn into a second billable generation", async () => {
    generateMock.mockResolvedValueOnce({ data: [{ b64_json: b64ImagePayload() }] });
    await generateProductImageBytes({ prompt: "a red mug", background: "studio" });
    const requestOptions = generateMock.mock.calls[0][1];
    expect(requestOptions).toEqual({ maxRetries: 0 });
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

  it("logs the OpenAI error's structured status/code/type/name server-side on failure, so a real failure is diagnosable from logs", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    generateMock.mockRejectedValueOnce(
      Object.assign(new Error("Incorrect API key provided: sk-***abcd"), {
        name: "AuthenticationError",
        status: 401,
        code: "invalid_api_key",
        type: "invalid_request_error",
      }),
    );
    await expect(generateProductImageBytes({ prompt: "x", background: "studio" })).rejects.toThrow();
    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = consoleError.mock.calls[0].join(" ");
    expect(logged).toContain('"status":401');
    expect(logged).toContain('"code":"invalid_api_key"');
    expect(logged).toContain('"type":"invalid_request_error"');
    expect(logged).toContain('"name":"AuthenticationError"');
    consoleError.mockRestore();
  });

  it("never logs the error's raw message — the exact field that echoes back a redacted API key fragment on auth failures", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    generateMock.mockRejectedValueOnce(
      Object.assign(new Error("Incorrect API key provided: sk-***abcd"), { name: "AuthenticationError", status: 401 }),
    );
    await expect(generateProductImageBytes({ prompt: "x", background: "studio" })).rejects.toThrow();
    const logged = consoleError.mock.calls.map((c) => c.join(" ")).join(" ");
    expect(logged).not.toContain("sk-***abcd");
    expect(logged).not.toContain("Incorrect API key provided");
    consoleError.mockRestore();
  });

  it("does not log anything on a successful generation", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    generateMock.mockResolvedValueOnce({ data: [{ b64_json: b64ImagePayload() }] });
    await generateProductImageBytes({ prompt: "x", background: "studio" });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("classifies a network-level failure (no HTTP status at all, e.g. APIConnectionError) distinctly from an OpenAI-issued status code", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    generateMock.mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { name: "APIConnectionError" }));
    await expect(generateProductImageBytes({ prompt: "x", background: "studio" })).rejects.toThrow(
      "Image generation failed. Please try again.",
    );
    const logged = consoleError.mock.calls[0].join(" ");
    expect(logged).toContain('"status":null');
    expect(logged).toContain('"name":"APIConnectionError"');
    consoleError.mockRestore();
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

describe("assertProductImageNamespace — used before every read/apply/delete of a client-supplied path", () => {
  const OTHER_PROPERTY_ID = "00000000-0000-4000-8000-00000000000f";

  it("accepts a well-formed path that actually belongs to the given property", () => {
    const path = productImageStoragePath({
      propertyId: PROPERTY_ID,
      itemId: ITEM_ID,
      imageId: "00000000-0000-4000-8000-0000000000c1",
      fileName: "ai-generated.webp",
    });
    expect(() => assertProductImageNamespace(path, PROPERTY_ID)).not.toThrow();
  });

  it("rejects a path whose property segment does not match the claimed propertyId (cross-property attempt)", () => {
    const path = productImageStoragePath({
      propertyId: OTHER_PROPERTY_ID,
      itemId: ITEM_ID,
      imageId: "00000000-0000-4000-8000-0000000000c1",
      fileName: "ai-generated.webp",
    });
    expect(() => assertProductImageNamespace(path, PROPERTY_ID)).toThrow("Invalid image reference");
  });

  it("rejects a path outside the inventory-items namespace entirely", () => {
    expect(() => assertProductImageNamespace(`${PROPERTY_ID}/something-else/x`, PROPERTY_ID)).toThrow();
  });

  it("rejects a path traversal attempt disguised as a filename segment", () => {
    expect(() =>
      assertProductImageNamespace(`${PROPERTY_ID}/inventory-items/${ITEM_ID}/../../../etc/passwd`, PROPERTY_ID),
    ).toThrow();
  });

  it("rejects a bare prefix match that isn't actually shaped like a real generated path", () => {
    expect(() => assertProductImageNamespace(`${PROPERTY_ID}/evil`, PROPERTY_ID)).toThrow();
  });
});
