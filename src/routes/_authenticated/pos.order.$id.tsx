import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Minus, Trash2, Printer, DollarSign, ArrowLeft, ChefHat, Search } from "lucide-react";
import { toast } from "sonner";
import { matchesSearch, menuItemSearchText } from "@/lib/search-filter";

export const Route = createFileRoute("/_authenticated/pos/order/$id")({
  head: () => ({ meta: [{ title: "Order" }] }),
  component: OrderPage,
});

function OrderPage() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [menuQuery, setMenuQuery] = useState("");

  const order = useQuery({
    queryKey: ["pos-order", id],
    queryFn: async () => (await (supabase.from as any)("pos_orders").select("*, pos_outlets(name,tax_rate), pos_tables(label)").eq("id", id).single()).data,
  });
  const lines = useQuery({
    queryKey: ["pos-order-lines", id],
    queryFn: async () => (await (supabase.from as any)("pos_order_items").select("*").eq("order_id", id).order("created_at")).data ?? [],
  });
  const menu = useQuery({
    queryKey: ["pos-menu-for-order", order.data?.outlet_id], enabled: !!order.data?.outlet_id,
    queryFn: async () => (await (supabase.from as any)("pos_menu_items").select("id,name,price,category_id,pos_menu_categories(name)").eq("outlet_id", order.data.outlet_id).eq("active", true).order("name")).data ?? [],
  });

  const subtotal = (lines.data ?? []).reduce((s: number, l: any) => s + Number(l.price_snapshot) * Number(l.quantity), 0);
  const taxRate = Number(order.data?.pos_outlets?.tax_rate ?? 0);
  const tax = Math.round(subtotal * taxRate) / 100;
  const total = subtotal + tax;
  const canEdit = order.data && !["closed","void"].includes(order.data.status);

  async function addItem(m: any) {
    if (!canEdit) return;
    await (supabase.from as any)("pos_order_items").insert({
      order_id: id, menu_item_id: m.id, name_snapshot: m.name, price_snapshot: m.price, quantity: 1,
    });
    qc.invalidateQueries({ queryKey: ["pos-order-lines", id] });
  }
  async function updateQty(lineId: string, q: number) {
    if (q <= 0) {
      await (supabase.from as any)("pos_order_items").delete().eq("id", lineId);
    } else {
      await (supabase.from as any)("pos_order_items").update({ quantity: q }).eq("id", lineId);
    }
    qc.invalidateQueries({ queryKey: ["pos-order-lines", id] });
  }
  async function fireKot() {
    const { data, error } = await (supabase.rpc as any)("fire_kot", { _order_id: id });
    if (error) return toast.error(error.message);
    toast.success("KOT " + data + " fired");
    qc.invalidateQueries({ queryKey: ["pos-order-lines", id] });
    qc.invalidateQueries({ queryKey: ["pos-order", id] });
    // open printable
    window.open(`/pos/kot/${id}`, "_blank");
  }
  async function voidOrder() {
    if (!confirm("Void this order?")) return;
    await (supabase.from as any)("pos_orders").update({ status: "void", closed_at: new Date().toISOString() }).eq("id", id);
    if (order.data?.table_id) await (supabase.from as any)("pos_tables").update({ status: "free" }).eq("id", order.data.table_id);
    toast.success("Voided"); nav({ to: "/pos" });
  }

  const filteredMenu = (menu.data ?? []).filter((m: any) => matchesSearch(menuItemSearchText(m), menuQuery));
  const grouped = new Map<string, any[]>();
  filteredMenu.forEach((m: any) => {
    const k = m.pos_menu_categories?.name ?? "Other";
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(m);
  });

  if (!order.data) return <div className="p-6 text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild><Link to="/pos"><ArrowLeft className="h-4 w-4" /></Link></Button>
          <div>
            <div className="text-xs text-muted-foreground">{order.data.pos_outlets?.name}</div>
            <h1 className="text-2xl font-semibold">
              Order {order.data.code} <Badge className="ml-2">{order.data.status}</Badge>
              {order.data.pos_tables?.label && <span className="text-base text-muted-foreground ml-2">· Table {order.data.pos_tables.label}</span>}
            </h1>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        {/* Menu picker */}
        <Card className="p-4 space-y-4">
          {(menu.data ?? []).length > 0 && (
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search menu items…"
                className="pl-8"
                value={menuQuery}
                onChange={(e) => setMenuQuery(e.target.value)}
              />
            </div>
          )}
          {[...grouped.entries()].map(([cat, ms]) => (
            <div key={cat}>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">{cat}</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {ms.map((m) => (
                  <button key={m.id} disabled={!canEdit} onClick={() => addItem(m)}
                    className="rounded-lg border p-3 text-left hover:border-primary transition-colors disabled:opacity-50">
                    <div className="text-sm font-medium">{m.name}</div>
                    <div className="text-xs text-muted-foreground">{Number(m.price).toFixed(2)}</div>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {grouped.size === 0 && (menu.data ?? []).length === 0 && (
            <div className="text-sm text-muted-foreground p-6 text-center">No menu items for this outlet. Add some in POS → Menu.</div>
          )}
          {grouped.size === 0 && (menu.data ?? []).length > 0 && (
            <div className="text-sm text-muted-foreground p-6 text-center">No menu items match “{menuQuery}”.</div>
          )}
        </Card>

        {/* Order lines & totals */}
        <Card className="p-4 space-y-3 h-fit sticky top-4">
          <div className="text-sm font-semibold">Order</div>
          <div className="space-y-2 max-h-[45vh] overflow-y-auto">
            {(lines.data ?? []).map((l: any) => (
              <div key={l.id} className="flex items-center gap-2 text-sm">
                <div className="flex-1">
                  <div className="font-medium flex items-center gap-2">
                    {l.name_snapshot}
                    {l.kot_fired_at && <span title="Fired" className="text-primary"><ChefHat className="h-3 w-3" /></span>}
                  </div>
                  <div className="text-xs text-muted-foreground">{Number(l.price_snapshot).toFixed(2)}</div>
                </div>
                {canEdit && !l.kot_fired_at && <>
                  <Button size="icon" variant="ghost" onClick={() => updateQty(l.id, Number(l.quantity) - 1)}><Minus className="h-3 w-3" /></Button>
                  <span className="w-6 text-center">{l.quantity}</span>
                  <Button size="icon" variant="ghost" onClick={() => updateQty(l.id, Number(l.quantity) + 1)}><Plus className="h-3 w-3" /></Button>
                </>}
                {(!canEdit || l.kot_fired_at) && <span className="w-16 text-right">× {l.quantity}</span>}
                <span className="w-16 text-right font-medium">{(l.price_snapshot * l.quantity).toFixed(2)}</span>
              </div>
            ))}
            {(lines.data ?? []).length === 0 && <div className="text-xs text-muted-foreground text-center py-4">No items yet.</div>}
          </div>
          <div className="border-t pt-2 space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span>{subtotal.toFixed(2)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Tax ({taxRate}%)</span><span>{tax.toFixed(2)}</span></div>
            <div className="flex justify-between text-base font-semibold pt-1"><span>Total</span><span>{total.toFixed(2)}</span></div>
          </div>
          {canEdit && (
            <div className="grid grid-cols-2 gap-2 pt-2">
              <Button variant="outline" onClick={fireKot}><ChefHat className="h-4 w-4 mr-1" /> Fire KOT</Button>
              <SettleDialog orderId={id} propertyId={order.data.property_id} total={total} onDone={() => nav({ to: "/pos" })} />
              <Button variant="ghost" onClick={voidOrder} className="col-span-2 text-destructive"><Trash2 className="h-4 w-4 mr-1" /> Void order</Button>
            </div>
          )}
          <Button variant="outline" asChild className="w-full">
            <Link to="/pos/kot/$id" params={{ id }} target="_blank"><Printer className="h-4 w-4 mr-1" /> Print latest KOT</Link>
          </Button>
        </Card>
      </div>
    </div>
  );
}

function SettleDialog({ orderId, propertyId, total, onDone }: { orderId: string; propertyId: string; total: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [postFolio, setPostFolio] = useState(false);
  const [reservationId, setReservationId] = useState("");
  const [amount, setAmount] = useState(total);

  const stays = useQuery({
    queryKey: ["settle-stays", propertyId], enabled: open && !!propertyId,
    queryFn: async () => (await (supabase.from as any)("reservations").select("id,code,guests(first_name,last_name),rooms(number)").eq("property_id", propertyId).eq("status", "checked_in").order("checked_in_at", { ascending: false })).data ?? [],
  });

  async function settle() {
    const { error } = await (supabase.rpc as any)("close_pos_order", {
      _order_id: orderId,
      _method: postFolio ? "other" : method,
      _amount: postFolio ? total : amount,
      _reference: reference || null,
      _reservation_id: postFolio ? reservationId : null,
      _post_to_folio: postFolio,
    });
    if (error) return toast.error(error.message);
    toast.success(postFolio ? "Posted to guest folio" : "Payment recorded");
    setOpen(false); onDone();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (v) setAmount(total); }}>
      <DialogTrigger asChild><Button><DollarSign className="h-4 w-4 mr-1" /> Settle</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Settle order</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="text-lg font-semibold">Total: {total.toFixed(2)}</div>
          <div className="flex items-center gap-2">
            <input id="folio" type="checkbox" checked={postFolio} onChange={(e) => setPostFolio(e.target.checked)} />
            <Label htmlFor="folio">Post to guest folio</Label>
          </div>
          {postFolio ? (
            <div>
              <Label>Checked-in guest</Label>
              <Select value={reservationId} onValueChange={setReservationId}>
                <SelectTrigger><SelectValue placeholder="Select reservation" /></SelectTrigger>
                <SelectContent>
                  {stays.data?.map((r: any) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.code} — {r.guests?.first_name} {r.guests?.last_name} {r.rooms?.number ? `· Rm ${r.rooms.number}` : ""}
                    </SelectItem>
                  ))}
                  {stays.data?.length === 0 && <div className="p-2 text-xs text-muted-foreground">No checked-in guests.</div>}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <>
              <div><Label>Method</Label>
                <Select value={method} onValueChange={setMethod}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{["cash","card","bank_transfer","mobile_money","wallet","other"].map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
                </Select></div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Amount received</Label><Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(+e.target.value)} /></div>
                <div><Label>Reference</Label><Input value={reference} onChange={(e) => setReference(e.target.value)} /></div>
              </div>
            </>
          )}
        </div>
        <DialogFooter><Button onClick={settle} disabled={postFolio && !reservationId}>Confirm & close order</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
