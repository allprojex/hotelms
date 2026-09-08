import { BRAND_NAME } from "@/lib/deployment-identity";
// PrintNode server bridge — reads PRINTNODE_API_KEY on the server so the
// customer's cloud-print token never touches the browser. Missing key ⇒
// { available: false } (never throws); UI falls back to browser-native.
import { createServerFn } from "@tanstack/react-start";

const BASE = "https://api.printnode.com";

function auth() {
  const key = process.env.PRINTNODE_API_KEY;
  if (!key) return null;
  return `Basic ${btoa(`${key}:`)}`;
}

export const listPrintNodePrinters = createServerFn({ method: "GET" }).handler(async () => {
  const a = auth();
  if (!a) return { available: false, printers: [], error: "PRINTNODE_API_KEY not configured" };
  try {
    const res = await fetch(`${BASE}/printers`, { headers: { Authorization: a } });
    if (!res.ok) return { available: true, printers: [], error: `PrintNode ${res.status}: ${await res.text()}` };
    const printers = await res.json();
    return { available: true, printers };
  } catch (e) {
    return { available: false, printers: [], error: (e as Error).message };
  }
});

export const sendPrintNodeJob = createServerFn({ method: "POST" })
  .inputValidator((input: {
    printnodeId: number;
    title: string;
    contentType: "pdf_uri" | "pdf_base64" | "raw_base64";
    content: string;
    copies?: number;
  }) => input)
  .handler(async ({ data }) => {
    const a = auth();
    if (!a) return { ok: false, error: "PRINTNODE_API_KEY not configured" };
    const body = {
      printerId: data.printnodeId,
      title: data.title,
      contentType: data.contentType,
      content: data.content,
      source: BRAND_NAME,
      qty: data.copies ?? 1,
    };
    const res = await fetch(`${BASE}/printjobs`, {
      method: "POST",
      headers: { Authorization: a, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `PrintNode ${res.status}: ${await res.text()}` };
    const jobId = await res.json();
    return { ok: true, jobId };
  });
