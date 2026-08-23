import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Trash2, Pencil, Upload, Search } from "lucide-react";
import { toast } from "sonner";
import { matchesSearch, menuItemSearchText } from "@/lib/search-filter";

export const Route = createFileRoute("/_authenticated/pos/menu")({
  head: () => ({ meta: [{ title: "POS Menu" }] }),
  component: MenuPage,
});

function MenuPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const outlets = useQuery({
    queryKey: ["pos-outlets-menu", propertyId], enabled: !!propertyId,
    queryFn: async () => (await (supabase.from as any)("pos_outlets").select("*").eq("property_id", propertyId).order("name")).data ?? [],
  });
  const [outletId, setOutletId] = useState<string>("");
  const [itemQuery, setItemQuery] = useState("");
  const outlet = outlets.data?.find((o: any) => o.id === outletId) ?? outlets.data?.[0];

  const cats = useQuery({
    queryKey: ["menu-cats", outlet?.id], enabled: !!outlet?.id,
    queryFn: async () => (await (supabase.from as any)("pos_menu_categories").select("*").eq("outlet_id", outlet.id).order("sort")).data ?? [],
  });
  const items = useQuery({
    queryKey: ["menu-items", outlet?.id], enabled: !!outlet?.id,
    queryFn: async () => (await (supabase.from as any)("pos_menu_items").select("*, pos_menu_categories(name), inventory_items(name)").eq("outlet_id", outlet.id).order("name")).data ?? [],
  });
  const filteredItems = (items.data ?? []).filter((it: any) => matchesSearch(menuItemSearchText(it), itemQuery));
  const inv = useQuery({
    queryKey: ["menu-inv", propertyId], enabled: !!propertyId,
    queryFn: async () => (await (supabase.from as any)("inventory_items").select("id,sku,name").eq("property_id", propertyId).eq("active", true).order("name")).data ?? [],
  });

  async function addCategory(name: string) {
    if (!outlet || !name.trim() || !propertyId) return;
    const { error } = await (supabase.from as any)("pos_menu_categories").insert({ property_id: propertyId, outlet_id: outlet.id, name });
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["menu-cats", outlet.id] });
  }
  async function delItem(id: string) {
    if (!confirm("Delete menu item?")) return;
    const { error } = await (supabase.from as any)("pos_menu_items").delete().eq("id", id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["menu-items", outlet?.id] });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Menu</h1>
          <p className="text-sm text-muted-foreground">Menu categories and items per outlet. Link an item to inventory to auto-deduct stock on sale.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <Link to="/admin/uploads"><Upload className="h-4 w-4 mr-1" />Import from Excel/CSV</Link>
          </Button>
          {outlets.data && outlets.data.length > 0 && (
            <Select value={outlet?.id ?? ""} onValueChange={setOutletId}>
              <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>{outlets.data.map((o: any) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}</SelectContent>
            </Select>
          )}
        </div>
      </div>

      {!outlet ? (
        <Card className="p-8 text-center text-muted-foreground">Create an outlet from the POS Terminal page first.</Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-[280px_1fr]">
          <Card className="p-4 space-y-3">
            <div className="text-sm font-semibold">Categories</div>
            <CategoryAdder onAdd={addCategory} />
            <div className="space-y-1">
              {cats.data?.map((c: any) => <div key={c.id} className="rounded px-2 py-1 bg-muted/50 text-sm">{c.name}</div>)}
              {cats.data?.length === 0 && <div className="text-xs text-muted-foreground">No categories yet.</div>}
            </div>
          </Card>

          <Card>
            <div className="flex items-center justify-between p-3 flex-wrap gap-2">
              <div className="text-sm font-semibold">Items</div>
              <div className="flex items-center gap-2">
                {(items.data?.length ?? 0) > 0 && (
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input placeholder="Search items…" className="pl-8 w-56" value={itemQuery} onChange={(e) => setItemQuery(e.target.value)} />
                  </div>
                )}
                <ItemDialog propertyId={propertyId} outletId={outlet.id} cats={cats.data ?? []} inv={inv.data ?? []} onDone={() => qc.invalidateQueries({ queryKey: ["menu-items", outlet.id] })} />
              </div>
            </div>
            <Table>
              <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Category</TableHead><TableHead>Linked stock</TableHead><TableHead className="text-right">Price</TableHead><TableHead></TableHead></TableRow></TableHeader>
              <TableBody>
                {filteredItems.map((it: any) => (
                  <TableRow key={it.id}>
                    <TableCell className="font-medium">{it.name}</TableCell>
                    <TableCell>{it.pos_menu_categories?.name ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{it.inventory_items?.name ?? "—"}</TableCell>
                    <TableCell className="text-right">{Number(it.price).toFixed(2)}</TableCell>
                    <TableCell className="text-right flex justify-end gap-1">
                      <ItemDialog propertyId={propertyId} outletId={outlet.id} cats={cats.data ?? []} inv={inv.data ?? []} existing={it} trigger={<Button size="icon" variant="ghost"><Pencil className="h-4 w-4" /></Button>} onDone={() => qc.invalidateQueries({ queryKey: ["menu-items", outlet.id] })} />
                      <Button size="icon" variant="ghost" onClick={() => delItem(it.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                    </TableCell>
                  </TableRow>
                ))}
                {items.data?.length === 0 && <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">No items yet.</TableCell></TableRow>}
                {(items.data?.length ?? 0) > 0 && filteredItems.length === 0 && (
                  <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">No items match "{itemQuery}".</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        </div>
      )}
    </div>
  );
}

function CategoryAdder({ onAdd }: { onAdd: (n: string) => void }) {
  const [v, setV] = useState("");
  return (
    <div className="flex gap-2">
      <Input placeholder="New category" value={v} onChange={(e) => setV(e.target.value)} />
      <Button size="sm" onClick={() => { onAdd(v); setV(""); }}><Plus className="h-4 w-4" /></Button>
    </div>
  );
}

function ItemDialog({ propertyId, outletId, cats, inv, existing, trigger, onDone }: any) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    name: existing?.name ?? "", description: existing?.description ?? "",
    price: existing?.price ?? 0, category_id: existing?.category_id ?? "",
    inventory_item_id: existing?.inventory_item_id ?? "", active: existing?.active ?? true,
  });
  async function save() {
    const payload: any = {
      ...f, property_id: propertyId, outlet_id: outletId,
      category_id: f.category_id || null, inventory_item_id: f.inventory_item_id || null,
    };
    const q = existing ? (supabase.from as any)("pos_menu_items").update(payload).eq("id", existing.id) : (supabase.from as any)("pos_menu_items").insert(payload);
    const { error } = await q;
    if (error) return toast.error(error.message);
    toast.success("Saved"); setOpen(false); onDone();
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger ?? <Button size="sm"><Plus className="h-4 w-4 mr-1" /> Item</Button>}</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{existing ? "Edit" : "New"} menu item</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><Label>Name</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div><Label>Price</Label><Input type="number" step="0.01" value={f.price} onChange={(e) => setF({ ...f, price: +e.target.value })} /></div>
          <div>
            <Label>Category</Label>
            <Select value={f.category_id || "_none"} onValueChange={(v) => setF({ ...f, category_id: v === "_none" ? "" : v })}>
              <SelectTrigger><SelectValue placeholder="Uncategorised" /></SelectTrigger>
              <SelectContent><SelectItem value="_none">Uncategorised</SelectItem>{cats.map((c: any) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2">
            <Label>Linked inventory item (optional — auto-deduct on sale)</Label>
            <Select value={f.inventory_item_id || "_none"} onValueChange={(v) => setF({ ...f, inventory_item_id: v === "_none" ? "" : v })}>
              <SelectTrigger><SelectValue placeholder="Not linked" /></SelectTrigger>
              <SelectContent><SelectItem value="_none">Not linked</SelectItem>{inv.map((it: any) => <SelectItem key={it.id} value={it.id}>{it.sku} — {it.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2"><Label>Description</Label><Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
        </div>
        <DialogFooter><Button onClick={save}>Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
