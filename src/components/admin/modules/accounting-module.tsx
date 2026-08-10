import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Pencil, Boxes, Percent, Settings2, TrendingUp, FileText, Truck, Receipt } from "lucide-react";
import { CrudTable } from "@/components/admin/crud-table";
import { DeleteConfirm } from "@/components/admin/delete-confirm";
import { FieldForm } from "@/components/admin/field-form";
import { useEntityCrud } from "@/lib/admin/use-entity-crud";
import { downloadServerPdf } from "@/lib/admin/pdf-docs";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface Props { propertyId: string | null; }

export function AccountingModule({ propertyId }: Props) {
  if (!propertyId) return <div className="text-sm text-muted-foreground p-6">Select a property to manage accounting.</div>;
  return (
    <div className="space-y-4">
      <AccountsSection propertyId={propertyId} />
      <TaxCodesSection propertyId={propertyId} />
      <PostingRulesSection propertyId={propertyId} />
      <FxRatesSection propertyId={propertyId} />
      <ApBillsSection propertyId={propertyId} />
      <ArInvoicesSection propertyId={propertyId} />
    </div>
  );
}

const ACCT_TYPES = ["asset","liability","equity","revenue","expense"];

function AccountsSection({ propertyId }: { propertyId: string }) {
  const [open, setOpen] = useState(false); const [editing, setEditing] = useState<any | null>(null);
  const { list, create, update, remove } = useEntityCrud<any>({
    table: "accounts", queryKey: ["admin", "accounts", propertyId],
    filter: (q) => q.eq("property_id", propertyId), order: { column: "code" }, label: "Account",
  });
  const fields = [
    { name: "code", label: "Code", type: "text" as const, required: true },
    { name: "name", label: "Name", type: "text" as const, required: true },
    { name: "type", label: "Type", type: "select" as const, required: true, options: ACCT_TYPES.map((t) => ({ value: t, label: t })) },
    { name: "system_key", label: "System key", type: "text" as const, placeholder: "optional (e.g. cash)" },
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
      <CrudTable
        title="Chart of Accounts" icon={<Boxes className="h-4 w-4" />}
        rows={list.data} loading={list.isLoading} rowKey={(r) => r.id}
        onAdd={() => { setEditing(null); setOpen(true); }} addLabel="New account"
        columns={[
          { label: "Code", cell: (r) => <span className="font-mono text-xs">{r.code}</span>, searchValue: (r) => r.code, printValue: (r) => r.code },
          { label: "Name", cell: (r) => <span className={r.is_active ? "" : "line-through text-muted-foreground"}>{r.name}</span>, searchValue: (r) => r.name, printValue: (r) => r.name },
          { label: "Type", cell: (r) => <Badge variant="outline">{r.type}</Badge>, printValue: (r) => r.type },
          { label: "System", cell: (r) => r.system_key ?? "—", printValue: (r) => r.system_key },
        ]}
        rowActions={(r) => <>
          <Button size="sm" variant="ghost" onClick={() => { setEditing(r); setOpen(true); }}><Pencil className="h-3.5 w-3.5" /></Button>
          <DeleteConfirm requireTyped={r.code} title={`Delete account ${r.code}?`} description="If any journal lines reference this account, deletion will fail." onConfirm={() => remove.mutateAsync(r.id)} />
        </>}
      />
      <FieldForm open={open} onOpenChange={setOpen} title={editing ? "Edit account" : "New account"} fields={fields} initial={editing ?? { is_active: true, type: "asset" }} onSubmit={submit} submitting={create.isPending || update.isPending} />
    </>
  );
}

function TaxCodesSection({ propertyId }: { propertyId: string }) {
  const [open, setOpen] = useState(false); const [editing, setEditing] = useState<any | null>(null);
  const { list, create, update, remove } = useEntityCrud<any>({
    table: "tax_codes", queryKey: ["admin", "tax_codes", propertyId],
    filter: (q) => q.eq("property_id", propertyId), order: { column: "code" }, label: "Tax code",
  });
  const { list: accts } = useEntityCrud<any>({
    table: "accounts", queryKey: ["admin", "accounts", propertyId],
    filter: (q) => q.eq("property_id", propertyId).eq("type", "liability"), order: { column: "code" },
  });
  const fields = [
    { name: "code", label: "Code", type: "text" as const, required: true },
    { name: "name", label: "Name", type: "text" as const, required: true },
    { name: "rate", label: "Rate (%)", type: "number" as const, required: true, min: 0 },
    { name: "payable_account_id", label: "Payable account", type: "select" as const, options: (accts.data ?? []).map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })) },
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
      <CrudTable title="Tax Codes" icon={<Percent className="h-4 w-4" />}
        rows={list.data} loading={list.isLoading} rowKey={(r) => r.id}
        onAdd={() => { setEditing(null); setOpen(true); }} addLabel="New tax"
        columns={[
          { label: "Code", cell: (r) => <span className="font-mono text-xs">{r.code}</span>, searchValue: (r) => r.code, printValue: (r) => r.code },
          { label: "Name", cell: (r) => r.name, searchValue: (r) => r.name, printValue: (r) => r.name },
          { label: "Rate", cell: (r) => `${Number(r.rate).toFixed(2)}%`, num: true, printValue: (r) => `${Number(r.rate).toFixed(2)}%` },
          { label: "Active", cell: (r) => r.is_active ? "Yes" : "No", printValue: (r) => r.is_active ? "Yes" : "No" },
        ]}
        rowActions={(r) => <>
          <Button size="sm" variant="ghost" onClick={() => { setEditing(r); setOpen(true); }}><Pencil className="h-3.5 w-3.5" /></Button>
          <DeleteConfirm onConfirm={() => remove.mutateAsync(r.id)} />
        </>}
      />
      <FieldForm open={open} onOpenChange={setOpen} title={editing ? "Edit tax code" : "New tax code"} fields={fields} initial={editing ?? { is_active: true, rate: 10 }} onSubmit={submit} submitting={create.isPending || update.isPending} />
    </>
  );
}

