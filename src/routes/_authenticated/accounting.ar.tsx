import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Trash2, FileText, Send, DollarSign } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { AccountingWorkspaceShell } from "@/components/accounting/accounting-workspace-nav";

export const Route = createFileRoute("/_authenticated/accounting/ar")({
  head: () => ({ meta: [{ title: "Accounts Receivable · Accounting" }] }),
  component: () => (
    <AccountingWorkspaceShell>
      <ARPage />
    </AccountingWorkspaceShell>
  ),
});

type Line = { description: string; quantity: string; unit_price: string; tax_rate: string };

function fmt(n: number, c = "GHS") { return new Intl.NumberFormat(undefined, { style: "currency", currency: c }).format(n); }

function ARPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    bill_to_name: "", bill_to_email: "", bill_to_address: "",
    issue_date: format(new Date(), "yyyy-MM-dd"),
    due_date: format(new Date(Date.now() + 30 * 86400e3), "yyyy-MM-dd"),
    currency: "GHS", notes: "",
  });
  const [lines, setLines] = useState<Line[]>([{ description: "", quantity: "1", unit_price: "0", tax_rate: "0" }]);

  const invoices = useQuery({
    queryKey: ["ar-invoices", propertyId],
    queryFn: async () => {
      const { data, error } = await supabase.from("ar_invoices").select("*")
        .eq("property_id", propertyId!).order("issue_date", { ascending: false }).limit(200);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!propertyId,
  });

  const aging = useQuery({
    queryKey: ["ar-aging", propertyId],
    queryFn: async () => {
      const { data } = await supabase.from("ar_aging").select("*").eq("property_id", propertyId!);
      return data ?? [];
    },
    enabled: !!propertyId,
  });

  const create = useMutation({
    mutationFn: async () => {
      const valid = lines.filter((l) => l.description && parseFloat(l.unit_price) >= 0);
      if (valid.length === 0) throw new Error("Add at least one line");
      const sub = valid.reduce((s, l) => s + parseFloat(l.quantity) * parseFloat(l.unit_price), 0);
      const tax = valid.reduce((s, l) => s + parseFloat(l.quantity) * parseFloat(l.unit_price) * parseFloat(l.tax_rate) / 100, 0);
      const { data: inv, error } = await supabase.from("ar_invoices").insert({
        property_id: propertyId!, ...form,
        subtotal: sub, tax, total: sub + tax, status: "draft",
      } as any).select().single();
      if (error) throw error;
      const { error: lerr } = await supabase.from("ar_invoice_lines").insert(
        valid.map((l) => ({
          invoice_id: inv.id, description: l.description,
          quantity: parseFloat(l.quantity), unit_price: parseFloat(l.unit_price), tax_rate: parseFloat(l.tax_rate),
        }))
      );
      if (lerr) throw lerr;
      return inv.id as string;
    },
    onSuccess: () => {
      toast.success("Invoice created as draft");
      setOpen(false);
      setLines([{ description: "", quantity: "1", unit_price: "0", tax_rate: "0" }]);
      qc.invalidateQueries({ queryKey: ["ar-invoices", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const post = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("post_ar_invoice", { _id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Invoice posted to ledger");
      qc.invalidateQueries({ queryKey: ["ar-invoices", propertyId] });
      qc.invalidateQueries({ queryKey: ["ar-aging", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const buckets = ["current", "1-30", "31-60", "61-90", "90+"] as const;
  const bucketTotals = buckets.map((b) => ({
    bucket: b,
    total: (aging.data ?? []).filter((r: any) => r.bucket === b).reduce((s: number, r: any) => s + Number(r.balance), 0),
  }));
  const outstanding = (aging.data ?? []).reduce((s: number, r: any) => s + Math.max(0, Number(r.balance)), 0);

  if (!propertyId) return <div className="p-6 text-muted-foreground">Select a property.</div>;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-display font-semibold flex items-center gap-2"><FileText className="h-6 w-6" /> Accounts Receivable</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button size="sm"><Plus className="h-4 w-4 mr-1" /> New invoice</Button></DialogTrigger>
          <DialogContent className="max-w-3xl">
            <DialogHeader><DialogTitle>New AR invoice</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div><Label>Bill to</Label><Input value={form.bill_to_name} onChange={(e) => setForm({ ...form, bill_to_name: e.target.value })} /></div>
                <div><Label>Email</Label><Input value={form.bill_to_email} onChange={(e) => setForm({ ...form, bill_to_email: e.target.value })} /></div>
                <div><Label>Issue date</Label><Input type="date" value={form.issue_date} onChange={(e) => setForm({ ...form, issue_date: e.target.value })} /></div>
                <div><Label>Due date</Label><Input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></div>
                <div><Label>Currency</Label><Input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} /></div>
              </div>
              <div><Label>Address</Label><Textarea rows={2} value={form.bill_to_address} onChange={(e) => setForm({ ...form, bill_to_address: e.target.value })} /></div>
              <div className="border rounded-md">
                <div className="grid grid-cols-[2fr_60px_100px_70px_32px] gap-2 p-2 text-xs font-medium bg-muted/50 border-b">
                  <div>Description</div><div>Qty</div><div>Price</div><div>Tax %</div><div></div>
                </div>
                {lines.map((l, i) => (
                  <div key={i} className="grid grid-cols-[2fr_60px_100px_70px_32px] gap-2 p-2 border-b last:border-0">
                    <Input className="h-8" value={l.description} onChange={(e) => { const c=[...lines]; c[i].description=e.target.value; setLines(c); }} />
                    <Input className="h-8" type="number" value={l.quantity} onChange={(e) => { const c=[...lines]; c[i].quantity=e.target.value; setLines(c); }} />
                    <Input className="h-8" type="number" value={l.unit_price} onChange={(e) => { const c=[...lines]; c[i].unit_price=e.target.value; setLines(c); }} />
                    <Input className="h-8" type="number" value={l.tax_rate} onChange={(e) => { const c=[...lines]; c[i].tax_rate=e.target.value; setLines(c); }} />
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setLines(lines.filter((_,j)=>j!==i))}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                ))}
                <Button variant="ghost" size="sm" className="h-7 m-2" onClick={() => setLines([...lines, { description: "", quantity: "1", unit_price: "0", tax_rate: "0" }])}>+ Line</Button>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button disabled={create.isPending} onClick={() => create.mutate()}>Create draft</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Outstanding</div><div className="text-lg font-semibold">{fmt(outstanding)}</div></CardContent></Card>
        {bucketTotals.map((b) => (
          <Card key={b.bucket}><CardContent className="p-3"><div className="text-xs text-muted-foreground capitalize">{b.bucket}</div><div className="text-lg font-mono">{fmt(b.total)}</div></CardContent></Card>
        ))}
      </div>

      <Card>
        <CardHeader className="py-3"><CardTitle className="text-sm">Invoices</CardTitle></CardHeader>
        <CardContent className="p-0">
          {(invoices.data ?? []).map((i: any) => (
            <div key={i.id} className="flex items-center justify-between px-4 py-2 border-b last:border-0 hover:bg-muted/30">
              <div className="flex items-center gap-3 min-w-0">
                <span className="font-mono text-xs text-muted-foreground w-24">{i.code}</span>
                <span className="truncate">{i.bill_to_name}</span>
                <Badge variant="outline" className="text-[10px] uppercase">{i.status}</Badge>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">Due {i.due_date}</span>
                <span className="font-mono text-sm">{fmt(Number(i.total), i.currency)}</span>
                {i.status === "draft" && (
                  <Button size="sm" variant="outline" className="h-7" onClick={() => post.mutate(i.id)}>
                    <Send className="h-3 w-3 mr-1" /> Post
                  </Button>
                )}
              </div>
            </div>
          ))}
          {(invoices.data ?? []).length === 0 && <div className="p-6 text-center text-sm text-muted-foreground">No invoices yet.</div>}
        </CardContent>
      </Card>
    </div>
  );
}
