import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Pencil, Package, Tag, Truck, MapPin, Receipt } from "lucide-react";
import { CrudTable } from "@/components/admin/crud-table";
import { DeleteConfirm } from "@/components/admin/delete-confirm";
import { FieldForm } from "@/components/admin/field-form";
import { ProductImageField, type ProductImageSelection } from "@/components/inventory/product-image-field";
import { useEntityCrud } from "@/lib/admin/use-entity-crud";
import { downloadServerPdf } from "@/lib/admin/pdf-docs";
import { renderAdminPdf } from "@/lib/admin/pdf.functions";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface Props { propertyId: string | null; }

export function InventoryModule({ propertyId }: Props) {
  if (!propertyId) return <div className="text-sm text-muted-foreground p-6">Select a property to manage inventory.</div>;
  return (
    <div className="space-y-4">
      <ItemCategoriesSection propertyId={propertyId} />
      <ItemsSection propertyId={propertyId} />
      <SuppliersSection propertyId={propertyId} />
      <LocationsSection propertyId={propertyId} />
      <PurchaseOrdersSection propertyId={propertyId} />
    </div>
  );
}

function ItemCategoriesSection({ propertyId }: { propertyId: string }) {
  const [open, setOpen] = useState(false); const [editing, setEditing] = useState<any | null>(null);
  const { list, create, update, remove } = useEntityCrud<any>({
    table: "item_categories", queryKey: ["admin", "item_categories", propertyId],
    filter: (q) => q.eq("property_id", propertyId), order: { column: "name" }, label: "Category",
  });
  const fields = [
    { name: "name", label: "Name", type: "text" as const, required: true },
    { name: "description", label: "Description", type: "textarea" as const },
  ];
  const submit = async (v: Record<string, unknown>) => {
    const payload = { ...v, property_id: propertyId };
    if (editing) await update.mutateAsync({ id: editing.id, values: payload });
    else await create.mutateAsync(payload);
    setOpen(false); setEditing(null);
  };
  return (
    <>
      <CrudTable title="Item Categories" icon={<Tag className="h-4 w-4" />}
        rows={list.data} loading={list.isLoading} rowKey={(r) => r.id}
        onAdd={() => { setEditing(null); setOpen(true); }} addLabel="New category"
        columns={[
          { label: "Name", cell: (r) => r.name, searchValue: (r) => r.name, printValue: (r) => r.name },
          { label: "Description", cell: (r) => r.description ?? "—", printValue: (r) => r.description },
        ]}
        rowActions={(r) => <>
          <Button size="sm" variant="ghost" onClick={() => { setEditing(r); setOpen(true); }}><Pencil className="h-3.5 w-3.5" /></Button>
          <DeleteConfirm onConfirm={() => remove.mutateAsync(r.id)} />
        </>}
      />
      <FieldForm open={open} onOpenChange={setOpen} title={editing ? "Edit category" : "New category"} fields={fields} initial={editing ?? {}} onSubmit={submit} submitting={create.isPending || update.isPending} />
    </>
  );
}

