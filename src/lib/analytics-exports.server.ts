// Server-only executor for scheduled analytics exports.
// Called by both the authenticated "Run now" server fn and the pg_cron endpoint.

import { execCurrency, execMoney, execNumber } from "@/lib/analytics-format";

type SummaryRow = Record<string, unknown>;

function isoDate(d: Date) { return d.toISOString().slice(0, 10); }

function periodForFrequency(freq: string): { from: string; to: string } {
  const today = new Date();
  const to = new Date(today); to.setUTCDate(to.getUTCDate() - 1);
  const from = new Date(to);
  if (freq === "daily") { /* single day */ }
  else if (freq === "weekly") from.setUTCDate(from.getUTCDate() - 6);
  else /* monthly */ from.setUTCDate(from.getUTCDate() - 29);
  return { from: isoDate(from), to: isoDate(to) };
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: SummaryRow[], cols: string[]): string {
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(","))].join("\n");
}

function fmtNum(v: unknown, suffix = ""): string {
  return execNumber(v, suffix);
}

function fmtMoney(v: unknown, currency: string): string {
  return execMoney(v, currency);
}

function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;");
}

export function buildHtmlReport(propertyName: string, from: string, to: string, kpis: any,
  daily: any[], sources: any[], top: any[], baseCurrency?: unknown): string {
  const e = escapeHtml;
  const currency = execCurrency(baseCurrency);
  const cur = (v: unknown) => fmtMoney(v, currency);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Executive Report ${e(from)}_${e(to)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;margin:32px;background:#fff;}
h1{font-size:22px;margin:0 0 4px;} h2{font-size:14px;margin:24px 0 8px;color:#333;}
.muted{color:#666;font-size:12px;} table{width:100%;border-collapse:collapse;font-size:12px;margin-top:4px;}
th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;} th{background:#f5f5f5;}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px;}
.kpi{border:1px solid #e5e5e5;border-radius:6px;padding:10px;}
.kpi .l{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.05em;}
.kpi .v{font-size:18px;font-weight:600;margin-top:2px;}
</style></head><body>
<h1>Executive Report</h1>
<div class="muted">${e(propertyName)} · ${e(from)} → ${e(to)} · Generated ${e(new Date().toUTCString())}</div>
<div class="kpis">
  <div class="kpi"><div class="l">Total revenue</div><div class="v">${e(cur(kpis?.revenue))}</div></div>
  <div class="kpi"><div class="l">Occupancy</div><div class="v">${e(fmtNum(kpis?.occupancy_pct, "%"))}</div></div>
  <div class="kpi"><div class="l">ADR</div><div class="v">${e(cur(kpis?.adr))}</div></div>
  <div class="kpi"><div class="l">RevPAR</div><div class="v">${e(cur(kpis?.revpar))}</div></div>
  <div class="kpi"><div class="l">Room revenue</div><div class="v">${e(cur(kpis?.room_revenue))}</div></div>
  <div class="kpi"><div class="l">POS revenue</div><div class="v">${e(cur(kpis?.pos_revenue))}</div></div>
  <div class="kpi"><div class="l">Cancellations</div><div class="v">${e(fmtNum(kpis?.cancellation_rate, "%"))}</div></div>
  <div class="kpi"><div class="l">Avg LOS</div><div class="v">${e(fmtNum(kpis?.avg_los))} nts</div></div>
</div>
<h2>Revenue by source</h2>
<table><thead><tr><th>Source</th><th>Reservations</th><th>Revenue</th></tr></thead><tbody>
${sources.map((r) => `<tr><td>${e(r.source)}</td><td>${e(r.reservations)}</td><td>${e(cur(r.revenue))}</td></tr>`).join("")}
</tbody></table>
<h2>Top room types</h2>
<table><thead><tr><th>Room type</th><th>Nights</th><th>Revenue</th></tr></thead><tbody>
${top.map((r) => `<tr><td>${e(r.room_type)}</td><td>${e(r.nights)}</td><td>${e(cur(r.revenue))}</td></tr>`).join("")}
</tbody></table>
<h2>Daily revenue</h2>
<table><thead><tr><th>Day</th><th>Rooms</th><th>POS</th><th>Total</th></tr></thead><tbody>
${daily.map((r) => `<tr><td>${e(r.day)}</td><td>${e(cur(r.room_revenue))}</td><td>${e(cur(r.pos_revenue))}</td><td>${e(cur(r.total))}</td></tr>`).join("")}
</tbody></table>
</body></html>`;
}

function computeNextRunISO(freq: string, hour: number, dow: number | null, dom: number | null): string {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0));
  if (freq === "daily") {
    next.setUTCDate(next.getUTCDate() + 1);
  } else if (freq === "weekly") {
    const targetDow = dow ?? 1;
    const diff = ((targetDow - next.getUTCDay() + 7) % 7) || 7;
    next.setUTCDate(next.getUTCDate() + diff);
  } else {
    const targetDom = dom ?? 1;
    next.setUTCMonth(next.getUTCMonth() + 1);
    next.setUTCDate(targetDom);
  }
  return next.toISOString();
}

async function sendReportEmail(opts: {
  recipients: string[];
  subject: string;
  html: string;
  attachments: { filename: string; content: string; contentType: string }[];
}): Promise<{ ok: boolean; status: number; body: string }> {
  const key = process.env.RESEND_API_KEY ?? process.env.LOVABLE_RESEND_API_KEY;
  const from = process.env.ANALYTICS_EMAIL_FROM ?? "Executive Reports <onboarding@resend.dev>";
  if (!key) {
    return { ok: false, status: 0, body: "Email delivery not configured (RESEND_API_KEY missing). Configure the email connector in Lovable to enable delivery." };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      from, to: opts.recipients, subject: opts.subject, html: opts.html,
      attachments: opts.attachments.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content, "utf-8").toString("base64"),
      })),
    }),
  });
  const body = (await res.text()).slice(0, 4000);
  return { ok: res.ok, status: res.status, body };
}

export async function runScheduledExport(
  scheduleId: string,
  opts: { expectedPropertyId?: string } = {},
) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: schedule, error: sErr } = await supabaseAdmin
    .from("analytics_export_schedules").select("*").eq("id", scheduleId).maybeSingle();
  if (sErr || !schedule) throw new Error("Schedule not found");
  if (opts.expectedPropertyId && schedule.property_id !== opts.expectedPropertyId) {
    throw new Error("Schedule does not belong to the requested property");
  }

  const { from, to } = periodForFrequency(schedule.frequency);

  const { data: run, error: rErr } = await supabaseAdmin.from("analytics_export_runs").insert({
    schedule_id: schedule.id, property_id: schedule.property_id,
    period_from: from, period_to: to, format: schedule.format, recipients: schedule.recipients,
    status: "pending",
  }).select().single();
  if (rErr) throw new Error(rErr.message);

  try {
    const args = { _property_id: schedule.property_id, _from: from, _to: to };
    const [kpisRes, dailyRes, sourcesRes, topRes, propRes] = await Promise.all([
      supabaseAdmin.rpc("exec_analytics_kpis", args),
      supabaseAdmin.rpc("exec_analytics_revenue_by_day", args),
      supabaseAdmin.rpc("exec_analytics_revenue_by_source", args),
      supabaseAdmin.rpc("exec_analytics_top_room_types", args),
      supabaseAdmin.from("properties").select("name, base_currency").eq("id", schedule.property_id).maybeSingle(),
    ]);
    const kpis: any = kpisRes.data?.[0] ?? {};
    const daily = dailyRes.data ?? [];
    const sources = sourcesRes.data ?? [];
    const top = topRes.data ?? [];
    const propName = propRes.data?.name ?? "Property";
    // Money on the scheduled report follows the same property base currency as the screen.
    const currency = execCurrency((propRes.data as { base_currency?: string } | null)?.base_currency);

    const dailyCsv = toCsv(daily as any[], ["day", "room_revenue", "pos_revenue", "total"]);
    const sourceCsv = toCsv(sources as any[], ["source", "reservations", "revenue"]);
    const topCsv = toCsv(top as any[], ["room_type", "nights", "revenue"]);
    const kpisCsv = toCsv(
      Object.entries(kpis).map(([metric, value]) => ({ metric, value })),
      ["metric", "value"],
    );
    const html = buildHtmlReport(propName, from, to, kpis, daily as any[], sources as any[], top as any[], currency);

    const combinedCsv = `# KPIs\n${kpisCsv}\n\n# Daily revenue\n${dailyCsv}\n\n# Revenue by source\n${sourceCsv}\n\n# Top room types\n${topCsv}\n`;

    const attachments: { filename: string; content: string; contentType: string }[] = [];
    if (schedule.format === "csv" || schedule.format === "both") {
      attachments.push({ filename: `analytics_${from}_${to}.csv`, content: combinedCsv, contentType: "text/csv" });
    }
    if (schedule.format === "pdf" || schedule.format === "both") {
      attachments.push({ filename: `analytics_${from}_${to}.html`, content: html, contentType: "text/html" });
    }

    const emailHtml = `<p>Executive analytics report for <strong>${propName}</strong> covering ${from} → ${to} is attached.</p>
<p>Total revenue: <strong>${fmtMoney(kpis.revenue, currency)}</strong> · Occupancy: <strong>${fmtNum(kpis.occupancy_pct, "%")}</strong> · RevPAR: <strong>${fmtMoney(kpis.revpar, currency)}</strong></p>`;

    const send = await sendReportEmail({
      recipients: schedule.recipients,
      subject: `Executive report · ${propName} · ${from} → ${to}`,
      html: emailHtml,
      attachments,
    });

    const nextRun = computeNextRunISO(schedule.frequency, schedule.hour, schedule.day_of_week, schedule.day_of_month);

    await supabaseAdmin.from("analytics_export_runs").update({
      status: send.ok ? "sent" : "failed",
      error: send.ok ? null : `Email delivery failed (${send.status}): ${send.body.slice(0, 500)}`,
      csv_payload: combinedCsv,
      html_report: html,
      sent_at: send.ok ? new Date().toISOString() : null,
    }).eq("id", run.id);

    await supabaseAdmin.from("analytics_export_schedules").update({
      last_run_at: new Date().toISOString(),
      last_run_status: send.ok ? "sent" : "failed",
      last_run_error: send.ok ? null : send.body.slice(0, 500),
      next_run_at: nextRun,
    }).eq("id", schedule.id);

    return { runId: run.id, status: send.ok ? "sent" : "failed", recipients: schedule.recipients.length };
  } catch (e) {
    const msg = (e as Error).message;
    await supabaseAdmin.from("analytics_export_runs").update({
      status: "failed", error: msg,
    }).eq("id", run.id);
    await supabaseAdmin.from("analytics_export_schedules").update({
      last_run_at: new Date().toISOString(), last_run_status: "failed", last_run_error: msg,
    }).eq("id", schedule.id);
    return { runId: run.id, status: "failed", error: msg };
  }
}
