import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Building2, BedDouble, LogIn, LogOut, Users, DollarSign, Sparkles, RefreshCw, TrendingUp, TrendingDown, Timer } from "lucide-react";
import { format } from "date-fns";
import { Line, LineChart, ResponsiveContainer, Tooltip as RTooltip } from "recharts";
import { getBusinessInsights, type Insight } from "@/lib/insights.functions";
import { DashboardSearch } from "@/components/dashboard-search";

// --- Shared refresh interval (persisted to localStorage) -------------------
const INTERVAL_KEY = "pms.dashboard.refreshMs";
const INTERVAL_OPTIONS: { label: string; value: number }[] = [
  { label: "Off", value: 0 },
  { label: "30 s", value: 30_000 },
  { label: "1 min", value: 60_000 },
  { label: "5 min", value: 5 * 60_000 },
  { label: "15 min", value: 15 * 60_000 },
];
const intervalSubs = new Set<() => void>();
function readInterval(): number {
  if (typeof window === "undefined") return 60_000;
  const v = Number(window.localStorage.getItem(INTERVAL_KEY));
  return Number.isFinite(v) && v >= 0 ? v : 60_000;
}
function writeInterval(v: number) {
  if (typeof window !== "undefined") window.localStorage.setItem(INTERVAL_KEY, String(v));
  intervalSubs.forEach((cb) => cb());
}
function useRefreshInterval() {
  return useSyncExternalStore(
    (cb) => { intervalSubs.add(cb); return () => intervalSubs.delete(cb); },
    readInterval,
    () => 60_000,
  );
}

function RefreshIntervalControl() {
  const interval = useRefreshInterval();
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Timer className="h-3.5 w-3.5" />
      <span>Auto-refresh</span>
      <Select value={String(interval)} onValueChange={(v) => writeInterval(Number(v))}>
        <SelectTrigger className="h-8 w-[110px] text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          {INTERVAL_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={String(o.value)} className="text-xs">{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}


export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — ThesKwoff Hotel" }] }),
  component: DashboardPage,
});

