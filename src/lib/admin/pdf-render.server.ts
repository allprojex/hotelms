// Server-only PDF builder. Never import from client bundles.
// pdf-lib is safe in the Cloudflare Worker SSR runtime.
import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from "pdf-lib";

export interface LineItem {
  description: string;
  qty?: number;
  unitPrice?: number;
  amount: number;
}

export interface DocData {
  filename: string;
  title: string;
  code?: string;
  subtitle?: string;
  fromBlock?: string[];
  toBlock?: string[];
  meta?: { label: string; value: string }[];
  lines: LineItem[];
  subtotal?: number;
  tax?: number;
  total: number;
  currency?: string;
  notes?: string;
}

const M = 40;
const W = 595;
const H = 842;

export async function buildDocPdf(data: DocData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(data.title);
  pdf.setProducer("ThesKwoff Hotel");
  pdf.setCreator("ThesKwoff Hotel");
  pdf.setCreationDate(new Date());

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([W, H]);
  let y = H - M;

  // Header
  page.drawText(data.title, {
    x: M,
    y: y - 18,
    size: 20,
    font: bold,
    color: rgb(0.05, 0.09, 0.16),
  });
  if (data.code) {
    const codeW = bold.widthOfTextAtSize(data.code, 12);
    page.drawText(data.code, {
      x: W - M - codeW,
      y: y - 14,
      size: 12,
      font: bold,
      color: rgb(0.05, 0.09, 0.16),
    });
  }
  y -= 30;
  if (data.subtitle) {
    page.drawText(data.subtitle, { x: M, y: y - 12, size: 10, font, color: rgb(0.42, 0.45, 0.5) });
    y -= 18;
  }
  y -= 6;
  page.drawLine({
    start: { x: M, y },
    end: { x: W - M, y },
    thickness: 0.7,
    color: rgb(0.85, 0.87, 0.9),
  });
  y -= 16;

  const colW = (W - M * 2 - 20) / 2;
  const fromLines = data.fromBlock ?? [];
  const toLines = data.toBlock ?? [];
  let fromY = y,
    toY = y;
  page.drawText("From", { x: M, y: fromY, size: 8, font: bold, color: rgb(0.4, 0.42, 0.48) });
  page.drawText("To", {
    x: M + colW + 20,
    y: toY,
    size: 8,
    font: bold,
    color: rgb(0.4, 0.42, 0.48),
  });
  fromY -= 12;
  toY -= 12;
  for (const line of fromLines) {
    page.drawText(String(line), { x: M, y: fromY, size: 10, font });
    fromY -= 12;
  }
  for (const line of toLines) {
    page.drawText(String(line), { x: M + colW + 20, y: toY, size: 10, font });
    toY -= 12;
  }
  y = Math.min(fromY, toY) - 8;

  if (data.meta?.length) {
    for (const m of data.meta) {
      page.drawText(`${m.label}:`, { x: M, y, size: 9, font: bold, color: rgb(0.42, 0.45, 0.5) });
      page.drawText(m.value, { x: M + 90, y, size: 9, font });
      y -= 12;
    }
    y -= 8;
  }

  const cols = [
    { label: "Description", x: M, w: 260, align: "left" as const },
    { label: "Qty", x: M + 270, w: 40, align: "right" as const },
    { label: "Unit", x: M + 320, w: 80, align: "right" as const },
    { label: "Amount", x: M + 410, w: 100, align: "right" as const },
  ];
  y -= 8;
  page.drawRectangle({
    x: M,
    y: y - 4,
    width: W - M * 2,
    height: 18,
    color: rgb(0.96, 0.97, 0.99),
  });
  for (const c of cols) drawText(page, bold, c.label.toUpperCase(), c.x, y + 4, 8, c.align, c.w);
  y -= 18;

  const cur = data.currency ?? "";
  for (const line of data.lines) {
    if (y < M + 120) {
      page = pdf.addPage([W, H]);
      y = H - M;
    }
    drawText(page, font, line.description, cols[0].x, y - 6, 10, "left", cols[0].w);
    if (line.qty !== undefined)
      drawText(page, font, String(line.qty), cols[1].x, y - 6, 10, "right", cols[1].w);
    if (line.unitPrice !== undefined)
      drawText(page, font, fmt(line.unitPrice, cur), cols[2].x, y - 6, 10, "right", cols[2].w);
    drawText(page, font, fmt(line.amount, cur), cols[3].x, y - 6, 10, "right", cols[3].w);
    y -= 16;
    page.drawLine({
      start: { x: M, y },
      end: { x: W - M, y },
      thickness: 0.4,
      color: rgb(0.9, 0.92, 0.94),
    });
  }
  y -= 10;

  const totalsX = W - M - 220;
  const drawTotalRow = (label: string, value: string, isBold = false) => {
    const f = isBold ? bold : font;
    drawText(page, f, label, totalsX, y, 10, "left", 110);
    drawText(page, f, value, totalsX + 110, y, 10, "right", 110);
    y -= 14;
  };
  if (data.subtotal !== undefined) drawTotalRow("Subtotal", fmt(data.subtotal, cur));
  if (data.tax !== undefined) drawTotalRow("Tax", fmt(data.tax, cur));
  y -= 4;
  page.drawLine({
    start: { x: totalsX, y: y + 8 },
    end: { x: W - M, y: y + 8 },
    thickness: 0.7,
    color: rgb(0.05, 0.09, 0.16),
  });
  drawTotalRow("Total", fmt(data.total, cur), true);

  if (data.notes) {
    y -= 16;
    page.drawText("Notes", { x: M, y, size: 9, font: bold, color: rgb(0.42, 0.45, 0.5) });
    y -= 12;
    for (const line of wrap(data.notes, 90)) {
      page.drawText(line, { x: M, y, size: 9, font });
      y -= 11;
    }
  }

  page.drawText(`Generated ${new Date().toISOString()} · ThesKwoff Hotel`, {
    x: M,
    y: M / 2,
    size: 8,
    font,
    color: rgb(0.6, 0.63, 0.68),
  });

  return pdf.save();
}

