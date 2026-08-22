import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { subDays, format, eachDayOfInterval } from "date-fns";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, LineChart, Line, CartesianGrid } from "recharts";

export const Route = createFileRoute("/_authenticated/reports")({
  head: () => ({ meta: [{ title: "Reports" }] }),
  component: ReportsPage,
});

function ReportsPage() {
  const propertyId = useActiveProperty();
  const days = 14;
  const end = new Date();
  const start = subDays(end, days - 1);

  const data = useQuery({
    queryKey: ["report", propertyId, days],
    enabled: !!propertyId,
    queryFn: async () => {
      const startStr = start.toISOString().slice(0, 10);
      const [{ data: rooms }, { data: res }, { data: pays }] = await Promise.all([
        supabase.from("rooms").select("id").eq("property_id", propertyId!),
        supabase.from("reservations").select("id,check_in,check_out,rate_total,status").eq("property_id", propertyId!).gte("check_out", startStr).in("status", ["checked_in", "checked_out"]),
        // status filter: excludes refunded payments from daily revenue — see
        // 20260822130000_reservation_payment_refund.sql. Cast to `any`
        // because `payments.status` is not yet in the generated Supabase
        // types (matching the ap_payments/ar_receipts precedent).
        (supabase as any).from("payments").select("amount, received_at, reservations!inner(property_id)").eq("reservations.property_id", propertyId!).eq("status", "posted").gte("received_at", startStr),
      ]);
      const roomCount = rooms?.length ?? 0;
      const range = eachDayOfInterval({ start, end });
      const series = range.map((d) => {
        const ds = d.toISOString().slice(0, 10);
        const occ = (res ?? []).filter((r: any) => r.check_in <= ds && r.check_out > ds).length;
        const rev = (pays ?? []).filter((p: any) => p.received_at.slice(0, 10) === ds).reduce((s: number, p: any) => s + Number(p.amount), 0);
        return { day: format(d, "MMM d"), occupancy: roomCount > 0 ? Math.round((occ / roomCount) * 100) : 0, revenue: rev };
      });
      const totalRev = series.reduce((s, d) => s + d.revenue, 0);
      const avgOcc = Math.round(series.reduce((s, d) => s + d.occupancy, 0) / series.length);
      const roomNights = (res ?? []).reduce((s: number, r: any) => {
        const ci = new Date(Math.max(new Date(r.check_in).getTime(), start.getTime()));
        const co = new Date(Math.min(new Date(r.check_out).getTime(), end.getTime() + 86400000));
        return s + Math.max(0, Math.round((co.getTime() - ci.getTime()) / 86400000));
      }, 0);
      const adr = roomNights > 0 ? totalRev / roomNights : 0;
      const revpar = roomCount > 0 ? totalRev / (roomCount * days) : 0;
      return { series, totalRev, avgOcc, adr, revpar, roomNights };
    },
  });

  const d = data.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="text-sm text-muted-foreground">Last {days} days · {format(start, "MMM d")} – {format(end, "MMM d, yyyy")}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat title="Revenue" value={(d?.totalRev ?? 0).toFixed(2)} />
        <Stat title="Avg Occupancy" value={`${d?.avgOcc ?? 0}%`} />
        <Stat title="ADR" value={(d?.adr ?? 0).toFixed(2)} sub="Avg daily rate" />
        <Stat title="RevPAR" value={(d?.revpar ?? 0).toFixed(2)} sub="Revenue / available room" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Occupancy trend</CardTitle></CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer>
              <LineChart data={d?.series ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="day" stroke="var(--color-muted-foreground)" fontSize={11} />
                <YAxis stroke="var(--color-muted-foreground)" fontSize={11} unit="%" />
                <Tooltip contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: 8 }} />
                <Line type="monotone" dataKey="occupancy" stroke="var(--color-primary)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Daily revenue</CardTitle></CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer>
              <BarChart data={d?.series ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="day" stroke="var(--color-muted-foreground)" fontSize={11} />
                <YAxis stroke="var(--color-muted-foreground)" fontSize={11} />
                <Tooltip contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: 8 }} />
                <Bar dataKey="revenue" fill="var(--color-primary)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({ title, value, sub }: { title: string; value: React.ReactNode; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">{title}</div>
        <div className="mt-2 text-2xl font-semibold">{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}