function ItemsSection({ propertyId }: { propertyId: string }) {
  const [open, setOpen] = useState(false); const [editing, setEditing] = useState<any | null>(null);
  const [imageSelection, setImageSelection] = useState<ProductImageSelection>(null);
  const { list: cats } = useEntityCrud<any>({
    table: "item_categories", queryKey: ["admin", "item_categories", propertyId],
    filter: (q) => q.eq("property_id", propertyId), order: { column: "name" },
  });
  const { list, create, update, remove } = useEntityCrud<any>({
    table: "inventory_items", queryKey: ["admin", "inventory_items", propertyId],
    filter: (q) => q.eq("property_id", propertyId), order: { column: "name" }, label: "Item",
  });
  const catMap = new Map((cats.data ?? []).map((c) => [c.id, c.name]));
  const fields = [
    { name: "name", label: "Name", type: "text" as const, required: true },
    { name: "sku", label: "SKU", type: "text" as const },
    { name: "category_id", label: "Category", type: "select" as const, options: (cats.data ?? []).map((c) => ({ value: c.id, label: c.name })) },
    { name: "unit", label: "Unit", type: "text" as const, placeholder: "e.g. kg, ea" },
    { name: "reorder_point", label: "Reorder point", type: "number" as const, min: 0 },
    { name: "cost", label: "Cost", type: "number" as const, min: 0 },
    { name: "is_active", label: "Active", type: "switch" as const },
  ];
  const submit = async (v: Record<string, unknown>) => {
    const payload: Record<string, unknown> = { ...v, property_id: propertyId };
    // Generating/uploading an AI or file image never writes to the product by
    // itself — it only becomes part of the payload here, on explicit Save.
    if (imageSelection) {
      payload.image_path = imageSelection.path;
      payload.image_source = imageSelection.source;
      payload.image_updated_at = new Date().toISOString();
    }
    if (editing) await update.mutateAsync({ id: editing.id, values: payload });
    else await create.mutateAsync(payload);
    setOpen(false); setEditing(null); setImageSelection(null);
  };
  return (
    <>
      <CrudTable title="Inventory Items" icon={<Package className="h-4 w-4" />}
        rows={list.data} loading={list.isLoading} rowKey={(r) => r.id}
        onAdd={() => { setEditing(null); setImageSelection(null); setOpen(true); }} addLabel="New item"
        columns={[
          { label: "Name", cell: (r) => r.name, searchValue: (r) => r.name, printValue: (r) => r.name },
          { label: "SKU", cell: (r) => <span className="font-mono text-xs">{r.sku ?? "—"}</span>, searchValue: (r) => r.sku, printValue: (r) => r.sku },
          { label: "Category", cell: (r) => catMap.get(r.category_id) ?? "—", printValue: (r) => catMap.get(r.category_id) },
          { label: "Unit", cell: (r) => r.unit ?? "—", printValue: (r) => r.unit },
          { label: "Cost", cell: (r) => Number(r.cost ?? 0).toFixed(2), num: true, printValue: (r) => Number(r.cost ?? 0).toFixed(2) },
          { label: "Reorder", cell: (r) => r.reorder_point ?? 0, num: true, printValue: (r) => r.reorder_point },
        ]}
        rowActions={(r) => <>
          <Button size="sm" variant="ghost" onClick={() => { setEditing(r); setImageSelection(null); setOpen(true); }}><Pencil className="h-3.5 w-3.5" /></Button>
          <DeleteConfirm onConfirm={() => remove.mutateAsync(r.id)} />
        </>}
      />
      <FieldForm
        open={open}
        onOpenChange={(v) => { setOpen(v); if (!v) setImageSelection(null); }}
        title={editing ? "Edit item" : "New item"}
        fields={fields}
        initial={editing ?? { is_active: true, unit: "ea" }}
        onSubmit={submit}
        submitting={create.isPending || update.isPending}
        extra={
          <ProductImageField
            key={open ? (editing?.id ?? "new") : "closed"}
            propertyId={propertyId}
            itemId={editing?.id ?? null}
            initialImagePath={editing?.image_path ?? null}
            productName={editing?.name}
            description={undefined}
            category={catMap.get(editing?.category_id) ?? undefined}
            color={undefined}
            onChange={setImageSelection}
          />
        }
      />
    </>
  );
}

function SuppliersSection({ propertyId }: { propertyId: string }) {
  const [open, setOpen] = useState(false); const [editing, setEditing] = useState<any | null>(null);
  const { list, create, update, remove } = useEntityCrud<any>({
    table: "suppliers", queryKey: ["admin", "suppliers", propertyId],
    filter: (q) => q.eq("property_id", propertyId), order: { column: "name" }, label: "Supplier",
  });
  const fields = [
    { name: "name", label: "Name", type: "text" as const, required: true },
    { name: "email", label: "Email", type: "email" as const },
    { name: "phone", label: "Phone", type: "text" as const },
    { name: "address", label: "Address", type: "textarea" as const },
    { name: "tax_id", label: "Tax ID", type: "text" as const },
    { name: "payment_terms", label: "Payment terms", type: "text" as const, placeholder: "e.g. NET30" },
    { name: "is_active", label: "Active", type: "switch" as const },
  ];
  const submit = async (v: Record<string, unknown>) => {
    const payload = { ...v, property_id: propertyId };
    if (editing) await update.mutateAsync({ id: editing.id, values: payload });
    else await create.mutateAsync(payload);
    setOpen(false); setEditing(null);
  };
  return (
    <>
      <CrudTable title="Suppliers" icon={<Truck className="h-4 w-4" />}
        rows={list.data} loading={list.isLoading} rowKey={(r) => r.id}
        onAdd={() => { setEditing(null); setOpen(true); }} addLabel="New supplier"
        columns={[
          { label: "Name", cell: (r) => r.name, searchValue: (r) => r.name, printValue: (r) => r.name },
          { label: "Email", cell: (r) => r.email ?? "—", searchValue: (r) => r.email, printValue: (r) => r.email },
          { label: "Phone", cell: (r) => r.phone ?? "—", printValue: (r) => r.phone },
          { label: "Active", cell: (r) => r.is_active ? "Yes" : "No", printValue: (r) => r.is_active ? "Yes" : "No" },
        ]}
        rowActions={(r) => <>
          <Button size="sm" variant="ghost" onClick={() => { setEditing(r); setOpen(true); }}><Pencil className="h-3.5 w-3.5" /></Button>
          <DeleteConfirm onConfirm={() => remove.mutateAsync(r.id)} />
        </>}
      />
      <FieldForm open={open} onOpenChange={setOpen} title={editing ? "Edit supplier" : "New supplier"} fields={fields} initial={editing ?? { is_active: true }} onSubmit={submit} submitting={create.isPending || update.isPending} />
    </>
  );
}

