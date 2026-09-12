import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Trash2, ArrowLeftRight } from "lucide-react";
import { toast } from "sonner";
import { InventoryItemSelect } from "@/components/inventory/inventory-item-select";

export const Route = createFileRoute("/_authenticated/inventory/transfers")({
  head: () => ({ meta: [{ title: "Stock transfers" }] }),
  component: TransfersPage,
});

function TransfersPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["tr-list", propertyId], enabled: !!propertyId,
    queryFn: async () => (await (supabase.from as any)("stock_transfers").select("*, from:from_location_id(name), to:to_location_id(name)").eq("property_id", propertyId).order("created_at", { ascending: false })).data ?? [],
  });
  async function execute(id: string) {
    const { error } = await (supabase.rpc as any)("execute_transfer", { _id: id });
    if (error) return toast.error(error.message);
    toast.success("Transfer completed"); qc.invalidateQueries({ queryKey: ["tr-list", propertyId] });
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Stock transfers</h1>
          <p className="text-sm text-muted-foreground">Move items between locations.</p>
        </div>
        <TransferDialog propertyId={propertyId} onDone={() => qc.invalidateQueries({ queryKey: ["tr-list", propertyId] })} />
      </div>
      <Card>
        <Table>
          <TableHeader><TableRow>
            <TableHead>Code</TableHead><TableHead>From</TableHead><TableHead>To</TableHead><TableHead>Status</TableHead><TableHead>Date</TableHead><TableHead></TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {list.data?.map((t: any) => (
              <TableRow key={t.id}>
                <TableCell className="font-mono text-xs">{t.code}</TableCell>
                <TableCell>{t.from?.name}</TableCell>
                <TableCell>{t.to?.name}</TableCell>
                <TableCell><Badge variant={t.status === "completed" ? "outline" : "secondary"}>{t.status}</Badge></TableCell>
                <TableCell>{t.transferred_at ? new Date(t.transferred_at).toLocaleString("en-GB") : "—"}</TableCell>
                <TableCell className="text-right">
                  {t.status === "draft" && <Button size="sm" onClick={() => execute(t.id)}><ArrowLeftRight className="h-3 w-3 mr-1" /> Execute</Button>}
                </TableCell>
              </TableRow>
            ))}
            {list.data?.length === 0 && <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">No transfers.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function TransferDialog({ propertyId, onDone }: any) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<{ item_id: string; quantity: number }[]>([]);
  const locs = useQuery({
    queryKey: ["tr-locs", propertyId], enabled: !!propertyId && open,
    queryFn: async () => (await (supabase.from as any)("stock_locations").select("*").eq("property_id", propertyId)).data ?? [],
  });
  const items = useQuery({
    queryKey: ["tr-items", propertyId], enabled: !!propertyId && open,
    queryFn: async () => (await (supabase.from as any)("inventory_items").select("id,sku,name").eq("property_id", propertyId).eq("active", true).order("name")).data ?? [],
  });
  async function save() {
    if (!from || !to || from === to) return toast.error("Choose different locations");
    if (lines.length === 0 || lines.some((l) => !l.item_id || l.quantity <= 0)) return toast.error("Add at least one line");
    const { data: t, error } = await (supabase.from as any)("stock_transfers").insert({
      property_id: propertyId, from_location_id: from, to_location_id: to, notes,
    }).select("id").single();
    if (error) return toast.error(error.message);
    const { error: le } = await (supabase.from as any)("stock_transfer_lines").insert(lines.map((l) => ({ transfer_id: t.id, ...l })));
    if (le) return toast.error(le.message);
    toast.success("Transfer drafted"); setOpen(false); setLines([]); setFrom(""); setTo(""); setNotes(""); onDone();
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="h-4 w-4 mr-1" /> New transfer</Button></DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>New stock transfer</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><Label>From</Label>
              <Select value={from} onValueChange={setFrom}><SelectTrigger><SelectValue placeholder="Location" /></SelectTrigger>
                <SelectContent>{locs.data?.map((l: any) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}</SelectContent>
              </Select></div>
            <div><Label>To</Label>
              <Select value={to} onValueChange={setTo}><SelectTrigger><SelectValue placeholder="Location" /></SelectTrigger>
                <SelectContent>{locs.data?.map((l: any) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}</SelectContent>
              </Select></div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-2"><Label>Items</Label>
              <Button size="sm" variant="outline" onClick={() => setLines([...lines, { item_id: "", quantity: 1 }])}><Plus className="h-3 w-3 mr-1" /> Add</Button>
            </div>
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-8">
                    <InventoryItemSelect items={items.data ?? []} value={l.item_id} onValueChange={(v) => { const c = [...lines]; c[i].item_id = v; setLines(c); }} />
                  </div>
                  <div className="col-span-3"><Input type="number" step="0.01" value={l.quantity} onChange={(e) => { const c = [...lines]; c[i].quantity = +e.target.value; setLines(c); }} /></div>
                  <div className="col-span-1"><Button size="icon" variant="ghost" onClick={() => setLines(lines.filter((_, x) => x !== i))}><Trash2 className="h-4 w-4 text-destructive" /></Button></div>
                </div>
              ))}
            </div>
          </div>
          <div><Label>Notes</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
        <DialogFooter><Button onClick={save}>Create draft</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
