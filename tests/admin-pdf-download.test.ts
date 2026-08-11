import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadServerPdf, type AdminPdfRenderer } from "../src/lib/admin/pdf-docs";

const PDF_BASE64 = "JVBERi0xLjQK";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("admin PDF download", () => {
  it("calls the bound server function and downloads its client-safe PDF result", async () => {
    const click = vi.fn();
    const remove = vi.fn();
    const anchor = { href: "", download: "", click, remove };
    const appendChild = vi.fn();
    const createObjectURL = vi.fn(() => "blob:invoice");
    const revokeObjectURL = vi.fn();
    const renderPdf = vi.fn(async () => ({
      filename: "invoice-INV-001.pdf",
      mime: "application/pdf",
      base64: PDF_BASE64,
      bytes: 9,
    })) as AdminPdfRenderer;

    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
      body: { appendChild },
    });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    await downloadServerPdf(renderPdf, "invoice", "invoice-id", "property-id");

    expect(renderPdf).toHaveBeenCalledWith({
      data: { kind: "invoice", id: "invoice-id", propertyId: "property-id" },
    });
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("application/pdf");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10]),
    );
    expect(anchor.href).toBe("blob:invoice");
    expect(anchor.download).toBe("invoice-INV-001.pdf");
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("rejects when the server function fails so the click handler can show a toast", async () => {
    const renderPdf = vi.fn(async () => {
      throw new Error("Invoice PDF failed");
    }) as AdminPdfRenderer;

    await expect(
      downloadServerPdf(renderPdf, "invoice", "invoice-id", "property-id"),
    ).rejects.toThrow("Invoice PDF failed");
  });
});
