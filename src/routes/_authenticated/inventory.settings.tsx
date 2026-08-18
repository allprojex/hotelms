import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Pencil, Trash2, FileText } from "lucide-react";
import { toast } from "sonner";
import {
  ProductImageField,
  type ProductImageFieldHandle,
  type ProductImageSelection,
} from "@/components/inventory/product-image-field";
import { ApSupplierStatementView } from "@/components/accounting/ap-supplier-statement-view";

export const Route = createFileRoute("/_authenticated/inventory/settings")({
  head: () => ({ meta: [{ title: "Inventory settings" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Inventory setup</h1>
        <p className="text-sm text-muted-foreground">Items, categories, suppliers and stock locations.</p>
      </div>
      <Tabs defaultValue="items">
        <TabsList>
          <TabsTrigger value="items">Items</TabsTrigger>
          <TabsTrigger value="categories">Categories</TabsTrigger>
          <TabsTrigger value="suppliers">Suppliers</TabsTrigger>
          <TabsTrigger value="locations">Locations</TabsTrigger>
        </TabsList>
        <TabsContent value="items"><ItemsTab /></TabsContent>
        <TabsContent value="categories"><CategoriesTab /></TabsContent>
        <TabsContent value="suppliers"><SuppliersTab /></TabsContent>
        <TabsContent value="locations"><LocationsTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// ---------- ITEMS ----------
function ItemsTab() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const items = useQuery({
    queryKey: ["inv-items-all", propertyId], enabled: !!propertyId,
    queryFn: async () => (await (supabase.from as any)("inventory_items").select("*, item_categories(name)").eq("property_id", propertyId).order("name")).data ?? [],
  });
  const cats = useQuery({
    queryKey: ["inv-cats", propertyId], enabled: !!propertyId,
    queryFn: async () => (await (supabase.from as any)("item_categories").select("*").eq("property_id", propertyId)).data ?? [],
  });
  const stock = useQuery({
    queryKey: ["inv-stock-all", propertyId], enabled: !!propertyId,
    queryFn: async () => (await (supabase.from as any)("item_stock").select("item_id,quantity").eq("property_id", propertyId)).data ?? [],
  });
  const totals = new Map<string, number>();
  (stock.data ?? []).forEach((s: any) => totals.set(s.item_id, (totals.get(s.item_id) ?? 0) + Number(s.quantity)));

  async function remove(id: string) {
    if (!confirm("Delete this item?")) return;
    const { error } = await (supabase.from as any)("inventory_items").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Deleted"); qc.invalidateQueries({ queryKey: ["inv-items-all", propertyId] });
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <ItemDialog propertyId={propertyId} cats={cats.data ?? []} onDone={() => qc.invalidateQueries({ queryKey: ["inv-items-all", propertyId] })} />
      </div>
      <Card>
        <Table>
          <TableHeader><TableRow>
            <TableHead>SKU</TableHead><TableHead>Name</TableHead><TableHead>Category</TableHead><TableHead>Unit</TableHead>
            <TableHead className="text-right">Cost</TableHead><TableHead className="text-right">Price</TableHead>
            <TableHead className="text-right">Reorder</TableHead><TableHead className="text-right">On hand</TableHead><TableHead></TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {items.data?.map((i: any) => (
              <TableRow key={i.id}>
                <TableCell className="font-mono text-xs">{i.sku}</TableCell>
                <TableCell className="font-medium">{i.name}</TableCell>
                <TableCell>{i.item_categories?.name ?? "—"}</TableCell>
                <TableCell>{i.unit}</TableCell>
                <TableCell className="text-right">{Number(i.cost).toFixed(2)}</TableCell>
                <TableCell className="text-right">{Number(i.sale_price).toFixed(2)}</TableCell>
                <TableCell className="text-right">{Number(i.reorder_level).toFixed(2)}</TableCell>
                <TableCell className="text-right">{(totals.get(i.id) ?? 0).toFixed(2)}</TableCell>
                <TableCell className="text-right flex justify-end gap-1">
                  <ItemDialog propertyId={propertyId} cats={cats.data ?? []} existing={i} trigger={<Button size="icon" variant="ghost"><Pencil className="h-4 w-4" /></Button>} onDone={() => qc.invalidateQueries({ queryKey: ["inv-items-all", propertyId] })} />
                  <Button size="icon" variant="ghost" onClick={() => remove(i.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                </TableCell>
              </TableRow>
            ))}
            {items.data?.length === 0 && <TableRow><TableCell colSpan={9} className="py-8 text-center text-muted-foreground">No items yet.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function ItemDialog({ propertyId, cats, existing, trigger, onDone }: any) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    sku: existing?.sku ?? "", name: existing?.name ?? "", category_id: existing?.category_id ?? "",
    unit: existing?.unit ?? "each", cost: existing?.cost ?? 0, sale_price: existing?.sale_price ?? 0,
    reorder_level: existing?.reorder_level ?? 0, active: existing?.active ?? true,
  });
  const [imageSelection, setImageSelection] = useState<ProductImageSelection>(null);
  const imageFieldRef = useRef<ProductImageFieldHandle>(null);
  async function save() {
    if (!propertyId) return;
    const payload: any = { ...f, property_id: propertyId, category_id: f.category_id || null };
    // Generating/uploading an AI or file image never writes to the item by
    // itself — it only becomes part of the payload here, on explicit Save.
    if (imageSelection) {
      payload.image_path = imageSelection.path;
      payload.image_source = imageSelection.source;
      payload.image_updated_at = new Date().toISOString();
    }
    const q = existing ? (supabase.from as any)("inventory_items").update(payload).eq("id", existing.id) : (supabase.from as any)("inventory_items").insert(payload);
    const { error } = await q;
    if (error) return toast.error(error.message);
    // Save succeeded: retain the selected image, clean up only a dangling
    // AI preview that was generated but never applied via Use Image.
    imageFieldRef.current?.cleanupUnsaved(imageSelection?.path ?? existing?.image_path ?? null);
    toast.success("Saved"); setOpen(false); onDone();
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          // Dialog dismissed without saving (Cancel/Escape/overlay click):
          // drop any unsaved temp image, but never the pre-existing saved one.
          imageFieldRef.current?.cleanupUnsaved(existing?.image_path ?? null);
          setImageSelection(null);
        }
        setOpen(v);
      }}
    >
      <DialogTrigger asChild>{trigger ?? <Button><Plus className="h-4 w-4 mr-1" /> New item</Button>}</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{existing ? "Edit" : "New"} item</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Label>SKU</Label><Input value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} /></div>
          <div><Label>Name</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div>
            <Label>Category</Label>
            <Select value={f.category_id || "_none"} onValueChange={(v) => setF({ ...f, category_id: v === "_none" ? "" : v })}>
              <SelectTrigger><SelectValue placeholder="Uncategorised" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">Uncategorised</SelectItem>
                {cats.map((c: any) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div><Label>Unit</Label><Input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} /></div>
          <div><Label>Cost</Label><Input type="number" step="0.01" value={f.cost} onChange={(e) => setF({ ...f, cost: +e.target.value })} /></div>
          <div><Label>Sale price</Label><Input type="number" step="0.01" value={f.sale_price} onChange={(e) => setF({ ...f, sale_price: +e.target.value })} /></div>
          <div><Label>Reorder level</Label><Input type="number" step="0.01" value={f.reorder_level} onChange={(e) => setF({ ...f, reorder_level: +e.target.value })} /></div>
        </div>
        <ProductImageField
          ref={imageFieldRef}
          key={open ? (existing?.id ?? "new") : "closed"}
          propertyId={propertyId}
          itemId={existing?.id ?? null}
          initialImagePath={existing?.image_path ?? null}
          productName={f.name}
          category={cats.find((c: any) => c.id === f.category_id)?.name}
          onChange={setImageSelection}
        />
        <DialogFooter><Button onClick={save}>Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Simple CRUD table pattern for categories/suppliers/locations ----------
function CategoriesTab() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const list = useQuery({
    queryKey: ["inv-cats-all", propertyId], enabled: !!propertyId,
    queryFn: async () => (await (supabase.from as any)("item_categories").select("*").eq("property_id", propertyId).order("name")).data ?? [],
  });
  async function add() {
    if (!name.trim() || !propertyId) return;
    const { error } = await (supabase.from as any)("item_categories").insert({ property_id: propertyId, name: name.trim() });
    if (error) return toast.error(error.message);
    setName(""); qc.invalidateQueries({ queryKey: ["inv-cats-all", propertyId] });
  }
  async function del(id: string) {
    const { error } = await (supabase.from as any)("item_categories").delete().eq("id", id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["inv-cats-all", propertyId] });
  }
  return (
    <div className="space-y-3">
      <div className="flex gap-2 max-w-md">
        <Input placeholder="e.g. Beverages" value={name} onChange={(e) => setName(e.target.value)} />
        <Button onClick={add}><Plus className="h-4 w-4 mr-1" /> Add</Button>
      </div>
      <Card>
        <Table>
          <TableHeader><TableRow><TableHead>Name</TableHead><TableHead></TableHead></TableRow></TableHeader>
          <TableBody>
            {list.data?.map((c: any) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell className="text-right"><Button size="icon" variant="ghost" onClick={() => del(c.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button></TableCell>
              </TableRow>
            ))}
            {list.data?.length === 0 && <TableRow><TableCell colSpan={2} className="py-6 text-center text-muted-foreground">No categories.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function LocationsTab() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("store");
  const list = useQuery({
    queryKey: ["stock-locs-all", propertyId], enabled: !!propertyId,
    queryFn: async () => (await (supabase.from as any)("stock_locations").select("*").eq("property_id", propertyId).order("name")).data ?? [],
  });
  async function add() {
    if (!name.trim() || !propertyId) return;
    const { error } = await (supabase.from as any)("stock_locations").insert({ property_id: propertyId, name: name.trim(), kind });
    if (error) return toast.error(error.message);
    setName(""); qc.invalidateQueries({ queryKey: ["stock-locs-all", propertyId] });
  }
  async function del(id: string) {
    const { error } = await (supabase.from as any)("stock_locations").delete().eq("id", id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["stock-locs-all", propertyId] });
  }
  return (
    <div className="space-y-3">
      <div className="flex gap-2 max-w-xl">
        <Input placeholder="e.g. Main Store" value={name} onChange={(e) => setName(e.target.value)} />
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            {["store","bar","kitchen","housekeeping","other"].map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button onClick={add}><Plus className="h-4 w-4 mr-1" /> Add</Button>
      </div>
      <Card>
        <Table>
          <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Kind</TableHead><TableHead></TableHead></TableRow></TableHeader>
          <TableBody>
            {list.data?.map((l: any) => (
              <TableRow key={l.id}>
                <TableCell className="font-medium">{l.name}</TableCell>
                <TableCell>{l.kind}</TableCell>
                <TableCell className="text-right"><Button size="icon" variant="ghost" onClick={() => del(l.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button></TableCell>
              </TableRow>
            ))}
            {list.data?.length === 0 && <TableRow><TableCell colSpan={3} className="py-6 text-center text-muted-foreground">No locations.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function SuppliersTab() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const [statementFor, setStatementFor] = useState<any | null>(null);
  const list = useQuery({
    queryKey: ["suppliers-all", propertyId], enabled: !!propertyId,
    queryFn: async () => (await (supabase.from as any)("suppliers").select("*").eq("property_id", propertyId).order("name")).data ?? [],
  });
  async function del(id: string) {
    const { error } = await (supabase.from as any)("suppliers").delete().eq("id", id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["suppliers-all", propertyId] });
  }
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <SupplierDialog propertyId={propertyId} onDone={() => qc.invalidateQueries({ queryKey: ["suppliers-all", propertyId] })} />
      </div>
      <Card>
        <Table>
          <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Contact</TableHead><TableHead>Email</TableHead><TableHead>Phone</TableHead><TableHead>Terms</TableHead><TableHead></TableHead></TableRow></TableHeader>
          <TableBody>
            {list.data?.map((s: any) => (
              <TableRow key={s.id}>
                <TableCell className="font-medium">{s.name}</TableCell>
                <TableCell>{s.contact_name}</TableCell>
                <TableCell>{s.email}</TableCell>
                <TableCell>{s.phone}</TableCell>
                <TableCell>{s.payment_terms}</TableCell>
                <TableCell className="text-right flex justify-end gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setStatementFor(s)}><FileText className="h-3.5 w-3.5 mr-1" /> Statement</Button>
                  <SupplierDialog propertyId={propertyId} existing={s} trigger={<Button size="icon" variant="ghost"><Pencil className="h-4 w-4" /></Button>} onDone={() => qc.invalidateQueries({ queryKey: ["suppliers-all", propertyId] })} />
                  <Button size="icon" variant="ghost" onClick={() => del(s.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                </TableCell>
              </TableRow>
            ))}
            {list.data?.length === 0 && <TableRow><TableCell colSpan={6} className="py-6 text-center text-muted-foreground">No suppliers.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Card>
      {propertyId && (
        <ApSupplierStatementView
          propertyId={propertyId}
          supplier={statementFor}
          open={!!statementFor}
          onOpenChange={(v) => { if (!v) setStatementFor(null); }}
        />
      )}
    </div>
  );
}

function SupplierDialog({ propertyId, existing, trigger, onDone }: any) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    name: existing?.name ?? "", contact_name: existing?.contact_name ?? "",
    email: existing?.email ?? "", phone: existing?.phone ?? "", address: existing?.address ?? "",
    payment_terms: existing?.payment_terms ?? "Net 30",
  });
  async function save() {
    if (!propertyId) return;
    const payload = { ...f, property_id: propertyId };
    const q = existing ? (supabase.from as any)("suppliers").update(payload).eq("id", existing.id) : (supabase.from as any)("suppliers").insert(payload);
    const { error } = await q;
    if (error) return toast.error(error.message);
    toast.success("Saved"); setOpen(false); onDone();
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger ?? <Button><Plus className="h-4 w-4 mr-1" /> New supplier</Button>}</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{existing ? "Edit" : "New"} supplier</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><Label>Name</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div><Label>Contact name</Label><Input value={f.contact_name} onChange={(e) => setF({ ...f, contact_name: e.target.value })} /></div>
          <div><Label>Email</Label><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
          <div><Label>Phone</Label><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
          <div><Label>Payment terms</Label><Input value={f.payment_terms} onChange={(e) => setF({ ...f, payment_terms: e.target.value })} /></div>
          <div className="sm:col-span-2"><Label>Address</Label><Textarea value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></div>
        </div>
        <DialogFooter><Button onClick={save}>Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