function PostingRulesSection({ propertyId }: { propertyId: string }) {
  const [open, setOpen] = useState(false); const [editing, setEditing] = useState<any | null>(null);
  const { list, create, update, remove } = useEntityCrud<any>({
    table: "posting_rules", queryKey: ["admin", "posting_rules", propertyId],
    filter: (q) => q.eq("property_id", propertyId), order: { column: "rule_key" }, label: "Rule",
  });
  const { list: accts } = useEntityCrud<any>({
    table: "accounts", queryKey: ["admin", "accounts", propertyId],
    filter: (q) => q.eq("property_id", propertyId), order: { column: "code" },
  });
  const acctMap = new Map((accts.data ?? []).map((a) => [a.id, `${a.code} — ${a.name}`]));
  const fields = [
    { name: "rule_key", label: "Rule key", type: "text" as const, required: true, placeholder: "e.g. room_revenue" },
    { name: "account_id", label: "Account", type: "select" as const, required: true, options: (accts.data ?? []).map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })) },
    { name: "notes", label: "Notes", type: "textarea" as const },
  ];
  const submit = async (v: Record<string, unknown>) => {
    const payload = { ...v, property_id: propertyId };
    if (editing) await update.mutateAsync({ id: editing.id, values: payload });
    else await create.mutateAsync(payload);
    setOpen(false); setEditing(null);
  };
  return (
    <>
      <CrudTable title="Posting Rules" icon={<Settings2 className="h-4 w-4" />}
        rows={list.data} loading={list.isLoading} rowKey={(r) => r.id}
        onAdd={() => { setEditing(null); setOpen(true); }} addLabel="New rule"
        columns={[
          { label: "Rule key", cell: (r) => <span className="font-mono text-xs">{r.rule_key}</span>, searchValue: (r) => r.rule_key, printValue: (r) => r.rule_key },
          { label: "Account", cell: (r) => acctMap.get(r.account_id) ?? "—", printValue: (r) => acctMap.get(r.account_id) },
        ]}
        rowActions={(r) => <>
          <Button size="sm" variant="ghost" onClick={() => { setEditing(r); setOpen(true); }}><Pencil className="h-3.5 w-3.5" /></Button>
          <DeleteConfirm onConfirm={() => remove.mutateAsync(r.id)} />
        </>}
      />
      <FieldForm open={open} onOpenChange={setOpen} title={editing ? "Edit rule" : "New rule"} fields={fields} initial={editing ?? {}} onSubmit={submit} submitting={create.isPending || update.isPending} />
    </>
  );
}

