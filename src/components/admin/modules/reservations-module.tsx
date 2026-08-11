import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Pencil, CalendarDays, Users, Printer, Receipt } from "lucide-react";
import { CrudTable } from "@/components/admin/crud-table";
import { DeleteConfirm } from "@/components/admin/delete-confirm";
import { FieldForm } from "@/components/admin/field-form";
import { useEntityCrud } from "@/lib/admin/use-entity-crud";
import { downloadServerPdf } from "@/lib/admin/pdf-docs";
import { renderAdminPdf } from "@/lib/admin/pdf.functions";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface Props { propertyId: string | null; }

export function ReservationsModule({ propertyId }: Props) {
  if (!propertyId) return <div className="text-sm text-muted-foreground p-6">Select a property to manage reservations.</div>;
  return (
    <div className="space-y-4">
      <ReservationsSection propertyId={propertyId} />
      <GuestsSection propertyId={propertyId} />
      <ReservationChargesSection propertyId={propertyId} />
    </div>
  );
}

function ReservationsSection({ propertyId }: { propertyId: string }) {
  const renderPdf = useServerFn(renderAdminPdf);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const { list, update, remove } = useEntityCrud<any>({
    table: "reservations", queryKey: ["admin", "reservations", propertyId],
    filter: (q) => q.eq("property_id", propertyId), order: { column: "check_in", ascending: false }, label: "Reservation",
    select: "*, guest:guests(first_name,last_name), room_type:room_types(name)",
  });

  const fields = [
    { name: "check_in", label: "Check-in", type: "date" as const, required: true },
    { name: "check_out", label: "Check-out", type: "date" as const, required: true },
    { name: "adults", label: "Adults", type: "number" as const, min: 1 },
    { name: "children", label: "Children", type: "number" as const, min: 0 },
    { name: "status", label: "Status", type: "select" as const, options: ["confirmed","checked_in","checked_out","cancelled","no_show"].map((s) => ({ value: s, label: s })) },
    { name: "rate_total", label: "Rate total", type: "number" as const, min: 0 },
    { name: "notes", label: "Notes", type: "textarea" as const },
  ];

  return (
    <>
      <CrudTable
        title="Reservations" icon={<CalendarDays className="h-4 w-4" />}
        rows={list.data} loading={list.isLoading} rowKey={(r) => r.id}
        columns={[
          { label: "Code", cell: (r) => <span className="font-mono text-xs">{r.code}</span>, searchValue: (r) => r.code, printValue: (r) => r.code },
          { label: "Guest", cell: (r) => `${r.guest?.first_name ?? ""} ${r.guest?.last_name ?? ""}`.trim() || "—", searchValue: (r) => `${r.guest?.first_name ?? ""} ${r.guest?.last_name ?? ""}`, printValue: (r) => `${r.guest?.first_name ?? ""} ${r.guest?.last_name ?? ""}`.trim() },
          { label: "Room type", cell: (r) => r.room_type?.name ?? "—", printValue: (r) => r.room_type?.name },
          { label: "In → Out", cell: (r) => `${r.check_in} → ${r.check_out}`, printValue: (r) => `${r.check_in} → ${r.check_out}` },
          { label: "Status", cell: (r) => <Badge variant="outline">{r.status}</Badge>, printValue: (r) => r.status },
          { label: "Total", cell: (r) => Number(r.rate_total ?? 0).toFixed(2), num: true, printValue: (r) => Number(r.rate_total ?? 0).toFixed(2) },
        ]}
        rowActions={(r) => <>
          <Button size="sm" variant="ghost" title="Print folio" onClick={async () => {
            try {
              await downloadServerPdf(renderPdf, "folio", r.id, propertyId);
            } catch (e: any) {
              toast.error(e?.message ?? "Failed to render folio");
            }
          }}><Receipt className="h-3.5 w-3.5" /></Button>
          <Button size="sm" variant="ghost" onClick={() => { setEditing(r); setOpen(true); }}><Pencil className="h-3.5 w-3.5" /></Button>
          <DeleteConfirm title={`Delete reservation ${r.code}?`} onConfirm={() => remove.mutateAsync(r.id)} />
        </>}
      />
      <FieldForm open={open} onOpenChange={setOpen} title="Edit reservation" fields={fields}
        initial={editing ?? {}}
        onSubmit={async (v) => { await update.mutateAsync({ id: editing.id, values: v }); setOpen(false); setEditing(null); }}
        submitting={update.isPending}
      />
    </>
  );
}

