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
import { Plus, Trash2, Check } from "lucide-react";
import { toast } from "sonner";
import { InventoryItemSelect } from "@/components/inventory/inventory-item-select";

export const Route = createFileRoute("/_authenticated/inventory/adjustments")({
  head: () => ({ meta: [{ title: "Stock adjustments" }] }),
  component: AdjPage,
});

const REASONS = ["Physical count", "Spoilage / waste", "Damage", "Complimentary", "Theft / loss", "Initial stock", "Other"];

function AdjPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["adj-list", propertyId], enabled: !!propertyId,
    queryFn: async () => (await (supabase.from as any)("stock_adjustments").select("*, stock_locations(name)").eq("property_id", propertyId).order("created_at", { ascending: false })).data ?? [],
  });
  async function apply(id: string) {
    const { error } = await (supabase.rpc as any)("apply_adjustment", { _id: id });
    if (error) return toast.error(error.message);
    toast.success("Adjustment applied"); qc.invalidateQueries({ queryKey: ["adj-list", propertyId] });
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Stock adjustments</h1>
          <p className="text-sm text-muted-foreground">Correct stock counts with signed deltas and a reason.</p>
        </div>
        <AdjDialog propertyId={propertyId} onDone={() => qc.invalidateQueries({ queryKey: ["adj-list", propertyId] })} />
      </div>
      <Card>
        <Table>
          <TableHeader><TableRow>
            <TableHead>Code</TableHead><TableHead>Location</TableHead><TableHead>Reason</TableHead><TableHead>Status</TableHead><TableHead>Applied</TableHead><TableHead></TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {list.data?.map((a: any) => (
              <TableRow key={a.id}>
                <TableCell className="font-mono text-xs">{a.code}</TableCell>
                <TableCell>{a.stock_locations?.name}</TableCell>
                <TableCell>{a.reason}</TableCell>
                <TableCell><Badge variant={a.adjusted_at ? "outline" : "secondary"}>{a.adjusted_at ? "applied" : "pending"}</Badge></TableCell>
                <TableCell>{a.adjusted_at ? new Date(a.adjusted_at).toLocaleString("en-GB") : "—"}</TableCell>
                <TableCell className="text-right">{!a.adjusted_at && <Button size="sm" onClick={() => apply(a.id)}><Check className="h-3 w-3 mr-1" /> Apply</Button>}</TableCell>
              </TableRow>
            ))}
            {list.data?.length === 0 && <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">No adjustments.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function AdjDialog({ propertyId, onDone }: any) {
  const [open, setOpen] = useState(false);
  const [loc, setLoc] = useState("");
  const [reason, setReason] = useState(REASONS[0]);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<{ item_id: string; delta: number }[]>([]);
  const locs = useQuery({
    queryKey: ["adj-locs", propertyId], enabled: !!propertyId && open,
    queryFn: async () => (await (supabase.from as any)("stock_locations").select("*").eq("property_id", propertyId)).data ?? [],
  });
  const items = useQuery({
    queryKey: ["adj-items", propertyId], enabled: !!propertyId && open,
    queryFn: async () => (await (supabase.from as any)("inventory_items").select("id,sku,name").eq("property_id", propertyId).order("name")).data ?? [],
  });
  async function save() {
    if (!loc || lines.length === 0) return toast.error("Location and at least one item required");
    const { data: a, error } = await (supabase.from as any)("stock_adjustments").insert({
      property_id: propertyId, location_id: loc, reason, notes,
    }).select("id").single();
    if (error) return toast.error(error.message);
    const { error: le } = await (supabase.from as any)("stock_adjustment_lines").insert(lines.map((l) => ({ adjustment_id: a.id, ...l })));
    if (le) return toast.error(le.message);
    toast.success("Draft created — click Apply to update stock"); setOpen(false); setLines([]); setLoc(""); setNotes(""); onDone();
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="h-4 w-4 mr-1" /> New adjustment</Button></DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>New adjustment</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Location</Label>
              <Select value={loc} onValueChange={setLoc}><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>{locs.data?.map((l: any) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}</SelectContent>
              </Select></div>
            <div><Label>Reason</Label>
              <Select value={reason} onValueChange={setReason}><SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
              </Select></div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-2"><Label>Lines (positive = add, negative = remove)</Label>
              <Button size="sm" variant="outline" onClick={() => setLines([...lines, { item_id: "", delta: 0 }])}><Plus className="h-3 w-3 mr-1" /> Add</Button>
            </div>
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-8">
                    <InventoryItemSelect items={items.data ?? []} value={l.item_id} onValueChange={(v) => { const c = [...lines]; c[i].item_id = v; setLines(c); }} />
                  </div>
                  <div className="col-span-3"><Input type="number" step="0.01" value={l.delta} onChange={(e) => { const c = [...lines]; c[i].delta = +e.target.value; setLines(c); }} /></div>
                  <div className="col-span-1"><Button size="icon" variant="ghost" onClick={() => setLines(lines.filter((_, x) => x !== i))}><Trash2 className="h-4 w-4 text-destructive" /></Button></div>
                </div>
              ))}
            </div>
          </div>
          <div><Label>Notes</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
        <DialogFooter><Button onClick={save}>Save draft</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
