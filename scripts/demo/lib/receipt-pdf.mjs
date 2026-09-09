// A minimal, dependency-free PDF writer used for the demo's expense receipts
// and employee documents. It produces a single A6-landscape page of Helvetica
// text — enough for the receipt viewer to show something real rather than a
// broken thumbnail, and small enough (about 1 KB) to store hundreds of them.
//
// Nothing here is a facsimile of a real vendor's document: every receipt is
// headed DEMO DATA and names only fictional suppliers.

function escapeText(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * @param {{ title: string, lines: string[], footer?: string }} content
 * @returns {Uint8Array}
 */
export function simpleReceiptPdf(content) {
  const width = 420;
  const height = 300;
  const parts = [
    "BT /F1 14 Tf 1 0 0 1 32 250 Tm 20 TL",
    `(${escapeText(content.title)}) Tj`,
    "ET",
    "0.6 w 32 240 m 388 240 l S",
    "BT /F1 10 Tf 1 0 0 1 32 218 Tm 15 TL",
  ];
  for (const line of content.lines) parts.push(`(${escapeText(line)}) Tj T*`);
  parts.push("ET");
  if (content.footer) {
    parts.push("BT /F1 8 Tf 1 0 0 1 32 40 Tm", `(${escapeText(content.footer)}) Tj`, "ET");
  }
  const stream = parts.join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