function drawText(
  page: PDFPage,
  font: PDFFont,
  text: string,
  x: number,
  y: number,
  size: number,
  align: "left" | "right",
  boxW: number,
) {
  const t = String(text ?? "");
  if (align === "right") {
    const tw = font.widthOfTextAtSize(t, size);
    page.drawText(t, { x: x + boxW - tw, y, size, font });
  } else {
    page.drawText(t, { x, y, size, font });
  }
}

function fmt(n: number, cur = ""): string {
  const s = Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return cur ? `${cur} ${s}` : s;
}

function wrap(s: string, w: number): string[] {
  const out: string[] = [];
  const words = s.split(/\s+/);
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > w) {
      out.push(line);
      line = word;
    } else line = (line + " " + word).trim();
  }
  if (line) out.push(line);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  // Worker-safe base64: chunk to avoid stack overflow on large PDFs.
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[],
    );
  }
  return btoa(bin);
}

export interface StatementTransactionRow {
  date: string;
  type: string;
  reference: string;
  description: string;
  debit: number;
  credit: number;
  runningBalance: number;
}

export interface StatementSection {
  currency: string;
  openingBalance: number;
  transactions: StatementTransactionRow[];
  totalDebits: number;
  totalCredits: number;
  closingBalance: number;
}

export interface StatementDocData {
  filename: string;
  title: string;
  code?: string;
  fromBlock?: string[];
  toBlock?: string[];
  meta?: { label: string; value: string }[];
  sections: StatementSection[];
}

/**
 * A ledger-style customer statement — Date/Type/Reference/Debit/Credit/
 * Balance columns, one section per currency (never a combined
 * multi-currency total). Distinct from buildDocPdf's invoice-style
 * Description/Qty/Unit/Amount layout, which doesn't have a running-balance
 * concept; reuses the same pdf-lib document setup, fonts, and drawText/fmt/
 * wrap helpers rather than a second PDF framework.
 */
