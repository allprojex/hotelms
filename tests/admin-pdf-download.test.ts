import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadServerPdf, type AdminPdfRenderer } from "../src/lib/admin/pdf-docs";
import { buildDocPdf, toBase64 } from "../src/lib/admin/pdf-render.server";
import { RenderAdminPdfInput } from "../src/lib/admin/pdf.functions";

const PDF_BASE64 = "JVBERi0xLjQK";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("admin PDF kind validation", () => {
  const validArgs = { id: "11111111-1111-4111-8111-111111111111", propertyId: "22222222-2222-4222-8222-222222222222" };

  it("accepts 'receipt' as a valid PDF kind", () => {
    expect(() => RenderAdminPdfInput.parse({ kind: "receipt", ...validArgs })).not.toThrow();
  });

  it("still accepts every previously supported kind", () => {
    for (const kind of ["folio", "bill", "invoice", "po"]) {
      expect(() => RenderAdminPdfInput.parse({ kind, ...validArgs })).not.toThrow();
    }
  });

  it("rejects an unknown kind", () => {
    expect(() => RenderAdminPdfInput.parse({ kind: "expense_receipt", ...validArgs })).toThrow();
  });
});

describe("admin PDF download", () => {
  it("renders and serializes the production AR invoice data shape", async () => {
    const bytes = await buildDocPdf({
      filename: "invoice-INV-001.pdf",
      title: "Invoice",
      code: "INV-001",
      fromBlock: ["Phase 6A Smoke Property"],
      toBlock: ["[LIVEQA-PDF] Test Customer", "liveqa-pdf@example.invalid"],
      meta: [
        { label: "Invoice date", value: "2026-08-11" },
        { label: "Due", value: "2026-09-10" },
        { label: "Status", value: "draft" },
      ],
      lines: [
        {
          description: "[LIVEQA-PDF] Invoice PDF smoke test",
          qty: 1,
          unitPrice: 1,
          amount: 1,
        },
      ],
      subtotal: 1,
      tax: 0,
      total: 1,
      currency: "GHS",
    });

    expect(bytes.length).toBeGreaterThan(500);
    expect(toBase64(bytes)).toMatch(/^JVBER/);
  });

  it("renders and serializes the production AR receipt data shape", async () => {
    const bytes = await buildDocPdf({
      filename: "receipt-RCT-001.pdf",
      title: "Receipt",
      code: "RCT-001",
      fromBlock: ["Phase 6A Smoke Property"],
      toBlock: ["[LIVEQA-PDF] Test Customer", "liveqa-pdf@example.invalid"],
      meta: [
        { label: "Receipt date", value: "2026-08-11" },
        { label: "Method", value: "cash" },
        { label: "Reference", value: "—" },
      ],
      lines: [
        {
          description: "Applied to invoice INV-001",
          amount: 1,
        },
      ],
      total: 1,
      currency: "GHS",
    });

    expect(bytes.length).toBeGreaterThan(500);
    expect(toBase64(bytes)).toMatch(/^JVBER/);
  });

  it("reserves a window before the server call and opens its client-safe PDF result", async () => {
    const close = vi.fn();
    const pdfWindow = {
      opener: {} as unknown,
      document: { title: "" },
      location: { href: "" },
      close,
    };
    const open = vi.fn(() => pdfWindow);
    const createObjectURL = vi.fn(() => "blob:invoice");
    const revokeObjectURL = vi.fn();
    const renderPdf = vi.fn(async () => ({
      filename: "invoice-INV-001.pdf",
      mime: "application/pdf",
      base64: PDF_BASE64,
      bytes: 9,
    })) as AdminPdfRenderer;

    vi.stubGlobal("window", { open });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    await downloadServerPdf(renderPdf, "invoice", "invoice-id", "property-id");

    expect(renderPdf).toHaveBeenCalledWith({
      data: { kind: "invoice", id: "invoice-id", propertyId: "property-id" },
    });
    expect(open).toHaveBeenCalledBefore(renderPdf);
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("application/pdf");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10]),
    );
    expect(pdfWindow.opener).toBeNull();
    expect(pdfWindow.document.title).toBe("invoice-INV-001.pdf");
    expect(pdfWindow.location.href).toBe("blob:invoice");
    expect(close).not.toHaveBeenCalled();
  });

  it("rejects when the server function fails so the click handler can show a toast", async () => {
    const close = vi.fn();
    vi.stubGlobal("window", {
      open: vi.fn(() => ({ opener: null, document: { title: "" }, location: { href: "" }, close })),
    });
    const renderPdf = vi.fn(async () => {
      throw new Error("Invoice PDF failed");
    }) as AdminPdfRenderer;

    await expect(
      downloadServerPdf(renderPdf, "invoice", "invoice-id", "property-id"),
    ).rejects.toThrow("Invoice PDF failed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("surfaces a blocked PDF window before calling the server", async () => {
    vi.stubGlobal("window", { open: vi.fn(() => null) });
    const renderPdf = vi.fn() as unknown as AdminPdfRenderer;

    await expect(
      downloadServerPdf(renderPdf, "invoice", "invoice-id", "property-id"),
    ).rejects.toThrow("PDF window was blocked");
    expect(renderPdf).not.toHaveBeenCalled();
  });

  it("reserves a window before the server call for an AR receipt and opens its client-safe PDF result", async () => {
    const close = vi.fn();
    const pdfWindow = {
      opener: {} as unknown,
      document: { title: "" },
      location: { href: "" },
      close,
    };
    const open = vi.fn(() => pdfWindow);
    const createObjectURL = vi.fn(() => "blob:receipt");
    const revokeObjectURL = vi.fn();
    const renderPdf = vi.fn(async () => ({
      filename: "receipt-RCT-001.pdf",
      mime: "application/pdf",
      base64: PDF_BASE64,
      bytes: 9,
    })) as AdminPdfRenderer;

    vi.stubGlobal("window", { open });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    await downloadServerPdf(renderPdf, "receipt", "receipt-id", "property-id");

    expect(renderPdf).toHaveBeenCalledWith({
      data: { kind: "receipt", id: "receipt-id", propertyId: "property-id" },
    });
    expect(open).toHaveBeenCalledBefore(renderPdf);
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("application/pdf");
    expect(pdfWindow.opener).toBeNull();
    expect(pdfWindow.document.title).toBe("receipt-RCT-001.pdf");
    expect(pdfWindow.location.href).toBe("blob:receipt");
    expect(close).not.toHaveBeenCalled();
  });

  it("closes the reserved window and propagates the error when receipt PDF generation fails", async () => {
    const close = vi.fn();
    vi.stubGlobal("window", {
      open: vi.fn(() => ({ opener: null, document: { title: "" }, location: { href: "" }, close })),
    });
    const renderPdf = vi.fn(async () => {
      throw new Error("Receipt PDF failed");
    }) as AdminPdfRenderer;

    await expect(
      downloadServerPdf(renderPdf, "receipt", "receipt-id", "property-id"),
    ).rejects.toThrow("Receipt PDF failed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("surfaces a blocked PDF window before calling the server for a receipt print", async () => {
    vi.stubGlobal("window", { open: vi.fn(() => null) });
    const renderPdf = vi.fn() as unknown as AdminPdfRenderer;

    await expect(
      downloadServerPdf(renderPdf, "receipt", "receipt-id", "property-id"),
    ).rejects.toThrow("PDF window was blocked");
    expect(renderPdf).not.toHaveBeenCalled();
  });
});
