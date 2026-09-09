import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listEslLabels, listEslTemplates, listSyncBatches,
  upsertEslLabel, deleteEslLabel, upsertEslTemplate, createSyncBatch,
} from "@/lib/esl/esl.functions";
import { useActiveProperty } from "@/hooks/use-active-property";
import { useHasAnyRole } from "@/hooks/use-user-roles";
import { ADMIN_ROLES } from "@/lib/admin/permissions";
import { AccessDenied } from "@/components/access-denied";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Tag, Grid3x3, RefreshCw, Plus, Download, Trash2, ScanLine } from "lucide-react";
import { DevicesTab } from "@/components/esl/devices-tab";
import { format } from "date-fns";
import { toast } from "sonner";
import { ChildRouteOr } from "@/components/child-route-or";

export const Route = createFileRoute("/_authenticated/admin_/esl")({
  head: () => ({
    meta: [
      { title: pageTitle("ESL Dashboard") },
      { name: "description", content: "Electronic shelf label management: templates, product mapping, batch export." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => (
    <ChildRouteOr>
      <EslPage />
    </ChildRouteOr>
  ),
});

function EslPage() {
  const propertyId = useActiveProperty();
  const gate = useHasAnyRole(ADMIN_ROLES, propertyId);
  const [tab, setTab] = useState("labels");

  if (gate.loading) return <div className="p-6 text-muted-foreground">Checking access…</div>;
  if (!gate.allowed) return <AccessDenied message="Only admins can view the ESL dashboard." />;
  if (!propertyId) return <AccessDenied message="Select a property from the header first." />;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <header className="flex items-center gap-3">
        <Tag className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-display font-semibold">Electronic Shelf Labels</h1>
          <p className="text-xs text-muted-foreground">
            Manage digital price labels — templates, product mapping, and exports for any ESL gateway.
          </p>
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="labels" className="gap-1.5"><Tag className="h-3.5 w-3.5" />Labels</TabsTrigger>
          <TabsTrigger value="templates" className="gap-1.5"><Grid3x3 className="h-3.5 w-3.5" />Templates</TabsTrigger>
          <TabsTrigger value="devices" className="gap-1.5"><ScanLine className="h-3.5 w-3.5" />Devices</TabsTrigger>
          <TabsTrigger value="sync" className="gap-1.5"><RefreshCw className="h-3.5 w-3.5" />Sync history</TabsTrigger>
        </TabsList>
        <TabsContent value="labels"><LabelsTab propertyId={propertyId} /></TabsContent>
        <TabsContent value="templates"><TemplatesTab propertyId={propertyId} /></TabsContent>
        <TabsContent value="devices"><DevicesTab propertyId={propertyId} /></TabsContent>
        <TabsContent value="sync"><SyncTab propertyId={propertyId} /></TabsContent>
      </Tabs>
    </div>
  );
}

function LabelsTab({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listEslLabels);
  const tplFn = useServerFn(listEslTemplates);
  const upsertFn = useServerFn(upsertEslLabel);
  const delFn = useServerFn(deleteEslLabel);
  const list = useQuery({ queryKey: ["esl-labels"], queryFn: () => listFn() });
  const tpls = useQuery({ queryKey: ["esl-templates"], queryFn: () => tplFn() });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ label_code: "", custom_text: "", price: "", barcode_type: "CODE128" as const, templateId: "" });

  const save = useMutation({
    mutationFn: () => upsertFn({ data: {
      propertyId,
      label_code: form.label_code || null,
      custom_text: form.custom_text || null,
      price_override: form.price ? Number(form.price) : null,
      barcode_type: form.barcode_type,
      templateId: form.templateId || null,
    }}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["esl-labels"] });
      setOpen(false); setForm({ label_code: "", custom_text: "", price: "", barcode_type: "CODE128", templateId: "" });
      toast.success("Label saved.");
    },
    onError: (e: any) => toast.error(e.message ?? "Failed to save."),
  });

  const del = useMutation({
    mutationFn: (id: string) => delFn({ data: { id } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["esl-labels"] }); toast.success("Label deleted."); },
  });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base">Labels</CardTitle>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button size="sm" className="gap-1.5"><Plus className="h-3.5 w-3.5" />New label</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>New ESL label</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Label code (SKU / barcode data)</Label><Input value={form.label_code} onChange={(e) => setForm({ ...form, label_code: e.target.value })} /></div>
              <div><Label>Custom text</Label><Input value={form.custom_text} onChange={(e) => setForm({ ...form, custom_text: e.target.value })} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Price override</Label><Input type="number" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></div>
                <div><Label>Barcode type</Label>
                  <Select value={form.barcode_type} onValueChange={(v) => setForm({ ...form, barcode_type: v as any })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CODE128">CODE128</SelectItem>
                      <SelectItem value="EAN13">EAN13</SelectItem>
                      <SelectItem value="UPC-A">UPC-A</SelectItem>
                      <SelectItem value="QR">QR</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {(tpls.data ?? []).length > 0 && (
                <div><Label>Template</Label>
                  <Select value={form.templateId} onValueChange={(v) => setForm({ ...form, templateId: v })}>
                    <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                    <SelectContent>{(tpls.data ?? []).map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Code</TableHead><TableHead>Text</TableHead><TableHead>Price</TableHead>
            <TableHead>Type</TableHead><TableHead>Status</TableHead><TableHead></TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {(list.data ?? []).map((l) => (
              <TableRow key={l.id}>
                <TableCell className="text-xs font-mono">{l.label_code ?? "—"}</TableCell>
                <TableCell className="text-xs">{l.custom_text ?? "—"}</TableCell>
                <TableCell className="text-xs">{l.price_override ?? "—"}</TableCell>
                <TableCell className="text-xs">{l.barcode_type}</TableCell>
                <TableCell>
                  <Badge variant={l.sync_status === "synced" ? "secondary" : l.sync_status === "error" ? "destructive" : "outline"}>
                    {l.sync_status}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Button size="icon" variant="ghost" onClick={() => del.mutate(l.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </TableCell>
              </TableRow>
            ))}
            {(list.data ?? []).length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">
                No labels yet — add one to start managing ESL prices.
              </TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function TemplatesTab({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listEslTemplates);
  const upsertFn = useServerFn(upsertEslTemplate);
  const list = useQuery({ queryKey: ["esl-templates"], queryFn: () => listFn() });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [w, setW] = useState(50);
  const [h, setH] = useState(30);

  const save = useMutation({
    mutationFn: () => upsertFn({ data: { propertyId, name, width_mm: w, height_mm: h } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["esl-templates"] });
      setOpen(false); setName(""); setW(50); setH(30);
      toast.success("Template saved.");
    },
    onError: (e: any) => toast.error(e.message ?? "Failed to save."),
  });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base">Templates</CardTitle>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button size="sm" className="gap-1.5"><Plus className="h-3.5 w-3.5" />New template</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>New label template</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Width (mm)</Label><Input type="number" value={w} onChange={(e) => setW(+e.target.value)} /></div>
                <div><Label>Height (mm)</Label><Input type="number" value={h} onChange={(e) => setH(+e.target.value)} /></div>
              </div>
            </div>
            <DialogFooter><Button onClick={() => save.mutate()} disabled={save.isPending || !name}>Save</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Name</TableHead><TableHead>Dimensions</TableHead><TableHead>Active</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {(list.data ?? []).map((t) => (
              <TableRow key={t.id}>
                <TableCell className="text-sm font-medium">{t.name}</TableCell>
                <TableCell className="text-xs">{t.width_mm} × {t.height_mm} mm</TableCell>
                <TableCell>{t.active ? <Badge variant="secondary">Yes</Badge> : <Badge variant="outline">No</Badge>}</TableCell>
              </TableRow>
            ))}
            {(list.data ?? []).length === 0 && (
              <TableRow><TableCell colSpan={3} className="text-center text-sm text-muted-foreground py-8">
                No templates yet.
              </TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function SyncTab({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listSyncBatches);
  const labelsFn = useServerFn(listEslLabels);
  const syncFn = useServerFn(createSyncBatch);
  const batches = useQuery({ queryKey: ["esl-batches"], queryFn: () => listFn() });
  const labels = useQuery({ queryKey: ["esl-labels"], queryFn: () => labelsFn() });

  const doSync = useMutation({
    mutationFn: (format: "csv" | "json" | "xml") =>
      syncFn({ data: { propertyId, format } }),
    onSuccess: (res: any, format) => {
      qc.invalidateQueries({ queryKey: ["esl-batches"] });
      qc.invalidateQueries({ queryKey: ["esl-labels"] });
      exportFile(labels.data ?? [], format);
      toast.success(`Synced ${res.count} labels · exported ${format.toUpperCase()}`);
    },
    onError: (e: any) => toast.error(e.message ?? "Sync failed."),
  });

  function exportFile(rows: any[], format: string) {
    let blob: Blob;
    if (format === "csv") {
      const header = "label_code,custom_text,price,barcode_type,sync_status\n";
      const body = rows.map((r) => [r.label_code, r.custom_text, r.price_override, r.barcode_type, r.sync_status]
        .map((v) => `"${(v ?? "").toString().replace(/"/g, '""')}"`).join(",")).join("\n");
      blob = new Blob([header + body], { type: "text/csv" });
    } else if (format === "json") {
      blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
    } else {
      const xml = "<?xml version=\"1.0\"?>\n<labels>\n" +
        rows.map((r) => `  <label><code>${r.label_code ?? ""}</code><price>${r.price_override ?? ""}</price></label>`).join("\n") +
        "\n</labels>";
      blob = new Blob([xml], { type: "application/xml" });
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `esl-labels.${format}`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">Export batch</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button className="gap-1.5" onClick={() => doSync.mutate("csv")} disabled={doSync.isPending}>
            <Download className="h-3.5 w-3.5" />Export CSV
          </Button>
          <Button variant="outline" className="gap-1.5" onClick={() => doSync.mutate("json")} disabled={doSync.isPending}>
            <Download className="h-3.5 w-3.5" />Export JSON
          </Button>
          <Button variant="outline" className="gap-1.5" onClick={() => doSync.mutate("xml")} disabled={doSync.isPending}>
            <Download className="h-3.5 w-3.5" />Export XML
          </Button>
          <p className="text-xs text-muted-foreground w-full pt-2">
            Feed the export to your ESL vendor gateway (SES-imagotag, Pricer, Hanshow, SoluM). All standard vendors accept CSV or JSON.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">History</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>When</TableHead><TableHead>Format</TableHead><TableHead>Labels</TableHead><TableHead>Status</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {(batches.data ?? []).map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="text-xs">{format(new Date(b.created_at), "MMM d, HH:mm")}</TableCell>
                  <TableCell className="text-xs uppercase">{b.format}</TableCell>
                  <TableCell className="text-xs">{b.label_count}</TableCell>
                  <TableCell><Badge variant={b.status === "completed" ? "secondary" : "outline"}>{b.status}</Badge></TableCell>
                </TableRow>
              ))}
              {(batches.data ?? []).length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-8">
                  No export history.
                </TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
