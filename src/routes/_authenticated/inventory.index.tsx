import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Boxes, AlertTriangle, Truck, ArrowLeftRight, CalendarClock } from "lucide-react";
import { computeBatchStatus } from "@/lib/inventory/batch-status";

export const Route = createFileRoute("/_authenticated/inventory/")({
  head: () => ({ meta: [{ title: "Inventory overview" }] }),
  component: InventoryHome,
});

function Stat({ label, value, icon: Icon }: { label: string; value: React.ReactNode; icon: any }) {
  return (
    <Card>
      <CardContent className="p-5 flex items-center gap-4">
        <div className="rounded-lg bg-primary/10 text-primary p-3"><Icon className="h-5 w-5" /></div>
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className="text-2xl font-semibold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function InventoryHome() {
  const propertyId = useActiveProperty();

  const items = useQuery({
    queryKey: ["inv-items", propertyId], enabled: !!propertyId,
    queryFn: async () => (await (supabase.from as any)("inventory_items").select("*").eq("property_id", propertyId)).data ?? [],
  });
  const stock = useQuery({
    queryKey: ["inv-stock", propertyId], enabled: !!propertyId,
    queryFn: async () => (await (supabase.from as any)("item_stock").select("item_id,quantity,location_id").eq("property_id", propertyId)).data ?? [],
  });
  const openPOs = useQuery({
    queryKey: ["inv-open-po", propertyId], enabled: !!propertyId,
    queryFn: async () => (await (supabase.from as any)("purchase_orders").select("id").eq("property_id", propertyId).in("status", ["draft","sent","partial"])).data ?? [],
  });
  const draftTransfers = useQuery({
    queryKey: ["inv-draft-tr", propertyId], enabled: !!propertyId,
    queryFn: async () => (await (supabase.from as any)("stock_transfers").select("id").eq("property_id", propertyId).eq("status","draft")).data ?? [],
  });
  const property = useQuery({
    queryKey: ["inv-property-threshold", propertyId], enabled: !!propertyId,
    queryFn: async () => (await (supabase.from as any)("properties").select("inventory_expiry_warning_days").eq("id", propertyId).single()).data,
  });
  const batches = useQuery({
    queryKey: ["inv-batches-home", propertyId], enabled: !!propertyId,
    queryFn: async () => (await (supabase.from as any)("inventory_stock_batches").select("expiry_date").eq("property_id", propertyId)).data ?? [],
  });

  const totals = new Map<string, number>();
  (stock.data ?? []).forEach((s: any) => totals.set(s.item_id, (totals.get(s.item_id) ?? 0) + Number(s.quantity)));
  const lowStock = (items.data ?? []).map((i: any) => ({ ...i, on_hand: totals.get(i.id) ?? 0 }))
    .filter((i: any) => Number(i.reorder_level) > 0 && i.on_hand <= Number(i.reorder_level));

  const warningDays = property.data?.inventory_expiry_warning_days ?? 30;
  const expiringOrExpired = (batches.data ?? []).filter((b: any) => {
    const s = computeBatchStatus(b.expiry_date, warningDays);
    return s === "expired" || s === "expiring_soon";
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Inventory</h1>
        <p className="text-sm text-muted-foreground">Stock levels, purchase orders and low-stock alerts.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Active items" value={items.data?.filter((i: any) => i.active).length ?? 0} icon={Boxes} />
        <Stat label="Low stock alerts" value={lowStock.length} icon={AlertTriangle} />
        <Stat label="Open POs" value={openPOs.data?.length ?? 0} icon={Truck} />
        <Stat label="Draft transfers" value={draftTransfers.data?.length ?? 0} icon={ArrowLeftRight} />
        <Link to="/inventory/settings"><Stat label="Expiring / expired batches" value={expiringOrExpired.length} icon={CalendarClock} /></Link>
      </div>

      <Card>
        <div className="flex items-center justify-between p-5 pb-2">
          <h2 className="text-lg font-semibold">Low stock</h2>
          <Link to="/inventory/purchase-orders" className="text-sm text-primary hover:underline">Reorder now →</Link>
        </div>
        <Table>
          <TableHeader><TableRow>
            <TableHead>SKU</TableHead><TableHead>Item</TableHead><TableHead>Unit</TableHead>
            <TableHead className="text-right">On hand</TableHead><TableHead className="text-right">Reorder at</TableHead><TableHead></TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {lowStock.map((i: any) => (
              <TableRow key={i.id}>
                <TableCell className="font-mono text-xs">{i.sku}</TableCell>
                <TableCell className="font-medium">{i.name}</TableCell>
                <TableCell>{i.unit}</TableCell>
                <TableCell className="text-right">{Number(i.on_hand).toFixed(2)}</TableCell>
                <TableCell className="text-right">{Number(i.reorder_level).toFixed(2)}</TableCell>
                <TableCell className="text-right"><Badge variant="destructive">Low</Badge></TableCell>
              </TableRow>
            ))}
            {lowStock.length === 0 && <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">All items above reorder level.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
