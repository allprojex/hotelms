import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { runChannelSync, testChannelSync } from "@/lib/channels.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Radio, RefreshCw, Plus, Inbox, ExternalLink, Zap } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";

export const Route = createFileRoute("/_authenticated/channels/")({
  head: () => ({ meta: [{ title: pageTitle("Channel Manager") }] }),
  component: ChannelsIndex,
});

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    idle: "bg-muted text-muted-foreground",
    syncing: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    success: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    failed: "bg-destructive/15 text-destructive",
  };
  return <Badge className={map[status] ?? map.idle} variant="outline">{status}</Badge>;
}

function ChannelsIndex() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "Booking.com", external_hotel_id: "" });

  const channels = useQuery({
    queryKey: ["channels", propertyId],
    queryFn: async () => {
      if (!propertyId) return [];
      const { data, error } = await supabase
        .from("channels")
        .select("*")
        .eq("property_id", propertyId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
    enabled: !!propertyId,
  });

  const queue = useQuery({
    queryKey: ["channel-queue-pending", propertyId],
    queryFn: async () => {
      const { count } = await supabase
        .from("channel_reservations_queue")
        .select("id", { count: "exact", head: true })
        .eq("property_id", propertyId!)
        .eq("status", "pending");
      return count ?? 0;
    },
    enabled: !!propertyId,
  });

  // Realtime: refresh channels list on sync log inserts
  useEffect(() => {
    if (!propertyId) return;
    const ch = supabase
      .channel(`csl-${propertyId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "channel_sync_logs", filter: `property_id=eq.${propertyId}` }, () => {
        qc.invalidateQueries({ queryKey: ["channels", propertyId] });
        qc.invalidateQueries({ queryKey: ["channel-queue-pending", propertyId] });
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [propertyId, qc]);

  const syncFn = useServerFn(runChannelSync);
  const syncMut = useMutation({
    mutationFn: (channelId: string) => syncFn({ data: { channelId, direction: "both" } }),
    onSuccess: (r) => {
      toast.success(`Sync complete${r.queued ? ` · ${r.queued} inbound` : ""}`);
      qc.invalidateQueries({ queryKey: ["channels", propertyId] });
      qc.invalidateQueries({ queryKey: ["channel-queue-pending", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const createMut = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("channels").insert({
        property_id: propertyId!,
        type: "booking_com",
        name: form.name,
        external_hotel_id: form.external_hotel_id || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Channel connected");
      setOpen(false);
      setForm({ name: "Booking.com", external_hotel_id: "" });
      qc.invalidateQueries({ queryKey: ["channels", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleMut = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { error } = await supabase.from("channels").update({ is_active: active }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["channels", propertyId] }),
  });

  if (!propertyId) return <div className="p-6 text-sm text-muted-foreground">Select a property first.</div>;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold flex items-center gap-2">
            <Radio className="h-6 w-6 text-primary" /> Channel Manager
          </h1>
          <p className="text-sm text-muted-foreground">Two-way sync with OTAs (mock Booking.com adapter).</p>
        </div>
        <div className="flex gap-2">
          {(queue.data ?? 0) > 0 && (
            <Badge variant="outline" className="bg-amber-500/15 text-amber-600 dark:text-amber-400 gap-1">
              <Inbox className="h-3 w-3" /> {queue.data} pending
            </Badge>
          )}
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm"><Plus className="h-4 w-4 mr-1" /> Connect channel</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Connect Booking.com</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div><Label>Channel name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
                <div><Label>External hotel ID (mock)</Label><Input value={form.external_hotel_id} onChange={(e) => setForm({ ...form, external_hotel_id: e.target.value })} placeholder="e.g. 1234567" /></div>
              </div>
              <DialogFooter>
                <Button onClick={() => createMut.mutate()} disabled={createMut.isPending}>Connect</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {channels.data?.length === 0 && (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
          No channels connected yet. Click "Connect channel" to add a mock Booking.com integration.
        </CardContent></Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {channels.data?.map((c) => (
          <Card key={c.id}>
            <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
              <div>
                <CardTitle className="text-base flex items-center gap-2">{c.name}</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">{c.type} · {c.external_hotel_id ?? "no hotel ID"}</p>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={c.last_sync_status} />
                <Switch checked={c.is_active} onCheckedChange={(v) => toggleMut.mutate({ id: c.id, active: v })} />
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <SyncStatusPanel
                channelId={c.id}
                isActive={c.is_active}
                lastSyncAt={c.last_sync_at}
                lastSyncError={c.last_sync_error}
                onFullSync={() => syncMut.mutate(c.id)}
                fullSyncPending={syncMut.isPending}
              />
              <div className="flex justify-end">
                <Button size="sm" variant="ghost" asChild>
                  <Link to="/channels/$id" params={{ id: c.id }}>
                    <ExternalLink className="h-3.5 w-3.5 mr-1" /> Manage
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

type TestResult = Awaited<ReturnType<ReturnType<typeof useServerFn<typeof testChannelSync>>>>;

function SyncStatusPanel({
  channelId,
  isActive,
  lastSyncAt,
  lastSyncError,
  onFullSync,
  fullSyncPending,
}: {
  channelId: string;
  isActive: boolean;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  onFullSync: () => void;
  fullSyncPending: boolean;
}) {
  const qc = useQueryClient();
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const logs = useQuery({
    queryKey: ["channel-status-logs", channelId],
    queryFn: async () => {
      const { data } = await supabase
        .from("channel_sync_logs")
        .select("id, direction, status, message, duration_ms, created_at")
        .eq("channel_id", channelId)
        .order("created_at", { ascending: false })
        .limit(10);
      return data ?? [];
    },
    // Poll fast while a sync is in-flight so progress feels live.
    refetchInterval: fullSyncPending ? 400 : 10000,
  });

  const testFn = useServerFn(testChannelSync);
  const testMut = useMutation({
    mutationFn: () => testFn({ data: { channelId } }),
    onSuccess: (r) => {
      setTestResult(r);
      if (r.ok) toast.success(`Test sync OK · ${r.rooms.length} room types · ${r.latency}ms`);
      else toast.error(`Test sync failed: ${r.error}`);
      qc.invalidateQueries({ queryKey: ["channel-status-logs", channelId] });
      qc.invalidateQueries({ queryKey: ["channels"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const counts = (logs.data ?? []).reduce(
    (acc, l) => {
      acc[l.status] = (acc[l.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  const lastError = (logs.data ?? []).find((l) => l.status === "failed");

  // Live progress for the currently-running Full sync.
  // A Full sync has 2 steps (push_ari + pull_reservations). We count them
  // by looking at logs since the mutation started.
  const [syncStartedAt, setSyncStartedAt] = useState<string | null>(null);
  useEffect(() => {
    if (fullSyncPending) setSyncStartedAt(new Date().toISOString());
  }, [fullSyncPending]);

  const activeSteps = (() => {
    const rows = logs.data ?? [];
    if (!syncStartedAt) return rows.slice(0, 0);
    const cutoff = new Date(syncStartedAt).getTime() - 500;
    return rows.filter((l) => new Date(l.created_at).getTime() >= cutoff).slice().reverse();
  })();


  const STEPS: Array<{ key: "push_ari" | "pull_reservations"; label: string }> = [
    { key: "push_ari", label: "Pushing availability & rates" },
    { key: "pull_reservations", label: "Pulling reservations" },
  ];
  const stepState = STEPS.map((s) => {
    const stepLogs = activeSteps.filter((l) => l.direction === s.key);
    const final = stepLogs.find((l) => l.status === "success" || l.status === "failed");
    const running = stepLogs.find((l) => l.status === "syncing");
    return {
      ...s,
      state: final ? final.status : running ? "syncing" : "pending",
      message: final?.message ?? running?.message ?? "Waiting…",
      duration: final?.duration_ms ?? 0,
    };
  });
  const completed = stepState.filter((s) => s.state === "success" || s.state === "failed").length;
  const progressPct = fullSyncPending ? Math.max(5, Math.round((completed / STEPS.length) * 100)) : 0;
  const showProgress = fullSyncPending || (syncStartedAt !== null && completed < STEPS.length && Date.now() - new Date(syncStartedAt).getTime() < 4000);


  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Last sync</span>
        <span className="font-medium">
          {lastSyncAt ? formatDistanceToNow(new Date(lastSyncAt), { addSuffix: true }) : "never"}
        </span>
      </div>
      <div className="flex items-center gap-2 text-[11px]">
        <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          ✓ {counts.success ?? 0}
        </Badge>
        <Badge variant="outline" className="bg-destructive/10 text-destructive">
          ✗ {counts.failed ?? 0}
        </Badge>
        <span className="text-muted-foreground ml-auto">recent 5</span>
      </div>

      {showProgress && (
        <div className="rounded border border-primary/30 bg-primary/5 p-2 space-y-2">
          <div className="flex items-center justify-between text-[11px] font-medium">
            <span className="flex items-center gap-1.5">
              <RefreshCw className="h-3 w-3 animate-spin text-primary" />
              Full sync in progress
            </span>
            <span className="text-muted-foreground">{completed}/{STEPS.length} steps</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <ul className="space-y-1 text-[11px]">
            {stepState.map((s) => (
              <li key={s.key} className="flex items-center gap-2">
                <span
                  className={
                    s.state === "success"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : s.state === "failed"
                        ? "text-destructive"
                        : s.state === "syncing"
                          ? "text-primary"
                          : "text-muted-foreground"
                  }
                >
                  {s.state === "success" ? "✓" : s.state === "failed" ? "✗" : s.state === "syncing" ? "●" : "○"}
                </span>
                <span className={s.state === "pending" ? "text-muted-foreground" : ""}>{s.label}</span>
                <span className="flex-1 truncate text-muted-foreground">— {s.message}</span>
                {s.duration > 0 && <span className="text-muted-foreground">{s.duration}ms</span>}
              </li>
            ))}
          </ul>
        </div>
      )}


      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => testMut.mutate()}
          disabled={testMut.isPending || !isActive}
        >
          <Zap className={`h-3 w-3 mr-1 ${testMut.isPending ? "animate-pulse" : ""}`} />
          {testMut.isPending ? "Testing…" : "Test sync"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={onFullSync}
          disabled={fullSyncPending || !isActive}
        >
          <RefreshCw className={`h-3 w-3 mr-1 ${fullSyncPending ? "animate-spin" : ""}`} />
          Full sync
        </Button>
      </div>

      {testResult && !testResult.ok && (
        <div className="rounded border border-destructive/30 bg-destructive/5 p-2 text-[11px] text-destructive">
          <div className="font-medium mb-0.5">Test sync failed</div>
          <div className="break-words">{testResult.error}</div>
        </div>
      )}
      {testResult && testResult.ok && (
        <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-2 text-[11px] space-y-1">
          <div className="flex items-center justify-between font-medium text-emerald-700 dark:text-emerald-400">
            <span>Live snapshot · {testResult.latency}ms</span>
            <span>{testResult.rooms.length} room types</span>
          </div>
          {testResult.rooms.length === 0 ? (
            <div className="text-muted-foreground">No room mappings configured — add mappings in Manage to see rates.</div>
          ) : (
            <ul className="space-y-0.5">
              {testResult.rooms.map((r) => (
                <li key={r.mapping_id} className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-muted-foreground">{r.external_code}</span>
                  <span className="truncate flex-1">{r.room_type}</span>
                  <span>{r.available_today} avail</span>
                  <span className="font-medium">{r.currency} {r.rate_today.toFixed(2)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!testResult && (lastSyncError || lastError) && (
        <div className="rounded border border-destructive/30 bg-destructive/5 p-2 text-[11px] text-destructive">
          <div className="font-medium mb-0.5">Last error</div>
          <div className="break-words">{lastSyncError ?? lastError?.message}</div>
        </div>
      )}
      {(logs.data ?? []).length > 0 && (
        <ul className="space-y-1 text-[11px]">
          {(logs.data ?? []).slice(0, 3).map((l) => (
            <li key={l.id} className="flex items-center gap-2 text-muted-foreground">
              <span className={l.status === "success" ? "text-emerald-600 dark:text-emerald-400" : l.status === "failed" ? "text-destructive" : ""}>●</span>
              <span className="font-mono">{l.direction}</span>
              <span className="truncate flex-1">{l.message}</span>
              <span>{l.duration_ms}ms</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
