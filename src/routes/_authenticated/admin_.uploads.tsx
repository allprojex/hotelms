import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import * as XLSX from "xlsx";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Upload, Check, X, Trash2, Download, FileSpreadsheet } from "lucide-react";
import { toast } from "sonner";
import { createUpload, approveUpload, rejectUpload, deleteUpload, type UploadTargetKind } from "@/lib/uploads.functions";
import { format } from "date-fns";
import {
  INVENTORY_TEMPLATE_COLUMNS,
  EXAMPLE_ROW,
  validateInventoryImportBatch,
  type InventoryImportBatchResult,
} from "@/lib/inventory/import-validation";

export const Route = createFileRoute("/_authenticated/admin_/uploads")({
  head: () => ({ meta: [{ title: "Data Uploads" }] }),
  component: UploadsPage,
});

const TARGETS: { value: UploadTargetKind; label: string; template: string[] }[] = [
  { value: "menu", label: "POS Menu items", template: ["name", "category", "price", "description", "sku", "image_url"] },
  { value: "product", label: "Products", template: ["name", "sku", "unit", "cost"] },
  { value: "inventory", label: "Inventory items", template: [...INVENTORY_TEMPLATE_COLUMNS] },
  { value: "service", label: "Services", template: ["name", "price", "description"] },
  { value: "price_list", label: "Price list", template: ["sku", "price", "currency"] },
];

function UploadsPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const approve = useServerFn(approveUpload);
  const reject = useServerFn(rejectUpload);
  const del = useServerFn(deleteUpload);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const list = useQuery({
    queryKey: ["data-uploads", propertyId], enabled: !!propertyId, refetchInterval: 20_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("data_uploads" as any)
        .select("*").eq("property_id", propertyId!).order("created_at", { ascending: false });
      if (error) throw error;
      return (data as any[]) ?? [];
    },
  });

  const rows = list.data ?? [];
  const pendingRows = useMemo(() => rows.filter((r: any) => r.status === "pending"), [rows]);
  const selectedPending = pendingRows.filter((r: any) => selected.has(r.id));
  const allPendingSelected = pendingRows.length > 0 && selectedPending.length === pendingRows.length;

  function toggle(id: string) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setSelected(allPendingSelected ? new Set() : new Set(pendingRows.map((r: any) => r.id)));
  }
  async function bulk(action: "approve" | "reject" | "delete") {
    const ids = action === "delete" ? Array.from(selected) : selectedPending.map((r: any) => r.id);
    if (!ids.length) return;
    if (action === "delete" && !confirm(`Delete ${ids.length} upload(s)?`)) return;
    setBulkBusy(true);
    let ok = 0, fail = 0, imported = 0;
    for (const id of ids) {
      try {
        if (action === "approve") {
          const r = await approve({ data: { uploadId: id, propertyId: propertyId! } });
          imported += r.imported; ok++;
        } else if (action === "reject") {
          await reject({ data: { uploadId: id, propertyId: propertyId! } }); ok++;
        } else {
          await del({ data: { uploadId: id, propertyId: propertyId! } }); ok++;
        }
      } catch (e: any) { fail++; }
    }
    setBulkBusy(false);
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: ["data-uploads"] });
    toast[fail ? "warning" : "success"](
      action === "approve" ? `Approved ${ok} • Imported ${imported} • ${fail} failed`
      : action === "reject" ? `Rejected ${ok} • ${fail} failed`
      : `Deleted ${ok} • ${fail} failed`
    );
  }


  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Excel & CSV Uploads</h1>
          <p className="text-sm text-muted-foreground">Bulk import menu items, products, inventory, services, and price lists.</p>
        </div>
        <UploadDialog propertyId={propertyId} onDone={() => qc.invalidateQueries({ queryKey: ["data-uploads"] })} />
      </div>

      {selected.size > 0 && (
        <Card className="p-3 flex items-center justify-between bg-muted/40">
          <div className="text-sm">
            <span className="font-medium">{selected.size}</span> selected
            {selectedPending.length > 0 && <span className="text-muted-foreground"> • {selectedPending.length} pending</span>}
          </div>
          <div className="flex gap-2">
            <Button size="sm" disabled={bulkBusy || selectedPending.length === 0} onClick={() => bulk("approve")}>
              <Check className="h-3 w-3 mr-1" />Approve selected
            </Button>
            <Button size="sm" variant="outline" disabled={bulkBusy || selectedPending.length === 0} onClick={() => bulk("reject")}>
              <X className="h-3 w-3 mr-1" />Reject selected
            </Button>
            <Button size="sm" variant="outline" disabled={bulkBusy} onClick={() => bulk("delete")}>
              <Trash2 className="h-3 w-3 mr-1 text-destructive" />Delete selected
            </Button>
            <Button size="sm" variant="ghost" disabled={bulkBusy} onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        </Card>
      )}

      <Card>
        <Table>
          <TableHeader><TableRow>
            <TableHead className="w-10">
              <Checkbox
                checked={allPendingSelected}
                onCheckedChange={toggleAll}
                aria-label="Select all pending"
                disabled={pendingRows.length === 0}
              />
            </TableHead>
            <TableHead>File</TableHead><TableHead>Target</TableHead><TableHead>Rows</TableHead>
            <TableHead>Status</TableHead><TableHead>Uploaded</TableHead><TableHead className="text-right">Actions</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {rows.map((u: any) => (
              <TableRow key={u.id} data-state={selected.has(u.id) ? "selected" : undefined}>
                <TableCell>
                  <Checkbox
                    checked={selected.has(u.id)}
                    onCheckedChange={() => toggle(u.id)}
                    aria-label={`Select ${u.filename}`}
                  />
                </TableCell>
                <TableCell><div className="font-medium">{u.filename}</div>{u.summary?.imported != null && <div className="text-xs text-muted-foreground">Imported: {u.summary.imported}</div>}</TableCell>
                <TableCell><Badge variant="outline">{u.target_kind}</Badge></TableCell>
                <TableCell>{u.row_count}</TableCell>
                <TableCell><StatusBadge status={u.status} /></TableCell>
                <TableCell className="text-xs text-muted-foreground">{format(new Date(u.created_at), "MMM d HH:mm")}</TableCell>
                <TableCell className="text-right">
                  {u.status === "pending" && (
                    <div className="inline-flex gap-1">
                      <Button size="sm" onClick={async () => {
                        try { const r = await approve({ data: { uploadId: u.id, propertyId: propertyId! } }); toast.success(`Imported ${r.imported} • ${r.errors} errors`); qc.invalidateQueries({ queryKey: ["data-uploads"] }); }
                        catch (e: any) { toast.error(e.message); }
                      }}><Check className="h-3 w-3 mr-1" />Approve</Button>
                      <Button size="sm" variant="outline" onClick={async () => {
                        try { await reject({ data: { uploadId: u.id, propertyId: propertyId! } }); toast.success("Rejected"); qc.invalidateQueries({ queryKey: ["data-uploads"] }); }
                        catch (e: any) { toast.error(e.message); }
                      }}><X className="h-3 w-3 mr-1" />Reject</Button>
                    </div>
                  )}
                  <Button size="icon" variant="ghost" onClick={async () => {
                    if (!confirm("Delete this upload?")) return;
                    try { await del({ data: { uploadId: u.id, propertyId: propertyId! } }); toast.success("Deleted"); qc.invalidateQueries({ queryKey: ["data-uploads"] }); }
                    catch (e: any) { toast.error(e.message); }
                  }}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No uploads yet.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </Card>


      <Card className="p-4">
        <div className="text-sm font-semibold mb-2">Templates</div>
        <div className="flex flex-wrap gap-2">
          {TARGETS.map((t) => (
            <Button key={t.value} size="sm" variant="outline" onClick={() => downloadTemplate(t.value, t.template)}>
              <Download className="h-3 w-3 mr-1" />{t.label} template
            </Button>
          ))}
        </div>
      </Card>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const v = status === "imported" ? "default" : status === "rejected" ? "destructive" : status === "approved" ? "default" : "secondary";
  return <Badge variant={v as any}>{status}</Badge>;
}

function downloadTemplate(kind: string, cols: string[]) {
  // Inventory gets one instruction/example row under the header. Its SKU
  // is the exact sentinel isExampleRow()/validateInventoryRow() detect and
  // auto-exclude, so leaving this row in an uploaded file can never create
  // real stock even if a user forgets to delete it.
  const aoa: (string | number)[][] = kind === "inventory"
    ? [cols, cols.map((c) => (EXAMPLE_ROW as Record<string, string | number>)[c] ?? "")]
    : [cols];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "template");
  XLSX.writeFile(wb, `${kind}-template.xlsx`);
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB -- rejected before parsing, well before the 5000-row server cap even applies

function UploadDialog({ propertyId, onDone }: { propertyId: string | null; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<UploadTargetKind>("menu");
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [busy, setBusy] = useState(false);
  const [duplicateMode, setDuplicateMode] = useState<"skip" | "reject">("skip");
  const [inventoryValidation, setInventoryValidation] = useState<InventoryImportBatchResult | null>(null);
  const create = useServerFn(createUpload);
  const approve = useServerFn(approveUpload);

  const columns = useMemo(() => rows[0] ? Object.keys(rows[0]) : [], [rows]);
  const isInventory = target === "inventory";

  async function onFile(f: File) {
    if (f.size > MAX_UPLOAD_BYTES) {
      toast.error(`File is too large (max ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB)`);
      return;
    }
    setFile(f);
    setInventoryValidation(null);
    let data: Record<string, unknown>[];
    try {
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      data = XLSX.utils.sheet_to_json(sheet) as Record<string, unknown>[];
    } catch {
      toast.error("Could not read this file — it may not be a valid .xlsx or .csv file");
      setFile(null);
      return;
    }
    const capped = data.slice(0, 5000);
    setRows(capped);

    if (target === "inventory" && propertyId) {
      const [{ data: items }, { data: locations }] = await Promise.all([
        supabase.from("inventory_items" as any).select("sku").eq("property_id", propertyId),
        supabase.from("stock_locations" as any).select("name").eq("property_id", propertyId),
      ]);
      const ctx = {
        existingSkusLower: new Set<string>(((items as any[]) ?? []).map((i) => String(i.sku).toLowerCase())),
        validLocationNamesLower: new Set<string>(((locations as any[]) ?? []).map((l) => String(l.name).toLowerCase())),
      };
      setInventoryValidation(validateInventoryImportBatch(capped, ctx));
    }
  }

  async function submit() {
    if (!propertyId) return toast.error("Select a property");
    if (!file || rows.length === 0) return toast.error("Choose a file");
    if (isInventory && inventoryValidation && inventoryValidation.totals.valid === 0) {
      return toast.error("No valid rows to import — fix the errors shown in the preview and re-upload");
    }
    setBusy(true);
    try {
      // Upload file to storage
      const path = `${propertyId}/${Date.now()}_${file.name}`;
      await supabase.storage.from("uploads").upload(path, file, { upsert: false });
      const res = await create({
        data: { propertyId, targetKind: target, filename: file.name, storagePath: path, rows, duplicateMode },
      });
      if (isInventory) {
        // Inventory rows already went through full Preview validation the
        // user confirmed, so Import runs immediately rather than requiring
        // a separate visit to Approve -- one confirm, one result summary.
        try {
          const r = await approve({ data: { uploadId: res.uploadId, propertyId } });
          toast.success(`Imported ${r.imported} • ${r.errors} row(s) had errors`);
        } catch (approveErr: any) { toast.error(approveErr.message ?? "Import failed"); }
      } else {
        toast.success(`Queued ${rows.length} rows • ${res.duplicates} duplicates flagged`);
      }
      setOpen(false); setFile(null); setRows([]); setInventoryValidation(null); onDone();
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Upload className="h-4 w-4 mr-1" />New upload</Button></DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>Upload Excel or CSV</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Target</Label>
            <Select value={target} onValueChange={(v) => { setTarget(v as UploadTargetKind); setFile(null); setRows([]); setInventoryValidation(null); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{TARGETS.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label>File (.xlsx or .csv)</Label>
            <Input type="file" accept=".xlsx,.csv" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          </div>

          {isInventory && (
            <div>
              <Label>If a SKU already exists in this property</Label>
              <Select value={duplicateMode} onValueChange={(v) => setDuplicateMode(v as "skip" | "reject")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="skip">Skip that row (create everything else)</SelectItem>
                  <SelectItem value="reject">Reject the whole file (import nothing)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                Existing items are never overwritten — cost, price, stock, and expiry are left untouched either way.
              </p>
            </div>
          )}

          {isInventory && inventoryValidation && (
            <Card className="p-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span><span className="font-semibold text-emerald-600">{inventoryValidation.totals.valid}</span> valid</span>
              <span><span className="font-semibold text-destructive">{inventoryValidation.totals.invalid}</span> invalid</span>
              <span><span className="font-semibold">{inventoryValidation.totals.duplicateInFile}</span> duplicate in file</span>
              <span><span className="font-semibold">{inventoryValidation.totals.duplicateInProperty}</span> duplicate of existing item</span>
              {inventoryValidation.totals.example > 0 && <span>{inventoryValidation.totals.example} example row skipped automatically</span>}
              {inventoryValidation.totals.blank > 0 && <span>{inventoryValidation.totals.blank} blank row ignored</span>}
            </Card>
          )}

          {rows.length > 0 && (
            <Card className="p-3 max-h-80 overflow-auto">
              <div className="text-xs text-muted-foreground mb-2 flex items-center gap-2">
                <FileSpreadsheet className="h-3 w-3" />
                Preview: {rows.length} rows × {columns.length} columns
              </div>
              <table className="text-xs w-full">
                <thead><tr className="border-b">
                  {isInventory && <th className="text-left p-1 font-semibold">Status</th>}
                  {columns.map((c) => <th key={c} className="text-left p-1 font-semibold">{c}</th>)}
                </tr></thead>
                <tbody>
                  {rows.slice(0, 10).map((r, i) => {
                    const v = inventoryValidation?.rows[i];
                    return (
                      <tr key={i} className="border-b align-top">
                        {isInventory && <td className="p-1"><InventoryRowStatusCell row={v} /></td>}
                        {columns.map((c) => <td key={c} className="p-1">{String(r[c] ?? "")}</td>)}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {rows.length > 10 && <div className="text-xs text-muted-foreground mt-2">…and {rows.length - 10} more rows</div>}
            </Card>
          )}
        </div>
        <DialogFooter>
          <Button
            onClick={submit}
            disabled={busy || rows.length === 0 || (isInventory && !!inventoryValidation && inventoryValidation.totals.valid === 0)}
          >
            {busy ? (isInventory ? "Importing…" : "Uploading…") : isInventory ? "Import" : "Queue for approval"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InventoryRowStatusCell({ row }: { row: InventoryImportBatchResult["rows"][number] | undefined }) {
  if (!row) return null;
  if (row.isExample) return <Badge variant="outline">Example</Badge>;
  if (row.isBlank) return <Badge variant="outline">Blank</Badge>;
  if (row.isDuplicateInFile) return <Badge variant="secondary">Duplicate in file</Badge>;
  if (row.isDuplicateInProperty) return <Badge variant="secondary">Already exists</Badge>;
  if (row.errors.length > 0) return <Badge variant="destructive" title={row.errors.join("; ")}>{row.errors[0]}</Badge>;
  return <Badge>Valid</Badge>;
}
