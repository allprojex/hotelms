export type AdminPdfKind = "folio" | "bill" | "invoice" | "po";

export interface AdminPdfResult {
  filename: string;
  mime: string;
  base64: string;
  bytes: number;
}

export type AdminPdfRenderer = (options: {
  data: { kind: AdminPdfKind; id: string; propertyId: string };
}) => Promise<AdminPdfResult>;

/**
 * Request a server-rendered PDF and trigger a browser download.
 * All data fetching, authorization, and PDF composition happens server-side —
 * sensitive rows never enter the browser bundle or memory.
 */
export async function downloadServerPdf(
  renderPdf: AdminPdfRenderer,
  kind: AdminPdfKind,
  id: string,
  propertyId: string,
) {
  // Reserve the browser target while the click still has user activation.
  // A synthetic download started after the server round-trip may be blocked
  // silently by the browser because transient activation has expired.
  const pdfWindow = window.open("", "_blank");
  if (!pdfWindow) throw new Error("PDF window was blocked. Allow pop-ups and try again.");
  pdfWindow.opener = null;
  pdfWindow.document.title = "Preparing PDF…";

  try {
    const res = await renderPdf({ data: { kind, id, propertyId } });
    const bin = atob(res.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: res.mime });
    const url = URL.createObjectURL(blob);
    pdfWindow.document.title = res.filename;
    pdfWindow.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    pdfWindow.close();
    throw error;
  }
}
