/** Open a print-optimized HTML window and trigger the browser print dialog. */
export function openPrintView(opts: {
  title: string;
  subtitle?: string;
  bodyHtml: string;
  landscape?: boolean;
}) {
  // "noopener" in the features string makes window.open() itself return
  // null (the caller is given no reference to a window it has no opener
  // link to) -- fatal here, since this function needs that reference to
  // write the report into the new window. The target is always "" (a
  // blank, same-origin window we fully control, never third-party
  // content), so the classic reverse-tabnabbing risk noopener defends
  // against doesn't apply -- but we still sever the back-reference
  // defensively, the same way, just after obtaining the handle instead of
  // through the features string that broke it.
  const w = window.open("", "_blank", "width=1024,height=768");
  if (!w) return;
  w.opener = null;
  const size = opts.landscape ? "landscape" : "portrait";
  w.document.write(`<!doctype html><html><head><meta charset="utf-8" />
    <title>${escapeHtml(opts.title)}</title>
    <style>
      @page { size: A4 ${size}; margin: 16mm; }
      * { box-sizing: border-box; }
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #0f172a; margin: 0; padding: 24px; }
      h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: -0.01em; }
      .subtitle { color: #64748b; font-size: 12px; margin-bottom: 20px; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e2e8f0; }
      th { background: #f8fafc; font-weight: 600; text-transform: uppercase; font-size: 10px; letter-spacing: 0.06em; color: #475569; }
      tr:nth-child(even) td { background: #fafbfc; }
      .num { text-align: right; font-variant-numeric: tabular-nums; }
      .muted { color: #64748b; }
      .badge { display: inline-block; padding: 2px 6px; border: 1px solid #cbd5e1; border-radius: 4px; font-size: 10px; }
      footer { margin-top: 24px; font-size: 10px; color: #94a3b8; }
      @media print { .no-print { display: none; } }
    </style></head><body>
    <h1>${escapeHtml(opts.title)}</h1>
    ${opts.subtitle ? `<div class="subtitle">${escapeHtml(opts.subtitle)}</div>` : ""}
    ${opts.bodyHtml}
    <footer>Printed ${new Date().toLocaleString()} · ThesKwoff Hotel</footer>
    <script>window.addEventListener('load',()=>setTimeout(()=>window.print(),150));</script>
    </body></html>`);
  w.document.close();
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

export function renderTable<T>(
  columns: { label: string; key: (row: T) => unknown; num?: boolean }[],
  rows: T[],
): string {
  const head = columns.map((c) => `<th class="${c.num ? "num" : ""}">${escapeHtml(c.label)}</th>`).join("");
  const body = rows.map((r) => {
    const cells = columns.map((c) => {
      const v = c.key(r);
      return `<td class="${c.num ? "num" : ""}">${escapeHtml(v)}</td>`;
    }).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