function LocationsSection({ propertyId }: { propertyId: string }) {
  const [open, setOpen] = useState(false); const [editing, setEditing] = useState<any | null>(null);
  const { list, create, update, remove } = useEntityCrud<any>({
    table: "stock_locations", queryKey: ["admin", "stock_locations", propertyId],
    filter: (q) => q.eq("property_id", propertyId), order: { column: "name" }, label: "Location",
  });
  const fields = [
    { name: "name", label: "Name", type: "text" as const, required: true },
    { name: "code", label: "Code", type: "text" as const },
  ];
  const submit = async (v: Record<string, unknown>) => {
    const payload = { ...v, property_id: propertyId };
    if (editing) await update.mutateAsync({ id: editing.id, values: payload });
    else await create.mutateAsync(payload);
    setOpen(false); setEditing(null);
  };
  return (
    <>
      <CrudTable title="Stock Locations" icon={<MapPin className="h-4 w-4" />}
        rows={list.data} loading={list.isLoading} rowKey={(r) => r.id}
        onAdd={() => { setEditing(null); setOpen(true); }} addLabel="New location"
        columns={[
          { label: "Name", cell: (r) => r.name, searchValue: (r) => r.name, printValue: (r) => r.name },
          { label: "Code", cell: (r) => <span className="font-mono text-xs">{r.code ?? "—"}</span>, printValue: (r) => r.code },
        ]}
        rowActions={(r) => <>
          <Button size="sm" variant="ghost" onClick={() => { setEditing(r); setOpen(true); }}><Pencil className="h-3.5 w-3.5" /></Button>
          <DeleteConfirm onConfirm={() => remove.mutateAsync(r.id)} />
        </>}
      />
      <FieldForm open={open} onOpenChange={setOpen} title={editing ? "Edit location" : "New location"} fields={fields} initial={editing ?? {}} onSubmit={submit} submitting={create.isPending || update.isPending} />
    </>
  );
}

function PurchaseOrdersSection({ propertyId }: { propertyId: string }) {
  const renderPdf = useServerFn(renderAdminPdf);
  const { list, remove } = useEntityCrud<any>({
    table: "purchase_orders", queryKey: ["admin", "purchase_orders", propertyId],
    filter: (q) => q.eq("property_id", propertyId), order: { column: "created_at", ascending: false }, label: "PO",
  });
  return (
    <CrudTable title="Purchase Orders" icon={<Truck className="h-4 w-4" />}
      rows={list.data} loading={list.isLoading} rowKey={(r) => r.id}
      columns={[
        { label: "Code", cell: (r) => <span className="font-mono text-xs">{r.code}</span>, searchValue: (r) => r.code, printValue: (r) => r.code },
        { label: "Ordered", cell: (r) => r.ordered_at?.slice(0, 10) ?? "—", printValue: (r) => r.ordered_at?.slice(0, 10) },
        { label: "Total", cell: (r) => Number(r.total ?? 0).toFixed(2), num: true, printValue: (r) => Number(r.total ?? 0).toFixed(2) },
        { label: "Status", cell: (r) => <Badge variant="outline">{r.status}</Badge>, printValue: (r) => r.status },
      ]}
      rowActions={(r) => <>
        <Button size="sm" variant="ghost" title="Print PO" onClick={async () => {
          try {
            await downloadServerPdf(renderPdf, "po", r.id, propertyId);
          } catch (e: any) {
            toast.error(e?.message ?? "Failed to render purchase order");
          }
        }}><Receipt className="h-3.5 w-3.5" /></Button>
        <DeleteConfirm title={`Delete PO ${r.code}?`} onConfirm={() => remove.mutateAsync(r.id)} />
      </>}
    />
  );
}
