import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Download, Upload, ShieldAlert, Database, HardDriveDownload, RotateCcw, Play, Trash2, Plus, Clock, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  exportBackup, restoreBackup,
  listSchedules, upsertSchedule, deleteSchedule, runScheduleNow,
  listSnapshots, getSnapshotDownloadUrl, restoreFromSnapshot,
  BACKUP_TABLES, type BackupArchive,
} from "@/lib/backup.functions";
import { useUserRoles } from "@/hooks/use-user-roles";
import { AccessDenied } from "@/components/access-denied";
import { format } from "date-fns";

export const Route = createFileRoute("/_authenticated/admin_/backup")({
  head: () => ({ meta: [{ title: "Backup & Recovery" }] }),
  component: BackupPage,
});

function BackupPage() {
  const rolesQ = useUserRoles();
  const isSuper = (rolesQ.data ?? []).some((r) => r.role === "super_admin");
  if (rolesQ.isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (!isSuper) return <AccessDenied message="Only super admins can access backup & recovery." />;

  return (
    <div className="space-y-4 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2"><HardDriveDownload className="h-6 w-6" />Backup & Recovery</h1>
        <p className="text-sm text-muted-foreground">
          Manual and scheduled logical backups with retention limits and incremental snapshots. For a physical Postgres dump, use Cloud → Advanced settings → Export data.
        </p>
      </div>

      <Alert>
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Super admin only</AlertTitle>
        <AlertDescription>
          Restore bypasses row-level security. Take a fresh export before every restore.
        </AlertDescription>
      </Alert>

      <Tabs defaultValue="schedules" className="space-y-4">
        <TabsList>
          <TabsTrigger value="schedules"><Clock className="h-4 w-4 mr-1" />Schedules</TabsTrigger>
          <TabsTrigger value="snapshots"><Database className="h-4 w-4 mr-1" />Snapshots</TabsTrigger>
          <TabsTrigger value="manual"><Download className="h-4 w-4 mr-1" />Manual</TabsTrigger>
        </TabsList>

        <TabsContent value="schedules"><SchedulesTab /></TabsContent>
        <TabsContent value="snapshots"><SnapshotsTab /></TabsContent>
        <TabsContent value="manual"><ManualTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// ─────────────────────────── Schedules ───────────────────────────

function SchedulesTab() {
  const qc = useQueryClient();
  const load = useServerFn(listSchedules);
  const del = useServerFn(deleteSchedule);
  const runNow = useServerFn(runScheduleNow);

  const q = useQuery({
    queryKey: ["backup-schedules"],
    queryFn: () => load({}),
  });

  const properties = useQuery({
    queryKey: ["properties-min"],
    queryFn: async () => {
      const { data } = await supabase.from("properties").select("id,name").order("name");
      return data ?? [];
    },
  });
  const propName = (id: string | null) => properties.data?.find((p: any) => p.id === id)?.name ?? "—";

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div className="text-sm text-muted-foreground">{q.data?.length ?? 0} schedules</div>
        <ScheduleDialog onSaved={() => qc.invalidateQueries({ queryKey: ["backup-schedules"] })}
          properties={properties.data ?? []} />
      </div>
      <Card>
        <Table>
          <TableHeader><TableRow>
            <TableHead>Name</TableHead><TableHead>Scope</TableHead><TableHead>Kind</TableHead>
            <TableHead>Frequency</TableHead><TableHead>Retention</TableHead>
            <TableHead>Next run (UTC)</TableHead><TableHead>Last run</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {(q.data ?? []).map((s: any) => (
              <TableRow key={s.id}>
                <TableCell>
                  <div className="font-medium flex items-center gap-2">
                    {s.name}
                    {!s.enabled && <Badge variant="secondary">Paused</Badge>}
                  </div>
                </TableCell>
                <TableCell>{s.scope === "property" ? propName(s.property_id) : <Badge variant="outline">System</Badge>}</TableCell>
                <TableCell><Badge variant={s.kind === "incremental" ? "secondary" : "default"}>{s.kind}</Badge></TableCell>
                <TableCell className="text-sm">{describeFrequency(s)}</TableCell>
                <TableCell>{s.retention_count}</TableCell>
                <TableCell className="text-xs">{s.next_run_at ? format(new Date(s.next_run_at), "dd/MM/yyyy HH:mm") : "—"}</TableCell>
                <TableCell className="text-xs">{s.last_run_at ? format(new Date(s.last_run_at), "dd/MM/yyyy HH:mm") : "—"}</TableCell>
                <TableCell className="text-right">
                  <div className="inline-flex gap-1">
                    <Button size="sm" variant="outline" onClick={async () => {
                      try { const r = await runNow({ data: { id: s.id } }); toast.success(`Snapshot ${r.rowCount} rows • ${(r.sizeBytes / 1024).toFixed(1)} KB`); qc.invalidateQueries({ queryKey: ["backup-schedules"] }); qc.invalidateQueries({ queryKey: ["backup-snapshots"] }); }
                      catch (e: any) { toast.error(e.message); }
                    }}><Play className="h-3 w-3 mr-1" />Run now</Button>
                    <ScheduleDialog schedule={s} properties={properties.data ?? []}
                      onSaved={() => qc.invalidateQueries({ queryKey: ["backup-schedules"] })} />
                    <Button size="icon" variant="ghost" onClick={async () => {
                      if (!confirm("Delete this schedule? Existing snapshots are kept.")) return;
                      try { await del({ data: { id: s.id } }); toast.success("Deleted"); qc.invalidateQueries({ queryKey: ["backup-schedules"] }); }
                      catch (e: any) { toast.error(e.message); }
                    }}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {q.data?.length === 0 && (
              <TableRow><TableCell colSpan={8} className="text-center py-10 text-muted-foreground">No schedules yet. Create one to automate backups.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function describeFrequency(s: any): string {
  const h = String(s.hour_utc).padStart(2, "0") + ":00";
  if (s.frequency === "hourly") return "Every hour";
  if (s.frequency === "daily") return `Daily at ${h}`;
  if (s.frequency === "weekly") return `Weekly ${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][s.day_of_week ?? 1]} ${h}`;
  return `Monthly day ${s.day_of_month ?? 1} at ${h}`;
}

function ScheduleDialog({ schedule, properties, onSaved }: { schedule?: any; properties: any[]; onSaved: () => void }) {
  const save = useServerFn(upsertSchedule);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(() => ({
    name: schedule?.name ?? "",
    scope: (schedule?.scope ?? "system") as "system" | "property",
    propertyId: schedule?.property_id ?? "",
    kind: (schedule?.kind ?? "full") as "full" | "incremental",
    frequency: (schedule?.frequency ?? "daily") as "hourly" | "daily" | "weekly" | "monthly",
    hourUtc: schedule?.hour_utc ?? 2,
    dayOfWeek: schedule?.day_of_week ?? 1,
    dayOfMonth: schedule?.day_of_month ?? 1,
    retentionCount: schedule?.retention_count ?? 14,
    enabled: schedule?.enabled ?? true,
  }));

  async function submit() {
    try {
      await save({ data: { id: schedule?.id, ...form, propertyId: form.scope === "property" ? form.propertyId : null } });
      toast.success(schedule ? "Schedule updated" : "Schedule created");
      setOpen(false); onSaved();
    } catch (e: any) { toast.error(e.message); }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {schedule
          ? <Button size="sm" variant="outline">Edit</Button>
          : <Button size="sm"><Plus className="h-4 w-4 mr-1" />New schedule</Button>}
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{schedule ? "Edit schedule" : "New backup schedule"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nightly full system" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Scope</Label>
              <Select value={form.scope} onValueChange={(v) => setForm({ ...form, scope: v as any })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">Whole system</SelectItem>
                  <SelectItem value="property">Single property</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.scope === "property" && (
              <div>
                <Label>Property</Label>
                <Select value={form.propertyId} onValueChange={(v) => setForm({ ...form, propertyId: v })}>
                  <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>
                    {properties.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Kind</Label>
              <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v as any })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="full">Full snapshot</SelectItem>
                  <SelectItem value="incremental">Incremental (changed rows only)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Frequency</Label>
              <Select value={form.frequency} onValueChange={(v) => setForm({ ...form, frequency: v as any })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="hourly">Hourly</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {form.frequency !== "hourly" && (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Hour (UTC)</Label>
                <Input type="number" min={0} max={23} value={form.hourUtc}
                  onChange={(e) => setForm({ ...form, hourUtc: Number(e.target.value) })} />
              </div>
              {form.frequency === "weekly" && (
                <div>
                  <Label>Day of week</Label>
                  <Select value={String(form.dayOfWeek)} onValueChange={(v) => setForm({ ...form, dayOfWeek: Number(v) })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d, i) =>
                        <SelectItem key={d} value={String(i)}>{d}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {form.frequency === "monthly" && (
                <div>
                  <Label>Day of month</Label>
                  <Input type="number" min={1} max={28} value={form.dayOfMonth}
                    onChange={(e) => setForm({ ...form, dayOfMonth: Number(e.target.value) })} />
                </div>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Retention (keep N snapshots)</Label>
              <Input type="number" min={1} max={365} value={form.retentionCount}
                onChange={(e) => setForm({ ...form, retentionCount: Number(e.target.value) })} />
            </div>
            <div className="flex items-end gap-2">
              <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
              <Label>Enabled</Label>
            </div>
          </div>
        </div>
        <DialogFooter><Button onClick={submit}>{schedule ? "Save" : "Create"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────── Snapshots ───────────────────────────

function SnapshotsTab() {
  const load = useServerFn(listSnapshots);
  const getUrl = useServerFn(getSnapshotDownloadUrl);
  const doRestore = useServerFn(restoreFromSnapshot);
  const qc = useQueryClient();
  const [restoring, setRestoring] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["backup-snapshots"],
    queryFn: () => load({ data: { limit: 200 } }),
    refetchInterval: 30_000,
  });

  return (
    <Card>
      <div className="p-3 flex justify-between items-center border-b">
        <div className="text-sm text-muted-foreground">{q.data?.length ?? 0} snapshots</div>
        <Button size="sm" variant="outline" onClick={() => qc.invalidateQueries({ queryKey: ["backup-snapshots"] })}>
          <RefreshCw className="h-3 w-3 mr-1" />Refresh
        </Button>
      </div>
      <Table>
        <TableHeader><TableRow>
          <TableHead>Created</TableHead><TableHead>Scope</TableHead><TableHead>Kind</TableHead>
          <TableHead>Rows</TableHead><TableHead>Size</TableHead><TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {(q.data ?? []).map((s: any) => (
            <TableRow key={s.id}>
              <TableCell className="text-xs">{format(new Date(s.created_at), "dd/MM/yyyy HH:mm:ss")}</TableCell>
              <TableCell><Badge variant="outline">{s.scope}</Badge></TableCell>
              <TableCell><Badge variant={s.kind === "incremental" ? "secondary" : "default"}>{s.kind}</Badge></TableCell>
              <TableCell>{(s.row_count ?? 0).toLocaleString()}</TableCell>
              <TableCell className="text-xs">{s.size_bytes ? formatBytes(s.size_bytes) : "—"}</TableCell>
              <TableCell><Badge variant={s.status === "completed" ? "default" : s.status === "failed" ? "destructive" : "secondary"}>{s.status}</Badge></TableCell>
              <TableCell className="text-right">
                {s.status === "completed" && (
                  <div className="inline-flex gap-1">
                    <Button size="sm" variant="outline" onClick={async () => {
                      try { const { url } = await getUrl({ data: { snapshotId: s.id } }); window.open(url, "_blank"); }
                      catch (e: any) { toast.error(e.message); }
                    }}><Download className="h-3 w-3 mr-1" />Download</Button>
                    <Button size="sm" variant="destructive" disabled={restoring === s.id}
                      onClick={async () => {
                        if (!confirm(`Restore from snapshot ${format(new Date(s.created_at), "dd/MM/yyyy HH:mm")}?\nExisting rows with the same id will be overwritten.`)) return;
                        setRestoring(s.id);
                        try {
                          const r = await doRestore({ data: { snapshotId: s.id, mode: "upsert" } });
                          const total = Object.values(r.imported).reduce((a, b) => a + b, 0);
                          toast[r.errors.length ? "warning" : "success"](`Restored ${total} rows • ${r.errors.length} errors`);
                        } catch (e: any) { toast.error(e.message); }
                        finally { setRestoring(null); }
                      }}><RotateCcw className="h-3 w-3 mr-1" />Restore</Button>
                  </div>
                )}
                {s.status === "failed" && <span className="text-xs text-destructive">{s.error?.slice(0, 60)}</span>}
              </TableCell>
            </TableRow>
          ))}
          {q.data?.length === 0 && (
            <TableRow><TableCell colSpan={7} className="text-center py-10 text-muted-foreground">No snapshots yet.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
    </Card>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ─────────────────────────── Manual ───────────────────────────

function ManualTab() {
  const runExport = useServerFn(exportBackup);
  const runRestore = useServerFn(restoreBackup);
  const [busy, setBusy] = useState<null | "export" | "restore">(null);
  const [archive, setArchive] = useState<BackupArchive | null>(null);
  const [mode, setMode] = useState<"upsert" | "insert">("upsert");
  const [selected, setSelected] = useState<Set<string>>(new Set(BACKUP_TABLES));
  const [confirm, setConfirm] = useState("");

  function toggleTable(t: string) {
    setSelected((s) => { const n = new Set(s); n.has(t) ? n.delete(t) : n.add(t); return n; });
  }
  async function doExport() {
    setBusy("export");
    try {
      const arc = await runExport({ data: { tables: Array.from(selected) } });
      const blob = new Blob([JSON.stringify(arc, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url;
      a.download = `backup-${arc.createdAt.replace(/[:.]/g, "-")}.json`; a.click();
      URL.revokeObjectURL(url);
      const total = Object.values(arc.counts).filter((n) => n > 0).reduce((a, b) => a + b, 0);
      toast.success(`Exported ${total.toLocaleString()} rows`);
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(null); }
  }
  async function onArchiveFile(f: File) {
    try {
      const parsed = JSON.parse(await f.text()) as BackupArchive;
      if (!parsed?.data) throw new Error("Not a valid archive");
      setArchive(parsed);
      toast.success(`Loaded archive from ${parsed.createdAt}`);
    } catch (e: any) { toast.error(e.message); setArchive(null); }
  }
  async function doRestore() {
    if (!archive || confirm !== "RESTORE") return;
    setBusy("restore");
    try {
      const r = await runRestore({ data: { archive, mode, onlyTables: Array.from(selected) } });
      const total = Object.values(r.imported).reduce((a, b) => a + b, 0);
      toast[r.errors.length ? "warning" : "success"](`Restored ${total} rows • ${r.errors.length} errors`);
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(null); setConfirm(""); }
  }

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2 font-semibold"><Database className="h-4 w-4" />Tables ({selected.size}/{BACKUP_TABLES.length})</div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setSelected(new Set(BACKUP_TABLES))}>Select all</Button>
          <Button size="sm" variant="outline" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 max-h-72 overflow-auto border rounded p-2">
          {BACKUP_TABLES.map((t) => (
            <label key={t} className="flex items-center gap-2 text-xs cursor-pointer">
              <Checkbox checked={selected.has(t)} onCheckedChange={() => toggleTable(t)} />
              <span className="truncate">{t}</span>
            </label>
          ))}
        </div>
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-4 space-y-3">
          <div className="font-semibold flex items-center gap-2"><Download className="h-4 w-4" />Export backup</div>
          <p className="text-xs text-muted-foreground">Downloads a JSON archive of the selected tables. Safe, read-only.</p>
          <Button onClick={doExport} disabled={busy !== null || selected.size === 0}>
            {busy === "export" ? "Exporting…" : "Export & download"}
          </Button>
        </Card>

        <Card className="p-4 space-y-3">
          <div className="font-semibold flex items-center gap-2"><Upload className="h-4 w-4" />Restore from archive</div>
          <div>
            <Label>Archive file (.json)</Label>
            <Input type="file" accept="application/json,.json" onChange={(e) => e.target.files?.[0] && onArchiveFile(e.target.files[0])} />
          </div>
          {archive && <div className="text-xs text-muted-foreground">Loaded: {new Date(archive.createdAt).toLocaleString("en-GB")}</div>}
          <div>
            <Label>Mode</Label>
            <RadioGroup value={mode} onValueChange={(v) => setMode(v as any)} className="flex gap-4 mt-1">
              <label className="flex items-center gap-2 text-sm cursor-pointer"><RadioGroupItem value="upsert" />Upsert by id (safe)</label>
              <label className="flex items-center gap-2 text-sm cursor-pointer"><RadioGroupItem value="insert" />Insert only</label>
            </RadioGroup>
          </div>
          <div>
            <Label>Type <code className="text-xs">RESTORE</code> to confirm</Label>
            <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="RESTORE" />
          </div>
          <Button variant="destructive" onClick={doRestore} disabled={busy !== null || !archive || confirm !== "RESTORE"}>
            <RotateCcw className="h-4 w-4 mr-1" />
            {busy === "restore" ? "Restoring…" : "Restore now"}
          </Button>
        </Card>
      </div>
    </div>
  );
}
