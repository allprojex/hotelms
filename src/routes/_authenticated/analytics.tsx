import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Download, FileText, ChevronDown, Mail, Plus, Play, Trash2, Pencil, CheckCircle2, XCircle, Clock } from "lucide-react";
import { toast } from "sonner";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  BarChart, Bar, PieChart, Pie, Cell, Legend,
} from "recharts";
import {
  getExecKpis, getExecRevenueByDay, getExecRevenueBySource, getExecTopRoomTypes,
} from "@/lib/analytics.functions";
import {
  assertExecExportAccess, listExportSchedules, upsertExportSchedule,
  deleteExportSchedule, listExportRuns, runExportScheduleNow,
} from "@/lib/analytics-exports.functions";
import { useHasAnyRole, EXEC_ROLES } from "@/hooks/use-user-roles";
import { execCurrency, execMoney, execNumber } from "@/lib/analytics-format";
import { AccessDenied } from "@/components/access-denied";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated/analytics")({
  head: () => ({ meta: [{ title: "Executive Analytics" }] }),
  component: AnalyticsPage,
});

function isoDate(d: Date) { return d.toISOString().slice(0, 10); }

function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (!rows.length) return "";
  const cols = columns ?? Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

function download(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

function AnalyticsPage() {
  const propertyId = useActiveProperty();
  const { allowed, loading: rolesLoading } = useHasAnyRole(EXEC_ROLES, propertyId);
  const today = new Date();
  const monthAgo = new Date(today); monthAgo.setDate(today.getDate() - 29);
  const [from, setFrom] = useState(isoDate(monthAgo));
  const [to, setTo] = useState(isoDate(today));

  const kpisFn = useServerFn(getExecKpis);
  const dailyFn = useServerFn(getExecRevenueByDay);
  const sourceFn = useServerFn(getExecRevenueBySource);
  const topFn = useServerFn(getExecTopRoomTypes);
  const gateFn = useServerFn(assertExecExportAccess);

  async function guardExport(): Promise<boolean> {
    if (!propertyId) { toast.error("Select a property first"); return false; }
    try { await gateFn({ data: { propertyId } }); return true; }
    catch (e: any) {
      toast.error(e?.message ?? "Not authorized to export this property's data");
      return false;
    }
  }




  const args = { propertyId: propertyId ?? "", from, to };
  const enabled = !!propertyId && !!from && !!to && from <= to;

  const kpis = useQuery({ queryKey: ["exec-kpis", args], enabled,
    queryFn: () => kpisFn({ data: args }) });
  const daily = useQuery({ queryKey: ["exec-daily", args], enabled,
    queryFn: () => dailyFn({ data: args }) });
  const sources = useQuery({ queryKey: ["exec-sources", args], enabled,
    queryFn: () => sourceFn({ data: args }) });
  const top = useQuery({ queryKey: ["exec-top", args], enabled,
    queryFn: () => topFn({ data: args }) });

  // Single source of truth for money on this surface: the property's base currency.
  const property = useQuery({
    queryKey: ["exec-property", propertyId], enabled: !!propertyId,
    queryFn: async () => (await supabase.from("properties")
      .select("name, base_currency").eq("id", propertyId!).maybeSingle()).data,
  });
  const currency = execCurrency(property.data?.base_currency);
  const money = (v: unknown) => execMoney(v, currency);

  const dailyData = useMemo(() =>
    (daily.data ?? []).map((r: any) => ({
      day: r.day, rooms: Number(r.room_revenue), pos: Number(r.pos_revenue), total: Number(r.total),
    })), [daily.data]);

  const sourceData = useMemo(() =>
    (sources.data ?? []).map((r: any) => ({ name: r.source, value: Number(r.revenue) })), [sources.data]);

  const COLORS = ["hsl(var(--primary))", "hsl(var(--chart-2, 200 70% 50%))", "hsl(var(--chart-3, 30 70% 50%))",
    "hsl(var(--chart-4, 280 70% 55%))", "hsl(var(--chart-5, 340 70% 55%))"];

  const range = `${from}_${to}`;

  async function exportKpisCsv() {
    if (!kpis.data || !(await guardExport())) return;
    const rows = Object.entries(kpis.data).map(([metric, value]) => ({ metric, value }));
    download(`kpis_${range}.csv`, toCsv(rows, ["metric", "value"]), "text/csv");
  }
  async function exportDailyCsv() {
    if (!(await guardExport())) return;
    download(`revenue_by_day_${range}.csv`,
      toCsv((daily.data ?? []) as any[], ["day", "room_revenue", "pos_revenue", "total"]), "text/csv");
  }
  async function exportSourceCsv() {
    if (!(await guardExport())) return;
    download(`revenue_by_source_${range}.csv`,
      toCsv((sources.data ?? []) as any[], ["source", "reservations", "revenue"]), "text/csv");
  }
  async function exportTopCsv() {
    if (!(await guardExport())) return;
    download(`top_room_types_${range}.csv`,
      toCsv((top.data ?? []) as any[], ["room_type", "nights", "revenue"]), "text/csv");
  }

  async function exportPdf() {
    if (!(await guardExport())) return;
    const propRow = property.data ?? (propertyId
      ? (await supabase.from("properties").select("name, base_currency").eq("id", propertyId).maybeSingle()).data
      : null);
    const propName = propRow?.name ?? "Property";
    const printCurrency = execCurrency(propRow?.base_currency);
    const k = kpis.data ?? {} as any;
    const fmt = (v: unknown, s = "") => execNumber(v, s);
    const cur = (v: unknown) => execMoney(v, printCurrency);
    const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Executive Report ${esc(range)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;margin:32px;}
h1{font-size:22px;margin:0 0 4px;} h2{font-size:14px;margin:24px 0 8px;color:#333;}
.muted{color:#666;font-size:12px;} table{width:100%;border-collapse:collapse;font-size:12px;margin-top:4px;}
th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;} th{background:#f5f5f5;}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px;}
.kpi{border:1px solid #e5e5e5;border-radius:6px;padding:10px;}
.kpi .l{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.05em;}
.kpi .v{font-size:18px;font-weight:600;margin-top:2px;}
@media print{@page{margin:16mm;}}
</style></head><body>
<h1>Executive Report</h1>
<div class="muted">${esc(propName)} · ${esc(from)} → ${esc(to)} · Generated ${esc(new Date().toLocaleString())}</div>
<div class="kpis">
  <div class="kpi"><div class="l">Total revenue</div><div class="v">${esc(cur(k.revenue))}</div></div>
  <div class="kpi"><div class="l">Occupancy</div><div class="v">${esc(fmt(k.occupancy_pct, "%"))}</div></div>
  <div class="kpi"><div class="l">ADR</div><div class="v">${esc(cur(k.adr))}</div></div>
  <div class="kpi"><div class="l">RevPAR</div><div class="v">${esc(cur(k.revpar))}</div></div>
  <div class="kpi"><div class="l">Room revenue</div><div class="v">${esc(cur(k.room_revenue))}</div></div>
  <div class="kpi"><div class="l">POS revenue</div><div class="v">${esc(cur(k.pos_revenue))}</div></div>
  <div class="kpi"><div class="l">Cancellations</div><div class="v">${esc(fmt(k.cancellation_rate, "%"))}</div></div>
  <div class="kpi"><div class="l">Avg LOS</div><div class="v">${esc(fmt(k.avg_los))} nts</div></div>
</div>
<h2>Revenue by source</h2>
<table><thead><tr><th>Source</th><th>Reservations</th><th>Revenue</th></tr></thead><tbody>
${(sources.data ?? []).map((r: any) => `<tr><td>${esc(r.source)}</td><td>${esc(r.reservations)}</td><td>${esc(cur(r.revenue))}</td></tr>`).join("")}
</tbody></table>
<h2>Top room types</h2>
<table><thead><tr><th>Room type</th><th>Nights</th><th>Revenue</th></tr></thead><tbody>
${(top.data ?? []).map((r: any) => `<tr><td>${esc(r.room_type)}</td><td>${esc(r.nights)}</td><td>${esc(cur(r.revenue))}</td></tr>`).join("")}
</tbody></table>
<h2>Daily revenue</h2>
<table><thead><tr><th>Day</th><th>Rooms</th><th>POS</th><th>Total</th></tr></thead><tbody>
${(daily.data ?? []).map((r: any) => `<tr><td>${esc(r.day)}</td><td>${esc(cur(r.room_revenue))}</td><td>${esc(cur(r.pos_revenue))}</td><td>${esc(cur(r.total))}</td></tr>`).join("")}
</tbody></table>
<script>window.onload=()=>{setTimeout(()=>window.print(),300);};</script>
</body></html>`;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.open(); w.document.write(html); w.document.close();
  }

  if (!rolesLoading && propertyId && !allowed) {
    return <AccessDenied message="Executive analytics are restricted to owners, general managers, and accountants for this property." />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Executive Analytics</h1>
          <p className="text-sm text-muted-foreground">
            Occupancy, ADR, RevPAR and revenue trends across the selected period.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div><Label className="text-xs">From</Label>
            <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="w-[150px]" /></div>
          <div><Label className="text-xs">To</Label>
            <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="w-[150px]" /></div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={!enabled}>
                <Download className="h-4 w-4 mr-1" />Export<ChevronDown className="h-3 w-3 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={exportKpisCsv}><Download className="h-4 w-4 mr-2" />KPIs (CSV)</DropdownMenuItem>
              <DropdownMenuItem onClick={exportDailyCsv}><Download className="h-4 w-4 mr-2" />Daily revenue (CSV)</DropdownMenuItem>
              <DropdownMenuItem onClick={exportSourceCsv}><Download className="h-4 w-4 mr-2" />Revenue by source (CSV)</DropdownMenuItem>
              <DropdownMenuItem onClick={exportTopCsv}><Download className="h-4 w-4 mr-2" />Top room types (CSV)</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={exportPdf}><FileText className="h-4 w-4 mr-2" />Full report (PDF)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>


      {!propertyId && <p className="text-sm text-muted-foreground">Select a property to view analytics.</p>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Total revenue" value={kpis.data?.revenue} loading={kpis.isLoading} currency={currency} />
        <Kpi label="Occupancy" value={kpis.data?.occupancy_pct} loading={kpis.isLoading} suffix="%" />
        <Kpi label="ADR" value={kpis.data?.adr} loading={kpis.isLoading} currency={currency} />
        <Kpi label="RevPAR" value={kpis.data?.revpar} loading={kpis.isLoading} currency={currency} />
        <Kpi label="Room revenue" value={kpis.data?.room_revenue} loading={kpis.isLoading} currency={currency} />
        <Kpi label="POS revenue" value={kpis.data?.pos_revenue} loading={kpis.isLoading} currency={currency} />
        <Kpi label="Cancellation rate" value={kpis.data?.cancellation_rate} loading={kpis.isLoading} suffix="%" />
        <Kpi label="Avg length of stay" value={kpis.data?.avg_los} loading={kpis.isLoading} suffix=" nts" />
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Daily revenue</CardTitle></CardHeader>
        <CardContent className="h-[280px]">
          {daily.isLoading ? <Skeleton className="h-full w-full" /> : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={dailyData}>
                <defs>
                  <linearGradient id="gRooms" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.6} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="day" fontSize={11} />
                <YAxis fontSize={11} />
                <Tooltip formatter={(v: number) => money(v)} contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))" }} />
                <Area type="monotone" dataKey="rooms" stroke="hsl(var(--primary))" fill="url(#gRooms)" />
                <Area type="monotone" dataKey="pos" stroke="hsl(var(--chart-2, 200 70% 50%))" fillOpacity={0.15} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Revenue by source</CardTitle></CardHeader>
          <CardContent className="h-[260px]">
            {sources.isLoading ? <Skeleton className="h-full w-full" /> : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={sourceData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={90} paddingAngle={2}>
                    {sourceData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => money(v)} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Top room types</CardTitle></CardHeader>
          <CardContent className="h-[260px]">
            {top.isLoading ? <Skeleton className="h-full w-full" /> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={(top.data ?? []).map((r: any) => ({ name: r.room_type, revenue: Number(r.revenue), nights: Number(r.nights) }))}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="name" fontSize={11} />
                  <YAxis fontSize={11} />
                  <Tooltip formatter={(v: number) => money(v)} contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))" }} />
                  <Bar dataKey="revenue" fill="hsl(var(--primary))" radius={[4,4,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Source breakdown</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Source</TableHead><TableHead className="text-right">Reservations</TableHead><TableHead className="text-right">Revenue</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {(sources.data ?? []).map((r: any) => (
                <TableRow key={r.source}>
                  <TableCell className="capitalize">{r.source}</TableCell>
                  <TableCell className="text-right">{r.reservations}</TableCell>
                  <TableCell className="text-right font-mono">{money(r.revenue)}</TableCell>
                </TableRow>
              ))}
              {sources.data?.length === 0 && <TableRow><TableCell colSpan={3} className="py-6 text-center text-muted-foreground">No reservations in this period.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ScheduledExportsSection propertyId={propertyId} />
    </div>
  );
}

const DOW_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function ScheduledExportsSection({ propertyId }: { propertyId: string | null }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listExportSchedules);
  const runsFn = useServerFn(listExportRuns);
  const delFn = useServerFn(deleteExportSchedule);
  const runNowFn = useServerFn(runExportScheduleNow);
  const [editing, setEditing] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const schedules = useQuery({
    queryKey: ["export-schedules", propertyId], enabled: !!propertyId,
    queryFn: () => listFn({ data: { propertyId: propertyId! } }),
  });
  const runs = useQuery({
    queryKey: ["export-runs", propertyId], enabled: !!propertyId,
    queryFn: () => runsFn({ data: { propertyId: propertyId! } }),
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["export-schedules", propertyId] });
    qc.invalidateQueries({ queryKey: ["export-runs", propertyId] });
  };

  async function remove(id: string) {
    if (!propertyId || !confirm("Delete this schedule?")) return;
    try { await delFn({ data: { id, propertyId } }); toast.success("Deleted"); invalidate(); }
    catch (e: any) { toast.error(e.message); }
  }
  async function runNow(id: string) {
    if (!propertyId) return;
    setBusyId(id);
    try {
      const r = await runNowFn({ data: { scheduleId: id, propertyId } });
      if (r.status === "sent") toast.success(`Sent to ${r.recipients} recipient(s)`);
      else toast.error(r.error ?? "Send failed — check delivery configuration");
    } catch (e: any) { toast.error(e.message); }
    finally { setBusyId(null); invalidate(); }
  }

  function scheduleLabel(s: any): string {
    const hh = String(s.hour ?? 6).padStart(2, "0");
    if (s.frequency === "daily") return `Daily @ ${hh}:00 UTC`;
    if (s.frequency === "weekly") return `Weekly ${DOW_NAMES[s.day_of_week ?? 1]} @ ${hh}:00 UTC`;
    return `Monthly day ${s.day_of_month ?? 1} @ ${hh}:00 UTC`;
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2"><Mail className="h-4 w-4" />Scheduled email exports</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">Automatically email KPI CSV and PDF reports to authorized recipients.</p>
          </div>
          <Button size="sm" onClick={() => setCreating(true)} disabled={!propertyId}>
            <Plus className="h-4 w-4 mr-1" />New schedule
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Name</TableHead><TableHead>Schedule</TableHead><TableHead>Format</TableHead>
              <TableHead>Recipients</TableHead><TableHead>Next run</TableHead><TableHead>Last</TableHead>
              <TableHead>Active</TableHead><TableHead></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {schedules.data?.map((s: any) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell className="text-xs">{scheduleLabel(s)}</TableCell>
                  <TableCell><Badge variant="outline" className="text-[10px]">{s.format.toUpperCase()}</Badge></TableCell>
                  <TableCell className="text-xs">{s.recipients?.length ?? 0}</TableCell>
                  <TableCell className="text-xs">{s.next_run_at ? new Date(s.next_run_at).toLocaleString() : "—"}</TableCell>
                  <TableCell><RunStatusBadge status={s.last_run_status} error={s.last_run_error} /></TableCell>
                  <TableCell>{s.is_active ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <XCircle className="h-4 w-4 text-muted-foreground" />}</TableCell>
                  <TableCell className="text-right space-x-1">
                    <Button size="sm" variant="outline" disabled={busyId === s.id} onClick={() => runNow(s.id)}>
                      <Play className="h-3 w-3 mr-1" />Run now
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => setEditing(s)}><Pencil className="h-4 w-4" /></Button>
                    <Button size="icon" variant="ghost" onClick={() => remove(s.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </TableCell>
                </TableRow>
              ))}
              {schedules.data?.length === 0 && (
                <TableRow><TableCell colSpan={8} className="py-6 text-center text-muted-foreground">No scheduled exports yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {(creating || editing) && (
        <ScheduleDialog
          propertyId={propertyId}
          schedule={editing}
          open
          onOpenChange={(o) => { if (!o) { setCreating(false); setEditing(null); } }}
          onSaved={() => { setCreating(false); setEditing(null); invalidate(); }}
        />
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Recent deliveries</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Sent</TableHead><TableHead>Period</TableHead><TableHead>Format</TableHead>
              <TableHead>Recipients</TableHead><TableHead>Status</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {runs.data?.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="text-xs">{new Date(r.created_at).toLocaleString()}</TableCell>
                  <TableCell className="text-xs">{r.period_from} → {r.period_to}</TableCell>
                  <TableCell className="text-xs uppercase">{r.format}</TableCell>
                  <TableCell className="text-xs">{r.recipients?.join(", ")}</TableCell>
                  <TableCell><RunStatusBadge status={r.status} error={r.error} /></TableCell>
                </TableRow>
              ))}
              {runs.data?.length === 0 && (
                <TableRow><TableCell colSpan={5} className="py-6 text-center text-muted-foreground">No deliveries yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

function RunStatusBadge({ status, error }: { status: string | null; error?: string | null }) {
  if (!status) return <span className="text-xs text-muted-foreground">—</span>;
  const map: Record<string, { icon: any; cls: string; label: string }> = {
    sent: { icon: CheckCircle2, cls: "text-emerald-600", label: "Sent" },
    success: { icon: CheckCircle2, cls: "text-emerald-600", label: "Sent" },
    failed: { icon: XCircle, cls: "text-destructive", label: "Failed" },
    pending: { icon: Clock, cls: "text-amber-500 animate-pulse", label: "Pending" },
  };
  const m = map[status] ?? map.pending;
  const Icon = m.icon;
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${m.cls}`} title={error ?? ""}>
      <Icon className="h-3.5 w-3.5" />{m.label}
    </span>
  );
}

function ScheduleDialog({ propertyId, schedule, open, onOpenChange, onSaved }: {
  propertyId: string | null; schedule: any | null; open: boolean;
  onOpenChange: (o: boolean) => void; onSaved: () => void;
}) {
  const isEdit = !!schedule;
  const saveFn = useServerFn(upsertExportSchedule);
  const [name, setName] = useState(schedule?.name ?? "");
  const [frequency, setFrequency] = useState<string>(schedule?.frequency ?? "weekly");
  const [format, setFormat] = useState<string>(schedule?.format ?? "both");
  const [recipientsText, setRecipientsText] = useState((schedule?.recipients ?? []).join(", "));
  const [hour, setHour] = useState<number>(schedule?.hour ?? 6);
  const [dow, setDow] = useState<number>(schedule?.day_of_week ?? 1);
  const [dom, setDom] = useState<number>(schedule?.day_of_month ?? 1);
  const [isActive, setIsActive] = useState<boolean>(schedule?.is_active ?? true);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!propertyId) return toast.error("Select a property first");
    if (!name.trim()) return toast.error("Name required");
    const emails: string[] = recipientsText.split(/[,\s]+/).map((s: string) => s.trim()).filter(Boolean);
    if (emails.length === 0) return toast.error("At least one recipient email required");
    const invalid = emails.filter((e: string) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (invalid.length) return toast.error(`Invalid email(s): ${invalid.join(", ")}`);
    setBusy(true);
    try {
      await saveFn({ data: {
        id: schedule?.id, propertyId, name: name.trim(), frequency: frequency as any,
        format: format as any, recipients: emails, hour,
        dayOfWeek: frequency === "weekly" ? dow : null,
        dayOfMonth: frequency === "monthly" ? dom : null,
        isActive,
      }});
      toast.success(isEdit ? "Schedule updated" : "Schedule created");
      onSaved();
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit schedule" : "New scheduled export"}</DialogTitle>
          <DialogDescription>
            Only users with executive analytics access to this property can create schedules or receive reports.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekly board report" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Frequency</Label>
              <Select value={frequency} onValueChange={setFrequency}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Format</Label>
              <Select value={format} onValueChange={setFormat}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="csv">CSV</SelectItem>
                  <SelectItem value="pdf">PDF (printable HTML)</SelectItem>
                  <SelectItem value="both">Both</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Hour (UTC)</Label>
              <Input type="number" min={0} max={23} value={hour} onChange={(e) => setHour(Number(e.target.value))} />
            </div>
            {frequency === "weekly" && (
              <div>
                <Label>Day of week</Label>
                <Select value={String(dow)} onValueChange={(v) => setDow(Number(v))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{DOW_NAMES.map((d, i) => <SelectItem key={i} value={String(i)}>{d}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            )}
            {frequency === "monthly" && (
              <div>
                <Label>Day of month (1–28)</Label>
                <Input type="number" min={1} max={28} value={dom} onChange={(e) => setDom(Number(e.target.value))} />
              </div>
            )}
          </div>
          <div>
            <Label>Recipient emails (comma or newline separated)</Label>
            <Textarea value={recipientsText} onChange={(e) => setRecipientsText(e.target.value)}
              placeholder="owner@example.com, gm@example.com" rows={3} />
          </div>
          <div className="flex items-center gap-2"><Switch checked={isActive} onCheckedChange={setIsActive} /><Label>Active</Label></div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={busy}>{busy ? "Saving…" : isEdit ? "Save changes" : "Create schedule"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Kpi({ label, value, loading, currency, suffix }: { label: string; value: any; loading: boolean; currency?: string; suffix?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        {loading ? <Skeleton className="h-7 w-24 mt-1" /> : (
          <div className="text-2xl font-semibold mt-1">
            {currency ? execMoney(value, currency) : execNumber(value, suffix)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