function GuestsSection({ propertyId }: { propertyId: string }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const { list, create, update, remove } = useEntityCrud<any>({
    table: "guests", queryKey: ["admin", "guests", propertyId],
    filter: (q) => q.eq("property_id", propertyId), order: { column: "created_at", ascending: false }, label: "Guest",
  });

  const fields = [
    { name: "first_name", label: "First name", type: "text" as const, required: true },
    { name: "last_name", label: "Last name", type: "text" as const, required: true },
    { name: "email", label: "Email", type: "email" as const },
    { name: "phone", label: "Phone", type: "text" as const },
    { name: "address", label: "Address", type: "textarea" as const },
    { name: "nationality", label: "Nationality", type: "text" as const },
    { name: "document_number", label: "ID / passport", type: "text" as const },
    { name: "vip", label: "VIP", type: "switch" as const },
  ];

  const handleSubmit = async (v: Record<string, unknown>) => {
    const payload = { ...v, property_id: propertyId };
    if (editing) await update.mutateAsync({ id: editing.id, values: payload });
    else await create.mutateAsync(payload);
    setOpen(false); setEditing(null);
  };

  return (
    <>
      <CrudTable
        title="Guests" icon={<Users className="h-4 w-4" />}
        rows={list.data} loading={list.isLoading} rowKey={(r) => r.id}
        onAdd={() => { setEditing(null); setOpen(true); }} addLabel="New guest"
        columns={[
          { label: "Name", cell: (r) => <div className="font-medium">{r.first_name} {r.last_name} {r.vip && <Badge className="ml-1">VIP</Badge>}</div>, searchValue: (r) => `${r.first_name} ${r.last_name}`, printValue: (r) => `${r.first_name} ${r.last_name}` },
          { label: "Email", cell: (r) => r.email ?? "—", searchValue: (r) => r.email, printValue: (r) => r.email },
          { label: "Phone", cell: (r) => r.phone ?? "—", printValue: (r) => r.phone },
          { label: "Nationality", cell: (r) => r.nationality ?? "—", printValue: (r) => r.nationality },
        ]}
        rowActions={(r) => <>
          <Button size="sm" variant="ghost" onClick={() => { setEditing(r); setOpen(true); }}><Pencil className="h-3.5 w-3.5" /></Button>
          <DeleteConfirm onConfirm={() => remove.mutateAsync(r.id)} />
        </>}
      />
      <FieldForm open={open} onOpenChange={setOpen} title={editing ? "Edit guest" : "New guest"} fields={fields} initial={editing ?? {}} onSubmit={handleSubmit} submitting={create.isPending || update.isPending} />
    </>
  );
}

function ReservationChargesSection({ propertyId }: { propertyId: string }) {
  const { list, remove } = useEntityCrud<any>({
    table: "reservation_charges", queryKey: ["admin", "res_charges", propertyId],
    filter: (q) => q,
    order: { column: "posted_at", ascending: false }, label: "Charge",
  });
  return (
    <CrudTable
      title="Reservation Charges" icon={<Printer className="h-4 w-4" />}
      rows={list.data} loading={list.isLoading} rowKey={(r) => r.id}
      columns={[
        { label: "Description", cell: (r) => r.description, searchValue: (r) => r.description, printValue: (r) => r.description },
        { label: "Amount", cell: (r) => Number(r.amount).toFixed(2), num: true, printValue: (r) => Number(r.amount).toFixed(2) },
        { label: "Posted", cell: (r) => r.posted_at?.slice(0, 10) ?? "—", printValue: (r) => r.posted_at?.slice(0, 10) },
      ]}
      rowActions={(r) => <DeleteConfirm onConfirm={() => remove.mutateAsync(r.id)} />}
    />
  );
}
