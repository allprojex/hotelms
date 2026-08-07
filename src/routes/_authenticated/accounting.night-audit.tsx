import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Moon, AlertTriangle, CheckCircle2, XCircle, Lock, PlayCircle } from "lucide-react";
import { toast } from "sonner";
import { format, subDays } from "date-fns";
import { AccountingWorkspaceShell } from "@/components/accounting/accounting-workspace-nav";

export const Route = createFileRoute("/_authenticated/accounting/night-audit")({
  head: () => ({ meta: [{ title: "Night Audit · Accounting" }] }),
  component: () => (
    <AccountingWorkspaceShell>
      <NightAuditPage />
    </AccountingWorkspaceShell>
  ),
});

function fmt(n: number, c = "GHS") { return new Intl.NumberFormat(undefined, { style: "currency", currency: c }).format(n); }

function NightAuditPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const [businessDate, setBusinessDate] = useState(format(subDays(new Date(), 1), "yyyy-MM-dd"));
  const [lockPeriod, setLockPeriod] = useState(false);

  const audits = useQuery({
    queryKey: ["night-audits", propertyId],
    queryFn: async () => {
      const { data, error } = await supabase.from("night_audits").select("*")
        .eq("property_id", propertyId!).order("business_date", { ascending: false }).limit(30);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!propertyId,
  });

  const preview = useQuery({
    queryKey: ["night-preview", propertyId, businessDate],
    queryFn: async () => {
      const [dep, arr, occ, open_pos] = await Promise.all([
        supabase.from("reservations").select("id", { count: "exact", head: true })
          .eq("property_id", propertyId!).eq("check_out", businessDate).eq("status", "checked_in"),
        supabase.from("reservations").select("id", { count: "exact", head: true })
          .eq("property_id", propertyId!).eq("check_in", businessDate),
        supabase.from("reservations").select("id", { count: "exact", head: true })
          .eq("property_id", propertyId!).eq("status", "checked_in")
          .lte("check_in", businessDate).gt("check_out", businessDate),
        supabase.from("pos_orders").select("id", { count: "exact", head: true })
          .eq("property_id", propertyId!).in("status", ["open", "sent"]),
      ]);
      return {
        pending_checkouts: dep.count ?? 0,
        arrivals: arr.count ?? 0,
        rooms_occupied: occ.count ?? 0,
        open_pos: open_pos.count ?? 0,
      };
    },
    enabled: !!propertyId,
  });

  const run = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("run_night_audit", {
        _property_id: propertyId!, _business_date: businessDate, _lock_period: lockPeriod,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Night audit complete");
      qc.invalidateQueries({ queryKey: ["night-audits", propertyId] });
      qc.invalidateQueries({ queryKey: ["night-preview", propertyId, businessDate] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const latest = (audits.data ?? [])[0];

  if (!propertyId) return <div className="p-6 text-muted-foreground">Select a property.</div>;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-display font-semibold flex items-center gap-2"><Moon className="h-6 w-6" /> Night Audit</h1>
          <p className="text-sm text-muted-foreground">End-of-day close: post pending transactions and lock the day.</p>
        </div>
      </div>

      <Card>
        <CardHeader className="py-3"><CardTitle className="text-sm">Run audit</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <div><Label>Business date</Label><Input type="date" value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} /></div>
            <div className="flex items-center gap-2 h-9"><Switch checked={lockPeriod} onCheckedChange={setLockPeriod} /><Label className="cursor-pointer">Lock period after run</Label></div>
            <Button className="md:col-span-2" onClick={() => run.mutate()} disabled={run.isPending}>
              <PlayCircle className="h-4 w-4 mr-1" /> {run.isPending ? "Running audit…" : "Run night audit"}
            </Button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Pending check-outs</div><div className="text-xl font-semibold">{preview.data?.pending_checkouts ?? "—"}</div></CardContent></Card>
            <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Arrivals</div><div className="text-xl font-semibold">{preview.data?.arrivals ?? "—"}</div></CardContent></Card>
            <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Rooms occupied</div><div className="text-xl font-semibold">{preview.data?.rooms_occupied ?? "—"}</div></CardContent></Card>
            <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Open POS orders</div><div className="text-xl font-semibold text-amber-500">{preview.data?.open_pos ?? "—"}</div></CardContent></Card>
          </div>
        </CardContent>
      </Card>

      {latest && (
        <Card>
          <CardHeader className="py-3 flex flex-row items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              {latest.status === "completed" ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> :
               latest.status === "failed" ? <XCircle className="h-4 w-4 text-destructive" /> :
               <AlertTriangle className="h-4 w-4 text-amber-500" />}
              Latest audit · {latest.business_date}
              {latest.period_locked && <Badge variant="outline" className="text-[10px] gap-1"><Lock className="h-3 w-3" /> Locked</Badge>}
            </CardTitle>
            <Badge variant={latest.status === "completed" ? "outline" : "destructive"}>{latest.status}</Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Metric label="Rooms occupied" value={String(latest.rooms_occupied)} />
              <Metric label="Arrivals" value={String(latest.arrivals)} />
              <Metric label="Departures" value={String(latest.departures)} />
              <Metric label="No-shows" value={String(latest.no_shows)} />
              <Metric label="Room revenue" value={fmt(Number(latest.room_revenue))} />
              <Metric label="F&B revenue" value={fmt(Number(latest.fnb_revenue))} />
              <Metric label="Tax collected" value={fmt(Number(latest.tax_collected))} />
              <Metric label="Cash in" value={fmt(Number(latest.cash_in))} />
            </div>
            {Array.isArray(latest.warnings) && latest.warnings.length > 0 && (
              <div>
                <div className="text-xs font-medium mb-1 flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-amber-500" /> Warnings ({latest.warnings.length})</div>
                <div className="border rounded-md divide-y">
                  {(latest.warnings as any[]).map((w, i) => (
                    <div key={i} className="px-3 py-2 text-xs font-mono flex justify-between">
                      <span className="uppercase text-amber-600 dark:text-amber-400">{w.type}</span>
                      <span className="text-muted-foreground truncate">{w.code ?? w.reservation_id ?? w.order_id ?? ""}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {Array.isArray(latest.errors) && latest.errors.length > 0 && (
              <div>
                <div className="text-xs font-medium mb-1 flex items-center gap-1"><XCircle className="h-3 w-3 text-destructive" /> Errors ({latest.errors.length})</div>
                <div className="border rounded-md divide-y border-destructive/40">
                  {(latest.errors as any[]).map((e, i) => (
                    <div key={i} className="px-3 py-2 text-xs">
                      <div className="font-mono uppercase text-destructive">{e.type}</div>
                      <div className="text-muted-foreground">{e.error}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="py-3"><CardTitle className="text-sm">History</CardTitle></CardHeader>
        <CardContent className="p-0">
          {(audits.data ?? []).map((a: any) => (
            <div key={a.id} className="flex items-center justify-between px-4 py-2 border-b last:border-0">
              <div className="flex items-center gap-3">
                <span className="font-mono text-xs w-24">{a.business_date}</span>
                <Badge variant="outline" className="text-[10px] uppercase">{a.status}</Badge>
                {a.period_locked && <Badge variant="outline" className="text-[10px] gap-1"><Lock className="h-3 w-3" /> locked</Badge>}
              </div>
              <div className="flex items-center gap-4 text-xs font-mono text-muted-foreground">
                <span>Occ {a.rooms_occupied}</span>
                <span>Rev {fmt(Number(a.room_revenue) + Number(a.fnb_revenue))}</span>
                <span className="text-amber-500">⚠ {(a.warnings as any[])?.length ?? 0}</span>
                <span className="text-destructive">✗ {(a.errors as any[])?.length ?? 0}</span>
              </div>
            </div>
          ))}
          {(audits.data ?? []).length === 0 && <div className="p-6 text-center text-sm text-muted-foreground">No audits run yet.</div>}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="text-lg font-mono">{value}</div></CardContent></Card>;
}