function DashboardPage() {
  const propertyId = useActiveProperty();
  const today = new Date().toISOString().slice(0, 10);
  const interval = useRefreshInterval();
  const refetchInterval = interval > 0 ? interval : (false as const);

  const stats = useQuery({
    queryKey: ["dashboard-stats", propertyId, today],
    enabled: !!propertyId,
    refetchInterval,
    refetchOnWindowFocus: true,

    queryFn: async () => {
      const [rooms, arrivals, departures, inhouse, revenue] = await Promise.all([
        supabase.from("rooms").select("id,status", { count: "exact" }).eq("property_id", propertyId!),
        supabase.from("reservations").select("id", { count: "exact", head: true }).eq("property_id", propertyId!).eq("check_in", today).in("status", ["confirmed", "checked_in"]),
        supabase.from("reservations").select("id", { count: "exact", head: true }).eq("property_id", propertyId!).eq("check_out", today).in("status", ["checked_in", "checked_out"]),
        supabase.from("reservations").select("id", { count: "exact", head: true }).eq("property_id", propertyId!).eq("status", "checked_in"),
        // status filter: excludes refunded payments from "today's revenue" —
        // see 20260822130000_reservation_payment_refund.sql. `payments.status`
        // is not yet in the generated Supabase types, so the query builder
        // is cast to `any` here, matching the established precedent for
        // ap_payments/ar_receipts (accounting.ap.tsx, accounting.ar.tsx).
        (supabase as any).from("payments").select("amount, reservations!inner(property_id)").eq("reservations.property_id", propertyId!).eq("status", "posted").gte("received_at", today),
      ]);
      const totalRooms = rooms.count ?? 0;
      const occupied = (rooms.data ?? []).filter((r) => r.status === "occupied").length;
      const revenueToday = (revenue.data ?? []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
      return {
        totalRooms,
        occupied,
        occupancy: totalRooms > 0 ? Math.round((occupied / totalRooms) * 100) : 0,
        arrivals: arrivals.count ?? 0,
        departures: departures.count ?? 0,
        inhouse: inhouse.count ?? 0,
        revenueToday,
      };
    },
  });

  const arrivalsList = useQuery({
    queryKey: ["arrivals-today", propertyId, today],
    enabled: !!propertyId,
    refetchInterval,
    queryFn: async () => {
      const { data, error } = await supabase.from("reservations")
        .select("id, code, check_in, check_out, adults, children, status, guests(first_name,last_name), room_types(name), rooms(number)")
        .eq("property_id", propertyId!).eq("check_in", today).order("created_at");
      if (error) throw error;
      return data;
    },
  });

  if (!propertyId) return <EmptyProperty />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Today</h1>
          <p className="text-sm text-muted-foreground">{format(new Date(), "EEEE, MMMM d, yyyy")}</p>
        </div>
        <div className="flex items-center gap-2">
          <DashboardSearch propertyId={propertyId} />
          <RefreshIntervalControl />
        </div>
      </div>


      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat title="Occupancy" value={`${stats.data?.occupancy ?? 0}%`} sub={`${stats.data?.occupied ?? 0}/${stats.data?.totalRooms ?? 0} rooms`} icon={BedDouble} accent />
        <Stat title="Arrivals" value={stats.data?.arrivals ?? 0} sub="scheduled today" icon={LogIn} />
        <Stat title="Departures" value={stats.data?.departures ?? 0} sub="scheduled today" icon={LogOut} />
        <Stat title="In-house guests" value={stats.data?.inhouse ?? 0} sub="currently staying" icon={Users} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">Today's arrivals</CardTitle></CardHeader>
          <CardContent>
            {arrivalsList.data && arrivalsList.data.length > 0 ? (
              <div className="divide-y">
                {arrivalsList.data.map((r: any) => (
                  <div key={r.id} className="flex items-center justify-between py-3">
                    <div>
                      <div className="font-medium">{r.guests?.first_name} {r.guests?.last_name}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.code} · {r.room_types?.name} {r.rooms?.number ? `· Room ${r.rooms.number}` : "· unassigned"}
                      </div>
                    </div>
                    <Badge variant={r.status === "checked_in" ? "default" : "secondary"}>{r.status.replace("_", " ")}</Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-6 text-center">No arrivals today.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Revenue today</CardTitle></CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium text-primary">GHS</span>
              <span className="text-3xl font-semibold">{(stats.data?.revenueToday ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Payments received since midnight.</p>
          </CardContent>
        </Card>
      </div>

      <TrendStrip propertyId={propertyId} />
      <AIInsightsCard propertyId={propertyId} />
    </div>
  );
}

function TrendStrip({ propertyId }: { propertyId: string }) {
  const fetchInsights = useServerFn(getBusinessInsights);
  const interval = useRefreshInterval();
  // AI insights are expensive: refresh at least 5 min, and only when auto-refresh is on.
  const biInterval = interval > 0 ? Math.max(interval, 5 * 60_000) : (false as const);
  const q = useQuery({
    queryKey: ["bi-insights", propertyId],
    queryFn: () => fetchInsights({ data: { propertyId } }),
    staleTime: 5 * 60_000,
    refetchInterval: biInterval,
    refetchOnWindowFocus: false,
  });
  const days = q.data?.days ?? [];
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Spark title="Occupancy (7d)" data={days} valueKey="occupancy" suffix="%" />
      <Spark title="Revenue (7d)" data={days} valueKey="revenue" />
      <Spark title="Arrivals (7d)" data={days} valueKey="arrivals" />
    </div>
  );
}


function Spark({ title, data, valueKey, suffix }: { title: string; data: any[]; valueKey: string; suffix?: string }) {
  const last = data[data.length - 1]?.[valueKey] ?? 0;
  const prev = data[data.length - 2]?.[valueKey] ?? 0;
  const up = Number(last) >= Number(prev);
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">{title}</span>
          {up ? <TrendingUp className="h-4 w-4 text-primary" /> : <TrendingDown className="h-4 w-4 text-muted-foreground" />}
        </div>
        <div className="mt-1 text-2xl font-semibold">
          {typeof last === "number" ? last.toLocaleString() : last}{suffix ?? ""}
        </div>
        <div className="mt-2 h-12">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <RTooltip
                contentStyle={{ fontSize: 11, padding: "4px 8px" }}
                formatter={(v: any) => [`${Number(v).toLocaleString()}${suffix ?? ""}`, title]}
              />
              <Line type="monotone" dataKey={valueKey} stroke="var(--primary)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function AIInsightsCard({ propertyId }: { propertyId: string }) {
  const fetchInsights = useServerFn(getBusinessInsights);
  const interval = useRefreshInterval();
  const biInterval = interval > 0 ? Math.max(interval, 5 * 60_000) : (false as const);
  const q = useQuery({
    queryKey: ["bi-insights", propertyId],
    queryFn: () => fetchInsights({ data: { propertyId } }),
    staleTime: 5 * 60_000,
    refetchInterval: biInterval,
    refetchOnWindowFocus: false,
  });

  const insights: Insight[] = q.data?.insights ?? [];
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" /> AI insights
        </CardTitle>
        <Button size="sm" variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${q.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground py-4">Analyzing last 7 days…</p>
        ) : insights.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">No insights yet. Try refreshing.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            {insights.map((ins, i) => (
              <div
                key={i}
                className={`rounded-lg border p-3 ${
                  ins.severity === "warning"
                    ? "border-warning/40 bg-warning/5"
                    : ins.severity === "positive"
                    ? "border-success/40 bg-success/5"
                    : "border-border bg-muted/30"
                }`}
              >
                <div className="text-sm font-semibold">{ins.title}</div>
                <div className="mt-1 text-xs text-muted-foreground">{ins.body}</div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ title, value, sub, icon: Icon, accent }: { title: string; value: React.ReactNode; sub?: string; icon: any; accent?: boolean }) {
  return (
    <Card className={accent ? "shadow-[var(--shadow-elegant)]" : ""}>
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">{title}</span>
          <Icon className={`h-4 w-4 ${accent ? "text-primary" : "text-muted-foreground"}`} />
        </div>
        <div className="mt-2 text-3xl font-semibold">{value}</div>
        {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function EmptyProperty() {
  return (
    <div className="mx-auto max-w-md rounded-2xl border bg-card p-8 text-center">
      <Building2 className="mx-auto h-10 w-10 text-muted-foreground" />
      <h2 className="mt-3 text-lg font-semibold">No property selected</h2>
      <p className="mt-1 text-sm text-muted-foreground">Choose a property from the top bar to load your dashboard.</p>
    </div>
  );
}
