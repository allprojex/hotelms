import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Play, RotateCcw, Download, Trash2, CheckCircle2, XCircle, Clock, Pencil, Eye, EyeOff, Copy, Zap } from "lucide-react";
import { toast } from "sonner";
import { runAccountingSync, retryFailedSync, getSyncRunCsv, testSyncWebhook } from "@/lib/accounting-sync.functions";

import { useHasAnyRole, SYNC_ROLES } from "@/hooks/use-user-roles";
import { AccessDenied } from "@/components/access-denied";
import { AccountingWorkspaceShell } from "@/components/accounting/accounting-workspace-nav";

export const Route = createFileRoute("/_authenticated/accounting/sync")({
  head: () => ({ meta: [{ title: "Accounting Sync" }] }),
  component: () => (
    <AccountingWorkspaceShell>
      <SyncPage />
    </AccountingWorkspaceShell>
  ),
});


const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function scheduleLabel(t: any): string {
  const hh = String(t.schedule_hour ?? 2).padStart(2, "0");
  switch (t.schedule) {
    case "manual": return "Manual";
    case "hourly": return "Hourly";
    case "daily": return `Daily @ ${hh}:00`;
    case "weekly": return `Weekly ${DOW[t.schedule_dow ?? 1]} @ ${hh}:00`;
    default: return t.schedule ?? "—";
  }
}

