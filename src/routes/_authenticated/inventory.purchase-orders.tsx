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
import { Plus, Trash2, Package } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/inventory/purchase-orders")({
  head: () => ({ meta: [{ title: "Purchase Orders" }] }),
  component: POPage,
});

const STATUS_COLORS: Record<string, any> = {
  draft: "secondary", sent: "default", partial: "outline", received: "outline", cancelled: "destructive",
};

function POPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["po-list", propertyId], enabled: !!propertyId,
    queryFn: async () => (await (supabase.from as any)("purchase_orders").select("*, suppliers(name), stock_locations(name)").eq("property_id", propertyId).order("created_at", { ascending: false })).data ?? [],
  });

  async function cancel(id: string) {
    if (!confirm("Cancel PO?")) return;
    const { error } = await (supabase.from as any)("purchase_orders").update({ status: "cancelled" }).eq("id", id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["po-list", propertyId] });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Purchase orders</h1>
          <p className="text-sm text-muted-foreground">Order stock from suppliers and receive into a location.</p>
        </div>
        <PODialog propertyId={propertyId} onDone={() => qc.invalidateQueries({ queryKey: ["po-list", propertyId] })} />
      </div>
      <Card>
        <Table>
          <TableHeader><TableRow>
            <TableHead>Code</TableHead><TableHead>Supplier</TableHead><TableHead>Destination</TableHead>
            <TableHead>Expected</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Total</TableHead><TableHead></TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {list.data?.map((p: any) => (
              <TableRow key={p.id}>
                <TableCell className="font-mono text-xs">{p.code}</TableCell>
                <TableCell>{p.suppliers?.name ?? "—"}</TableCell>
                <TableCell>{p.stock_locations?.name ?? "—"}</TableCell>
                <TableCell>{p.expected_at ?? "—"}</TableCell>
                <TableCell><Badge variant={STATUS_COLORS[p.status] ?? "secondary"}>{p.status}</Badge></TableCell>
                <TableCell className="text-right">{Number(p.total).toFixed(2)}</TableCell>
                <TableCell className="text-right space-x-1">
                  {p.status !== "received" && p.status !== "cancelled" && (
                    <>
                      <ReceiveDialog poId={p.id} poCode={p.code} onDone={() => qc.invalidateQueries({ queryKey: ["po-list", propertyId] })} />
                      <Button size="sm" variant="ghost" onClick={() => cancel(p.id)}>Cancel</Button>
                    </>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {list.data?.length === 0 && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No purchase orders.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function ReceiveDialog({ poId, poCode, onDone }: { poId: string; poCode: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [expiryByLine, setExpiryByLine] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const lines = useQuery({
    queryKey: ["po-receive-lines", poId],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await (supabase.from as any)("purchase_order_lines")
        .select("id, item_id, quantity, received_qty, inventory_items(name, sku)")
        .eq("po_id", poId)
        .order("id");
      if (error) throw error;
      return ((data ?? []) as any[]).filter((l) => Number(l.quantity) - Number(l.received_qty) > 0);
    },
  });

  const today = new Date().toISOString().slice(0, 10);

  async function confirmReceive() {
    setSaving(true);
    // Only pass entries for lines that actually have an expiry date typed —
    // blank stays out of the map entirely, which the RPC treats as "no
    // expiry" (batch still created for received-quantity tracking, just
    // with expiry_date = NULL).
    const lineExpiry: Record<string, string> = {};
    for (const [lineId, date] of Object.entries(expiryByLine)) {
      if (date) lineExpiry[lineId] = date;
    }
    const { error } = await (supabase.rpc as any)("receive_purchase_order", {
      _po_id: poId,
      _line_expiry: Object.keys(lineExpiry).length > 0 ? lineExpiry : null,
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Received");
    setOpen(false);
    setExpiryByLine({});
    onDone();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Package className="h-3 w-3 mr-1" /> Receive</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Receive {poCode}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            This receives the full remaining quantity of every line below. Expiration date is optional per item —
            leave blank if not tracked or not applicable.
          </p>
          <div className="space-y-2">
            {lines.data?.map((l: any) => {
              const remaining = Number(l.quantity) - Number(l.received_qty);
              const chosen = expiryByLine[l.id] ?? "";
              const isPast = chosen && chosen < today;
              return (
                <div key={l.id} className="grid grid-cols-12 gap-2 items-center border rounded p-2">
                  <div className="col-span-5">
                    <div className="text-sm font-medium">{l.inventory_items?.name ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">{l.inventory_items?.sku}</div>
                  </div>
                  <div className="col-span-3 text-sm text-muted-foreground">Qty: {remaining}</div>
                  <div className="col-span-4">
                    <Label className="text-xs">Expiration date (optional)</Label>
                    <Input
                      type="date"
                      value={chosen}
                      onChange={(e) => setExpiryByLine({ ...expiryByLine, [l.id]: e.target.value })}
                    />
                    {isPast && (
                      <p className="text-[10px] text-destructive mt-0.5">
                        This date is already in the past — the batch will be recorded as Expired.
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
            {lines.data?.length === 0 && (
              <div className="text-sm text-muted-foreground py-2">No remaining lines to receive.</div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={confirmReceive} disabled={saving || (lines.data?.length ?? 0) === 0}>
            {saving ? "Receiving…" : "Confirm receive"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PODialog({ propertyId, onDone }: { propertyId: string | null; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [supplier, setSupplier] = useState("");
  const [location, setLocation] = useState("");
  const [expected, setExpected] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<{ item_id: string; quantity: number; unit_cost: number }[]>([]);

  const suppliers = useQuery({
    queryKey: ["po-suppliers", propertyId], enabled: !!propertyId && open,
    queryFn: async () => (await (supabase.from as any)("suppliers").select("*").eq("property_id", propertyId).eq("active", true)).data ?? [],
  });
  const locs = useQuery({
    queryKey: ["po-locs", propertyId], enabled: !!propertyId && open,
    queryFn: async () => (await (supabase.from as any)("stock_locations").select("*").eq("property_id", propertyId)).data ?? [],
  });
  const items = useQuery({
    queryKey: ["po-items", propertyId], enabled: !!propertyId && open,
    queryFn: async () => (await (supabase.from as any)("inventory_items").select("*").eq("property_id", propertyId).eq("active", true).order("name")).data ?? [],
  });

  const total = lines.reduce((s, l) => s + (l.quantity || 0) * (l.unit_cost || 0), 0);

  function addLine() { setLines([...lines, { item_id: "", quantity: 1, unit_cost: 0 }]); }
  function removeLine(i: number) { setLines(lines.filter((_, idx) => idx !== i)); }

  async function save() {
    if (!propertyId) return;
    if (!location) return toast.error("Choose a destination location");
    if (lines.length === 0 || lines.some((l) => !l.item_id)) return toast.error("Add at least one item");
    const { data: po, error } = await (supabase.from as any)("purchase_orders").insert({
      property_id: propertyId,
      supplier_id: supplier || null,
      location_id: location,
      expected_at: expected || null,
      ordered_at: new Date().toISOString(),
      notes, status: "sent", total,
    }).select("id").single();
    if (error) return toast.error(error.message);
    const { error: le } = await (supabase.from as any)("purchase_order_lines").insert(lines.map((l) => ({ po_id: po.id, item_id: l.item_id, quantity: l.quantity, unit_cost: l.unit_cost })));
    if (le) return toast.error(le.message);
    toast.success("Purchase order created");
    setOpen(false); setLines([]); setSupplier(""); setLocation(""); setExpected(""); setNotes("");
    onDone();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="h-4 w-4 mr-1" /> New PO</Button></DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>New purchase order</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label>Supplier</Label>
              <Select value={supplier} onValueChange={setSupplier}>
                <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>{suppliers.data?.map((s: any) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Destination</Label>
              <Select value={location} onValueChange={setLocation}>
                <SelectTrigger><SelectValue placeholder="Location" /></SelectTrigger>
                <SelectContent>{locs.data?.map((l: any) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><Label>Expected</Label><Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Line items</Label>
              <Button size="sm" variant="outline" onClick={addLine}><Plus className="h-3 w-3 mr-1" /> Add line</Button>
            </div>
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-6">
                    <Select value={l.item_id} onValueChange={(v) => { const c = [...lines]; c[i].item_id = v; const it = items.data?.find((x: any) => x.id === v); if (it) c[i].unit_cost = Number(it.cost); setLines(c); }}>
                      <SelectTrigger><SelectValue placeholder="Select item" /></SelectTrigger>
                      <SelectContent>{items.data?.map((it: any) => <SelectItem key={it.id} value={it.id}>{it.sku} — {it.name}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="col-span-2"><Input type="number" step="0.01" value={l.quantity} onChange={(e) => { const c = [...lines]; c[i].quantity = +e.target.value; setLines(c); }} /></div>
                  <div className="col-span-3"><Input type="number" step="0.01" value={l.unit_cost} onChange={(e) => { const c = [...lines]; c[i].unit_cost = +e.target.value; setLines(c); }} /></div>
                  <div className="col-span-1"><Button size="icon" variant="ghost" onClick={() => removeLine(i)}><Trash2 className="h-4 w-4 text-destructive" /></Button></div>
                </div>
              ))}
              {lines.length === 0 && <div className="text-sm text-muted-foreground py-2">No lines. Click "Add line".</div>}
            </div>
          </div>
          <div><Label>Notes</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          <div className="flex justify-between items-center text-sm">
            <span className="text-muted-foreground">Total</span>
            <span className="text-lg font-semibold">{total.toFixed(2)}</span>
          </div>
        </div>
        <DialogFooter><Button onClick={save}>Create PO</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