function FxRatesSection({ propertyId }: { propertyId: string }) {
  const [open, setOpen] = useState(false); const [editing, setEditing] = useState<any | null>(null);
  const { list, create, update, remove } = useEntityCrud<any>({
    table: "fx_rates", queryKey: ["admin", "fx_rates", propertyId],
    filter: (q) => q.eq("property_id", propertyId), order: { column: "as_of_date", ascending: false }, label: "FX rate",
  });
  const fields = [
    { name: "from_code", label: "From", type: "text" as const, required: true },
    { name: "to_code", label: "To", type: "text" as const, required: true },
    { name: "rate", label: "Rate", type: "number" as const, required: true },
    { name: "as_of_date", label: "As of date", type: "date" as const, required: true },
  ];
  const submit = async (v: Record<string, unknown>) => {
    const payload = { ...v, property_id: propertyId };
    if (editing) await update.mutateAsync({ id: editing.id, values: payload });
    else await create.mutateAsync(payload);
    setOpen(false); setEditing(null);
  };
  return (
    <>
      <CrudTable title="FX Rates" icon={<TrendingUp className="h-4 w-4" />}
        rows={list.data} loading={list.isLoading} rowKey={(r) => r.id}
        onAdd={() => { setEditing(null); setOpen(true); }} addLabel="New rate"
        columns={[
          { label: "Pair", cell: (r) => `${r.from_code}→${r.to_code}`, searchValue: (r) => `${r.from_code}${r.to_code}`, printValue: (r) => `${r.from_code}→${r.to_code}` },
          { label: "Rate", cell: (r) => Number(r.rate).toFixed(6), num: true, printValue: (r) => Number(r.rate).toFixed(6) },
          { label: "As of", cell: (r) => r.as_of_date, printValue: (r) => r.as_of_date },
        ]}
        rowActions={(r) => <>
          <Button size="sm" variant="ghost" onClick={() => { setEditing(r); setOpen(true); }}><Pencil className="h-3.5 w-3.5" /></Button>
          <DeleteConfirm onConfirm={() => remove.mutateAsync(r.id)} />
        </>}
      />
      <FieldForm open={open} onOpenChange={setOpen} title={editing ? "Edit FX rate" : "New FX rate"} fields={fields} initial={editing ?? { as_of_date: new Date().toISOString().slice(0, 10), rate: 1 }} onSubmit={submit} submitting={create.isPending || update.isPending} />
    </>
  );
}

async function printBill(billId: string, propertyId: string) {
  try {
    await downloadServerPdf("bill", billId, propertyId);
  } catch (e: any) {
    toast.error(e?.message ?? "Failed to render bill");
  }
}

function ApBillsSection({ propertyId }: { propertyId: string }) {
  const { list, remove } = useEntityCrud<any>({
    table: "ap_bills", queryKey: ["admin", "ap_bills", propertyId],
    filter: (q) => q.eq("property_id", propertyId), order: { column: "bill_date", ascending: false }, label: "Bill",
  });
  return (
    <CrudTable title="AP Bills" icon={<Truck className="h-4 w-4" />}
      rows={list.data} loading={list.isLoading} rowKey={(r) => r.id}
      columns={[
        { label: "Code", cell: (r) => <span className="font-mono text-xs">{r.code}</span>, searchValue: (r) => r.code, printValue: (r) => r.code },
        { label: "Date", cell: (r) => r.bill_date, printValue: (r) => r.bill_date },
        { label: "Total", cell: (r) => Number(r.total ?? 0).toFixed(2), num: true, printValue: (r) => Number(r.total ?? 0).toFixed(2) },
        { label: "Status", cell: (r) => <Badge variant="outline">{r.status}</Badge>, printValue: (r) => r.status },
      ]}
      rowActions={(r) => <>
        <Button size="sm" variant="ghost" title="Print bill" onClick={() => printBill(r.id, propertyId)}><Receipt className="h-3.5 w-3.5" /></Button>
        <DeleteConfirm title={`Delete bill ${r.code}?`} description="Only allowed if not posted." onConfirm={() => remove.mutateAsync(r.id)} />
      </>}
    />
  );
}

async function printInvoice(invId: string, propertyId: string) {
  try {
    await downloadServerPdf("invoice", invId, propertyId);
  } catch (e: any) {
    toast.error(e?.message ?? "Failed to render invoice");
  }
}

function ArInvoicesSection({ propertyId }: { propertyId: string }) {
  const { list, remove } = useEntityCrud<any>({
    table: "ar_invoices", queryKey: ["admin", "ar_invoices", propertyId],
    filter: (q) => q.eq("property_id", propertyId), order: { column: "issue_date", ascending: false }, label: "Invoice",
  });
  return (
    <CrudTable title="AR Invoices" icon={<FileText className="h-4 w-4" />}
      rows={list.data} loading={list.isLoading} rowKey={(r) => r.id}
      columns={[
        { label: "Code", cell: (r) => <span className="font-mono text-xs">{r.code}</span>, searchValue: (r) => r.code, printValue: (r) => r.code },
        { label: "Customer", cell: (r) => r.bill_to_name ?? "—", searchValue: (r) => r.bill_to_name, printValue: (r) => r.bill_to_name },
        { label: "Date", cell: (r) => r.issue_date, printValue: (r) => r.issue_date },
        { label: "Total", cell: (r) => Number(r.total ?? 0).toFixed(2), num: true, printValue: (r) => Number(r.total ?? 0).toFixed(2) },
        { label: "Status", cell: (r) => <Badge variant="outline">{r.status}</Badge>, printValue: (r) => r.status },
      ]}
      rowActions={(r) => <>
        <Button size="sm" variant="ghost" title="Print invoice" onClick={() => printInvoice(r.id, propertyId)}><Receipt className="h-3.5 w-3.5" /></Button>
        <DeleteConfirm onConfirm={() => remove.mutateAsync(r.id)} />
      </>}
    />
  );
}
