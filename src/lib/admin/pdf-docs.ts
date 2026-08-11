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
  const res = await renderPdf({ data: { kind, id, propertyId } });
  const bin = atob(res.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: res.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = res.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