export async function buildStatementPdf(data: StatementDocData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(data.title);
  pdf.setProducer("ThesKwoff Hotel");
  pdf.setCreator("ThesKwoff Hotel");
  pdf.setCreationDate(new Date());

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([W, H]);
  let y = H - M;

  page.drawText(data.title, {
    x: M,
    y: y - 18,
    size: 20,
    font: bold,
    color: rgb(0.05, 0.09, 0.16),
  });
  if (data.code) {
    const codeW = bold.widthOfTextAtSize(data.code, 12);
    page.drawText(data.code, {
      x: W - M - codeW,
      y: y - 14,
      size: 12,
      font: bold,
      color: rgb(0.05, 0.09, 0.16),
    });
  }
  y -= 36;
  page.drawLine({
    start: { x: M, y },
    end: { x: W - M, y },
    thickness: 0.7,
    color: rgb(0.85, 0.87, 0.9),
  });
  y -= 16;

  const colW = (W - M * 2 - 20) / 2;
  const fromLines = data.fromBlock ?? [];
  const toLines = data.toBlock ?? [];
  let fromY = y;
  let toY = y;
  page.drawText("From", { x: M, y: fromY, size: 8, font: bold, color: rgb(0.4, 0.42, 0.48) });
  page.drawText("To", {
    x: M + colW + 20,
    y: toY,
    size: 8,
    font: bold,
    color: rgb(0.4, 0.42, 0.48),
  });
  fromY -= 12;
  toY -= 12;
  for (const line of fromLines) {
    page.drawText(String(line), { x: M, y: fromY, size: 10, font });
    fromY -= 12;
  }
  for (const line of toLines) {
    page.drawText(String(line), { x: M + colW + 20, y: toY, size: 10, font });
    toY -= 12;
  }
  y = Math.min(fromY, toY) - 8;

  if (data.meta?.length) {
    for (const m of data.meta) {
      page.drawText(`${m.label}:`, { x: M, y, size: 9, font: bold, color: rgb(0.42, 0.45, 0.5) });
      page.drawText(m.value, { x: M + 90, y, size: 9, font });
      y -= 12;
    }
    y -= 8;
  }

  const cols = [
    { label: "Date", x: M, w: 68, align: "left" as const },
    { label: "Type", x: M + 72, w: 55, align: "left" as const },
    { label: "Reference", x: M + 132, w: 130, align: "left" as const },
    { label: "Debit", x: M + 320, w: 70, align: "right" as const },
    { label: "Credit", x: M + 395, w: 70, align: "right" as const },
    { label: "Balance", x: M + 470, w: 85, align: "right" as const },
  ];

  const ensureSpace = (needed: number) => {
    if (y < M + needed) {
      page = pdf.addPage([W, H]);
      y = H - M;
    }
  };

  for (const section of data.sections) {
    ensureSpace(140);
    page.drawText(`Currency: ${section.currency}`, {
      x: M,
      y,
      size: 11,
      font: bold,
      color: rgb(0.05, 0.09, 0.16),
    });
    y -= 16;
    page.drawText("Opening balance", { x: M, y, size: 9, font: bold, color: rgb(0.42, 0.45, 0.5) });
    page.drawText(fmt(section.openingBalance, section.currency), { x: M + 120, y, size: 9, font });
    y -= 16;

    page.drawRectangle({
      x: M,
      y: y - 4,
      width: W - M * 2,
      height: 18,
      color: rgb(0.96, 0.97, 0.99),
    });
    for (const c of cols) drawText(page, bold, c.label.toUpperCase(), c.x, y + 4, 8, c.align, c.w);
    y -= 18;

    if (section.transactions.length === 0) {
      page.drawText("No transactions in this period.", {
        x: M,
        y: y - 6,
        size: 9,
        font,
        color: rgb(0.5, 0.52, 0.56),
      });
      y -= 16;
    }
    for (const t of section.transactions) {
      ensureSpace(60);
      drawText(page, font, t.date, cols[0].x, y - 6, 9, "left", cols[0].w);
      drawText(page, font, t.type, cols[1].x, y - 6, 9, "left", cols[1].w);
      drawText(page, font, t.reference, cols[2].x, y - 6, 9, "left", cols[2].w);
      drawText(page, font, t.debit ? fmt(t.debit) : "", cols[3].x, y - 6, 9, "right", cols[3].w);
      drawText(page, font, t.credit ? fmt(t.credit) : "", cols[4].x, y - 6, 9, "right", cols[4].w);
      drawText(page, bold, fmt(t.runningBalance), cols[5].x, y - 6, 9, "right", cols[5].w);
      y -= 15;
      page.drawLine({
        start: { x: M, y },
        end: { x: W - M, y },
        thickness: 0.4,
        color: rgb(0.9, 0.92, 0.94),
      });
    }
    y -= 10;

    const totalsX = W - M - 220;
    const drawTotalRow = (label: string, value: string, isBold = false) => {
      const f = isBold ? bold : font;
      drawText(page, f, label, totalsX, y, 10, "left", 110);
      drawText(page, f, value, totalsX + 110, y, 10, "right", 110);
      y -= 14;
    };
    drawTotalRow("Total debits", fmt(section.totalDebits, section.currency));
    drawTotalRow("Total credits", fmt(section.totalCredits, section.currency));
    y -= 4;
    page.drawLine({
      start: { x: totalsX, y: y + 8 },
      end: { x: W - M, y: y + 8 },
      thickness: 0.7,
      color: rgb(0.05, 0.09, 0.16),
    });
    drawTotalRow("Closing balance", fmt(section.closingBalance, section.currency), true);
    y -= 20;
  }

  if (data.sections.length === 0) {
    page.drawText("No AR activity for this customer in this period.", {
      x: M,
      y,
      size: 11,
      font,
      color: rgb(0.5, 0.52, 0.56),
    });
  }

  page.drawText(`Generated ${new Date().toISOString()} · ThesKwoff Hotel`, {
    x: M,
    y: M / 2,
    size: 8,
    font,
    color: rgb(0.6, 0.63, 0.68),
  });

  return pdf.save();
}