function SyncPage() {
  const propertyId = useActiveProperty();
  const { allowed, loading: rolesLoading } = useHasAnyRole(SYNC_ROLES, propertyId);
  const qc = useQueryClient();
  const runFn = useServerFn(runAccountingSync);
  const retryFn = useServerFn(retryFailedSync);
  const csvFn = useServerFn(getSyncRunCsv);
  const testFn = useServerFn(testSyncWebhook);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<any>(null);

  const targets = useQuery({
    queryKey: ["sync-targets", propertyId], enabled: !!propertyId,
    queryFn: async () => {
      const { data } = await supabase.from("accounting_sync_targets")
        .select("*").eq("property_id", propertyId!).order("created_at");
      return data ?? [];
    },
  });

  const runs = useQuery({
    queryKey: ["sync-runs", propertyId], enabled: !!propertyId,
    queryFn: async () => {
      const { data } = await supabase.from("accounting_sync_runs")
        .select("id, target_id, from_date, to_date, status, entries_count, response_status, error, started_at, finished_at, is_test")
        .eq("property_id", propertyId!).order("started_at", { ascending: false }).limit(50);
      return data ?? [];
    },
  });

  if (!rolesLoading && propertyId && !allowed) {
    return <AccessDenied message="Accounting sync targets can only be viewed by owners, general managers, and accountants." />;
  }


  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["sync-targets", propertyId] });
    qc.invalidateQueries({ queryKey: ["sync-runs", propertyId] });
  };

  async function syncNow(id: string) {
    setBusyId(id);
    try {
      const res = await runFn({ data: { targetId: id } });
      if (res.status === "success") toast.success(`Synced ${res.entriesCount ?? 0} entries`);
      else toast.error(res.error ?? "Sync failed");
    } catch (e: any) { toast.error(e.message); }
    finally { setBusyId(null); invalidate(); }
  }

  async function retry(runId: string) {
    setBusyId(runId);
    try {
      const res = await retryFn({ data: { runId } });
      if (res.status === "success") toast.success("Retry succeeded");
      else toast.error(res.error ?? "Retry failed");
    } catch (e: any) { toast.error(e.message); }
    finally { setBusyId(null); invalidate(); }
  }

  async function download(runId: string) {
    try {
      const res = await csvFn({ data: { runId } });
      if (!res.csv) return toast.error("No CSV payload on this run");
      const blob = new Blob([res.csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `journal-${res.fromDate}_${res.toDate}.csv`;
      a.click(); URL.revokeObjectURL(url);
    } catch (e: any) { toast.error(e.message); }
  }

  async function testWebhook(id: string) {
    setBusyId(id);
    try {
      const res = await testFn({ data: { targetId: id } });
      if (res.ok) toast.success(`Webhook test OK — HTTP ${res.status}`);
      else toast.error(`Webhook test failed — HTTP ${res.status || "network error"}: ${res.body || ""}`);
    } catch (e: any) { toast.error(e.message); }
    finally { setBusyId(null); invalidate(); }
  }

  async function toggleActive(t: any, v: boolean) {
    const { error } = await supabase.from("accounting_sync_targets").update({ is_active: v }).eq("id", t.id);
    if (error) return toast.error(error.message);
    invalidate();
  }

  async function remove(id: string) {
    if (!confirm("Delete this sync target?")) return;
    const { error } = await supabase.from("accounting_sync_targets").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Deleted");
    invalidate();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Accounting Sync</h1>
          <p className="text-sm text-muted-foreground">
            Push a daily journal summary (CSV) to an external accounting system via HMAC-signed webhook.
          </p>
        </div>
        <TargetDialog
          propertyId={propertyId}
          onDone={invalidate}
          target={null}
          trigger={<Button><Plus className="h-4 w-4 mr-1" />New target</Button>}
        />
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Sync targets</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Name</TableHead><TableHead>Webhook</TableHead><TableHead>Schedule</TableHead>
              <TableHead>Active</TableHead><TableHead>Last sync</TableHead><TableHead>Status</TableHead><TableHead></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {targets.data?.map((t: any) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground max-w-[240px] truncate">{t.webhook_url ?? "— (CSV only)"}</TableCell>
                  <TableCell className="text-xs">{scheduleLabel(t)}</TableCell>
                  <TableCell><Switch checked={t.is_active} onCheckedChange={(v) => toggleActive(t, v)} /></TableCell>
                  <TableCell className="text-xs">{t.last_sync_at ? new Date(t.last_sync_at).toLocaleString() : "—"}</TableCell>
                  <TableCell><StatusBadge status={t.last_sync_status} error={t.last_sync_error} /></TableCell>
                  <TableCell className="text-right space-x-1">
                    <Button size="sm" variant="outline" disabled={busyId === t.id} onClick={() => syncNow(t.id)}>
                      <Play className="h-3 w-3 mr-1" />Sync now
                    </Button>
                    <Button size="sm" variant="outline" disabled={busyId === t.id || !t.webhook_url}
                      title={t.webhook_url ? "Send a signed sample payload" : "Configure a webhook URL first"}
                      onClick={() => testWebhook(t.id)}>
                      <Zap className="h-3 w-3 mr-1" />Test
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => setEditTarget(t)}><Pencil className="h-4 w-4" /></Button>
                    <Button size="icon" variant="ghost" onClick={() => remove(t.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {targets.data?.length === 0 && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No sync targets configured.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {editTarget && (
        <TargetDialog
          propertyId={propertyId}
          onDone={() => { invalidate(); setEditTarget(null); }}
          target={editTarget}
          open
          onOpenChange={(o) => { if (!o) setEditTarget(null); }}
        />
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Recent runs</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Started</TableHead><TableHead>Target</TableHead><TableHead>Period</TableHead>
              <TableHead>Status</TableHead><TableHead>Entries</TableHead><TableHead>HTTP</TableHead><TableHead></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {runs.data?.map((r: any) => {
                const target = targets.data?.find((t: any) => t.id === r.target_id);
                return (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs">{new Date(r.started_at).toLocaleString()}</TableCell>
                    <TableCell className="text-xs">
                      {target?.name ?? "—"}
                      {r.is_test && <Badge variant="secondary" className="ml-2 text-[10px] py-0">test</Badge>}
                    </TableCell>
                    <TableCell className="text-xs">{r.from_date === r.to_date ? r.from_date : `${r.from_date} → ${r.to_date}`}</TableCell>
                    <TableCell><StatusBadge status={r.status} error={r.error} /></TableCell>
                    <TableCell>{r.entries_count}</TableCell>
                    <TableCell className="text-xs">{r.response_status ?? "—"}</TableCell>
                    <TableCell className="text-right space-x-1">
                      <Button size="icon" variant="ghost" onClick={() => download(r.id)} title="Download CSV">
                        <Download className="h-4 w-4" />
                      </Button>
                      {r.status === "failed" && (
                        <Button size="sm" variant="outline" disabled={busyId === r.id} onClick={() => retry(r.id)}>
                          <RotateCcw className="h-3 w-3 mr-1" />Retry
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {runs.data?.length === 0 && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No sync runs yet.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBadge({ status, error }: { status: string | null; error?: string | null }) {
  if (!status) return <span className="text-xs text-muted-foreground">—</span>;
  const map: Record<string, { icon: any; cls: string; label: string }> = {
    success: { icon: CheckCircle2, cls: "text-emerald-600", label: "Success" },
    failed: { icon: XCircle, cls: "text-destructive", label: "Failed" },
    running: { icon: Clock, cls: "text-amber-500 animate-pulse", label: "Running" },
    pending: { icon: Clock, cls: "text-muted-foreground", label: "Pending" },
  };
  const m = map[status] ?? map.pending;
  const Icon = m.icon;
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${m.cls}`} title={error ?? ""}>
      <Icon className="h-3.5 w-3.5" />{m.label}
    </span>
  );
}

function TargetDialog({ propertyId, onDone, target, trigger, open: openProp, onOpenChange }: {
  propertyId: string | null; onDone: () => void; target: any | null;
  trigger?: React.ReactNode; open?: boolean; onOpenChange?: (o: boolean) => void;
}) {
  const isEdit = !!target;
  const [openU, setOpenU] = useState(false);
  const open = openProp ?? openU;
  const setOpen = onOpenChange ?? setOpenU;

  const [name, setName] = useState(target?.name ?? "");
  const [url, setUrl] = useState(target?.webhook_url ?? "");
  const [active, setActive] = useState(target?.is_active ?? true);
  const [schedule, setSchedule] = useState<string>(target?.schedule ?? "daily");
  const [hour, setHour] = useState<number>(target?.schedule_hour ?? 2);
  const [dow, setDow] = useState<number>(target?.schedule_dow ?? 1);
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!propertyId) return toast.error("Select a property first");
    if (!name.trim()) return toast.error("Name required");
    if (url && !/^https?:\/\//i.test(url)) return toast.error("Webhook must start with http(s)://");
    setBusy(true);
    const payload: any = {
      property_id: propertyId, name: name.trim(), webhook_url: url || null, is_active: active,
      schedule, schedule_hour: hour,
      schedule_dow: schedule === "weekly" ? dow : null,
    };
    const { error } = isEdit
      ? await supabase.from("accounting_sync_targets").update(payload).eq("id", target.id)
      : await supabase.from("accounting_sync_targets").insert(payload);
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success(isEdit ? "Target updated" : "Target created");
    if (!isEdit) { setName(""); setUrl(""); setActive(true); setSchedule("daily"); setHour(2); setDow(1); }
    setOpen(false); onDone();
  }

  async function rotate() {
    if (!isEdit) return;
    if (!confirm("Rotate the signing secret? External systems using the old secret will start rejecting webhooks.")) return;
    const newSecret = crypto.getRandomValues(new Uint8Array(32));
    const hex = Array.from(newSecret).map((b) => b.toString(16).padStart(2, "0")).join("");
    const { error } = await supabase.from("accounting_sync_targets").update({ signing_secret: hex }).eq("id", target.id);
    if (error) return toast.error(error.message);
    toast.success("Signing secret rotated");
    onDone();
  }

  function copy(v: string) { navigator.clipboard.writeText(v); toast.success("Copied"); }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit sync target" : "New sync target"}</DialogTitle>
          <DialogDescription>
            Journal summaries are POSTed to the webhook as JSON + CSV, signed with an HMAC-SHA256 <code>X-Signature</code> header.
            Leave the webhook empty to keep runs CSV-only.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Xero primary, QBO staging…" /></div>
          <div><Label>Webhook URL</Label><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/journal" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Schedule</Label>
              <Select value={schedule} onValueChange={setSchedule}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual only</SelectItem>
                  <SelectItem value="hourly">Hourly</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {(schedule === "daily" || schedule === "weekly") && (
              <div>
                <Label>Hour (UTC)</Label>
                <Input type="number" min={0} max={23} value={hour} onChange={(e) => setHour(Number(e.target.value))} />
              </div>
            )}
            {schedule === "weekly" && (
              <div className="col-span-2">
                <Label>Day of week</Label>
                <Select value={String(dow)} onValueChange={(v) => setDow(Number(v))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DOW.map((d, i) => <SelectItem key={i} value={String(i)}>{d}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2"><Switch checked={active} onCheckedChange={setActive} /><Label>Active</Label></div>

          {isEdit && (
            <div className="pt-2 border-t space-y-2">
              <Label>HMAC signing secret</Label>
              <div className="flex items-center gap-1">
                <Input
                  type={showSecret ? "text" : "password"}
                  value={target.signing_secret ?? ""}
                  readOnly className="font-mono text-xs"
                />
                <Button size="icon" variant="ghost" type="button" onClick={() => setShowSecret((s) => !s)}>
                  {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
                <Button size="icon" variant="ghost" type="button" onClick={() => copy(target.signing_secret ?? "")}>
                  <Copy className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="outline" type="button" onClick={rotate}>Rotate</Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Verify webhooks by computing <code>HMAC_SHA256(secret, rawBody)</code> and comparing hex to the <code>X-Signature</code> header.
              </p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={busy}>{busy ? "Saving…" : isEdit ? "Save changes" : "Create"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
